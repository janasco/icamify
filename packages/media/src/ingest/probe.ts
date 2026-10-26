import type { StreamSource } from '@icamify/core';
import { MediaError } from '../errors.ts';
import { buildProbeArgs } from '../ffmpeg/args.ts';
import { createToolRunner } from '../ffmpeg/locate.ts';
import type { ProbeOptions, ProbeRunResult, StreamProbe } from '../types.ts';

/**
 * ffprobe -> StreamProbe.
 *
 * Discovery results feed the UI (resolution, codec, whether a sub-stream exists)
 * and the storage planner (bitrate -> bytes per hour), so a failed probe must be
 * distinguishable from "camera has no video track".
 */

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  pix_fmt?: string;
}

interface FfprobeFormat {
  format_name?: string;
  bit_rate?: string;
  duration?: string;
}

interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

const LIVE_FORMATS = /^(rtsp|rtmp|mpegts|hls|flv|matroska,webm|mjpeg)$/i;

export async function probeStream(source: StreamSource, options: ProbeOptions): Promise<StreamProbe> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const built = buildProbeArgs(source, options);
  const runner = options.runner ?? createToolRunner(process.env);
  const result = await runner(options.ffprobePath, built.args, timeoutMs);

  if (result.spawnFailed) {
    throw new MediaError(
      'toolchain-missing',
      `Could not execute ffprobe at "${options.ffprobePath}".`,
      'Install FFmpeg (which ships ffprobe) or set ICAMIFY_FFPROBE_PATH.',
    );
  }
  if (result.code !== 0) {
    throw new MediaError(
      'probe-failed',
      `ffprobe could not read the stream (exit ${result.code}).`,
      describeFailure(result),
    );
  }

  let document: FfprobeDocument;
  try {
    document = JSON.parse(result.stdout) as FfprobeDocument;
  } catch {
    throw new MediaError('probe-failed', 'ffprobe returned output that is not valid JSON.', result.stdout.slice(0, 400));
  }

  const video = document.streams?.find((stream) => stream.codec_type === 'video');
  if (video === undefined) {
    throw new MediaError(
      'probe-failed',
      'The source responded but contains no video stream.',
      'Check that the URL/profile token points at a video channel rather than an audio or metadata profile.',
    );
  }
  const audio = document.streams?.find((stream) => stream.codec_type === 'audio');

  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new MediaError(
      'probe-failed',
      'The video stream reported no frame size.',
      'The encoder may not have started yet; retry once the camera is publishing.',
    );
  }

  const format = document.format;
  const bitrateBps = numberOrUndefined(video.bit_rate) ?? numberOrUndefined(format?.bit_rate);
  const duration = numberOrUndefined(format?.duration);
  const container = format?.format_name ?? 'unknown';

  const probe: StreamProbe = {
    container,
    videoCodec: video.codec_name ?? 'unknown',
    width,
    height,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? 0,
    live: isLiveSource(source, container),
    raw: result.stdout,
  };
  if (bitrateBps !== undefined) probe.bitrateKbps = Math.round(bitrateBps / 1000);
  if (audio?.codec_name !== undefined) probe.audioCodec = audio.codec_name;
  if (video.pix_fmt !== undefined) probe.pixelFormat = video.pix_fmt;
  if (duration !== undefined && Number.isFinite(duration)) probe.durationSeconds = duration;
  return probe;
}

function isLiveSource(source: StreamSource, container: string): boolean {
  if (source.type === 'rtsp' || source.type === 'rtmp' || source.type === 'onvif' || source.type === 'usb') return true;
  if (source.type === 'http') return true;
  return LIVE_FORMATS.test(container) && source.type !== 'file';
}

function describeFailure(result: ProbeRunResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length === 0) return 'ffprobe produced no diagnostics.';
  const lines = stderr.split('\n').slice(-6).join('\n');
  const hint = /401|403|unauthorized/i.test(stderr)
    ? '\nHint: the camera rejected the credentials — check the source `credentials` (and the ONVIF profile token).'
    : /timed out|Connection refused|No route to host/i.test(stderr)
      ? '\nHint: the camera is unreachable — verify host, port, and that RTSP is enabled on the device.'
      : '';
  return `${lines}${hint}`;
}

function parseRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const [numerator, denominator] = value.split('/');
  const top = numberOrUndefined(numerator);
  const bottom = numberOrUndefined(denominator ?? '1');
  if (top === undefined || bottom === undefined || bottom === 0) return undefined;
  const rate = top / bottom;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : undefined;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === 'N/A' || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
