import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RawFrameReader } from '../src/frame.ts';

const WIDTH = 4;
const HEIGHT = 2;
const FRAME_BYTES = WIDTH * HEIGHT;

function clock(start = 1000): () => number {
  let value = start;
  return () => {
    value += 40;
    return value;
  };
}

function grayFrame(value: number): Buffer {
  return Buffer.alloc(FRAME_BYTES, value);
}

describe('RawFrameReader', () => {
  it('splits a chunk that contains several whole frames', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: WIDTH, height: HEIGHT });
    const frames = reader.push(Buffer.concat([grayFrame(10), grayFrame(20)]), clock());
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.luma[0], 10);
    assert.equal(frames[1]!.luma[0], 20);
    assert.equal(frames[0]!.width, WIDTH);
    assert.equal(frames[0]!.cameraId, 'cam');
    assert.equal(reader.pendingBytes, 0);
  });

  it('buffers a frame that arrives across chunk boundaries', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: WIDTH, height: HEIGHT });
    const frame = grayFrame(42);
    const first = reader.push(frame.subarray(0, 3), clock());
    assert.equal(first.length, 0);
    assert.equal(reader.pendingBytes, 3);
    const second = reader.push(frame.subarray(3), clock());
    assert.equal(second.length, 1);
    assert.equal(second[0]!.luma[0], 42);
    assert.equal(reader.pendingBytes, 0);
    assert.equal(reader.frames, 1);
  });

  it('handles a chunk with one and a half frames', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: WIDTH, height: HEIGHT });
    const chunk = Buffer.concat([grayFrame(7), grayFrame(9).subarray(0, 5)]);
    const frames = reader.push(chunk, clock());
    assert.equal(frames.length, 1);
    assert.equal(reader.pendingBytes, 5);
  });

  it('converts RGB24 to luma and keeps the colour plane', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: 1, height: 1, pixelFormat: 'rgb24' });
    // Pure green: Rec.601 integer luma is 149 (0.587 * 255 truncated).
    const frames = reader.push(Buffer.from([0, 255, 0]), clock());
    assert.equal(frames.length, 1);
    const frame = frames[0]!;
    assert.equal(frame.luma[0], 149);
    assert.deepEqual([...(frame.rgb ?? [])], [0, 255, 0]);
  });

  it('drops the oldest frames when a backlog exceeds the cap', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: WIDTH, height: HEIGHT, maxFramesPerPush: 2 });
    const chunk = Buffer.concat([grayFrame(1), grayFrame(2), grayFrame(3), grayFrame(4)]);
    const frames = reader.push(chunk, clock());
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.luma[0], 3, 'newest frames win');
    assert.equal(frames[1]!.luma[0], 4);
    assert.equal(reader.dropped, 2);
  });

  it('rejects impossible geometry', () => {
    assert.throws(() => new RawFrameReader({ cameraId: 'cam', width: 0, height: 2 }), /geometry/);
  });

  it('clears a partial frame on reset', () => {
    const reader = new RawFrameReader({ cameraId: 'cam', width: WIDTH, height: HEIGHT });
    reader.push(grayFrame(1).subarray(0, 2), clock());
    reader.reset();
    assert.equal(reader.pendingBytes, 0);
    const frames = reader.push(grayFrame(5), clock());
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.luma[0], 5);
  });
});
