import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Timeline playback without re-encoding.
 *
 * Recordings are Matroska by default, which no browser plays. Rather than
 * transcode (expensive and lossy), the container is rewritten to fragmented MP4
 * with `-c copy`: the video bytes are untouched, the CPU cost is a few percent of
 * one core, and the browser can start rendering as soon as the first fragment
 * arrives.
 *
 * Seeking happens on the input side (`-ss` before `-i`), which is a demuxer skip
 * instead of a decode-and-discard, and is therefore instant on a large file.
 * Because the result is streamed and not ranged, the player asks for one window at
 * a time: the timeline scrubber decides where the window starts.
 */

export interface RemuxOptions {
  /** Offset into the recording, in seconds. */
  startSeconds?: number;
  /** Length of the window, in seconds. Omit for "to the end". */
  durationSeconds?: number;
}

export function buildRemuxArgs(path: string, options: RemuxOptions = {}): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (options.startSeconds !== undefined && options.startSeconds > 0) {
    args.push('-ss', options.startSeconds.toFixed(3));
  }
  args.push('-i', path);
  if (options.durationSeconds !== undefined && options.durationSeconds > 0) {
    args.push('-t', options.durationSeconds.toFixed(3));
  }
  args.push(
    // `?` tolerates a silent camera and a video-free audio recording alike.
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  );
  return args;
}

export interface RemuxStream {
  child: ChildProcess;
  /** Resolves when FFmpeg exits; rejects when it fails before finishing. */
  done: Promise<void>;
  /** Last few stderr lines, for diagnostics. */
  errors(): string;
}

export function createRemuxStream(bin: string, path: string, options: RemuxOptions = {}): RemuxStream {
  const child = spawn(bin, buildRemuxArgs(path, options), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString('utf8');
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg remux exited with code ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
  return { child, done, errors: () => stderr };
}
