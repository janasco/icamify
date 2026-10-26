import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  labelMatches,
  normalizeBox,
  readBox,
  readCornerBox,
  readPath,
  remapBox,
  toConfidence,
  unionBox,
} from '../src/mapping.ts';
import { jpegSize } from '../src/image.ts';

/** Minimal JPEG: SOI + SOF0 + EOI. Enough for header inspection, not decoding. */
function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe('readPath', () => {
  it('reads dotted, bracketed and numeric paths', () => {
    const value = { a: { b: [{ c: 42 }] }, list: ['x', 'y'] };
    assert.equal(readPath(value, 'a.b[0].c'), 42);
    assert.equal(readPath(value, 'a.b.0.c'), 42);
    assert.equal(readPath(value, 'list[1]'), 'y');
    assert.equal(readPath(value, 'list.1'), 'y');
    assert.deepEqual(readPath(value, ''), value);
  });

  it('returns undefined for missing or non-traversable segments', () => {
    assert.equal(readPath({ a: 1 }, 'a.b.c'), undefined);
    assert.equal(readPath({ a: [1] }, 'a.x'), undefined);
    assert.equal(readPath(null, 'a'), undefined);
  });
});

describe('confidence', () => {
  it('accepts fractions, percentages and numeric strings', () => {
    assert.equal(toConfidence(0.5), 0.5);
    assert.equal(toConfidence(87), 0.87);
    assert.equal(toConfidence('0.33'), 0.33);
    assert.equal(toConfidence(1), 1);
  });

  it('rejects values that are not numbers', () => {
    assert.equal(toConfidence(undefined), undefined);
    assert.equal(toConfidence('high'), undefined);
    assert.equal(toConfidence(null), undefined);
  });
});

describe('boxes', () => {
  const size = { width: 640, height: 360 };

  it('clamps pixel boxes to the frame', () => {
    const box = readBox({ x: -20, y: 300, width: 100, height: 200 }, { x: 'x', y: 'y', width: 'width', height: 'height' }, size);
    assert.deepEqual(box, { x: 0, y: 300, width: 80, height: 60, normalized: false });
  });

  it('scales normalized boxes by the image size', () => {
    const box = readBox(
      { x: 0.5, y: 0.5, width: 0.25, height: 0.5 },
      { x: 'x', y: 'y', width: 'width', height: 'height', normalized: true },
      size,
    );
    assert.deepEqual(box, { x: 320, y: 180, width: 160, height: 180, normalized: false });
  });

  it('reads corner boxes and rejects degenerate ones', () => {
    const box = readCornerBox(
      { x_min: 10, y_min: 20, x_max: 110, y_max: 220 },
      { xMin: 'x_min', yMin: 'y_min', xMax: 'x_max', yMax: 'y_max' },
      size,
    );
    assert.deepEqual(box, { x: 10, y: 20, width: 100, height: 200, normalized: false });
    assert.equal(
      readCornerBox({ x_min: 10, y_min: 20, x_max: 10, y_max: 20 }, { xMin: 'x_min', yMin: 'y_min', xMax: 'x_max', yMax: 'y_max' }, size),
      undefined,
    );
  });

  it('remaps a crop-relative box into the full frame', () => {
    const remapped = remapBox({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.2, y: 0.1, width: 0.4, height: 0.6, normalized: true });
    assert.deepEqual(remapped, { x: 0.4, y: 0.4, width: 0.2, height: 0.3 });
  });

  it('normalizes pixel boxes for the API', () => {
    assert.deepEqual(normalizeBox({ x: 64, y: 36, width: 320, height: 180 }, size), {
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    });
  });

  it('unions padded boxes and clamps at the edges', () => {
    const union = unionBox([
      { x: 0.0, y: 0.45, width: 0.2, height: 0.1 },
      { x: 0.5, y: 0.4, width: 0.2, height: 0.2 },
    ]);
    assert.ok(union !== undefined);
    assert.equal(union.x, 0);
    assert.ok(union.y < 0.4);
    assert.ok(union.x + union.width > 0.7);
    assert.ok(union.y + union.height > 0.6 && union.y + union.height <= 0.62);
    assert.equal(unionBox([]), undefined);
  });
});

describe('label matching', () => {
  it('matches case-insensitively and by substring', () => {
    assert.equal(labelMatches('person', ['person']), true);
    assert.equal(labelMatches('Person/Adult', ['person']), true);
    assert.equal(labelMatches('dog', ['person', 'car']), false);
    assert.equal(labelMatches('anything', []), true);
  });
});

describe('jpegSize', () => {
  it('reads frame dimensions from the SOF marker', () => {
    assert.deepEqual(jpegSize(jpegHeader(1280, 720)), { width: 1280, height: 720 });
  });

  it('rejects non-JPEG and truncated buffers', () => {
    assert.equal(jpegSize(Buffer.from('not an image')), undefined);
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff])), undefined);
    assert.equal(jpegSize(Buffer.alloc(0)), undefined);
  });
});
