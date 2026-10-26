import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CameraConfig, RecordingMode, ResolvedIcamifyConfig } from '@icamify/core';
import type { IngestEvent, IngestSupervisor } from '../ingest/supervisor.ts';
import { resolveProfileForPurpose } from '../plan.ts';
import { cameraRecordingPaths, finalSegmentPath, type CameraRecordingPaths, type RecordingReason } from './paths.ts';
import { SegmentWindow, type BufferedSegment } from './prebuffer.ts';
import { SegmentWatcher, type ClosedSegment } from './watcher.ts';

/**
 * Per-camera recorder.
 *
 * One long-lived FFmpeg process per camera with a `copy` profile writes segments
 * straight to disk — no decode, no encode, so recording a 4K stream costs tens of
 * a millisecond of CPU per second of video. What changes per recording mode is
 * only what happens to each finished file:
 *
 * - `continuous`: every segment is adopted as a clip.
 * - `motion` / `alert`: segments land in a hot directory and live in the pre-buffer
 *   ring until a trigger window adopts them or they age out and are deleted.
 * - `scheduled`: like continuous, but only while a schedule window is open.
 *
 * The key property is that the encoder never stops for a trigger. Starting an
 * FFmpeg process for each motion event would lose the seconds before it (exactly
 * the interesting part) and pay connect latency every time.
 */

export type RecorderState = 'off' | 'idle' | 'buffering' | 'recording' | 'stalled' | 'error';

export type TriggerKind = 'motion' | 'alert' | 'scheduled';

export interface RecordedSegmentInfo {
  path: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  reason: RecordingReason;
  volumeId: string;
  eventId?: string;
}

export interface RecorderStatus {
  cameraId: string;
  mode: RecordingMode;
  state: RecorderState;
  /** True when the record profile copies packets instead of re-encoding. */
  directToDisk: boolean;
  hotSegmentSeconds: number;
  directory: string;
  volumeId: string;
  bufferedSegments: number;
  bufferedBytes: number;
  bufferedSeconds: number;
  adoptedSegments: number;
  adoptedBytes: number;
  droppedSegments: number;
  droppedBytes: number;
  eventActive: boolean;
  eventId?: string;
  eventKind?: TriggerKind;
  windowEndsAt?: number;
  lastSegmentAt?: number;
  lastError?: string;
  pid?: number;
}

export interface RecorderCallbacks {
  /** A segment was moved into the recordings tree and is ready to be indexed. */
  onAdopt?(segment: RecordedSegmentInfo): void;
  /** A pre-buffered segment aged out and its file was deleted. */
  onDrop?(segment: { path: string; startedAt: number; endedAt: number; bytes: number }): void;
  onTrigger?(event: { eventId: string; kind: TriggerKind; at: number; windowStart: number; windowEnd: number }): void;
  onRelease?(event: { eventId: string; endedAt: number }): void;
  onState?(status: RecorderStatus): void;
  onError?(message: string): void;
}

export interface RecorderStartOptions {
  outputTemplate: string;
  segmentSeconds: number;
  includeAudio?: boolean;
  onEvent?: (event: IngestEvent) => void;
}

/** Narrow view of MediaEngine, so the recorder has no dependency cycle. */
export interface RecorderPipelineHost {
  start(
    config: ResolvedIcamifyConfig,
    camera: CameraConfig,
    purpose: 'record',
    options: RecorderStartOptions,
  ): IngestSupervisor;
}

export interface CameraRecorderOptions {
  config: ResolvedIcamifyConfig;
  camera: CameraConfig;
  media: RecorderPipelineHost;
  callbacks?: RecorderCallbacks;
  now?: () => number;
  pollIntervalMs?: number;
  /** Schedule gate for mode `scheduled`; absent means "always active". */
  scheduleActive?: () => boolean;
  eventIdFactory?: () => string;
}

const MIN_HOT_SECONDS = 2;
const MAX_HOT_SECONDS = 10;

export class CameraRecorder {
  readonly cameraId: string;

  private readonly options: CameraRecorderOptions;
  private readonly paths: CameraRecordingPaths;
  private readonly buffer = new SegmentWindow();
  private readonly mode: RecordingMode;
  private readonly directToDisk: boolean;
  private readonly hotSeconds: number;

  private watcher: SegmentWatcher | undefined;
  private supervisor: IngestSupervisor | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stateValue: RecorderState;
  private stopping = false;
  private started = false;

  private windowStart: number | undefined;
  private windowEnd: number | undefined;
  private eventId: string | undefined;
  private eventKind: TriggerKind | undefined;

  private adoptedSegments = 0;
  private adoptedBytes = 0;
  private droppedSegments = 0;
  private droppedBytes = 0;
  private lastSegmentAt: number | undefined;
  private lastError: string | undefined;
  private lastNotified: string | undefined;

  constructor(options: CameraRecorderOptions) {
    this.options = options;
    this.cameraId = options.camera.id;
    this.paths = cameraRecordingPaths(options.config, options.camera);
    this.mode = options.camera.recording?.mode ?? 'off';
    this.stateValue = this.mode === 'off' ? 'off' : 'idle';

    let directToDisk = true;
    try {
      const profile = resolveProfileForPurpose(options.config, options.camera, 'record').profile;
      directToDisk = profile.copy === true || profile.video.codec === 'copy';
    } catch {
      directToDisk = false;
    }
    this.directToDisk = directToDisk;
    this.hotSeconds = this.computeHotSeconds();
  }

  get pathsForCamera(): CameraRecordingPaths {
    return this.paths;
  }

  get modeOfRecording(): RecordingMode {
    return this.mode;
  }

  status(): RecorderStatus {
    return {
      cameraId: this.cameraId,
      mode: this.mode,
      state: this.stateValue,
      directToDisk: this.directToDisk,
      hotSegmentSeconds: this.hotSeconds,
      directory: this.paths.cameraDir,
      volumeId: this.paths.volumeId,
      bufferedSegments: this.buffer.size,
      bufferedBytes: this.buffer.bytes,
      bufferedSeconds: Math.round(this.buffer.spanMs / 100) / 10,
      adoptedSegments: this.adoptedSegments,
      adoptedBytes: this.adoptedBytes,
      droppedSegments: this.droppedSegments,
      droppedBytes: this.droppedBytes,
      eventActive: this.eventId !== undefined,
      ...(this.eventId === undefined ? {} : { eventId: this.eventId }),
      ...(this.eventKind === undefined ? {} : { eventKind: this.eventKind }),
      ...(this.windowEnd === undefined ? {} : { windowEndsAt: this.windowEnd }),
      ...(this.lastSegmentAt === undefined ? {} : { lastSegmentAt: this.lastSegmentAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.supervisor?.pid === undefined ? {} : { pid: this.supervisor.pid }),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.mode === 'off' || this.options.camera.enabled === false) {
      this.setState('off');
      return;
    }
    this.started = true;
    this.stopping = false;

    try {
      await mkdir(this.paths.hotDir, { recursive: true });
      // Anything left in .hot belongs to a previous process: it was never
      // indexed, so it can never be played back. Delete it instead of leaking GBs.
      await this.clearHotDirectory();
    } catch (error) {
      this.fail(error);
      return;
    }

    this.watcher = new SegmentWatcher({
      dir: this.paths.hotDir,
      extension: this.paths.extension,
      segmentSeconds: this.hotSeconds,
      ...(this.options.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.options.pollIntervalMs }),
      now: () => this.now(),
      onError: (message) => this.fail(new Error(message)),
      onSweep: () => this.enqueue(() => this.tick()),
    });
    this.watcher.onClosed((segment) => this.enqueue(() => this.handleClosed(segment)));
    this.watcher.start();

    try {
      this.supervisor = this.options.media.start(this.options.config, this.options.camera, 'record', {
        outputTemplate: this.paths.hotTemplate,
        segmentSeconds: this.hotSeconds,
        ...(this.options.camera.recording?.audio === undefined
          ? {}
          : { includeAudio: this.options.camera.recording.audio }),
        onEvent: (event) => this.handleIngestEvent(event),
      });
      this.setState(this.mode === 'continuous' || this.mode === 'scheduled' ? 'recording' : 'buffering');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Runs one watcher scan; tests drive the recorder deterministically with it. */
  async pollOnce(): Promise<void> {
    await this.watcher?.sweep();
    await this.chain;
  }

  /**
   * Opens (or extends) a trigger window. Buffered segments overlapping the window
   * — including everything before "now" — are adopted immediately, which is what
   * puts pre-roll in the clip.
   */
  trigger(kind: TriggerKind, at = this.now(), options: { holdMs?: number } = {}): void {
    if (this.mode === 'off' || this.mode === 'continuous') return;
    if (this.mode === 'scheduled' && kind !== 'scheduled') return;
    if (this.stopping) return;

    const windowStart = at - this.preBufferMs();
    // `holdMs` lets a rule request a specific clip length (then.record.seconds)
    // instead of relying on the camera's post-roll.
    const windowEnd = at + Math.max(this.postRollMs(), options.holdMs ?? 0);
    this.windowStart = this.windowStart === undefined ? windowStart : Math.min(this.windowStart, windowStart);
    this.windowEnd = this.windowEnd === undefined ? windowEnd : Math.max(this.windowEnd, windowEnd);

    if (this.eventId === undefined) {
      this.eventId = this.options.eventIdFactory?.() ?? randomUUID();
      this.eventKind = kind;
      this.options.callbacks?.onTrigger?.({
        eventId: this.eventId,
        kind,
        at,
        windowStart: this.windowStart,
        windowEnd: this.windowEnd,
      });
    } else if (kind === 'alert' && this.eventKind !== 'alert') {
      // A rule firing during a motion episode escalates it: the clip is kept as
      // an alert, because that is the reason someone will look for it later.
      this.eventKind = 'alert';
    }

    const reason: RecordingReason = kind === 'alert' ? 'alert' : kind === 'scheduled' ? 'scheduled' : 'motion';
    this.enqueue(async () => {
      const overlapping = this.buffer.takeOverlapping(this.windowStart ?? windowStart, this.windowEnd ?? windowEnd);
      for (const segment of overlapping) await this.adopt(segment, reason, this.eventId);
      this.setState('recording');
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      this.setState(this.mode === 'off' ? 'off' : 'idle');
      return;
    }
    this.stopping = true;
    try {
      await this.supervisor?.stop();
      this.supervisor = undefined;
    } catch (error) {
      this.fail(error);
    }
    try {
      // FFmpeg has exited, so every file in .hot is complete.
      await this.watcher?.stop();
    } catch (error) {
      this.fail(error);
    }
    await this.chain;

    if (this.eventId !== undefined) {
      this.options.callbacks?.onRelease?.({ eventId: this.eventId, endedAt: this.windowEnd ?? this.now() });
      this.eventId = undefined;
      this.eventKind = undefined;
      this.windowStart = undefined;
      this.windowEnd = undefined;
    }

    for (const segment of this.buffer.clear()) await this.deleteFile(segment);
    this.started = false;
    this.setState('idle');
  }

  // -- internals -------------------------------------------------------------

  private async handleClosed(segment: ClosedSegment): Promise<void> {
    this.lastSegmentAt = segment.endedAt;
    const reason = this.reasonFor(segment);

    if (reason !== undefined) {
      await this.adopt(segment, reason, this.eventId);
    } else if (this.withinPreBuffer(segment, this.now())) {
      this.buffer.push(segment);
    } else {
      await this.deleteFile(segment);
    }

    await this.tick();
    this.notify();
  }

  /** Drops aged-out buffer entries and closes the trigger window when it is due. */
  private async tick(): Promise<void> {
    const now = this.now();
    const keepAfter = now - this.preBufferMs() - 1000;
    for (const segment of this.buffer.expire(keepAfter)) await this.deleteFile(segment);

    if (this.windowEnd !== undefined && now >= this.windowEnd + 1000 && this.eventId !== undefined) {
      this.options.callbacks?.onRelease?.({ eventId: this.eventId, endedAt: this.windowEnd });
      this.eventId = undefined;
      this.eventKind = undefined;
      this.windowStart = undefined;
      this.windowEnd = undefined;
      this.setState(this.mode === 'continuous' || this.mode === 'scheduled' ? 'recording' : 'buffering');
    }
    this.notify();
  }

  private reasonFor(segment: ClosedSegment): RecordingReason | undefined {
    switch (this.mode) {
      case 'continuous':
        return 'continuous';
      case 'scheduled':
        return this.options.scheduleActive?.() ?? true ? 'scheduled' : undefined;
      case 'motion':
      case 'alert': {
        if (this.windowStart === undefined || this.windowEnd === undefined) return undefined;
        if (segment.endedAt < this.windowStart || segment.startedAt > this.windowEnd) return undefined;
        return this.eventKind === 'alert' ? 'alert' : 'motion';
      }
      case 'off':
      default:
        return undefined;
    }
  }

  private withinPreBuffer(segment: ClosedSegment, now: number): boolean {
    return segment.endedAt >= now - this.preBufferMs();
  }

  private async adopt(segment: ClosedSegment | BufferedSegment, reason: RecordingReason, eventId?: string): Promise<void> {
    const target = finalSegmentPath(this.paths, segment.startedAt, reason);
    try {
      await mkdir(dirname(target), { recursive: true });
      await this.move(segment.path, target);
    } catch (error) {
      this.fail(error);
      return;
    }

    this.adoptedSegments += 1;
    this.adoptedBytes += segment.bytes;
    this.options.callbacks?.onAdopt?.({
      path: target,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      bytes: segment.bytes,
      reason,
      volumeId: this.paths.volumeId,
      ...(eventId === undefined ? {} : { eventId }),
    });
  }

  /** Same-filesystem rename, with a copy fallback for exotic volume setups. */
  private async move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM') throw error;
      await copyFile(from, to);
      await unlink(from).catch(() => undefined);
    }
  }

  private async deleteFile(segment: { path: string; bytes: number; startedAt: number; endedAt: number }): Promise<void> {
    try {
      await unlink(segment.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.fail(error);
        return;
      }
    }
    this.droppedSegments += 1;
    this.droppedBytes += segment.bytes;
    this.options.callbacks?.onDrop?.({ path: segment.path, startedAt: segment.startedAt, endedAt: segment.endedAt, bytes: segment.bytes });
  }

  private handleIngestEvent(event: IngestEvent): void {
    switch (event.type) {
      case 'stderr':
        this.lastError = event.line;
        break;
      case 'degraded':
        this.lastError = `recording pipeline failed ${event.failures} times`;
        this.setState('error');
        break;
      case 'gave-up':
        this.lastError = event.reason;
        this.setState('error');
        break;
      case 'exited':
        if (!this.stopping && !event.requested) {
          this.setState('stalled');
          this.notify();
        }
        break;
      case 'running':
        if (this.stateValue === 'error' || this.stateValue === 'stalled' || this.stateValue === 'idle') {
          this.setState(this.eventId === undefined && this.mode !== 'continuous' ? 'buffering' : 'recording');
        }
        break;
      default:
        break;
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.setState('error');
    this.options.callbacks?.onError?.(message);
    this.notify();
  }

  private setState(state: RecorderState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.notify();
  }

  private notify(): void {
    const status = this.status();
    const signature = `${status.state}:${status.bufferedSegments}:${status.adoptedSegments}:${status.droppedSegments}:${status.eventActive}:${status.eventId ?? ''}:${status.lastError ?? ''}`;
    if (signature === this.lastNotified) return;
    this.lastNotified = signature;
    this.options.callbacks?.onState?.(status);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => this.fail(error));
  }

  private computeHotSeconds(): number {
    if (this.mode === 'continuous' || this.mode === 'scheduled') {
      const minutes = this.options.camera.recording?.segmentMinutes ?? this.options.config.storage.segmentMinutes ?? 15;
      return Math.max(1, Math.round(minutes * 60));
    }
    const preBuffer = this.preBufferSeconds();
    return Math.max(MIN_HOT_SECONDS, Math.min(MAX_HOT_SECONDS, Math.round(preBuffer)));
  }

  private preBufferSeconds(): number {
    return Math.max(
      0,
      this.options.camera.recording?.preBufferSeconds ?? this.options.config.storage.preBufferSeconds ?? 5,
    );
  }

  private preBufferMs(): number {
    return this.preBufferSeconds() * 1000;
  }

  private postRollMs(): number {
    const seconds =
      this.options.camera.recording?.postRollSeconds ??
      this.options.config.motion.postMotionSeconds ??
      10;
    return Math.max(0, seconds) * 1000;
  }

  private async clearHotDirectory(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.paths.hotDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      await unlink(join(this.paths.hotDir, entry.name)).catch(() => undefined);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
