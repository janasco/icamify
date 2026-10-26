import type { Frame } from './index.ts';

/**
 * Raw-frame splitter for the `detect` pipeline.
 *
 * FFmpeg writes `-f rawvideo` to stdout: fixed-size frames with no container, so
 * a chunk can end anywhere inside a frame. This reader buffers across chunks and
 * emits whole frames, which is why the pipeline never needs a demuxer or a
 * decoder in Node.
 */

export type PixelFormat = 'gray' | 'rgb24';

export interface RawFrameReaderOptions {
  cameraId: string;
  width: number;
  height: number;
  pixelFormat?: PixelFormat;
  /**
   * A stalled consumer must not grow memory without bound. When a push yields
   * more frames than this, the oldest are dropped and counted.
   */
  maxFramesPerPush?: number;
}

export class RawFrameReader {
  readonly cameraId: string;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: PixelFormat;
  readonly frameBytes: number;

  private readonly maxFramesPerPush: number;
  private readonly frameBuffer: Uint8Array;
  private readonly rgbScratch: Uint8Array | undefined;
  private filled = 0;
  private droppedFrames = 0;
  private totalFrames = 0;

  constructor(options: RawFrameReaderOptions) {
    if (options.width <= 0 || options.height <= 0) {
      throw new Error(`Invalid frame geometry ${options.width}x${options.height}.`);
    }
    this.cameraId = options.cameraId;
    this.width = Math.round(options.width);
    this.height = Math.round(options.height);
    this.pixelFormat = options.pixelFormat ?? 'gray';
    this.frameBytes = this.width * this.height * (this.pixelFormat === 'rgb24' ? 3 : 1);
    this.maxFramesPerPush = Math.max(1, options.maxFramesPerPush ?? 4);
    this.frameBuffer = new Uint8Array(this.frameBytes);
    this.rgbScratch = this.pixelFormat === 'rgb24' ? new Uint8Array(this.width * this.height) : undefined;
  }

  get dropped(): number {
    return this.droppedFrames;
  }

  get frames(): number {
    return this.totalFrames;
  }

  /** Bytes buffered towards the next frame (diagnostics). */
  get pendingBytes(): number {
    return this.filled;
  }

  /**
   * Feeds a stdout chunk and returns the frames completed by it. Timestamps come
   * from the caller because rawvideo carries none; `now` is sampled per frame so
   * a backlog does not collapse into one timestamp.
   */
  push(chunk: Buffer | Uint8Array, now: () => number = Date.now): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this.frameBytes - this.filled, chunk.length - offset);
      this.frameBuffer.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameBytes) {
        this.filled = 0;
        this.totalFrames += 1;
        frames.push(this.toFrame(now()));
      }
    }

    if (frames.length > this.maxFramesPerPush) {
      // Keep the newest frames: stale analysis is worse than a gap, and the next
      // frame is a fresh comparison either way.
      const dropped = frames.length - this.maxFramesPerPush;
      this.droppedFrames += dropped;
      return frames.slice(dropped);
    }
    return frames;
  }

  reset(): void {
    this.filled = 0;
  }

  private toFrame(timestamp: number): Frame {
    if (this.pixelFormat === 'gray') {
      return {
        cameraId: this.cameraId,
        timestamp,
        width: this.width,
        height: this.height,
        luma: this.frameBuffer.slice(),
      };
    }
    const luma = this.rgbScratch!;
    const rgb = this.frameBuffer;
    for (let pixel = 0, source = 0; pixel < luma.length; pixel += 1, source += 3) {
      // Rec.601 integer luma; close enough to BT.709 for differencing, and it
      // keeps the conversion to shifts instead of floating point.
      luma[pixel] = (rgb[source]! * 77 + rgb[source + 1]! * 150 + rgb[source + 2]! * 29) >> 8;
    }
    return {
      cameraId: this.cameraId,
      timestamp,
      width: this.width,
      height: this.height,
      luma: luma.slice(),
      rgb: rgb.slice(),
    };
  }
}
