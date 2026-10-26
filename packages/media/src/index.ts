import type { CameraConfig, CameraHealthOptions, ResolvedIcamifyConfig } from '@icamify/core';
import type { ProgressFrame, SpawnFn } from './ffmpeg/process.ts';
import { probeStream } from './ingest/probe.ts';
import { IngestSupervisor, type IngestEvent } from './ingest/supervisor.ts';
import { buildPipelinePlan, type PipelinePlan, type PipelinePlanOptions } from './plan.ts';
import { captureSnapshot } from './snapshot.ts';
import type { MediaEngineOptions, MediaPipeline, PipelinePurpose, StreamProbe } from './types.ts';

export * from './types.ts';
export * from './errors.ts';
export {
  MIN_FFMPEG_MAJOR,
  createToolRunner,
  defaultToolRunner,
  describeToolchain,
  locateFfmpeg,
  parseFfmpegVersion,
  versionAtLeast,
  versionText,
  type FfmpegCapabilities,
  type FfmpegToolchain,
  type LocateOptions,
  type ParsedVersion,
  type ToolInfo,
  type ToolRunResult,
  type ToolRunner,
} from './ffmpeg/locate.ts';
export {
  baseArgs,
  buildDetectArgs,
  buildLiveArgs,
  buildProbeArgs,
  buildRecordArgs,
  buildSnapshotArgs,
  selectVideoEncoder,
  type BuildResult,
  type CommonBuildOptions,
  type DetectBuildOptions,
  type EncoderChoice,
  type LiveBuildOptions,
  type LiveOutput,
  type RecordBuildOptions,
  type SnapshotBuildOptions,
} from './ffmpeg/args.ts';
export {
  FfmpegProcess,
  ProgressParser,
  type ExitResult,
  type FfmpegProcessOptions,
  type ProgressFrame,
  type SpawnFn,
} from './ffmpeg/process.ts';
export {
  buildInputArgs,
  maskUrl,
  redactArgv,
  withCredentials,
  type SourceArgs,
  type SourceBuildOptions,
} from './ingest/source.ts';
export { probeStream } from './ingest/probe.ts';
export { IngestSupervisor, cameraHealthOptions, type IngestEvent, type IngestSupervisorOptions } from './ingest/supervisor.ts';
export { captureSnapshot, createSnapshotRunner } from './snapshot.ts';
export {
  buildPipelinePlan,
  defaultOutputTemplate,
  resolveProfileForPurpose,
  resolveRecordingsDir,
  selectSource,
  type PipelinePlan,
  type PipelinePlanOptions,
  type ResolvedProfile,
} from './plan.ts';

export const MEDIA_VERSION = '0.1.0';

export interface StartPipelineOptions extends PipelinePlanOptions {
  health?: CameraHealthOptions;
  onEvent?: (event: IngestEvent) => void;
  onProgress?: (frame: ProgressFrame) => void;
  /** Consumes the media/raw-frame stream (live and detect purposes). */
  onStdout?: (chunk: Buffer) => void;
  spawn?: SpawnFn;
  healthyAfterMs?: number;
  killGraceMs?: number;
}

/**
 * Composition root for the media layer: owns the binary paths and turns a camera
 * + purpose into a supervised FFmpeg job. Restart/backoff policy lives in
 * `IngestSupervisor`; command shaping lives in the pure builders, so neither
 * leaks into the HTTP or storage layers.
 */
export class MediaEngine implements MediaPipeline {
  readonly options: MediaEngineOptions;

  constructor(options: MediaEngineOptions) {
    this.options = options;
  }

  probe(source: CameraConfig['streams']['main'], timeoutMs?: number): Promise<StreamProbe> {
    return probeStream(source, {
      ffprobePath: this.options.ffprobePath,
      timeoutMs: timeoutMs ?? this.options.probeTimeoutMs,
    });
  }

  async snapshot(source: CameraConfig['streams']['main'], maxWidth?: number): Promise<Buffer> {
    const result = await captureSnapshot(source, {
      ffmpegPath: this.options.ffmpegPath,
      maxWidth,
      timeoutMs: this.options.snapshotTimeoutMs,
    });
    return result.jpeg;
  }

  plan(
    config: ResolvedIcamifyConfig,
    camera: CameraConfig,
    purpose: PipelinePurpose,
    options: PipelinePlanOptions = {},
  ): PipelinePlan {
    return buildPipelinePlan(config, camera, purpose, {
      ffmpegMajor: this.options.ffmpegMajor,
      hasEncoder: this.options.hasEncoder,
      ...options,
    });
  }

  /** Builds the plan and starts supervising it. Returns the live supervisor. */
  start(
    config: ResolvedIcamifyConfig,
    camera: CameraConfig,
    purpose: PipelinePurpose,
    options: StartPipelineOptions = {},
  ): IngestSupervisor {
    const supervisor = new IngestSupervisor({
      cameraId: camera.id,
      purpose,
      bin: this.options.ffmpegPath,
      health: options.health ?? camera.health,
      onEvent: options.onEvent,
      onProgress: options.onProgress,
      onStdout: options.onStdout,
      spawn: options.spawn,
      healthyAfterMs: options.healthyAfterMs,
      killGraceMs: options.killGraceMs,
      build: () => buildPipelinePlan(config, camera, purpose, { ...options, ffmpegMajor: this.options.ffmpegMajor, hasEncoder: this.options.hasEncoder }),
    });
    supervisor.start();
    return supervisor;
  }
}
