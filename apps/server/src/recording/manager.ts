import { join } from 'node:path';
import { activeSchedules, type CameraConfig, type ResolvedIcamifyConfig } from '@icamify/core';
import {
  CameraRecorder,
  type MediaEngine,
  type RecorderStatus,
  type RecordedSegmentInfo,
  type TriggerKind,
} from '@icamify/media';
import { RecordingIndex, type RecordedEvent, type RecordingSegment } from '@icamify/storage';
import { resolveStoragePaths } from '../storage-paths.ts';

/**
 * Recording manager.
 *
 * Owns one `CameraRecorder` per recording-enabled camera, and is the only place
 * that writes to the recording index. The recorder layer deliberately knows
 * nothing about SQLite (and the index nothing about FFmpeg): this class is the
 * seam, and it also turns recorder callbacks into WebSocket events so the UI can
 * show a clip the moment it is finalized.
 */

export type RecordingHubEvent =
  | { type: 'recording:segment'; segment: RecordingSegment }
  | { type: 'recording:status'; cameraId: string; status: RecorderStatus }
  | { type: 'recording:event'; event: RecordedEvent; closed: boolean };

export interface RecordingManagerOptions {
  config: ResolvedIcamifyConfig;
  media: MediaEngine;
  /** Defaults to `<stateDir>/recordings.db`. */
  indexPath?: string;
  pollIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (event: RecordingHubEvent) => void;
  /** Set to false for read-only API processes and tests. */
  startRecorders?: boolean;
}

export interface TriggerMeta {
  peakPercent?: number;
  boxes?: unknown;
}

export class RecordingManager {
  readonly index: RecordingIndex;

  private readonly options: RecordingManagerOptions;
  private readonly recorders = new Map<string, CameraRecorder>();
  private readonly statusByCamera = new Map<string, RecorderStatus>();
  private pendingMeta: TriggerMeta | undefined;
  private started = false;

  constructor(options: RecordingManagerOptions) {
    this.options = options;
    this.index = new RecordingIndex({ path: options.indexPath ?? defaultIndexPath(options.config) });
  }

  get startedRecorders(): number {
    return this.recorders.size;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const camera of this.options.config.cameras ?? []) {
      if (camera.enabled === false) continue;
      if ((camera.recording?.mode ?? 'off') === 'off') continue;
      this.attach(camera);
    }
  }

  /** Starts one camera on demand (used by tests and by config reloads). */
  async startCamera(camera: CameraConfig): Promise<void> {
    if (this.recorders.has(camera.id)) return;
    this.attach(camera);
    await this.recorders.get(camera.id)?.start();
  }

  private attach(camera: CameraConfig): void {
    const config = this.options.config;
    const scheduleActive =
      (camera.recording?.mode ?? 'off') === 'scheduled'
        ? () =>
            activeSchedules(config.schedules, new Date(this.now()), camera.recording?.scheduleIds).active
        : undefined;

    const recorder = new CameraRecorder({
      config,
      camera,
      media: this.options.media,
      ...(this.options.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.options.pollIntervalMs }),
      now: () => this.now(),
      ...(scheduleActive === undefined ? {} : { scheduleActive }),
      callbacks: {
        onAdopt: (segment) => this.onAdopt(camera, segment),
        onDrop: () => undefined,
        onTrigger: (event) => this.onTrigger(camera, event),
        onRelease: (event) => this.onRelease(camera, event),
        onState: (status) => this.onState(status),
        onError: (message) => this.options.log?.(`camera ${camera.id}: recording: ${message}`),
      },
    });
    this.recorders.set(camera.id, recorder);
    this.statusByCamera.set(camera.id, recorder.status());
    if (this.started && this.options.startRecorders !== false) void recorder.start();
  }

  async stop(): Promise<void> {
    const recorders = [...this.recorders.values()];
    this.recorders.clear();
    await Promise.all(recorders.map((recorder) => recorder.stop().catch(() => undefined)));
    this.statusByCamera.clear();
    this.started = false;
  }

  close(): void {
    this.index.close();
  }

  /**
   * Opens a recording window. Called by the motion/AI layers; the metadata is
   * attached to the event row created for this episode.
   */
  trigger(cameraId: string, kind: TriggerKind = 'motion', at = this.now(), meta?: TriggerMeta): void {
    const recorder = this.recorders.get(cameraId);
    if (recorder === undefined) return;
    this.pendingMeta = meta;
    try {
      recorder.trigger(kind, at);
    } finally {
      this.pendingMeta = undefined;
    }
  }

  status(cameraId: string): RecorderStatus | undefined {
    return this.statusByCamera.get(cameraId) ?? this.recorders.get(cameraId)?.status();
  }

  statuses(): RecorderStatus[] {
    return [...this.recorders.keys()]
      .map((cameraId) => this.status(cameraId))
      .filter((status): status is RecorderStatus => status !== undefined);
  }

  segment(id: string): RecordingSegment | undefined {
    return this.index.getSegment(id);
  }

  private onAdopt(camera: CameraConfig, segment: RecordedSegmentInfo): void {
    try {
      const stored = this.index.insertSegment({
        cameraId: camera.id,
        volumeId: segment.volumeId,
        path: segment.path,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        bytes: segment.bytes,
        reason: segment.reason,
        hasMotion: segment.reason === 'motion' || segment.reason === 'alert',
        hasAlert: segment.reason === 'alert',
        ...(segment.eventId === undefined ? {} : { eventId: segment.eventId }),
      });
      this.options.onEvent?.({ type: 'recording:segment', segment: stored });
    } catch (error) {
      this.options.log?.(
        `camera ${camera.id}: could not index ${segment.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private onTrigger(
    camera: CameraConfig,
    event: { eventId: string; kind: TriggerKind; at: number; windowStart: number; windowEnd: number },
  ): void {
    const meta = this.pendingMeta;
    try {
      const stored = this.index.insertEvent({
        id: event.eventId,
        cameraId: camera.id,
        kind: event.kind === 'alert' ? 'rule' : 'motion',
        startedAt: event.at,
        ...(meta?.peakPercent === undefined ? {} : { peakPercent: meta.peakPercent }),
        ...(meta?.boxes === undefined ? {} : { boxes: meta.boxes }),
      });
      this.options.onEvent?.({ type: 'recording:event', event: stored, closed: false });
    } catch (error) {
      this.options.log?.(`camera ${camera.id}: could not record event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onRelease(camera: CameraConfig, event: { eventId: string; endedAt: number }): void {
    try {
      const updated = this.index.updateEvent(event.eventId, { endedAt: event.endedAt });
      if (updated !== undefined) this.options.onEvent?.({ type: 'recording:event', event: updated, closed: true });
    } catch (error) {
      this.options.log?.(`camera ${camera.id}: could not close event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onState(status: RecorderStatus): void {
    this.statusByCamera.set(status.cameraId, status);
    this.options.onEvent?.({ type: 'recording:status', cameraId: status.cameraId, status });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function defaultIndexPath(config: ResolvedIcamifyConfig): string {
  return join(resolveStoragePaths(config).stateDir, 'recordings.db');
}
