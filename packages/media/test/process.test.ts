import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FfmpegProcess, type ProgressFrame } from '../src/index.ts';

/**
 * These tests run a real child process (node itself, so no FFmpeg is required)
 * because the bug they guard against only appears in the hand-off between the
 * child's pipes and the two stdout consumers: live media and `-progress` frames
 * share stdout, and choosing the wrong consumer yields a silently empty stream.
 */

const NODE = process.execPath;

describe('FfmpegProcess stdout routing', () => {
  test('delivers media bytes to onStdout even when onProgress is also registered', async () => {
    const chunks: Buffer[] = [];
    const frames: ProgressFrame[] = [];
    const process_ = new FfmpegProcess({
      bin: NODE,
      args: ['-e', "process.stdout.write('this-is-media'); process.stderr.write('warn: hello\\n')"],
      stdout: 'pipe',
      onStdout: (chunk) => chunks.push(chunk),
      onProgress: (frame) => frames.push(frame),
    });

    const stderr: string[] = [];
    const exited = await process_.exited;
    assert.equal(exited.code, 0);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'this-is-media');
    assert.deepEqual(frames, [], 'media must not be parsed as progress frames');
    assert.deepEqual(stderr, []);
  });

  test('parses progress frames when no media consumer is attached', async () => {
    const frames: ProgressFrame[] = [];
    const script = "process.stdout.write('frame=42\\nfps=25\\nbitrate=1200.0kbits/s\\nprogress=continue\\n')";
    const process_ = new FfmpegProcess({
      bin: NODE,
      args: ['-e', script],
      stdout: 'pipe',
      onProgress: (frame) => frames.push(frame),
    });
    await process_.exited;
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.frame, 42);
    assert.equal(frames[0]?.fps, 25);
    assert.equal(frames[0]?.bitrateKbps, 1200);
  });

  test('drains stdout when nobody listens, so a chatty child cannot stall', async () => {
    const process_ = new FfmpegProcess({
      bin: NODE,
      args: ['-e', 'process.stdout.write("x".repeat(2_000_000)); process.exit(0)'],
      stdout: 'pipe',
    });
    const exited = await process_.exited;
    assert.equal(exited.code, 0);
  });

  test('reports a spawn failure instead of throwing', async () => {
    const process_ = new FfmpegProcess({ bin: '/nonexistent/ffmpeg-xyz', args: [], stdout: 'pipe' });
    const exited = await process_.exited;
    assert.ok(exited.spawnError !== undefined);
    assert.equal(process_.running, false);
  });
});
