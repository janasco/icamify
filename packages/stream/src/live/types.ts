import type { CameraConfig } from '@icamify/core';

/**
 * Live-view contracts.
 *
 * A `LiveSession` owns one FFmpeg pipeline for one camera and one transport, and
 * fans its output out to every viewer. Adding a viewer therefore never adds an
 * encoder — the central performance rule of the whole design — and closing the
 * last viewer tears the pipeline down again (`streaming.onDemandStart`).
 *
 * The session never spawns FFmpeg itself: it drives a `LiveSource`, which the
 * server builds from the media engine. Tests substitute a fake source.
 */

/** Transports this package can carry. HLS and WebRTC are separate adapters. */
export type LiveTransport = 'mse' | 'mjpeg';

export interface LiveSourceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the session asked the source to stop. */
  requested: boolean;
  /** Most recent FFmpeg stderr lines, for the UI's error banner. */
  stderr?: string[];
}

export interface LiveSourceHandlers {
  onData(chunk: Buffer): void;
  onExit(exit: LiveSourceExit): void;
}

export interface LiveSource {
  /** Begins producing bytes on `handlers.onData`. Must be idempotent-safe. */
  start(handlers: LiveSourceHandlers): void;
  stop(): Promise<void>;
  /** Exact FFmpeg argv, surfaced by `/api/cameras/:id` for troubleshooting. */
  readonly argv?: readonly string[];
}

export interface LiveSourceContext {
  cameraId: string;
  transport: LiveTransport;
  camera: CameraConfig;
}

export type LiveSourceFactory = (context: LiveSourceContext) => LiveSource;

export interface ViewerStreamInfo {
  cameraId: string;
  transport: LiveTransport;
  /** e.g. `video/mp4; codecs="avc1.64001e"` or `multipart/x-mixed-replace`. */
  mimeType: string;
  codec?: string;
  width?: number;
  height?: number;
  segmentMode: 'fmp4' | 'jpeg';
}

export interface LiveViewer {
  readonly id: string;
  /** First message to a viewer: media type plus the init segment (empty for MJPEG). */
  sendInit(info: ViewerStreamInfo, initSegment: Buffer): void;
  sendSegment(data: Buffer): void;
  sendError(message: string, code?: string): void;
  close(reason: string): void;
  /** Socket/socket-like queue depth; used to drop slow consumers. */
  bufferedBytes(): number;
}

export type LiveSessionEvent =
  | { type: 'started'; cameraId: string; transport: LiveTransport; argv: readonly string[] }
  | {
      type: 'init';
      cameraId: string;
      transport: LiveTransport;
      codec?: string;
      width?: number;
      height?: number;
    }
  | { type: 'viewers'; cameraId: string; transport: LiveTransport; viewers: number }
  | { type: 'source-exited'; cameraId: string; transport: LiveTransport; reason: string; willRestart: boolean }
  | { type: 'error'; cameraId: string; transport: LiveTransport; message: string }
  | { type: 'stopped'; cameraId: string; transport: LiveTransport; reason: string };

export type LiveSessionState = 'idle' | 'running' | 'restarting' | 'closed';

export interface LiveSessionStats {
  cameraId: string;
  transport: LiveTransport;
  state: LiveSessionState;
  viewers: number;
  startedAt?: number;
  fragments: number;
  bytes: number;
  restarts: number;
  codec?: string;
  width?: number;
  height?: number;
  lastError?: string;
}

export type AddViewerResult = 'added' | 'viewer-limit' | 'closed';
