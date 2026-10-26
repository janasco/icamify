import { execFile } from 'node:child_process';
import type { StreamSource } from '@icamify/core';
import { MediaError } from './errors.ts';
import { buildSnapshotArgs } from './ffmpeg/args.ts';
import type { SnapshotOptions, SnapshotResult, SnapshotRunner } from './types.ts';

/**
 * One-shot JPEG grab from the high-resolution stream.
 *
 * Used for camera thumbnails, AI analysis on alert and notification attachments.
 * Deliberately a separate short-lived FFmpeg process: taking a snapshot must not
 * disturb a running recording or live transcode.
 */

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export function createSnapshotRunner(env: NodeJS.ProcessEnv = process.env): SnapshotRunner {
  return (bin, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', windowsHide: true, env },
        (error, stdout, stderr) => {
          const errno = error as NodeJS.ErrnoException | null;
          const spawnFailed = errno?.code === 'ENOENT' || errno?.code === 'EACCES';
          const exitCode = typeof errno?.code === 'number' ? errno.code : error ? 1 : 0;
          resolve({
            code: spawnFailed ? 127 : exitCode,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
            stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
            spawnFailed,
          });
        },
      );
    });
}

export async function captureSnapshot(source: StreamSource, options: SnapshotOptions): Promise<SnapshotResult> {
  const built = buildSnapshotArgs({
    source,
    maxWidth: options.maxWidth,
    quality: options.quality,
    ...(options.crop === undefined ? {} : { crop: options.crop }),
    resolvedUri: options.resolvedUri,
  });
  const runner = options.runner ?? createSnapshotRunner();
  const result = await runner(options.ffmpegPath, built.args, options.timeoutMs ?? 20_000);

  if (result.spawnFailed) {
    throw new MediaError(
      'toolchain-missing',
      `Could not execute ffmpeg at "${options.ffmpegPath}".`,
      'Install FFmpeg or set ICAMIFY_FFMPEG_PATH.',
    );
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim().split('\n').slice(-5).join('\n');
    throw new MediaError(
      'snapshot-failed',
      `FFmpeg could not produce a snapshot (exit ${result.code}).`,
      stderr.length > 0 ? stderr : 'The camera may be offline or still negotiating its stream.',
    );
  }
  if (!result.stdout.subarray(0, 3).equals(JPEG_MAGIC)) {
    throw new MediaError(
      'snapshot-failed',
      'FFmpeg returned data that is not a JPEG image.',
      `Received ${result.stdout.length} bytes. Check that the profile is not producing raw frames.`,
    );
  }

  return { jpeg: result.stdout, warnings: built.warnings };
}
