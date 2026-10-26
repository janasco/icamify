import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Fmp4Error,
  FragmentedMp4Parser,
  mseMimeType,
  parseInitSegment,
  readBox,
} from '../src/index.ts';

/** Minimal ISO-BMFF box writer used to build fixtures without FFmpeg. */
function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function fullBox(type: string, version: number, flags: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(version, 0);
  head.writeUIntBE(flags, 1, 3);
  return box(type, Buffer.concat([head, body]));
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** VisualSampleEntry with the required 78-byte prefix, then avcC. */
function avc1Entry(width: number, height: number, profile = 0x64, compatibility = 0x00, level = 0x1e): Buffer {
  const prefix = Buffer.alloc(78);
  prefix.writeUInt16BE(1, 6); // data_reference_index
  prefix.writeUInt16BE(width, 24);
  prefix.writeUInt16BE(height, 26);
  const avcC = box('avcC', Buffer.from([1, profile, compatibility, level, 0xff, 0xe1, 0, 0, 0]));
  return box('avc1', Buffer.concat([prefix, avcC]));
}

function initSegment(width = 640, height = 360, timescale = 12800, trackId = 1): Buffer {
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), avc1Entry(width, height)]));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(0)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)]));
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const tkhd = fullBox('tkhd', 0, 7, Buffer.concat([u32(0), u32(0), u32(trackId), u32(0), u32(0)]));
  const trak = box('trak', Buffer.concat([tkhd, mdia]));
  const moov = box('moov', Buffer.concat([fullBox('mvhd', 0, 0, Buffer.alloc(96)), trak]));
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1')]));
  return Buffer.concat([ftyp, moov]);
}

function fragment(sequence: number, payload = 32): Buffer {
  const mfhd = fullBox('mfhd', 0, 0, u32(sequence));
  const moof = box('moof', mfhd);
  const mdat = box('mdat', Buffer.alloc(payload, sequence));
  return Buffer.concat([moof, mdat]);
}

describe('readBox', () => {
  test('reads a normal 32-bit box header', () => {
    const info = readBox(box('moof', Buffer.alloc(4)), 0);
    assert.deepEqual({ type: info?.type, size: info?.size, headerSize: info?.headerSize }, { type: 'moof', size: 12, headerSize: 8 });
  });

  test('returns undefined when more bytes are needed', () => {
    assert.equal(readBox(Buffer.from([0, 0, 0, 16, 0x6d, 0x6f])), undefined);
  });

  test('reads a 64-bit largesize box', () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(24n, 8);
    const info = readBox(Buffer.concat([header, Buffer.alloc(8)]), 0);
    assert.equal(info?.size, 24);
    assert.equal(info?.headerSize, 16);
  });

  test('rejects an impossible size instead of looping forever', () => {
    const buffer = Buffer.from([0, 0, 0, 3, 0x66, 0x72, 0x65, 0x65]);
    assert.throws(() => readBox(buffer, 0), Fmp4Error);
  });
});

describe('parseInitSegment', () => {
  test('extracts the RFC 6381 codec string, dimensions and timescale', () => {
    const info = parseInitSegment(initSegment(1920, 1080, 90000));
    assert.equal(info.video?.codec, 'avc1.64001e');
    assert.equal(info.video?.format, 'avc1');
    assert.equal(info.video?.width, 1920);
    assert.equal(info.video?.height, 1080);
    assert.equal(info.video?.timescale, 90000);
    assert.equal(info.video?.trackId, 1);
    assert.equal(info.video?.kind, 'video');
  });

  test('builds the MIME type the browser needs for isTypeSupported', () => {
    const init = { ...parseInitSegment(initSegment()), data: Buffer.alloc(0) };
    assert.equal(mseMimeType(init), 'video/mp4; codecs="avc1.64001e"');
  });

  test('returns nothing for a moov-less buffer rather than throwing', () => {
    assert.deepEqual(parseInitSegment(box('ftyp', Buffer.alloc(8))), {});
  });

  test('decodes HEVC profile/level into a codec string', () => {
    const prefix = Buffer.alloc(78);
    prefix.writeUInt16BE(1280, 24);
    prefix.writeUInt16BE(720, 26);
    const hvcC = box('hvcC', Buffer.from([1, 0x21, 0x60, 0x00, 0x00, 0x00, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0x00]));
    const entry = box('hvc1', Buffer.concat([prefix, hvcC]));
    const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), entry]));
    const stbl = box('stbl', stsd);
    const minf = box('minf', stbl);
    const mdhd = fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(90000), u32(0)]));
    const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)]));
    const moov = box('moov', box('trak', Buffer.concat([box('tkhd', Buffer.alloc(84)), box('mdia', Buffer.concat([mdhd, hdlr, minf]))])));
    const info = parseInitSegment(Buffer.concat([box('ftyp', Buffer.alloc(8)), moov]));
    assert.equal(info.video?.format, 'hvc1');
    // profile space 0, profile 1, compatibility 0x6 (bit-reversed), main tier,
    // level 93, one non-zero constraint byte.
    assert.equal(info.video?.codec, 'hvc1.1.6.H93.90');
  });
});

describe('FragmentedMp4Parser', () => {
  test('emits init once, then one event per moof/mdat pair', () => {
    const parser = new FragmentedMp4Parser();
    const events = parser.push(Buffer.concat([initSegment(), fragment(1), fragment(2)]));
    assert.equal(events.filter((event) => event.kind === 'init').length, 1);
    const fragments = events.filter((event) => event.kind === 'fragment');
    assert.equal(fragments.length, 2);
    for (const event of fragments) {
      if (event.kind !== 'fragment') continue;
      assert.equal(event.data.toString('latin1', 4, 8), 'moof');
    }
  });

  test('survives arbitrary chunk boundaries', () => {
    const parser = new FragmentedMp4Parser();
    const stream = Buffer.concat([initSegment(), fragment(1), fragment(2), fragment(3)]);
    const events = [];
    for (let offset = 0; offset < stream.length; offset += 7) {
      events.push(...parser.push(stream.subarray(offset, Math.min(offset + 7, stream.length))));
    }
    assert.equal(events.filter((event) => event.kind === 'init').length, 1);
    assert.equal(events.filter((event) => event.kind === 'fragment').length, 3);
    assert.equal(parser.init?.video?.codec, 'avc1.64001e');
  });

  test('keeps a fragment whole when the mdat arrives in several reads', () => {
    const parser = new FragmentedMp4Parser();
    const init = initSegment();
    const frag = fragment(1, 16);
    assert.equal(parser.push(init).length, 1);
    const events = [...parser.push(frag.subarray(0, 10)), ...parser.push(frag.subarray(10, 20)), ...parser.push(frag.subarray(20))];
    assert.equal(events.length, 1);
    if (events[0]?.kind === 'fragment') assert.deepEqual(events[0].data, frag);
  });

  test('reset() allows a restarted pipeline to deliver a fresh moov', () => {
    const parser = new FragmentedMp4Parser();
    parser.push(Buffer.concat([initSegment(640, 360), fragment(1)]));
    parser.reset();
    assert.equal(parser.init, undefined);
    const events = parser.push(Buffer.concat([initSegment(1280, 720), fragment(1)]));
    assert.equal(events[0]?.kind, 'init');
    if (events[0]?.kind === 'init') assert.equal(events[0].init.video?.width, 1280);
  });

  test('refuses a stream that is not fragmented MP4 instead of buffering forever', () => {
    const parser = new FragmentedMp4Parser({ maxBufferedBytes: 64 });
    assert.throws(() => parser.push(Buffer.alloc(200, 0xff)), Fmp4Error);
  });
});
