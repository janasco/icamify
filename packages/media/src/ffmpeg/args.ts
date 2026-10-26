import type { StreamProfile, StreamSource } from '@icamify/core';
import { MediaError } from '../errors.ts';
import { buildInputArgs, type SourceBuildOptions } from '../ingest/source.ts';

/**
 * Pure FFmpeg argv builders.
 *
 * Nothing here spawns a process: each builder returns the exact argv, so the
 * command can be unit-tested and shown to the operator (`icamify ingest
 * --dry-run`) before anything touches a camera. Builders never use a shell, so
 * camera names, paths and URLs with spaces are safe.
 */

export type LogLevel = 'error' | 'warning' | 'info';

export interface BuildResult {
  args: string[];
  warnings: string[];
}

export interface CommonBuildOptions extends SourceBuildOptions {
  logLevel?: LogLevel;
  /**
   * Emit machine-readable progress on stdout (`-progress pipe:1`) instead of the
   * human status line. Required for segment accounting and the storage manager.
   */
  progress?: boolean;
  /** FFmpeg major version, used to pick `-fps_mode` (5+) over `-vsync`. */
  ffmpegMajor?: number;
  hasEncoder?: (name: string) => boolean;
}

const DEFAULT_FFMPEG_MAJOR = 6;

export function baseArgs(options: CommonBuildOptions): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', options.logLevel ?? 'error'];
  if (options.progress === true) {
    args.push('-nostats', '-progress', 'pipe:1');
  }
  return args;
}

/** Inserts global codec options (only VAAPI needs one) ahead of the input. */
function withGlobal(options: CommonBuildOptions, global: string[], input: string[]): string[] {
  return [...baseArgs(options), ...global, ...input];
}

// ---------------------------------------------------------------------------
// Encoder selection
// ---------------------------------------------------------------------------

type EncoderFamily = 'x264' | 'x265' | 'nvenc' | 'qsv' | 'vaapi' | 'videotoolbox' | 'vpx' | 'svtav1' | 'mjpeg';

export interface EncoderChoice {
  encoder: string;
  family: EncoderFamily;
  /** Global options that must appear before `-i` (VAAPI device selection). */
  global: string[];
  /** Filters that must be appended to the filter chain, in order. */
  filters: string[];
  warnings: string[];
}

const NVENC_PRESETS: Record<NonNullable<StreamProfile['video']['preset']>, string> = {
  ultrafast: 'p1',
  superfast: 'p2',
  veryfast: 'p3',
  faster: 'p4',
  fast: 'p5',
  medium: 'p6',
  slow: 'p7',
};

const VAAPI_DEVICE = '/dev/dri/renderD128';

/**
 * Chooses an encoder for a profile, honouring `hardwareAcceleration` when the
 * build actually provides it and degrading to the software encoder with a
 * warning instead of failing the camera.
 */
export function selectVideoEncoder(
  video: StreamProfile['video'],
  hasEncoder?: (name: string) => boolean,
): EncoderChoice {
  const available = (name: string): boolean => (hasEncoder ? hasEncoder(name) : true);
  const warnings: string[] = [];
  const hw = video.hardwareAcceleration ?? 'none';

  const candidates: Array<{ name: string; family: EncoderFamily; hw: boolean }> = [];
  switch (video.codec) {
    case 'h264':
      candidates.push({ name: 'libx264', family: 'x264', hw: false });
      candidates.push({ name: 'h264_nvenc', family: 'nvenc', hw: true });
      candidates.push({ name: 'h264_qsv', family: 'qsv', hw: true });
      candidates.push({ name: 'h264_vaapi', family: 'vaapi', hw: true });
      candidates.push({ name: 'h264_videotoolbox', family: 'videotoolbox', hw: true });
      break;
    case 'h265':
      candidates.push({ name: 'libx265', family: 'x265', hw: false });
      candidates.push({ name: 'hevc_nvenc', family: 'nvenc', hw: true });
      candidates.push({ name: 'hevc_qsv', family: 'qsv', hw: true });
      candidates.push({ name: 'hevc_vaapi', family: 'vaapi', hw: true });
      candidates.push({ name: 'hevc_videotoolbox', family: 'videotoolbox', hw: true });
      break;
    case 'vp8':
      candidates.push({ name: 'libvpx', family: 'vpx', hw: false });
      break;
    case 'vp9':
      candidates.push({ name: 'libvpx-vp9', family: 'vpx', hw: false });
      break;
    case 'av1':
      candidates.push({ name: 'libsvtav1', family: 'svtav1', hw: false });
      break;
    case 'mjpeg':
      candidates.push({ name: 'mjpeg', family: 'mjpeg', hw: false });
      break;
    case 'copy':
      throw new MediaError(
        'invalid-argument',
        'A "copy" video codec cannot be used where re-encoding is required (live/detect).',
        'Use the copy profile for recording only; give live/detect profiles a real codec.',
      );
  }

  const preferred = preferredFamily(hw);
  const ordered =
    preferred === undefined
      ? candidates
      : [...candidates.filter((c) => c.family === preferred), ...candidates.filter((c) => c.family !== preferred)];

  const chosen = ordered.find((c) => available(c.name));
  if (chosen === undefined) {
    throw new MediaError(
      'toolchain-unsupported',
      `No FFmpeg encoder is available for ${video.codec} (tried ${candidates.map((c) => c.name).join(', ')}).`,
      'Install an FFmpeg build with the matching encoder, or change the profile codec.',
    );
  }
  if (hw !== 'none' && hw !== 'auto' && !chosen.hw) {
    warnings.push(
      `hardwareAcceleration "${hw}" was requested but ${chosen.name} is not present in this FFmpeg build; falling back to the software encoder.`,
    );
  }
  if (hw === 'vaapi' && chosen.family === 'vaapi' && process.platform !== 'linux') {
    warnings.push('VAAPI encoding is Linux-only; this profile will fail on other platforms.');
  }

  switch (chosen.family) {
    case 'vaapi':
      return {
        encoder: chosen.name,
        family: chosen.family,
        global: ['-vaapi_device', VAAPI_DEVICE],
        filters: ['format=nv12', 'hwupload'],
        warnings,
      };
    default:
      return { encoder: chosen.name, family: chosen.family, global: [], filters: [], warnings };
  }
}

function preferredFamily(hw: NonNullable<StreamProfile['video']['hardwareAcceleration']>): EncoderFamily | undefined {
  switch (hw) {
    case 'nvenc':
      return 'nvenc';
    case 'qsv':
      return 'qsv';
    case 'vaapi':
      return 'vaapi';
    case 'videotoolbox':
      return 'videotoolbox';
    default:
      return undefined;
  }
}

interface VideoArgOptions {
  /** `live` trades quality for latency (`-tune zerolatency`). */
  lowLatency?: boolean;
  fps?: number;
}

/** Encoder-specific output flags for a chosen profile. */
function videoCodecArgs(
  video: StreamProfile['video'],
  choice: EncoderChoice,
  options: VideoArgOptions = {},
): string[] {
  const args = ['-c:v', choice.encoder];

  if (video.bitrateKbps !== undefined) args.push('-b:v', `${video.bitrateKbps}k`);
  if (video.maxBitrateKbps !== undefined) {
    args.push('-maxrate', `${video.maxBitrateKbps}k`, '-bufsize', `${video.maxBitrateKbps * 2}k`);
  }

  switch (choice.family) {
    case 'x264':
    case 'x265':
      if (video.preset !== undefined) args.push('-preset', video.preset);
      if (video.profile !== undefined) args.push('-profile:v', video.profile);
      if (options.lowLatency === true) args.push('-tune', 'zerolatency');
      if (video.pixelFormat !== undefined) args.push('-pix_fmt', video.pixelFormat);
      break;
    case 'nvenc':
      args.push('-preset', NVENC_PRESETS[video.preset ?? 'medium']);
      args.push('-rc', video.maxBitrateKbps !== undefined ? 'vbr' : 'cbr');
      if (video.pixelFormat !== undefined) args.push('-pix_fmt', video.pixelFormat);
      break;
    case 'vaapi':
      // VAAPI surfaces are already NV12; -pix_fmt must not be forced.
      break;
    default:
      if (video.pixelFormat !== undefined) args.push('-pix_fmt', video.pixelFormat);
      break;
  }

  if (video.bframes !== undefined) args.push('-bf', String(video.bframes));

  const gop = gopFrames(video, options.fps);
  if (gop !== undefined) {
    if (choice.family === 'nvenc') {
      args.push('-g', String(gop), '-no-scenecut', '1');
    } else if (choice.family === 'x264' || choice.family === 'x265') {
      // A fixed keyframe interval keeps MSE/WebRTC segment boundaries predictable
      // and gives the pre-buffer fallback a clean place to cut.
      args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    } else {
      args.push('-g', String(gop));
    }
  }

  return args;
}

function gopFrames(video: StreamProfile['video'], fps: number | undefined): number | undefined {
  if (video.gopSeconds === undefined) return undefined;
  const rate = fps ?? video.fps ?? 25;
  return Math.max(1, Math.round(video.gopSeconds * rate));
}

function audioCodecArgs(
  audio: StreamProfile['audio'] | undefined,
  copy: boolean,
  include: boolean,
): string[] {
  if (!include) return ['-an'];
  if (copy) return ['-c:a', 'copy'];
  if (audio?.codec === 'none') return ['-an'];
  const args: string[] = [];
  switch (audio?.codec) {
    case 'opus':
      args.push('-c:a', 'libopus');
      break;
    case 'aac':
    default:
      args.push('-c:a', 'aac');
      break;
  }
  if (audio?.bitrateKbps !== undefined) args.push('-b:a', `${audio.bitrateKbps}k`);
  if (audio?.sampleRate !== undefined) args.push('-ar', String(audio.sampleRate));
  if (audio?.channels !== undefined) args.push('-ac', String(audio.channels));
  return args;
}

// ---------------------------------------------------------------------------
// Recording (direct-to-disk)
// ---------------------------------------------------------------------------

export interface RecordBuildOptions extends CommonBuildOptions {
  source: StreamSource;
  profile: StreamProfile;
  /** strftime template; `%Y%m%d-%H%M%S` yields one file per segment boundary. */
  outputTemplate: string;
  segmentSeconds?: number;
  maxFileSizeMb?: number;
  includeAudio?: boolean;
}

const MUXER_BY_CONTAINER: Record<NonNullable<StreamProfile['container']>, string> = {
  mkv: 'matroska',
  mp4: 'mp4',
  fmp4: 'mp4',
  webm: 'webm',
  mpegts: 'mpegts',
};

/**
 * Builds a recording command. With a `copy` profile this is a pure remux: FFmpeg
 * reads the compressed packets straight to disk, which is the 0%-CPU path the
 * "Recording Stream" requirement depends on.
 */
export function buildRecordArgs(options: RecordBuildOptions): BuildResult {
  const { profile, outputTemplate } = options;
  const warnings: string[] = [];
  const copy = profile.copy === true || profile.video.codec === 'copy';
  const container = profile.container ?? containerFromTemplate(outputTemplate);
  const includeAudio = options.includeAudio ?? profile.audio?.codec !== 'none';
  const input = buildInputArgs(options.source, options);

  if (copy && container === 'mp4') {
    warnings.push(
      'Recording MP4 with a copy profile loses the file if FFmpeg is killed before it writes the moov atom; prefer MKV or MPEG-TS for direct-to-disk.',
    );
  }
  if (copy && profile.video.rotation !== undefined && profile.video.rotation !== 0) {
    warnings.push('Rotation requires re-encoding and is ignored for copy profiles; set rotation on the live profile instead.');
  }

  const args = withGlobal(options, [], input.args);
  args.push('-map', '0:v:0');
  if (includeAudio) args.push('-map', '0:a:0?');

  if (copy) {
    args.push('-c:v', 'copy');
  } else {
    const choice = selectVideoEncoder(profile.video, options.hasEncoder);
    warnings.push(...choice.warnings);
    args.push(...choice.global, ...videoCodecArgs(profile.video, choice, { fps: profile.video.fps }));
  }
  args.push(...audioCodecArgs(profile.audio, copy, includeAudio));

  // Keep segment timestamps starting near zero so the timeline can place files
  // without knowing when the source clock was rebooted.
  args.push('-avoid_negative_ts', 'make_zero');
  args.push('-flush_packets', '1');

  const muxer = MUXER_BY_CONTAINER[container];
  const segmentSeconds = options.segmentSeconds ?? 60;
  const segmenting = segmentSeconds > 0;

  if (segmenting) {
    args.push(
      '-f',
      'segment',
      '-segment_format',
      muxer,
      '-segment_time',
      String(segmentSeconds),
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
    );
  } else {
    args.push('-f', muxer);
  }

  if (options.maxFileSizeMb !== undefined && !segmenting) {
    args.push('-fs', String(Math.round(options.maxFileSizeMb * 1024 * 1024)));
  } else if (options.maxFileSizeMb !== undefined) {
    warnings.push(
      'maxFileSizeMb has no effect while segmenting by duration; the segment boundary is the file boundary. Use a shorter segmentMinutes to cap file size.',
    );
  }

  args.push(outputTemplate);
  return { args, warnings };
}

function containerFromTemplate(template: string): NonNullable<StreamProfile['container']> {
  const match = /\.([a-z0-9]+)$/i.exec(template);
  const ext = match?.[1]?.toLowerCase();
  switch (ext) {
    case 'mkv':
      return 'mkv';
    case 'mp4':
      return 'mp4';
    case 'ts':
      return 'mpegts';
    case 'webm':
      return 'webm';
    default:
      return 'mkv';
  }
}

// ---------------------------------------------------------------------------
// Live streaming
// ---------------------------------------------------------------------------

export type LiveOutput = 'fmp4' | 'mpegts' | 'mjpeg';

export interface LiveBuildOptions extends CommonBuildOptions {
  source: StreamSource;
  profile: StreamProfile;
  output?: LiveOutput;
  /** Fragment size for MSE/WebRTC delivery. */
  segmentDurationMs?: number;
  fps?: number;
  includeAudio?: boolean;
  width?: number;
  height?: number;
  /** JPEG quality for the MJPEG fallback (2 best … 31 worst). */
  mjpegQuality?: number;
}

/**
 * Builds the live-view command. One process per camera serves every viewer:
 * `pipe:1` is fragmented MP4 (WebRTC/MSE) or an MJPEG stream that the HTTP layer
 * fans out, so adding a viewer never adds an encoder.
 */
export function buildLiveArgs(options: LiveBuildOptions): BuildResult {
  const { profile } = options;
  const output = options.output ?? 'fmp4';
  const warnings: string[] = [];
  const input = buildInputArgs(options.source, options);
  const fps = options.fps ?? profile.video.fps;

  if (output === 'mjpeg') {
    const args = withGlobal(options, [], input.args);
    args.push('-map', '0:v:0', '-an', '-sn');
    const filters: string[] = [];
    if (fps !== undefined) filters.push(`fps=${fps}`);
    const size = targetSize(options.width ?? profile.video.width, options.height ?? profile.video.height);
    if (size !== undefined) filters.push(`scale=${size}`);
    if (filters.length > 0) args.push('-vf', filters.join(','));
    args.push('-c:v', 'mjpeg', '-q:v', String(options.mjpegQuality ?? 5), '-f', 'mjpeg', 'pipe:1');
    return { args, warnings };
  }

  const choice = selectVideoEncoder(profile.video, options.hasEncoder);
  warnings.push(...choice.warnings);

  const args = withGlobal(options, choice.global, input.args);
  args.push('-map', '0:v:0');
  if (options.includeAudio === true) args.push('-map', '0:a:0?');

  const filters: string[] = [];
  const size = targetSize(options.width ?? profile.video.width, options.height ?? profile.video.height);
  if (size !== undefined) filters.push(`scale=${size}`);
  if (profile.video.rotation !== undefined && profile.video.rotation !== 0) {
    filters.push(transposeFilter(profile.video.rotation));
  }
  filters.push(...choice.filters);
  if (filters.length > 0) args.push('-vf', filters.join(','));

  args.push(...videoCodecArgs(profile.video, choice, { lowLatency: profile.latency !== 'quality', fps }));
  args.push(...audioCodecArgs(profile.audio, false, options.includeAudio === true));

  if (output === 'mpegts') {
    args.push('-f', 'mpegts', 'pipe:1');
    return { args, warnings };
  }

  // Fragmented MP4: one fragment per keyframe plus a duration cap, so a browser
  // can start decoding after the first fragment instead of waiting for a moov.
  const fragDurationUs = Math.round((options.segmentDurationMs ?? 1000) * 1000);
  args.push(
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    '-frag_duration',
    String(fragDurationUs),
    '-flush_packets',
    '1',
    '-f',
    'mp4',
    'pipe:1',
  );
  return { args, warnings };
}

function targetSize(width: number | undefined, height: number | undefined): string | undefined {
  if (width !== undefined && height !== undefined) return `${width}:${height}`;
  if (width !== undefined) return `${width}:-2`;
  if (height !== undefined) return `-2:${height}`;
  return undefined;
}

function transposeFilter(rotation: NonNullable<StreamProfile['video']['rotation']>): string {
  switch (rotation) {
    case 90:
      return 'transpose=1';
    case 180:
      return 'transpose=1,transpose=1';
    case 270:
      return 'transpose=2';
    default:
      return 'null';
  }
}

// ---------------------------------------------------------------------------
// Motion detection frames
// ---------------------------------------------------------------------------

export interface DetectBuildOptions extends CommonBuildOptions {
  source: StreamSource;
  /** Frames per second the motion engine will analyse. */
  fps: number;
  /** Analysis resolution; motion runs on a downscaled frame, never full-res. */
  width: number;
  height: number;
  /** `gray` halves the data and is what the differencing matrix expects. */
  grayscale?: boolean;
}

/**
 * Raw frames on stdout for the motion engine. One `rawvideo` frame is exactly
 * `width * height * channels` bytes, which keeps the reader trivially parsable
 * compared with decoding JPEG or a container in Node.
 */
export function buildDetectArgs(options: DetectBuildOptions): BuildResult {
  const input = buildInputArgs(options.source, options);
  const gray = options.grayscale !== false;
  const args = withGlobal(options, [], input.args);
  args.push(
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-vf',
    `fps=${options.fps},scale=${options.width}:${options.height},format=${gray ? 'gray' : 'rgb24'}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    gray ? 'gray' : 'rgb24',
    'pipe:1',
  );
  return { args, warnings: input.warnings };
}

// ---------------------------------------------------------------------------
// Snapshots and probing
// ---------------------------------------------------------------------------

export interface SnapshotBuildOptions extends CommonBuildOptions {
  source: StreamSource;
  maxWidth?: number;
  quality?: number;
}

/** Single JPEG on stdout, taken from the recording (high-resolution) stream. */
export function buildSnapshotArgs(options: SnapshotBuildOptions): BuildResult {
  const input = buildInputArgs(options.source, options);
  const args = withGlobal(options, [], input.args);
  const filters: string[] = [];
  if (options.maxWidth !== undefined) filters.push(`scale=${options.maxWidth}:-2`);
  args.push('-frames:v', '1', '-an', '-sn');
  if (filters.length > 0) args.push('-vf', filters.join(','));
  args.push('-q:v', String(options.quality ?? 3), '-f', 'mjpeg', 'pipe:1');
  return { args, warnings: input.warnings };
}

/** ffprobe argv (different binary, same source mapping). */
export function buildProbeArgs(source: StreamSource, options: SourceBuildOptions = {}): BuildResult {
  const input = buildInputArgs(source, options);
  return {
    args: [
      '-hide_banner',
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      '-i',
      input.target,
    ],
    warnings: input.warnings,
  };
}
