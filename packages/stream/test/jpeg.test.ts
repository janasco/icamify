import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CameraConfig } from '@icamify/core';
import {
  JpegFrameSplitter,
  extractJpegs,
  isJpeg,
} from '../src/index.ts';

/** A fake JPEG: SOI + entropy bytes + EOI. */
function jpeg(payload: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload, 'latin1'), Buffer.from([0xff, 0xd9])]);
}

describe('JpegFrameSplitter', () => {
  test('splits several frames written in one chunk', () => {
    const frames = new JpegFrameSplitter().push(Buffer.concat([jpeg('one'), jpeg('two')]));
    assert.equal(frames.length, 2);
    assert.ok(isJpeg(frames[0] ?? Buffer.alloc(0)));
    assert.equal(frames[1]?.toString('latin1').includes('two'), true);
  });

  test('reassembles a frame split across reads', () => {
    const frame = jpeg('split-me');
    const splitter = new JpegFrameSplitter();
    const first = splitter.push(frame.subarray(0, 5));
    const second = splitter.push(frame.subarray(5));
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);
    assert.deepEqual(second[0], frame);
  });

  test('skips garbage before the SOI marker', () => {
    const frames = new JpegFrameSplitter().push(Buffer.concat([Buffer.from('garbage'), jpeg('clean')]));
    assert.equal(frames.length, 1);
    assert.ok(isJpeg(frames[0] ?? Buffer.alloc(0)));
  });

  test('drops a runaway frame instead of buffering it without bound', () => {
    const splitter = new JpegFrameSplitter({ maxFrameBytes: 32 });
    splitter.push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64)]));
    assert.equal(splitter.bufferedBytes, 0);
    assert.equal(splitter.dropped, true);
    assert.equal(splitter.push(jpeg('after-reset')).length, 1);
  });

  test('extractJpegs is the one-shot form used for snapshots', () => {
    assert.equal(extractJpegs(Buffer.concat([jpeg('a'), jpeg('b'), jpeg('c')])).length, 3);
  });
});
