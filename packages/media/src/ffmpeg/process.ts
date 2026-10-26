import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * FFmpeg child-process supervisor primitives.
 *
 * Two hard requirements drive this file:
 * 1. no orphan encoders — every child runs in its own process group and is
 *    killed as a group (SIGTERM, grace period, SIGKILL), and
 * 2. no silent failures — stderr is captured in a bounded ring buffer so the
 *    camera supervisor and the UI can explain *why* a stream died.
 */

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface FfmpegProcessOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** `pipe` keeps a stdin open so `q` can be sent for a clean muxer shutdown. */
  stdin?: 'ignore' | 'pipe';
  stdout?: 'pipe' | 'ignore';
  /** Number of trailing stderr lines to retain. */
  stderrLines?: number;
  killGraceMs?: number;
  /**
   * Run the child in its own process group (default on POSIX) so the whole
   * encoder tree can be signalled. Disable only for tests that fake a child.
   */
  detached?: boolean;
  onStdout?: (chunk: Buffer) => void;
  onProgress?: (frame: ProgressFrame) => void;
  onStderrLine?: (line: string) => void;
}

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  startedAt: number;
  exitedAt: number;
  /** True when `stop()` asked for the exit rather than FFmpeg failing. */
  requested: boolean;
}

export interface ProgressFrame {
  frame: number;
  fps?: number;
  bitrateKbps?: number;
  totalSizeBytes?: number;
  outTimeMs?: number;
  speed?: number;
  dropFrames?: number;
}

/**
 * Parses `-progress pipe:1` output: `key=value` lines terminated by a
 * `progress=continue|end` line. FFmpeg reuses keys across frames, so a frame is
 * only emitted at the terminator.
 */
export class ProgressParser {
  private remainder = '';
  private pending = new Map<string, string>();
  private frameCount = 0;

  push(chunk: string | Buffer): ProgressFrame[] {
    this.remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const frames: ProgressFrame[] = [];
    let newline = this.remainder.indexOf('\n');
    while (newline !== -1) {
      const line = this.remainder.slice(0, newline).trim();
      this.remainder = this.remainder.slice(newline + 1);
      if (line.length > 0) {
        const separator = line.indexOf('=');
        if (separator > 0) {
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1);
          this.pending.set(key, value);
          if (key === 'progress') {
            frames.push(this.build());
            this.pending.clear();
          }
        }
      }
      newline = this.remainder.indexOf('\n');
    }
    return frames;
  }

  private build(): ProgressFrame {
    this.frameCount += 1;
    const get = (key: string): string | undefined => this.pending.get(key);
    const num = (key: string): number | undefined => {
      const raw = get(key);
      if (raw === undefined || raw === 'N/A') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const outTimeUs = num('out_time_us');
    const frame: ProgressFrame = { frame: this.frameCount };
    const fps = num('fps');
    // FFmpeg reports `bitrate=1500.0kbits/s`, so the unit has to be stripped
    // before the value is numeric; a bare value is bits/s.
    const bitrate = this.bitrateKbps();
    const totalSize = num('total_size');
    const speedRaw = get('speed');
    const speed = speedRaw === undefined || speedRaw === 'N/A' ? undefined : Number.parseFloat(speedRaw);
    const dropFrames = num('drop_frames');
    if (fps !== undefined) frame.fps = fps;
    if (bitrate !== undefined) frame.bitrateKbps = bitrate;
    if (totalSize !== undefined) frame.totalSizeBytes = totalSize;
    if (outTimeUs !== undefined) frame.outTimeMs = outTimeUs / 1000;
    if (speed !== undefined && Number.isFinite(speed)) frame.speed = speed;
    if (dropFrames !== undefined) frame.dropFrames = dropFrames;
    return frame;
  }

  private bitrateKbps(): number | undefined {
    const raw = this.pending.get('bitrate');
    if (raw === undefined || raw === 'N/A') return undefined;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return undefined;
    return /kbits?\/s/i.test(raw) ? value : value / 1000;
  }
}

/** Splits a byte stream into trimmed lines without losing partial writes. */
class LineSplitter {
  private remainder = '';

  push(chunk: string): string[] {
    this.remainder += chunk;
    const lines = this.remainder.split('\n');
    this.remainder = lines.pop() ?? '';
    return lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  }

  flush(): string[] {
    const rest = this.remainder.trim();
    this.remainder = '';
    return rest.length > 0 ? [rest] : [];
  }
}

export class FfmpegProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ExitResult>;
  private readonly child: ChildProcess;
  private readonly stderrRing: string[];
  private readonly maxStderrLines: number;
  private readonly killGraceMs: number;
  private readonly detached: boolean;
  private readonly startedAt = Date.now();
  private stopRequested = false;
  private settled = false;
  private spawnError: Error | undefined;
  private readonly resolveExit: (result: ExitResult) => void;
  private readonly progress?: ProgressParser;

  constructor(options: FfmpegProcessOptions) {
    this.maxStderrLines = options.stderrLines ?? 40;
    this.stderrRing = [];
    this.killGraceMs = options.killGraceMs ?? 5_000;
    this.detached = options.detached ?? process.platform !== 'win32';
    if (options.onProgress !== undefined) this.progress = new ProgressParser();

    const spawnFn = options.spawn ?? (spawn as unknown as SpawnFn);
    let resolveExit: (result: ExitResult) => void = () => {};
    this.exited = new Promise<ExitResult>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = resolveExit;

    // `detached` puts the child in its own process group so the whole tree dies
    // together; without it a killed ffmpeg can leave hardware encoder helpers
    // behind holding the device open.
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.stdin === 'pipe' ? 'pipe' : 'ignore', options.stdout === 'ignore' ? 'ignore' : 'pipe', 'pipe'],
      detached: this.detached,
      windowsHide: true,
    };

    let child: ChildProcess;
    try {
      child = spawnFn(options.bin, options.args, spawnOptions);
    } catch (error) {
      this.child = undefined as unknown as ChildProcess;
      this.pid = undefined;
      this.settle({ code: null, signal: null, spawnError: asError(error) });
      return;
    }
    this.child = child;
    this.pid = child.pid;

    const stderrSplitter = new LineSplitter();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of stderrSplitter.push(chunk)) {
        this.pushStderr(line);
        options.onStderrLine?.(line);
      }
    });

    if (this.progress !== undefined && options.onProgress !== undefined) {
      const parser = this.progress;
      const onProgress = options.onProgress;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) onProgress(frame);
      });
    } else if (options.onStdout !== undefined) {
      child.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk));
    } else if (child.stdout !== null) {
      // Nothing consumes stdout: drain it so a chatty muxer cannot fill the pipe
      // buffer and stall the encoder.
      child.stdout.resume();
    }

    child.stdin?.on('error', () => {
      // EPIPE when FFmpeg exits before a quit command is written; the exit
      // handler is authoritative, so this is only noise.
    });

    child.on('error', (error) => {
      this.spawnError = error;
    });

    child.on('exit', (code, signal) => {
      for (const line of stderrSplitter.flush()) {
        this.pushStderr(line);
        options.onStderrLine?.(line);
      }
      this.settle({ code, signal, spawnError: this.spawnError });
    });
  }

  get running(): boolean {
    return !this.settled;
  }

  get requested(): boolean {
    return this.stopRequested;
  }

  stderrTail(): string[] {
    return [...this.stderrRing];
  }

  /** Signals the whole process group. Safe to call on an already-dead child. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.settled || this.pid === undefined) return;
    try {
      if (this.detached && process.platform !== 'win32') {
        process.kill(-this.pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Asks FFmpeg to quit cleanly (`q` on stdin lets it flush the muxer), then
   * escalates to SIGTERM and SIGKILL on the process group.
   */
  async stop(graceMs: number = this.killGraceMs): Promise<ExitResult> {
    this.stopRequested = true;
    if (this.settled) return this.exited;

    const stdin = this.child?.stdin;
    if (stdin?.writable === true) {
      // With stdin detached (the normal case, since jobs run with -nostdin)
      // there is nothing to wait for: go straight to SIGTERM.
      stdin.write('q');
      stdin.end();
      const graceful = await this.waitForExit(graceMs);
      if (graceful !== undefined) return graceful;
    }

    this.kill('SIGTERM');
    const terminated = await this.waitForExit(graceMs);
    if (terminated !== undefined) return terminated;

    this.kill('SIGKILL');
    return this.exited;
  }

  private async waitForExit(timeoutMs: number): Promise<ExitResult | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([this.exited, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  private pushStderr(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    this.stderrRing.push(trimmed);
    if (this.stderrRing.length > this.maxStderrLines) {
      this.stderrRing.splice(0, this.stderrRing.length - this.maxStderrLines);
    }
  }

  private settle(result: Omit<ExitResult, 'startedAt' | 'exitedAt' | 'requested'>): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveExit({
      ...result,
      startedAt: this.startedAt,
      exitedAt: Date.now(),
      requested: this.stopRequested,
    });
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
