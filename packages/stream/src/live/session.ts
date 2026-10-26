import {
  FragmentedMp4Parser,
  mseMimeType,
  type InitInfo,
} from '../fmp4.ts';
import { JpegFrameSplitter } from '../jpeg.ts';
import type { CameraConfig } from '@icamify/core';
import type {
  AddViewerResult,
  LiveSessionEvent,
  LiveSessionStats,
  LiveSessionState,
  LiveSource,
  LiveSourceFactory,
  LiveTransport,
  LiveViewer,
  ViewerStreamInfo,
} from './types.ts';

/**
 * One camera, one transport, N viewers.
 *
 * Responsibilities, in order of importance:
 * - exactly one FFmpeg pipeline per camera+transport, started on first viewer,
 *   torn down after the idle timeout when the last one leaves;
 * - late joiners get the init segment plus a short window of recent fragments,
 *   so they paint immediately instead of waiting for the next keyframe;
 * - a viewer that cannot keep up is disconnected instead of being buffered
 *   without limit (a stalled 4G phone must not OOM the NVR);
 * - if the pipeline dies, parser state is discarded and viewers are told the
 *   stream is restarting; the source (an auto-restarting supervisor) is expected
 *   to start producing again.
 */

const RESTART_GRACE_MS = 30_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface LiveSessionOptions {
  camera: CameraConfig;
  transport: LiveTransport;
  createSource: LiveSourceFactory;
  /** Refs from config; sensible defaults for tests. */
  maxViewers?: number;
  windowSegments?: number;
  idleTimeoutMs?: number;
  /** Viewer queue depth above which the viewer is dropped. */
  maxBufferedBytes?: number;
  /** How long a dying pipeline may stay away before viewers are disconnected. */
  restartGraceMs?: number;
  onEvent?: (event: LiveSessionEvent) => void;
  now?: () => number;
}

export class LiveSession {
  readonly cameraId: string;
  readonly transport: LiveTransport;

  private readonly options: LiveSessionOptions;
  private readonly maxViewers: number;
  private readonly windowSegments: number;
  private readonly idleTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly restartGraceMs: number;
  private readonly now: () => number;

  private readonly viewers = new Map<string, LiveViewer>();
  private state: LiveSessionState = 'idle';
  private source: LiveSource | undefined;
  private parser: FragmentedMp4Parser | undefined;
  private jpeg: JpegFrameSplitter | undefined;
  private init: { info: ViewerStreamInfo; data: Buffer } | undefined;
  private ring: Buffer[] = [];
  private ringBytes = 0;
  private generation = 0;
  private stopping = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private startedAt: number | undefined;
  private fragments = 0;
  private bytes = 0;
  private restarts = 0;
  private lastError: string | undefined;

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.cameraId = options.camera.id;
    this.transport = options.transport;
    this.maxViewers = Math.max(1, options.maxViewers ?? 8);
    this.windowSegments = Math.max(0, options.windowSegments ?? 8);
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.restartGraceMs = options.restartGraceMs ?? RESTART_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  addViewer(viewer: LiveViewer): AddViewerResult {
    if (this.stopping || this.state === 'closed') return 'closed';
    if (this.viewers.has(viewer.id)) return 'added';
    if (this.viewers.size >= this.maxViewers) return 'viewer-limit';

    this.viewers.set(viewer.id, viewer);
    this.clearIdleTimer();
    this.emit({ type: 'viewers', cameraId: this.cameraId, transport: this.transport, viewers: this.viewers.size });

    if (this.state === 'running' && this.init !== undefined) {
      this.replayTo(viewer);
    } else if (this.state === 'idle') {
      this.start();
    } else if (this.state === 'restarting') {
      viewer.sendError('The camera stream is restarting; the view will resume automatically.', 'pipeline-restart');
    }
    return 'added';
  }

  removeViewer(viewerId: string): void {
    if (!this.viewers.delete(viewerId)) return;
    this.emit({ type: 'viewers', cameraId: this.cameraId, transport: this.transport, viewers: this.viewers.size });
    if (this.viewers.size === 0 && this.state !== 'closed') this.scheduleIdleStop();
  }

  /** Stops the pipeline and disconnects viewers. Idempotent. */
  async stop(reason = 'stopped'): Promise<void> {
    if (this.state === 'closed') return;
    this.stopping = true;
    this.generation += 1;
    this.clearIdleTimer();
    this.clearRestartTimer();

    const source = this.source;
    this.source = undefined;
    if (source !== undefined) {
      try {
        await source.stop();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.state = 'closed';
    this.closeViewers(reason);
    this.parser = undefined;
    this.jpeg = undefined;
    this.init = undefined;
    this.ring = [];
    this.ringBytes = 0;
    this.emit({ type: 'stopped', cameraId: this.cameraId, transport: this.transport, reason });
  }

  stats(): LiveSessionStats {
    const stats: LiveSessionStats = {
      cameraId: this.cameraId,
      transport: this.transport,
      state: this.state,
      viewers: this.viewers.size,
      fragments: this.fragments,
      bytes: this.bytes,
      restarts: this.restarts,
    };
    if (this.startedAt !== undefined) stats.startedAt = this.startedAt;
    if (this.init?.info.codec !== undefined) stats.codec = this.init.info.codec;
    if (this.init?.info.width !== undefined) stats.width = this.init.info.width;
    if (this.init?.info.height !== undefined) stats.height = this.init.info.height;
    if (this.lastError !== undefined) stats.lastError = this.lastError;
    return stats;
  }

  private start(): void {
    if (this.stopping || this.state === 'running' || this.state === 'closed') return;
    this.state = 'running';
    this.startedAt = this.now();
    this.parser = this.transport === 'mse' ? new FragmentedMp4Parser() : undefined;
    this.jpeg = this.transport === 'mjpeg' ? new JpegFrameSplitter() : undefined;
    this.init = undefined;
    this.ring = [];
    this.ringBytes = 0;

    let source: LiveSource;
    try {
      source = this.options.createSource({
        cameraId: this.cameraId,
        transport: this.transport,
        camera: this.options.camera,
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.source = source;
    const generation = ++this.generation;

    this.emit({
      type: 'started',
      cameraId: this.cameraId,
      transport: this.transport,
      argv: source.argv ?? [],
    });

    try {
      source.start({
        onData: (chunk) => {
          if (generation !== this.generation || this.stopping) return;
          this.handleChunk(chunk);
        },
        onExit: (exit) => {
          if (generation !== this.generation || this.stopping) return;
          if (exit.requested) return;
          this.handleUnexpectedExit(exit.stderr);
        },
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private handleChunk(chunk: Buffer): void {
    this.clearRestartTimer();
    if (this.state === 'restarting') this.state = 'running';
    this.bytes += chunk.length;
    try {
      if (this.transport === 'mjpeg') {
        const splitter = this.jpeg;
        if (splitter === undefined) return;
        for (const frame of splitter.push(chunk)) this.broadcastSegment(frame);
        return;
      }

      const parser = this.parser;
      if (parser === undefined) return;
      for (const event of parser.push(chunk)) {
        if (event.kind === 'init') this.handleInit(event.init);
        else this.broadcastSegment(event.data);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private handleInit(init: InitInfo): void {
    const info: ViewerStreamInfo = {
      cameraId: this.cameraId,
      transport: this.transport,
      mimeType: mseMimeType(init) ?? 'video/mp4',
      segmentMode: 'fmp4',
    };
    if (init.video?.codec !== undefined) info.codec = init.video.codec;
    if (init.video?.width !== undefined) info.width = init.video.width;
    if (init.video?.height !== undefined) info.height = init.video.height;

    if (init.video?.codec === undefined) {
      // The browser cannot build a SourceBuffer without a codec string. Report
      // the actual fourcc so the operator knows to prefer MJPEG (or change the
      // live profile) instead of staring at a black tile.
      this.lastError = `MSE cannot play ${init.video?.format ?? 'this'} video; no RFC 6381 codec string could be derived.`;
      this.emit({ type: 'error', cameraId: this.cameraId, transport: this.transport, message: this.lastError });
      this.closeViewers('codec-unsupported');
      this.state = 'closed';
      this.emit({ type: 'stopped', cameraId: this.cameraId, transport: this.transport, reason: 'codec-unsupported' });
      void this.source?.stop();
      return;
    }

    this.init = { info, data: init.data };
    this.ring = [];
    this.ringBytes = 0;
    this.emit({
      type: 'init',
      cameraId: this.cameraId,
      transport: this.transport,
      codec: info.codec,
      width: info.width,
      height: info.height,
    });

    for (const viewer of this.viewers.values()) {
      this.sendInitTo(viewer);
    }
  }

  private broadcastSegment(data: Buffer): void {
    if (data.length === 0) return;
    this.fragments += 1;
    this.pushToRing(data);

    for (const [id, viewer] of this.viewers) {
      if (this.tooSlow(viewer)) {
        this.dropViewer(id, 'slow-consumer');
        continue;
      }
      try {
        viewer.sendSegment(data);
      } catch {
        this.dropViewer(id, 'write-failed');
      }
    }
  }

  private sendInitTo(viewer: LiveViewer): void {
    if (this.init === undefined) return;
    try {
      viewer.sendInit(this.init.info, this.init.data);
    } catch {
      this.viewers.delete(viewer.id);
      try {
        viewer.close('write-failed');
      } catch {
        // Nothing left to do for a viewer that cannot even be written to.
      }
    }
  }

  /** Sends the current init segment plus recent fragments to a late joiner. */
  private replayTo(viewer: LiveViewer): void {
    if (this.init === undefined) return;
    this.sendInitTo(viewer);
    for (const segment of this.ring) {
      if (this.tooSlow(viewer)) break;
      try {
        viewer.sendSegment(segment);
      } catch {
        break;
      }
    }
  }

  private pushToRing(segment: Buffer): void {
    if (this.windowSegments === 0) return;
    this.ring.push(segment);
    this.ringBytes += segment.length;
    while (this.ring.length > this.windowSegments) {
      const removed = this.ring.shift();
      if (removed !== undefined) this.ringBytes -= removed.length;
    }
  }

  private tooSlow(viewer: LiveViewer): boolean {
    try {
      return viewer.bufferedBytes() > this.maxBufferedBytes;
    } catch {
      return true;
    }
  }

  private dropViewer(viewerId: string, reason: string): void {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined) return;
    this.viewers.delete(viewerId);
    try {
      viewer.close(reason);
    } catch {
      // The viewer is already gone.
    }
    this.emit({ type: 'viewers', cameraId: this.cameraId, transport: this.transport, viewers: this.viewers.size });
    if (this.viewers.size === 0 && this.state !== 'closed') this.scheduleIdleStop();
  }

  private handleUnexpectedExit(stderr: string[] | undefined): void {
    const tail = stderr?.slice(-3).join(' ') ?? '';
    this.lastError = tail.length > 0 ? tail : 'The live pipeline exited unexpectedly.';
    this.restarts += 1;
    this.state = 'restarting';
    // Fragment numbering restarts with the new pipeline, so old parser state and
    // buffered fragments must never be mixed into the new stream.
    this.parser?.reset();
    this.jpeg = this.transport === 'mjpeg' ? new JpegFrameSplitter() : undefined;
    this.init = undefined;
    this.ring = [];
    this.ringBytes = 0;

    this.emit({
      type: 'source-exited',
      cameraId: this.cameraId,
      transport: this.transport,
      reason: this.lastError,
      willRestart: true,
    });
    for (const viewer of this.viewers.values()) {
      viewer.sendError('The camera pipeline stopped; waiting for it to restart.', 'pipeline-restart');
    }

    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping || this.state === 'closed') return;
      this.lastError = 'The camera pipeline did not come back in time.';
      for (const viewer of this.viewers.values()) {
        viewer.sendError(this.lastError, 'pipeline-offline');
      }
      void this.stop('pipeline-offline');
    }, this.restartGraceMs);
    this.restartTimer.unref?.();
  }

  private fail(message: string): void {
    this.lastError = message;
    this.emit({ type: 'error', cameraId: this.cameraId, transport: this.transport, message });
    for (const viewer of this.viewers.values()) viewer.sendError(message, 'stream-error');
    void this.stop('stream-error');
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.viewers.size > 0 || this.stopping) return;
      void this.stop('idle');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private closeViewers(reason: string): void {
    const viewers = [...this.viewers.values()];
    this.viewers.clear();
    for (const viewer of viewers) {
      try {
        viewer.close(reason);
      } catch {
        // Viewer already gone.
      }
    }
    if (viewers.length > 0) {
      this.emit({ type: 'viewers', cameraId: this.cameraId, transport: this.transport, viewers: 0 });
    }
  }

  private emit(event: LiveSessionEvent): void {
    this.options.onEvent?.(event);
  }
}
