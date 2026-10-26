import type { CameraHealthOptions, CameraConfig } from '@icamify/core';
import type { BuildResult } from '../ffmpeg/args.ts';
import { FfmpegProcess, type ExitResult, type ProgressFrame, type SpawnFn } from '../ffmpeg/process.ts';
import type { PipelinePurpose, PipelineState } from '../types.ts';

/**
 * Per-camera ingest supervisor.
 *
 * One supervisor owns one FFmpeg job for one purpose (record/live/detect). It
 * handles the failure modes that actually happen in the field — camera reboot,
 * DHCP change, Wi-Fi drop, encoder negotiation failure — with exponential
 * backoff and jitter (so twelve cameras coming back after a power cut do not
 * stampede), reports health transitions, and guarantees no orphan processes.
 */

export type IngestEvent =
  | { type: 'starting'; attempt: number }
  | { type: 'running'; pid: number | undefined; args: readonly string[] }
  | { type: 'progress'; frame: ProgressFrame }
  | { type: 'stderr'; line: string }
  | { type: 'exited'; code: number | null; signal: NodeJS.Signals | null; uptimeMs: number; requested: boolean }
  | { type: 'restart-scheduled'; attempt: number; delayMs: number; reason: string }
  | { type: 'degraded'; failures: number }
  | { type: 'recovered' }
  | { type: 'gave-up'; failures: number; reason: string }
  | { type: 'stopped' };

export interface IngestSupervisorOptions {
  cameraId: string;
  purpose: PipelinePurpose;
  /** Rebuilt on every attempt so profile edits apply to the next start. */
  build: () => BuildResult;
  bin: string;
  health?: CameraHealthOptions;
  onEvent?: (event: IngestEvent) => void;
  onProgress?: (frame: ProgressFrame) => void;
  /** Consumes stdout for purposes that pipe media (live/detect). */
  onStdout?: (chunk: Buffer) => void;
  stdout?: 'pipe' | 'ignore';
  spawn?: SpawnFn;
  cwd?: string;
  killGraceMs?: number;
  /** Run FFmpeg in its own process group so the whole tree is signalled. */
  detached?: boolean;
  /** A run lasting this long counts as healthy and resets the failure counter. */
  healthyAfterMs?: number;
  /** Test seam for deterministic jitter. */
  random?: () => number;
}

const DEFAULTS = {
  restartBackoffSeconds: 5,
  maxBackoffSeconds: 300,
  offlineAfterFailures: 5,
  healthyAfterMs: 10_000,
};

export class IngestSupervisor {
  readonly cameraId: string;
  readonly purpose: PipelinePurpose;

  private readonly options: IngestSupervisorOptions;
  private current: FfmpegProcess | undefined;
  private currentState: PipelineState = 'stopped';
  private attempt = 0;
  private failures = 0;
  private degraded = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private lastResult: ExitResult | undefined;

  constructor(options: IngestSupervisorOptions) {
    this.options = options;
    this.cameraId = options.cameraId;
    this.purpose = options.purpose;
  }

  state(): PipelineState {
    return this.currentState;
  }

  get pid(): number | undefined {
    return this.current?.pid;
  }

  get attempts(): number {
    return this.attempt;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  get lastExit(): ExitResult | undefined {
    return this.lastResult;
  }

  /** Starts the job, or returns immediately when it is already running. */
  start(): void {
    if (this.currentState === 'starting' || this.currentState === 'running' || this.currentState === 'degraded') {
      return;
    }
    this.stopping = false;
    this.spawnAttempt();
  }

  /** Stops the job and cancels any pending restart. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const process = this.current;
    this.current = undefined;
    if (process !== undefined) {
      await process.stop(this.options.killGraceMs);
    }
    this.currentState = 'stopped';
    this.emit({ type: 'stopped' });
  }

  private spawnAttempt(): void {
    if (this.stopping) return;
    this.attempt += 1;
    this.currentState = 'starting';
    this.emit({ type: 'starting', attempt: this.attempt });

    let built: BuildResult;
    try {
      built = this.options.build();
    } catch (error) {
      this.handleFailure(
        {
          code: null,
          signal: null,
          spawnError: error instanceof Error ? error : new Error(String(error)),
          startedAt: Date.now(),
          exitedAt: Date.now(),
          requested: false,
        },
        'could not build the FFmpeg command',
      );
      return;
    }

    const process = new FfmpegProcess({
      bin: this.options.bin,
      args: built.args,
      cwd: this.options.cwd,
      spawn: this.options.spawn,
      // Progress and media both arrive on stdout, so pipe it whenever anything
      // downstream is listening; an unread pipe would stall the encoder.
      stdout:
        this.options.stdout ??
        (this.options.onStdout !== undefined || this.options.onProgress !== undefined ? 'pipe' : 'ignore'),
      killGraceMs: this.options.killGraceMs,
      detached: this.options.detached,
      onStdout: this.options.onStdout,
      onProgress: (frame) => {
        this.options.onProgress?.(frame);
        this.emit({ type: 'progress', frame });
      },
      onStderrLine: (line) => this.emit({ type: 'stderr', line }),
    });

    this.current = process;
    if (process.running) {
      this.currentState = 'running';
      this.emit({ type: 'running', pid: process.pid, args: built.args });
    }

    void process.exited.then((result) => this.handleExit(result));
  }

  private handleExit(result: ExitResult): void {
    this.current = undefined;
    this.lastResult = result;

    if (result.requested || this.stopping) {
      this.currentState = 'stopped';
      this.emit({
        type: 'exited',
        code: result.code,
        signal: result.signal,
        uptimeMs: result.exitedAt - result.startedAt,
        requested: true,
      });
      return;
    }

    this.emit({
      type: 'exited',
      code: result.code,
      signal: result.signal,
      uptimeMs: result.exitedAt - result.startedAt,
      requested: false,
    });

    const uptimeMs = result.exitedAt - result.startedAt;
    const healthyAfter = this.options.healthyAfterMs ?? DEFAULTS.healthyAfterMs;
    const wasHealthy = uptimeMs >= healthyAfter;
    if (wasHealthy && this.failures > 0) {
      // A run that survived the health window clears the history: the next
      // outage should start back at the base backoff, not at the previous cap.
      this.failures = 0;
      this.degraded = false;
      this.emit({ type: 'recovered' });
    }
    this.handleFailure(result, this.describeExit(result));
  }

  private handleFailure(result: ExitResult, reason: string): void {
    this.failures += 1;
    const offlineAfter = this.options.health?.offlineAfterFailures ?? DEFAULTS.offlineAfterFailures;

    if (this.failures >= offlineAfter && !this.degraded) {
      this.degraded = true;
      this.currentState = 'degraded';
      this.emit({ type: 'degraded', failures: this.failures });
    } else if (this.currentState !== 'degraded') {
      this.currentState = 'starting';
    }

    const delayMs = this.nextDelayMs();
    const reasonText = result.spawnError !== undefined ? `${reason}: ${result.spawnError.message}` : reason;
    this.emit({ type: 'restart-scheduled', attempt: this.attempt + 1, delayMs, reason: reasonText });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnAttempt();
    }, delayMs);
  }

  private nextDelayMs(): number {
    const base = Math.max(0.05, this.options.health?.restartBackoffSeconds ?? DEFAULTS.restartBackoffSeconds);
    const max = this.options.health?.maxBackoffSeconds ?? DEFAULTS.maxBackoffSeconds;
    const exponent = Math.min(this.failures - 1, 8);
    const raw = Math.min(max, base * 2 ** exponent);
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
    return Math.max(50, Math.round(raw * 1000 * jitter));
  }

  private describeExit(result: ExitResult): string {
    if (result.spawnError !== undefined) return 'could not start FFmpeg';
    if (result.signal !== null) return `FFmpeg was terminated by ${result.signal}`;
    return `FFmpeg exited with code ${result.code ?? 'unknown'}`;
  }

  private emit(event: IngestEvent): void {
    this.options.onEvent?.(event);
  }
}

/** Convenience: builds supervisors for every enabled camera purpose. */
export function cameraHealthOptions(camera: CameraConfig): CameraHealthOptions {
  return camera.health ?? {};
}
