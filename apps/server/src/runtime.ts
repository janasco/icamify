import type { CameraConfig, ResolvedIcamifyConfig, StreamSource } from '@icamify/core';
import { MediaError, MediaEngine, maskUrl, redactArgv } from '@icamify/media';
import { HttpError } from './http/responses.ts';
import type { LiveRegistry, LiveSessionStats, TransportAvailability } from '@icamify/stream';

/**
 * Camera-facing read model for the API.
 *
 * Two rules are enforced here and nowhere else:
 * - credentials never leave the process: stream URLs are masked and raw FFmpeg
 *   argv is redacted before it reaches a client;
 * - status is derived from live sessions rather than tracked separately, so the
 *   UI cannot disagree with the encoder.
 */

export interface CameraSourceView {
  type: StreamSource['type'];
  label: string;
  /** URL/device with credentials and token-ish query values masked. */
  masked: string;
}

export interface CameraStatusView {
  state: 'idle' | 'live' | 'restarting' | 'offline';
  viewers: number;
  sessions: LiveSessionStats[];
  transports: TransportAvailability[];
  lastError?: string;
}

export interface CameraView {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  groupIds: string[];
  tags: string[];
  profiles: { record?: string; live?: string; detect?: string };
  recording: { mode: string; enabled: boolean; segmentMinutes?: number };
  motion: { enabled: boolean };
  ai: { enabled: boolean; providerId?: string; labels: string[] };
  ptz: { supported: boolean };
  hasSubStream: boolean;
  source: CameraSourceView;
  snapshotUrl: string;
  /** WebSocket MSE endpoint. */
  liveUrl: string;
  /** MJPEG fallback endpoint. */
  mjpegUrl: string;
  ui: { order?: number; accentColor?: string };
  status: CameraStatusView;
}

export interface SnapshotResult {
  jpeg: Buffer;
  camera: CameraConfig;
}

export interface CameraRuntimeOptions {
  config: ResolvedIcamifyConfig;
  media: MediaEngine;
  registry: LiveRegistry;
  toolchain?: { ffmpegVersion: string };
  log?: (line: string) => void;
}

export class CameraRuntime {
  readonly startedAt = Date.now();

  private readonly options: CameraRuntimeOptions;
  private readonly errors = new Map<string, string>();

  constructor(options: CameraRuntimeOptions) {
    this.options = options;
  }

  get config(): ResolvedIcamifyConfig {
    return this.options.config;
  }

  camera(cameraId: string): CameraConfig | undefined {
    return (this.options.config.cameras ?? []).find((camera) => camera.id === cameraId);
  }

  cameras(): CameraView[] {
    return (this.options.config.cameras ?? [])
      .map((camera) => this.view(camera))
      .sort((left, right) => (left.ui.order ?? 1000) - (right.ui.order ?? 1000) || left.name.localeCompare(right.name));
  }

  view(camera: CameraConfig): CameraView {
    const sessions = this.options.registry.statsFor(camera.id);
    const lastError = this.errors.get(camera.id) ?? sessions.find((session) => session.lastError !== undefined)?.lastError;
    const state: CameraStatusView['state'] =
      sessions.some((session) => session.state === 'restarting')
        ? 'restarting'
        : sessions.some((session) => session.state === 'running')
          ? 'live'
          : camera.enabled === false
            ? 'offline'
            : 'idle';

    const view: CameraView = {
      id: camera.id,
      name: camera.name,
      enabled: camera.enabled !== false,
      groupIds: camera.groupIds ?? [],
      tags: camera.tags ?? [],
      profiles: {
        ...(camera.profiles?.record === undefined ? {} : { record: camera.profiles.record }),
        ...(camera.profiles?.live === undefined ? {} : { live: camera.profiles.live }),
        ...(camera.profiles?.detect === undefined ? {} : { detect: camera.profiles.detect }),
      },
      recording: {
        mode: camera.recording?.mode ?? 'off',
        enabled: camera.recording?.enabled !== false && (camera.recording?.mode ?? 'off') !== 'off',
        ...(camera.recording?.segmentMinutes === undefined ? {} : { segmentMinutes: camera.recording.segmentMinutes }),
      },
      motion: { enabled: camera.motion?.enabled === true },
      ai: {
        enabled: camera.ai?.enabled === true,
        ...(camera.ai?.providerId === undefined ? {} : { providerId: camera.ai.providerId }),
        labels: camera.ai?.labels ?? [],
      },
      ptz: { supported: camera.ptz?.enabled === true || camera.ptz !== undefined },
      hasSubStream: camera.streams.sub !== undefined,
      source: describeSource(camera.streams.main),
      snapshotUrl: `/api/cameras/${encodeURIComponent(camera.id)}/snapshot.jpg`,
      liveUrl: `/api/cameras/${encodeURIComponent(camera.id)}/live.ws`,
      mjpegUrl: `/api/cameras/${encodeURIComponent(camera.id)}/live.mjpeg`,
      ui: {
        ...(camera.ui?.order === undefined ? {} : { order: camera.ui.order }),
        ...(camera.ui?.accentColor === undefined ? {} : { accentColor: camera.ui.accentColor }),
      },
      status: {
        state,
        viewers: this.options.registry.viewerCount(camera.id),
        sessions,
        transports: this.options.registry.availability(),
        ...(lastError === undefined ? {} : { lastError }),
      },
    };
    if (camera.description !== undefined) view.description = camera.description;
    return view;
  }

  /** High-resolution (or sub-stream) JPEG for thumbnails and poster frames. */
  async snapshot(cameraId: string, maxWidth = 960): Promise<SnapshotResult> {
    const camera = this.requireCamera(cameraId);
    const source = camera.streams.sub ?? camera.streams.main;
    try {
      const jpeg = await this.options.media.snapshot(source, maxWidth);
      this.errors.delete(cameraId);
      return { jpeg, camera };
    } catch (error) {
      const message = error instanceof MediaError ? error.message : error instanceof Error ? error.message : String(error);
      this.errors.set(cameraId, message);
      throw new HttpError(502, 'snapshot-failed', `Could not capture a snapshot from "${camera.name}": ${message}`, {
        ...(error instanceof MediaError && error.detail !== undefined ? { hint: error.detail } : {}),
      });
    }
  }

  /** Redacted argv for the live pipeline, shown in the UI for troubleshooting. */
  liveArgv(cameraId: string, transport: 'mse' | 'mjpeg' = 'mse'): string[] {
    const camera = this.requireCamera(cameraId);
    const plan = this.options.media.plan(this.options.config, camera, 'live', {
      liveOutput: transport === 'mjpeg' ? 'mjpeg' : 'fmp4',
    });
    return redactArgv(plan.args);
  }

  requireCamera(cameraId: string): CameraConfig {
    const camera = this.camera(cameraId);
    if (camera === undefined) {
      throw new HttpError(404, 'camera-not-found', `Camera "${cameraId}" does not exist.`);
    }
    return camera;
  }

  markError(cameraId: string, message: string): void {
    this.errors.set(cameraId, message);
  }

  clearError(cameraId: string): void {
    this.errors.delete(cameraId);
  }
}

export function describeSource(source: StreamSource): CameraSourceView {
  switch (source.type) {
    case 'rtsp':
      return { type: source.type, label: 'RTSP', masked: maskUrl(source.url) };
    case 'rtmp':
      return { type: source.type, label: 'RTMP', masked: maskUrl(source.url) };
    case 'http':
      return { type: source.type, label: 'HTTP', masked: maskUrl(source.url) };
    case 'onvif':
      return { type: source.type, label: 'ONVIF', masked: `onvif://${source.host}:${source.port ?? 80}` };
    case 'usb':
      return { type: source.type, label: 'USB', masked: source.device };
    case 'file':
      return { type: source.type, label: 'File', masked: source.path };
  }
}
