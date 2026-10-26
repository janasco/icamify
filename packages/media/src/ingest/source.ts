import type { Credentials, StreamSource } from '@icamify/core';
import { MediaError } from '../errors.ts';

/**
 * StreamSource -> FFmpeg input args.
 *
 * Every source type needs a different set of demuxer/protocol flags to behave
 * well on a long-lived NVR loop: RTSP wants TCP because UDP loss corrupts
 * keyframes, HTTP/RTMP need reconnect logic or the pipeline dies on the first
 * Wi-Fi hiccup, and USB capture needs an explicit format and resolution. Keeping
 * that knowledge in one pure function makes it testable without a camera.
 */

export interface SourceBuildOptions {
  /** RTSP URI resolved by @icamify/onvif for `onvif` sources. */
  resolvedUri?: string;
  /** Fallback socket timeout when the source does not specify one. */
  defaultTimeoutSeconds?: number;
}

export interface SourceArgs {
  args: string[];
  warnings: string[];
  /** URL/device with credentials applied, for probing or display (may contain secrets). */
  target: string;
}

const DEFAULT_TIMEOUT_SECONDS = 10;

export function buildInputArgs(source: StreamSource, options: SourceBuildOptions = {}): SourceArgs {
  const timeoutSeconds = sourceTimeout(source) ?? options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutUs = Math.max(1, Math.round(timeoutSeconds * 1_000_000));

  switch (source.type) {
    case 'rtsp': {
      assertScheme(source.url, 'rtsp');
      const target = withCredentials(source.url, source.credentials);
      const transport = source.transport === 'udp' ? 'udp' : 'tcp';
      return {
        args: ['-rtsp_transport', transport, '-timeout', String(timeoutUs), '-i', target],
        warnings:
          transport === 'udp'
            ? ['UDP RTSP transport is configured: packet loss will produce corrupt keyframes and unreliable motion detection.']
            : [],
        target,
      };
    }

    case 'rtmp': {
      const target = withCredentials(source.url, credentialsOf(source));
      const args = ['-rw_timeout', String(timeoutUs)];
      if (source.live !== false) args.push('-rtmp_live', 'live');
      args.push('-i', target);
      return { args, warnings: [], target };
    }

    case 'http': {
      const target = withCredentials(source.url, source.credentials);
      const args = [
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
        '-rw_timeout',
        String(timeoutUs),
      ];
      if (source.auth === 'basic' || source.auth === 'digest') {
        args.push('-auth_type', source.auth);
      }
      const format = httpFormat(source.format);
      if (format !== undefined) args.push('-f', format);
      args.push('-i', target);
      return {
        args,
        warnings:
          source.format === 'mjpeg'
            ? ['MJPEG sources are re-encoded for recording; the 0%-CPU direct-to-disk path requires an H.264/H.265 stream.']
            : [],
        target,
      };
    }

    case 'onvif': {
      const uri = source.streamUriOverride ?? options.resolvedUri;
      if (uri === undefined || uri.length === 0) {
        throw new MediaError(
          'unsupported-source',
          `Camera source is ONVIF but no stream URI has been resolved yet (device ${source.host}).`,
          'ONVIF devices must be queried with GetStreamUri before ingest can start; run `icamify onvif discover` or set streams.main.streamUriOverride.',
        );
      }
      assertScheme(uri, 'rtsp');
      const target = withCredentials(uri, source.credentials);
      return {
        args: ['-rtsp_transport', 'tcp', '-timeout', String(timeoutUs), '-i', target],
        warnings: [],
        target,
      };
    }

    case 'usb':
      return buildUsbInput(source);

    case 'file': {
      const args: string[] = [];
      if (source.realtime !== false) args.push('-re');
      if (source.loop === true) args.push('-stream_loop', '-1');
      if (source.startSeconds !== undefined && source.startSeconds > 0) {
        args.push('-ss', String(source.startSeconds));
      }
      args.push('-i', source.path);
      return { args, warnings: [], target: source.path };
    }

    default: {
      const exhaustive: never = source;
      throw new MediaError(
        'unsupported-source',
        `Unsupported stream source type: ${String((exhaustive as { type?: string }).type)}`,
      );
    }
  }
}

interface UsbSource {
  type: 'usb';
  device: string;
  inputFormat?: 'v4l2' | 'dshow' | 'avfoundation';
  resolution?: { width?: number; height?: number };
  fps?: number;
  pixelFormat?: string;
}

function buildUsbInput(source: UsbSource): SourceArgs {
  const format = source.inputFormat ?? platformCaptureFormat();
  const warnings: string[] = [];
  const args: string[] = [];

  switch (format) {
    case 'v4l2':
      args.push('-f', 'v4l2');
      break;
    case 'dshow':
      args.push('-f', 'dshow');
      break;
    case 'avfoundation':
      args.push('-f', 'avfoundation');
      break;
  }

  if (source.fps !== undefined && source.fps > 0) {
    args.push('-framerate', String(source.fps));
  }
  const size = captureSize(source.resolution);
  if (size !== undefined) {
    args.push('-video_size', size);
    warnings.push(
      'A fixed capture size is configured: USB devices reject unsupported modes at open time, so verify it with `ffmpeg -f v4l2 -list_formats all -i <device>`.',
    );
  }
  if (source.pixelFormat !== undefined) {
    // v4l2 uses -input_format, DirectShow/AVFoundation use -pixel_format.
    args.push(format === 'v4l2' ? '-input_format' : '-pixel_format', source.pixelFormat);
  }

  let device = source.device;
  if (format === 'avfoundation' && !device.includes(':')) {
    // AVFoundation wants "<video>:<audio>"; "none" avoids grabbing a microphone.
    device = `${device}:none`;
  }
  args.push('-i', device);

  return { args, warnings, target: device };
}

function platformCaptureFormat(): 'v4l2' | 'dshow' | 'avfoundation' {
  if (process.platform === 'win32') return 'dshow';
  if (process.platform === 'darwin') return 'avfoundation';
  return 'v4l2';
}

function captureSize(resolution: { width?: number; height?: number } | undefined): string | undefined {
  if (resolution?.width !== undefined && resolution.height !== undefined) {
    return `${resolution.width}x${resolution.height}`;
  }
  return undefined;
}

function httpFormat(format: 'auto' | 'mjpeg' | 'h264' | 'h265' | undefined): string | undefined {
  switch (format) {
    case 'mjpeg':
      return 'mjpeg';
    case 'h264':
      return 'h264';
    case 'h265':
      return 'hevc';
    default:
      return undefined;
  }
}

function sourceTimeout(source: StreamSource): number | undefined {
  if ('timeoutSeconds' in source && typeof source.timeoutSeconds === 'number') {
    return source.timeoutSeconds;
  }
  return undefined;
}

function credentialsOf(source: StreamSource): Credentials | undefined {
  return 'credentials' in source ? source.credentials : undefined;
}

function assertScheme(url: string, scheme: string): void {
  if (!url.toLowerCase().startsWith(`${scheme}://`)) {
    throw new MediaError(
      'invalid-argument',
      `Expected a ${scheme}:// URL but got "${maskUrl(url)}".`,
      'The source type must match its URL scheme; use type "http" for HTTP/MJPEG cameras.',
    );
  }
}

/** Injects credentials as URL userinfo, leaving them out of FFmpeg's stdout. */
export function withCredentials(url: string, credentials: Credentials | undefined): string {
  if (credentials?.username === undefined && credentials?.password === undefined) return url;
  try {
    const parsed = new URL(url);
    if (credentials.username !== undefined) parsed.username = credentials.username;
    if (credentials.password !== undefined) parsed.password = credentials.password;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Masks userinfo and token-ish query parameters so URLs can be logged. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0) parsed.username = '***';
    if (parsed.password.length > 0) parsed.password = '***';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|pass|auth|sig/i.test(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Removes credentials from an argv array before it is printed or logged. */
export function redactArgv(args: string[]): string[] {
  return args.map((arg) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? maskUrl(arg) : arg));
}
