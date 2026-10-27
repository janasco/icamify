import { isAbsolute, join } from 'node:path';
import type { CameraConfig, ResolvedIcamifyConfig, StreamProfile, StreamSource } from '@icamify/core';
import {
  buildDetectArgs,
  buildLiveArgs,
  buildRecordArgs,
  type BuildResult,
  type LiveOutput,
  type RtpEgressOptions,
} from './ffmpeg/args.ts';
import { MediaError } from './errors.ts';
import type { PipelinePurpose } from './types.ts';

/**
 * Turns configuration into a concrete FFmpeg command.
 *
 * This is where the "dual-stream" rule lives: recording reads the main stream for
 * full resolution, while live view and motion detection read the sub-stream so a
 * 4K camera does not spend its CPU budget on a 320x240 analysis frame.
 */

export interface ResolvedProfile {
  name: string;
  profile: StreamProfile;
}

export function resolveProfileForPurpose(
  config: Pick<ResolvedIcamifyConfig, 'streaming'>,
  camera: CameraConfig,
  purpose: PipelinePurpose,
): ResolvedProfile {
  // `recording.profile` is the recording-specific override; `profiles.record` is
  // the camera-wide one. Both beat the global default so an operator who tunes
  // "record" on the recording block gets what they asked for.
  const explicit =
    purpose === 'record'
      ? (camera.recording?.profile ?? camera.profiles?.record)
      : camera.profiles?.[purpose];
  const fallback = config.streaming.defaults?.[purpose];
  const name = explicit ?? fallback;
  if (name === undefined) {
    throw new MediaError(
      'invalid-argument',
      `Camera "${camera.id}" has no ${purpose} profile and streaming.defaults.${purpose} is not set.`,
      'Set cameras[].profiles.' + purpose + ' or streaming.defaults.' + purpose + '.',
    );
  }
  const profile = config.streaming.profiles?.[name];
  if (profile === undefined) {
    throw new MediaError(
      'invalid-argument',
      `Camera "${camera.id}" references stream profile "${name}", which is not defined.`,
      `Defined profiles: ${Object.keys(config.streaming.profiles ?? {}).join(', ') || 'none'}.`,
    );
  }
  return { name, profile };
}

/** Recording uses the main stream; live/detect prefer the cheap sub-stream. */
export function selectSource(camera: CameraConfig, purpose: PipelinePurpose): StreamSource {
  if (purpose === 'record') return camera.streams.main;
  return camera.streams.sub ?? camera.streams.main;
}

export interface PipelinePlanOptions {
  /** strftime template for recording; defaults to the storage layout. */
  outputTemplate?: string;
  /** Motion analysis frame size and colour mode (ignored for live/record). */
  detect?: { width: number; height: number; fps: number; grayscale?: boolean };
  ffmpegMajor?: number;
  hasEncoder?: (name: string) => boolean;
  segmentSeconds?: number;
  maxFileSizeMb?: number;
  includeAudio?: boolean;
  liveOutput?: LiveOutput;
  /** Set together with `liveOutput: 'rtp'`; the WebRTC engine owns the socket. */
  rtp?: RtpEgressOptions;
  /** Fragment duration for MSE (streaming.mse.segmentDurationMs). */
  segmentDurationMs?: number;
  /** MJPEG fallback geometry, cadence and quality (ignored for fMP4). */
  liveWidth?: number;
  liveHeight?: number;
  liveFps?: number;
  mjpegQuality?: number;
  resolvedStreamUri?: string;
}

export interface PipelinePlan {
  cameraId: string;
  purpose: PipelinePurpose;
  profileName: string;
  sourceType: StreamSource['type'];
  args: string[];
  warnings: string[];
}

export function buildPipelinePlan(
  config: ResolvedIcamifyConfig,
  camera: CameraConfig,
  purpose: PipelinePurpose,
  options: PipelinePlanOptions = {},
): PipelinePlan {
  const { name, profile } = resolveProfileForPurpose(config, camera, purpose);
  const source = selectSource(camera, purpose);
  const common = {
    source,
    profile,
    ffmpegMajor: options.ffmpegMajor,
    hasEncoder: options.hasEncoder,
    resolvedUri: options.resolvedStreamUri,
  };

  let built: BuildResult;
  switch (purpose) {
    case 'record': {
      const segmentMinutes = camera.recording?.segmentMinutes ?? config.storage.segmentMinutes ?? 60;
      built = buildRecordArgs({
        ...common,
        outputTemplate: options.outputTemplate ?? defaultOutputTemplate(config, camera, profile),
        segmentSeconds: options.segmentSeconds ?? segmentMinutes * 60,
        maxFileSizeMb: options.maxFileSizeMb ?? camera.recording?.maxFileSizeMb,
        includeAudio: options.includeAudio ?? camera.recording?.audio,
      });
      if (profile.copy !== true && profile.video.codec !== 'copy') {
        // Not fatal, but this is where CPU cost multiplies without being obvious
        // in the UI: one decoder plus one encoder per camera.
        built.warnings.unshift(
          `Recording profile "${name}" re-encodes (${profile.video.codec}); the direct-to-disk path requires a copy profile.`,
        );
      }
      break;
    }
    case 'live':
      built = buildLiveArgs({
        ...common,
        output: options.liveOutput ?? 'fmp4',
        fps: options.liveFps ?? profile.video.fps,
        ...(options.segmentDurationMs === undefined ? {} : { segmentDurationMs: options.segmentDurationMs }),
        ...(options.liveWidth === undefined ? {} : { width: options.liveWidth }),
        ...(options.liveHeight === undefined ? {} : { height: options.liveHeight }),
        ...(options.mjpegQuality === undefined ? {} : { mjpegQuality: options.mjpegQuality }),
        ...(options.rtp === undefined ? {} : { rtp: options.rtp }),
      });
      break;
    case 'detect':
      built = buildDetectArgs({
        ...common,
        // The camera may override the global analysis cadence, but the global
        // setting has to be honoured rather than replaced by a hard-coded one.
        fps:
          options.detect?.fps ??
          Math.max(1, Math.round(1000 / (camera.motion?.intervalMs ?? config.motion.intervalMs ?? 500))),
        width: options.detect?.width ?? 320,
        height: options.detect?.height ?? 240,
        ...(options.detect?.grayscale === undefined ? {} : { grayscale: options.detect.grayscale }),
      });
      break;
  }

  return {
    cameraId: camera.id,
    purpose,
    profileName: name,
    sourceType: source.type,
    args: built.args,
    warnings: built.warnings,
  };
}

/**
 * Which volume a camera records to.
 *
 * The order is explicit assignment → configured default → the highest-priority
 * volume that accepts any camera. The last rule matters: without it, a single
 * configured volume (or several left unassigned) would silently record into the
 * generic recordings directory under the volume id `default`, and retention would
 * never see those files even though the configuration claims a quota. Validation
 * already rejects a camera no volume accepts, so the fallback is unreachable for a
 * config that started.
 */
export function selectStorageVolume(
  storage: ResolvedIcamifyConfig['storage'],
  cameraId?: string,
): NonNullable<ResolvedIcamifyConfig['storage']['volumes']>[number] | undefined {
  const volumes = storage.volumes ?? [];
  if (volumes.length === 0) return undefined;
  const byPriority = (left: { priority?: number }, right: { priority?: number }): number =>
    (left.priority ?? 100) - (right.priority ?? 100);

  const assigned = volumes
    .filter((volume) => cameraId !== undefined && (volume.cameraIds ?? []).includes(cameraId))
    .sort(byPriority)[0];
  if (assigned !== undefined) return assigned;

  const explicitDefault = volumes.find((volume) => volume.id === storage.defaultVolume);
  if (explicitDefault !== undefined) return explicitDefault;

  return volumes.filter((volume) => (volume.cameraIds ?? []).length === 0).sort(byPriority)[0];
}

/**
 * Storage directories are relative to `storage.rootDir` unless absolute, which is
 * how the schema defaults are written (`rootDir: ./data`, `recordingsDir: recordings`).
 *
 * The generic recordings directory is only used when no volume can own the camera.
 */
export function resolveRecordingsDir(
  storage: ResolvedIcamifyConfig['storage'],
  cameraId?: string,
): string {
  const root = storage.rootDir ?? './data';
  const dir = selectStorageVolume(storage, cameraId)?.path ?? storage.recordingsDir ?? 'recordings';
  return isAbsolute(dir) ? dir : join(root, dir);
}

export function defaultOutputTemplate(
  config: Pick<ResolvedIcamifyConfig, 'storage'>,
  camera: CameraConfig,
  profile: StreamProfile,
): string {
  const container = profile.container ?? config.storage.format ?? 'mkv';
  const ext = container === 'mpegts' ? 'ts' : container;
  return join(resolveRecordingsDir(config.storage, camera.id), camera.id, `%Y%m%d-%H%M%S.${ext}`);
}
