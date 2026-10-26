import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import { liveLimits, type LiveLimits } from './limits.ts';
import { LiveSession } from './session.ts';
import type {
  AddViewerResult,
  LiveSessionEvent,
  LiveSessionStats,
  LiveSourceFactory,
  LiveTransport,
  LiveViewer,
} from './types.ts';

/**
 * Owns every live session in the process.
 *
 * The registry is where global limits live (total concurrent pipelines, viewers
 * per camera, per-transport enablement) so individual sessions stay simple and
 * a single misbehaving client cannot exhaust the box.
 */

export type LiveRejectionCode =
  | 'camera-not-found'
  | 'camera-disabled'
  | 'transport-disabled'
  | 'transport-unavailable'
  | 'session-limit'
  | 'viewer-limit'
  | 'closed';

export interface LiveRejection {
  ok: false;
  code: LiveRejectionCode;
  message: string;
}

export interface LiveAccepted {
  ok: true;
  session: LiveSession;
}

export type LiveViewResult = LiveAccepted | LiveRejection;

export interface TransportAvailability {
  transport: LiveTransport | 'webrtc' | 'hls';
  enabled: boolean;
  available: boolean;
  /** Why the transport cannot be used, phrased for the UI. */
  reason?: string;
}

export interface LiveRegistryOptions {
  config: ResolvedIcamifyConfig;
  camera: (cameraId: string) => CameraConfig | undefined;
  createSource: LiveSourceFactory;
  onEvent?: (event: LiveSessionEvent) => void;
  /** Set by the server once a WebRTC engine is registered. */
  webrtc?: { available: boolean; reason?: string };
  now?: () => number;
}

export class LiveRegistry {
  readonly limits: LiveLimits;

  private readonly options: LiveRegistryOptions;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(options: LiveRegistryOptions) {
    this.options = options;
    this.limits = liveLimits(options.config);
  }

  private key(cameraId: string, transport: LiveTransport): string {
    return `${cameraId}:${transport}`;
  }

  /** Attaches a viewer, starting the pipeline if this is the first one. */
  view(cameraId: string, transport: LiveTransport, viewer: LiveViewer): LiveViewResult {
    const camera = this.options.camera(cameraId);
    if (camera === undefined) {
      return { ok: false, code: 'camera-not-found', message: `Camera "${cameraId}" does not exist.` };
    }
    if (camera.enabled === false) {
      return { ok: false, code: 'camera-disabled', message: `Camera "${cameraId}" is disabled.` };
    }
    if (!this.limits.enabled[transport]) {
      return {
        ok: false,
        code: 'transport-disabled',
        message: `The "${transport}" live transport is disabled in streaming.${transport}.enabled.`,
      };
    }

    let session = this.sessions.get(this.key(cameraId, transport));
    if (session === undefined) {
      if (this.sessions.size >= this.limits.maxSessions) {
        return {
          ok: false,
          code: 'session-limit',
          message: `All ${this.limits.maxSessions} live sessions are in use (streaming.maxConcurrentSessions).`,
        };
      }
      session = new LiveSession({
        camera,
        transport,
        createSource: this.options.createSource,
        maxViewers: this.limits.maxViewersPerCamera,
        windowSegments: this.limits.windowSegments,
        idleTimeoutMs: this.limits.idleTimeoutMs,
        onEvent: (event) => {
          if (event.type === 'stopped') this.sessions.delete(this.key(event.cameraId, event.transport));
          this.options.onEvent?.(event);
        },
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.sessions.set(this.key(cameraId, transport), session);
    }

    const result: AddViewerResult = session.addViewer(viewer);
    if (result === 'viewer-limit') {
      return {
        ok: false,
        code: 'viewer-limit',
        message: `Camera "${cameraId}" already has ${this.limits.maxViewersPerCamera} live viewers (streaming.webrtc.maxViewersPerCamera).`,
      };
    }
    if (result === 'closed') {
      return { ok: false, code: 'closed', message: 'The live session is shutting down.' };
    }
    return { ok: true, session };
  }

  /** Releases a viewer without waiting for the socket to close. */
  removeViewer(cameraId: string, transport: LiveTransport, viewerId: string): void {
    this.sessions.get(this.key(cameraId, transport))?.removeViewer(viewerId);
  }

  session(cameraId: string, transport: LiveTransport): LiveSession | undefined {
    return this.sessions.get(this.key(cameraId, transport));
  }

  stats(): LiveSessionStats[] {
    return [...this.sessions.values()].map((session) => session.stats());
  }

  statsFor(cameraId: string): LiveSessionStats[] {
    return [...this.sessions.values()]
      .filter((session) => session.cameraId === cameraId)
      .map((session) => session.stats());
  }

  viewerCount(cameraId: string): number {
    return [...this.sessions.values()]
      .filter((session) => session.cameraId === cameraId)
      .reduce((total, session) => total + session.viewerCount, 0);
  }

  /** What the UI may attempt for this camera, in fallback-chain order. */
  availability(): TransportAvailability[] {
    const chain = this.limits.fallbackChain;
    const list: TransportAvailability[] = [];
    const push = (entry: TransportAvailability): void => {
      if (!list.some((existing) => existing.transport === entry.transport)) list.push(entry);
    };
    for (const transport of chain) {
      if (transport === 'mse') {
        push({ transport, enabled: this.limits.enabled.mse, available: this.limits.enabled.mse });
      } else if (transport === 'mjpeg') {
        push({ transport, enabled: this.limits.enabled.mjpeg, available: this.limits.enabled.mjpeg });
      } else if (transport === 'webrtc') {
        const webrtc = this.options.webrtc;
        push({
          transport,
          enabled: this.limits.webrtcEnabled,
          available: this.limits.webrtcEnabled && webrtc?.available === true,
          ...(this.limits.webrtcEnabled && webrtc?.available !== true
            ? { reason: webrtc?.reason ?? 'No WebRTC media engine is registered.' }
            : {}),
        });
      } else if (transport === 'hls') {
        push({
          transport,
          enabled: this.limits.hlsEnabled,
          available: false,
          ...(this.limits.hlsEnabled ? { reason: 'The HLS segmenter is not implemented yet.' } : {}),
        });
      }
    }
    return list;
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.stop('shutdown')));
  }
}
