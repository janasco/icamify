/**
 * MJPEG framing.
 *
 * FFmpeg's `-f mjpeg` writes one JPEG after another with no length prefix, so
 * the only way to know a frame is complete is to find its `FFD9` end marker
 * (after its `FFD8` start marker). This splitter does that across chunk
 * boundaries — FFmpeg routinely splits a JPEG across several pipe reads — and
 * refuses to buffer a runaway "frame" that never ends.
 */

const SOI_FIRST = 0xff;
const SOI_SECOND = 0xd8;
const EOI_SECOND = 0xd9;

export interface JpegFrame {
  data: Buffer;
  /** Bytes discarded before this frame (garbage, partial header). */
  skippedBytes: number;
}

export interface JpegSplitterOptions {
  /** Frames larger than this are dropped rather than buffered (default 8 MiB). */
  maxFrameBytes?: number;
}

export class JpegFrameSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private discarding = false;
  private readonly maxFrameBytes: number;

  constructor(options: JpegSplitterOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
  }

  /** Bytes currently held between frames (for diagnostics). */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): Buffer[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    const frames: Buffer[] = [];

    for (;;) {
      const start = this.findStart();
      if (start === undefined) break;
      const end = this.findEnd(start + 2);
      if (end === undefined) break;
      frames.push(Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }

    if (this.buffer.length > this.maxFrameBytes) {
      // No EOI in sight: this is not MJPEG. Drop what we have and look again
      // rather than growing without bound.
      this.buffer = Buffer.alloc(0);
      this.discarding = true;
    }
    return frames;
  }

  private findStart(): number | undefined {
    for (let index = 0; index + 1 < this.buffer.length; index += 1) {
      if (this.buffer[index] === SOI_FIRST && this.buffer[index + 1] === SOI_SECOND) return index;
    }
    return undefined;
  }

  private findEnd(from: number): number | undefined {
    // JPEG entropy-coded data escapes FF as FF00, so FF D9 is unambiguous.
    for (let index = from; index + 1 < this.buffer.length; index += 1) {
      if (this.buffer[index] === SOI_FIRST && this.buffer[index + 1] === EOI_SECOND) return index;
    }
    return undefined;
  }

  get dropped(): boolean {
    return this.discarding;
  }
}

/** Pulls every complete JPEG out of a fixed buffer (snapshot URLs, tests). */
export function extractJpegs(buffer: Buffer, options: JpegSplitterOptions = {}): Buffer[] {
  return new JpegFrameSplitter(options).push(buffer);
}

/** True when the buffer starts with a JPEG SOI marker. */
export function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === SOI_FIRST && buffer[1] === SOI_SECOND && buffer[2] === 0xff;
}
