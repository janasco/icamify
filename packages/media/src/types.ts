import type { CameraConfig } from '@icamify/core';
import type { SourceBuildOptions } from './ingest/source.ts';

/**
 * Media pipeline contracts.
 *
 * iCamify never decodes video in Node. It supervises FFmpeg child processes:
 * - `record` jobs use a `copy` profile and write segments directly to disk,
 * - `live` jobs transcode the sub-stream once and fan the result out to
 *   WebRTC / MSE / MJPEG consumers,
 * - `detect` jobs produce small raw frames for the motion engine.
 */

export type PipelinePurpose = 'record' | 'live' | 'detect';
export type PipelineState = 'starting' | 'running' | 'degraded' | 'offline' | 'stopped' | 'failed';

export interface StreamProbe {
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps?: number;
  audioCodec?: string;
  pixelFormat?: string;
  durationSeconds?: number;
  /** True when the source is a live stream rather than a file. */
  live: boolean;
  raw: string;
}

export interface ProbeOptions extends SourceBuildOptions {
  ffprobePath: string;
  timeoutMs?: number;
  runner?: (bin: string, args: string[], timeoutMs: number) => Promise<ProbeRunResult>;
}

export interface ProbeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
}

export interface SnapshotOptions extends SourceBuildOptions {
  ffmpegPath: string;
  maxWidth?: number;
  quality?: number;
  timeoutMs?: number;
  runner?: SnapshotRunner;
}

export type SnapshotRunner = (bin: string, args: string[], timeoutMs: number) => Promise<{
  code: number;
  stdout: Buffer;
  stderr: string;
  spawnFailed: boolean;
}>;

export interface SnapshotResult {
  jpeg: Buffer;
  warnings: string[];
}

export interface MediaEngineOptions {
  ffmpegPath: string;
  ffprobePath: string;
  hasEncoder?: (name: string) => boolean;
  ffmpegMajor?: number;
  probeTimeoutMs?: number;
  snapshotTimeoutMs?: number;
}

/** Narrow surface used by the API/timeline layers; the camera supervisor owns restarts. */
export interface MediaPipeline {
  probe(source: CameraConfig['streams']['main'], timeoutMs?: number): Promise<StreamProbe>;
  snapshot(source: CameraConfig['streams']['main'], maxWidth?: number): Promise<Buffer>;
}
