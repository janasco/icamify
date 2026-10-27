import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRemuxArgs } from '../src/remux.ts';

/**
 * The remux command is the contract between the timeline UI and FFmpeg, so the
 * ordering of `-ss`/`-i` and the stream-copy flags are asserted, not just the
 * presence of an argument list.
 */

describe('buildRemuxArgs', () => {
  it('copies the streams into a streamable MP4', () => {
    const args = buildRemuxArgs('/data/clip.mkv');
    assert.equal(args.includes('-c'), true);
    assert.equal(args[args.indexOf('-c') + 1], 'copy', 'no re-encoding');
    assert.equal(args[args.indexOf('-movflags') + 1], '+frag_keyframe+empty_moov+default_base_moof');
    assert.equal(args.at(-1), 'pipe:1');
    assert.equal(args.includes('-ss'), false);
    assert.equal(args.includes('-t'), false);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:v:0?']);
  });

  it('seeks before the input so the demuxer skips instead of decoding', () => {
    const args = buildRemuxArgs('/data/clip.mkv', { startSeconds: 12.5, durationSeconds: 30 });
    const seek = args.indexOf('-ss');
    const input = args.indexOf('-i');
    assert.equal(seek < input, true, '-ss must precede -i for an input seek');
    assert.equal(args[seek + 1], '12.500');
    assert.equal(args[input + 1], '/data/clip.mkv');
    assert.equal(args[args.indexOf('-t') + 1], '30.000');
  });

  it('ignores zero-valued windows', () => {
    const args = buildRemuxArgs('/data/clip.mkv', { startSeconds: 0, durationSeconds: 0 });
    assert.equal(args.includes('-ss'), false);
    assert.equal(args.includes('-t'), false);
  });
});
