/**
 * Fragmented MP4 parsing for the MSE transport.
 *
 * FFmpeg writes `ftyp`+`moov` once and then a stream of `moof`+`mdat`
 * fragments. A browser `SourceBuffer` needs three things from that byte stream
 * that it cannot guess:
 *
 * 1. the init segment (`ftyp`+`moov`) delivered exactly once, before any media,
 * 2. a `MediaSource.isTypeSupported()` codec string such as `avc1.64001e`,
 * 3. media appends that begin on a fragment boundary.
 *
 * This module derives all three from the bytes alone, so no probing round-trip
 * is needed and the same code path works for any camera profile.
 */

export class Fmp4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fmp4Error';
  }
}

export interface BoxInfo {
  type: string;
  /** Total box size in bytes, including the header. */
  size: number;
  /** 8 normally, 16 for 64-bit `largesize` boxes. */
  headerSize: number;
}

export type TrackKind = 'video' | 'audio';

export interface TrackInfo {
  kind: TrackKind;
  trackId: number;
  /** RFC 6381 codec string, e.g. `avc1.64001e`. Absent when unsupported. */
  codec?: string;
  width?: number;
  height?: number;
  timescale?: number;
  /** ISO sample-entry fourcc, e.g. `avc1`, `hvc1`, `mp4a`. */
  format?: string;
}

export interface InitInfo {
  video?: TrackInfo;
  audio?: TrackInfo;
  /** Complete init segment (`ftyp` … `moov`), ready for `SourceBuffer.appendBuffer`. */
  data: Buffer;
}

export type Fmp4Event = { kind: 'init'; init: InitInfo } | { kind: 'fragment'; data: Buffer };

export interface Fmp4ParserOptions {
  /** Guard against a corrupt stream exhausting memory (default 32 MiB). */
  maxBufferedBytes?: number;
}

/** Reads one box header at `offset`, or undefined when more bytes are needed. */
export function readBox(buffer: Buffer, offset = 0): BoxInfo | undefined {
  if (buffer.length - offset < 8) return undefined;
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size32 === 1) {
    if (buffer.length - offset < 16) return undefined;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large < 16n || large > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Fmp4Error(`Invalid 64-bit box size ${large} for "${type}".`);
    }
    return { type, size: Number(large), headerSize: 16 };
  }
  if (size32 === 0) {
    // "extends to end of file" — legal in a finalised file, never in a live pipe
    // where the end is unknown.
    return { type, size: buffer.length - offset, headerSize: 8 };
  }
  if (size32 < 8) {
    throw new Fmp4Error(`Invalid box size ${size32} for "${type}".`);
  }
  return { type, size: size32, headerSize: 8 };
}

/**
 * Incremental parser: feed it whatever FFmpeg wrote, get init and fragment
 * events back. Every emitted fragment starts at a `moof`, which is what makes
 * it safe to append to a `SourceBuffer`.
 */
export class FragmentedMp4Parser {
  private pending: Buffer = Buffer.alloc(0);
  private initParts: Buffer[] = [];
  private fragmentParts: Buffer[] = [];
  private fragmentBytes = 0;
  private hasMoof = false;
  private hasMdat = false;
  private phase: 'init' | 'media' = 'init';
  private initInfo: InitInfo | undefined;
  private readonly maxBufferedBytes: number;

  constructor(options: Fmp4ParserOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024;
  }

  /** The last parsed init segment, if any. */
  get init(): InitInfo | undefined {
    return this.initInfo;
  }

  /** Clears all state; used when a pipeline restarts and emits a fresh `moov`. */
  reset(): void {
    this.pending = Buffer.alloc(0);
    this.initParts = [];
    this.fragmentParts = [];
    this.fragmentBytes = 0;
    this.hasMoof = false;
    this.hasMdat = false;
    this.phase = 'init';
    this.initInfo = undefined;
  }

  push(chunk: Buffer): Fmp4Event[] {
    if (chunk.length > 0) {
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    }
    if (this.pending.length > this.maxBufferedBytes) {
      throw new Fmp4Error(
        `MP4 parser buffered ${this.pending.length} bytes without finding a complete box; the stream is not fragmented MP4.`,
      );
    }

    const events: Fmp4Event[] = [];
    for (;;) {
      const box = readBox(this.pending, 0);
      if (box === undefined) break;
      if (box.size > this.maxBufferedBytes) {
        throw new Fmp4Error(`Box "${box.type}" claims ${box.size} bytes, which exceeds the parser limit.`);
      }
      if (this.pending.length < box.size) break;
      const data = Buffer.from(this.pending.subarray(0, box.size));
      this.pending = this.pending.subarray(box.size);
      this.consume(box.type, data, events);
    }
    return events;
  }

  private consume(type: string, data: Buffer, events: Fmp4Event[]): void {
    if (this.phase === 'init') {
      this.initParts.push(data);
      if (type === 'moov') {
        const init: InitInfo = { ...parseInitSegment(Buffer.concat(this.initParts)), data: Buffer.concat(this.initParts) };
        this.initInfo = init;
        this.initParts = [];
        this.phase = 'media';
        events.push({ kind: 'init', init });
      }
      return;
    }

    if (type === 'moof') {
      this.flushFragment(events);
      this.hasMoof = true;
      this.fragmentParts.push(data);
      this.fragmentBytes += data.length;
      return;
    }

    if (type === 'mdat') this.hasMdat = true;
    this.fragmentParts.push(data);
    this.fragmentBytes += data.length;

    // A fragment is complete as soon as its mdat arrives; emitting here (rather
    // than waiting for the next moof) keeps live latency at one fragment.
    if (this.hasMoof && this.hasMdat) this.flushFragment(events);
  }

  /** Emits the accumulated fragment and resets the accumulator. */
  flushFragment(events: Fmp4Event[]): void {
    if (this.fragmentParts.length === 0) return;
    events.push({ kind: 'fragment', data: Buffer.concat(this.fragmentParts) });
    this.fragmentParts = [];
    this.fragmentBytes = 0;
    this.hasMoof = false;
    this.hasMdat = false;
  }
}

interface ChildBox {
  type: string;
  start: number;
  size: number;
  /** Offset of the payload (after the header). */
  body: number;
}

function* children(buffer: Buffer, start: number, end: number): Generator<ChildBox> {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) return;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset, size, body: offset + headerSize };
    offset += size;
  }
}

function findChild(buffer: Buffer, parent: ChildBox, type: string): ChildBox | undefined {
  for (const child of children(buffer, parent.body, parent.start + parent.size)) {
    if (child.type === type) return child;
  }
  return undefined;
}

function pathTo(buffer: Buffer, parent: ChildBox, path: string[]): ChildBox | undefined {
  let current: ChildBox = parent;
  for (const type of path) {
    const next = findChild(buffer, current, type);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/**
 * Extracts track metadata (codec string, dimensions, timescale) from an init
 * segment. Never throws on unknown codecs: it reports the fourcc and leaves
 * `codec` undefined so the caller can fall back to MJPEG.
 */
export function parseInitSegment(init: Buffer): Omit<InitInfo, 'data'> {
  const result: Omit<InitInfo, 'data'> = {};
  const top = [...children(init, 0, init.length)];
  const moov = top.find((box) => box.type === 'moov');
  if (moov === undefined) return result;

  let trackIndex = 0;
  for (const trak of children(init, moov.body, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findChild(init, trak, 'tkhd');
    const mdia = findChild(init, trak, 'mdia');
    if (mdia === undefined) continue;
    const mdhd = findChild(init, mdia, 'mdhd');
    const hdlr = findChild(init, mdia, 'hdlr');
    const stsd = pathTo(init, mdia, ['minf', 'stbl', 'stsd']);
    if (stsd === undefined) continue;

    const handler = hdlr === undefined ? '' : init.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    const kind: TrackKind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'video';
    const entry = firstSampleEntry(init, stsd);
    if (entry === undefined) continue;

    trackIndex += 1;
    const info: TrackInfo = {
      kind,
      trackId: tkhd === undefined ? trackIndex : readTrackId(init, tkhd),
      format: entry.type,
    };
    const timescale = mdhd === undefined ? undefined : readTimescale(init, mdhd);
    if (timescale !== undefined) info.timescale = timescale;

    if (kind === 'video') {
      const dimensions = readDimensions(init, entry);
      if (dimensions !== undefined) {
        info.width = dimensions.width;
        info.height = dimensions.height;
      }
      info.codec = videoCodecString(init, entry);
      if (result.video === undefined) result.video = info;
    } else if (result.audio === undefined) {
      info.codec = audioCodecString(init, entry);
      result.audio = info;
    }
  }
  return result;
}

function firstSampleEntry(buffer: Buffer, stsd: ChildBox): ChildBox | undefined {
  // FullBox header (version+flags) then entry_count, then the entries.
  const entriesStart = stsd.body + 8;
  for (const entry of children(buffer, entriesStart, stsd.start + stsd.size)) {
    return entry;
  }
  return undefined;
}

function readTrackId(buffer: Buffer, tkhd: ChildBox): number {
  const version = buffer.readUInt8(tkhd.body);
  return version === 1 ? buffer.readUInt32BE(tkhd.body + 20) : buffer.readUInt32BE(tkhd.body + 12);
}

function readTimescale(buffer: Buffer, mdhd: ChildBox): number | undefined {
  const version = buffer.readUInt8(mdhd.body);
  const offset = version === 1 ? mdhd.body + 20 : mdhd.body + 12;
  if (offset + 4 > mdhd.start + mdhd.size) return undefined;
  return buffer.readUInt32BE(offset);
}

/** VisualSampleEntry: 8 bytes after the box header, then width/height. */
function readDimensions(buffer: Buffer, entry: ChildBox): { width: number; height: number } | undefined {
  const offset = entry.body + 24;
  if (offset + 4 > entry.start + entry.size) return undefined;
  return { width: buffer.readUInt16BE(offset), height: buffer.readUInt16BE(offset + 2) };
}

const VISUAL_CHILD_OFFSET = 78;

function videoCodecString(buffer: Buffer, entry: ChildBox): string | undefined {
  const childStart = entry.body + VISUAL_CHILD_OFFSET;
  if (childStart >= entry.start + entry.size) return undefined;
  switch (entry.type) {
    case 'avc1':
    case 'avc3': {
      const avcC = findInRange(buffer, childStart, entry.start + entry.size, 'avcC');
      if (avcC === undefined || avcC.body + 4 > avcC.start + avcC.size) return undefined;
      const hex = (value: number): string => value.toString(16).padStart(2, '0');
      const profile = buffer.readUInt8(avcC.body + 1);
      const compatibility = buffer.readUInt8(avcC.body + 2);
      const level = buffer.readUInt8(avcC.body + 3);
      return `${entry.type}.${hex(profile)}${hex(compatibility)}${hex(level)}`;
    }
    case 'hvc1':
    case 'hev1': {
      const hvcC = findInRange(buffer, childStart, entry.start + entry.size, 'hvcC');
      if (hvcC === undefined || hvcC.body + 13 > hvcC.start + hvcC.size) return undefined;
      return hevcCodecString(buffer, hvcC, entry.type);
    }
    case 'av01': {
      const av1C = findInRange(buffer, childStart, entry.start + entry.size, 'av1C');
      if (av1C === undefined || av1C.body + 3 > av1C.start + av1C.size) return undefined;
      return av1CodecString(buffer, av1C);
    }
    default:
      return undefined;
  }
}

function findInRange(buffer: Buffer, start: number, end: number, type: string): ChildBox | undefined {
  for (const child of children(buffer, start, end)) {
    if (child.type === type) return child;
  }
  return undefined;
}

/** RFC 6381 HEVC string: hvc1.<space><profile>.<compat reversed>.<tier><level>.<constraints>. */
function hevcCodecString(buffer: Buffer, hvcC: ChildBox, type: string): string | undefined {
  const body = hvcC.body;
  if (body + 13 > hvcC.start + hvcC.size) return undefined;
  const profileByte = buffer.readUInt8(body + 1);
  const space = (profileByte >> 6) & 0x03;
  const tier = (profileByte >> 5) & 0x01;
  const profileIdc = profileByte & 0x1f;

  const compatRaw = buffer.readUInt32BE(body + 2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if ((compatRaw & (1 << bit)) !== 0) reversed |= 1 << (31 - bit);
  }
  const constraints: string[] = [];
  for (const byte of buffer.subarray(body + 6, body + 12)) {
    constraints.push(byte.toString(16).padStart(2, '0').toUpperCase());
  }
  while (constraints.length > 0 && constraints[constraints.length - 1] === '00') constraints.pop();

  const level = buffer.readUInt8(body + 12);
  const parts = [`${type}.${space > 0 ? space : ''}${profileIdc}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier === 1 ? 'H' : 'L'}${level}`];
  if (constraints.length > 0) parts.push(constraints.join('.'));
  return parts.join('.');
}

/** RFC 6381 AV1 string: av01.P.LLT.DD. */
function av1CodecString(buffer: Buffer, av1C: ChildBox): string | undefined {
  const body = av1C.body;
  if (body + 3 > av1C.start + av1C.size) return undefined;
  const first = buffer.readUInt8(body + 1);
  const profile = (first >> 5) & 0x07;
  const level = first & 0x1f;
  const flags = buffer.readUInt8(body + 2);
  const tier = (flags >> 7) & 0x01;
  const highBitdepth = (flags >> 6) & 0x01;
  const twelveBit = (flags >> 5) & 0x01;
  const bitDepth = twelveBit === 1 ? 12 : highBitdepth === 1 ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier === 1 ? 'H' : 'M'}.${String(bitDepth).padStart(2, '0')}`;
}

function audioCodecString(_buffer: Buffer, entry: ChildBox): string | undefined {
  if (entry.type !== 'mp4a') return undefined;
  // AAC-LC is what the profile builder asks FFmpeg for; the esds object type
  // could refine this, but every browser capable of MSE supports 40.2.
  return 'mp4a.40.2';
}

/** Convenience: the MSE MIME type for an init segment, or undefined. */
export function mseMimeType(init: InitInfo): string | undefined {
  const codec = init.video?.codec;
  return codec === undefined ? undefined : `video/mp4; codecs="${codec}"`;
}
