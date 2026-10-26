import type { LiveTransport } from './types.ts';
import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';

/** Reads the stream settings that govern live view, with the schema defaults. */

export interface LiveLimits {
  enabled: Record<LiveTransport, boolean>;
  hlsEnabled: boolean;
  webrtcEnabled: boolean;
  fallbackChain: string[];
  maxSessions: number;
  maxViewersPerCamera: number;
  idleTimeoutMs: number;
  windowSegments: number;
  segmentDurationMs: number;
  mjpeg: { fps: number; width: number; quality: number; enabled: boolean };
  onDemandStart: boolean;
  fallbackAfterMs: number;
}

export function liveLimits(config: Pick<ResolvedIcamifyConfig, 'streaming'>): LiveLimits {
  const streaming = config.streaming ?? {};
  const mjpeg = streaming.mjpeg ?? {};
  return {
    enabled: {
      mse: streaming.mse?.enabled !== false,
      mjpeg: mjpeg.enabled !== false,
    },
    hlsEnabled: streaming.hls?.enabled === true,
    webrtcEnabled: streaming.webrtc?.enabled !== false,
    fallbackChain: streaming.fallbackChain ?? ['webrtc', 'mse', 'mjpeg'],
    maxSessions: streaming.maxConcurrentSessions ?? 32,
    maxViewersPerCamera: streaming.webrtc?.maxViewersPerCamera ?? 8,
    idleTimeoutMs: (streaming.sessionIdleTimeoutSeconds ?? 60) * 1000,
    windowSegments: Math.max(0, streaming.mse?.windowSegments ?? 8),
    segmentDurationMs: streaming.mse?.segmentDurationMs ?? 1000,
    mjpeg: {
      // FFmpeg's -q:v scale is 2 (best) … 31 (worst); config speaks 1…100 quality.
      quality: qualityToQScale(mjpeg.quality ?? 70),
      width: mjpeg.width ?? 640,
      fps: mjpeg.fps ?? 5,
      enabled: mjpeg.enabled !== false,
    },
    onDemandStart: streaming.onDemandStart !== false,
    fallbackAfterMs: streaming.webrtc?.fallbackAfterMs ?? 4000,
  };
}

export function qualityToQScale(quality: number): number {
  const clamped = Math.min(100, Math.max(1, quality));
  return Math.max(2, Math.min(31, Math.round(31 - (clamped / 100) * 29)));
}

export function cameraEnabled(camera: CameraConfig | undefined): boolean {
  return camera !== undefined && camera.enabled !== false;
}

/** True when the camera has a sub-stream; the live view always prefers it. */
export function hasSubStream(camera: CameraConfig): boolean {
  return camera.streams.sub !== undefined;
}
