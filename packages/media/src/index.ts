import type { CameraConfig, StreamProfile, StreamSource } from '@icamify/core';

/**
 * Media pipeline contracts (Phase 1).
 *
 * iCamify never decodes video in Node. It supervises FFmpeg child processes:
 * - `record` jobs use a `copy` profile and write MPEG-TS/MKV segments directly,
 * - `live` jobs transcode the sub-stream once and fan the result out to
 *   WebRTC / MSE / MJPEG consumers,
 * - `detect` jobs produce small raw frames for the motion engine.
 */

export type PipelinePurpose = 'record' | 'live' | 'detect';
export type PipelineState = 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';

export interface StreamProbe {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps?: number;
  audioCodec?: string;
  raw: string;
}

export interface IngestOptions {
  cameraId: string;
  source: StreamSource;
  profile: StreamProfile;
  purpose: PipelinePurpose;
  /** Where a record job writes its segment (resolved by @icamify/storage). */
  outputPath?: string;
}

export interface IngestHandle {
  readonly cameraId: string;
  readonly purpose: PipelinePurpose;
  /** FFmpeg process id, for diagnostics and process-tree cleanup. */
  readonly pid?: number;
  state(): PipelineState;
  /** Resolves once FFmpeg has exited and buffers are flushed. */
  stop(): Promise<void>;
}

export interface MediaPipeline {
  probe(source: StreamSource, timeoutMs?: number): Promise<StreamProbe>;
  start(options: IngestOptions): Promise<IngestHandle>;
  /** Grabs a JPEG from the recording stream on demand. */
  snapshot(camera: CameraConfig, maxWidth?: number): Promise<Buffer>;
}

/**
 * Rolling in-memory GOP cache used to replay pre-roll into motion clips.
 * Implementations must keep whole keyframe-to-keyframe groups so the concatenated
 * output stays decodable.
 */
export interface PreBuffer {
  push(chunk: Uint8Array): void;
  /** Yields buffered chunks covering the last `seconds`. */
  drain(seconds: number): AsyncIterable<Uint8Array>;
  bytes(): number;
  clear(): void;
}
