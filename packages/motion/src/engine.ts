import type { MotionSettings } from '@icamify/core';
import { resolveMotionThresholds } from '@icamify/core';
import type { Box, Frame, MotionDetection, MotionEngine, MotionEngineOptions } from './index.ts';
import { compileZones, hasActiveCells, type CompiledZones } from './grid.ts';

/**
 * Pixel-differencing motion engine.
 *
 * The background model is a per-pixel running average that adapts slowly where
 * the scene is stable and stops adapting entirely on moving pixels, which keeps
 * a parked car from being absorbed into the background in seconds. Everything is
 * integer/luma work on a 320x180 frame, so a 15-camera install costs a fraction
 * of one core — the expensive part (decode) already happened in FFmpeg.
 *
 * Pipeline per frame: optional blur → absolute difference against the model →
 * optional colour filter → denoise erosion → per-cell pixel counts → zone matrix
 * → cell flips → connected blobs → boxes.
 */

const BACKGROUND_ALPHA = 0.02;
/**
 * Changed pixels adapt far more slowly than stable ones. A person crossing the
 * frame must never be absorbed into the model, but a parked car, a moved bin or
 * a permanent lighting change has to stop triggering within a minute or so.
 */
const CHANGED_ALPHA = 0.004;
const MAX_BOXES = 8;

export interface MotionEngineStats {
  cameraId: string;
  width: number;
  height: number;
  frames: number;
  analysed: number;
  motion: boolean;
  lastPercent: number;
  peakPercent: number;
  lastMotionAt?: number;
  lastDetectedAt?: number;
  zones: { cols: number; rows: number; mode: 'include' | 'exclude'; activeCells: number; totalCells: number };
  thresholds: { threshold: number; percentThreshold: number; sensitivity: number };
}

export class PixelMotionEngine implements MotionEngine {
  readonly cameraId: string;

  private settings: MotionSettings;
  private zones: CompiledZones;
  private width = 0;
  private height = 0;

  private background: Float32Array | undefined;
  private blurred: Uint8Array | undefined;
  private blurTemp: Uint16Array | undefined;
  private mask: Uint8Array | undefined;
  private eroded: Uint8Array | undefined;
  private cellCounts: Uint32Array | undefined;
  private cellMask: Uint8Array | undefined;

  private frames = 0;
  private primed = false;
  private analysed = 0;
  private active = false;
  private lastPercent = 0;
  private peakPercent = 0;
  private lastMotionAt: number | undefined;
  private lastDetectedAt: number | undefined;

  constructor(options: MotionEngineOptions & { cameraId?: string }) {
    this.cameraId = options.cameraId ?? 'camera';
    this.settings = options.settings;
    // Zones are compiled lazily: the analysis frame size is only known once the
    // detect pipeline reports it.
    this.zones = compileZones(options.zones, 1, 1);
  }

  configure(options: Partial<MotionEngineOptions>): void {
    if (options.settings !== undefined) this.settings = options.settings;
    if (options.zones !== undefined) {
      this.zones = compileZones(options.zones, Math.max(1, this.width), Math.max(1, this.height));
    }
  }

  reset(): void {
    this.primed = false;
    this.frames = 0;
    this.analysed = 0;
    this.active = false;
    this.lastPercent = 0;
    this.peakPercent = 0;
    this.lastMotionAt = undefined;
    this.mask?.fill(0);
  }

  /** Re-reads the frame geometry; a camera restart may change the analysis size. */
  resize(width: number, height: number, zones?: CompiledZones): void {
    if (width === this.width && height === this.height && zones === undefined) return;
    this.width = width;
    this.height = height;
    const pixels = width * height;
    this.background = new Float32Array(pixels);
    this.blurred = new Uint8Array(pixels);
    this.blurTemp = new Uint16Array(pixels);
    this.mask = new Uint8Array(pixels);
    this.eroded = new Uint8Array(pixels);
    this.cellCounts = new Uint32Array(this.zones.cols * this.zones.rows);
    this.cellMask = new Uint8Array(this.zones.cols * this.zones.rows);
    this.zones = zones ?? compileZones(toGrid(this.zones), width, height);
    this.frames = 0;
    this.primed = false;
    this.active = false;
    this.lastPercent = 0;
    this.peakPercent = 0;
    this.lastMotionAt = undefined;
  }

  stats(): MotionEngineStats {
    const thresholds = resolveMotionThresholds(this.settings);
    return {
      cameraId: this.cameraId,
      width: this.width,
      height: this.height,
      frames: this.frames,
      analysed: this.analysed,
      motion: this.active,
      lastPercent: round2(this.lastPercent),
      peakPercent: round2(this.peakPercent),
      ...(this.lastMotionAt === undefined ? {} : { lastMotionAt: this.lastMotionAt }),
      ...(this.lastDetectedAt === undefined ? {} : { lastDetectedAt: this.lastDetectedAt }),
      zones: {
        cols: this.zones.cols,
        rows: this.zones.rows,
        mode: this.zones.mode,
        activeCells: this.zones.activeCells,
        totalCells: this.zones.cols * this.zones.rows,
      },
      thresholds: {
        threshold: thresholds.threshold,
        percentThreshold: round2(thresholds.percentThreshold),
        sensitivity: thresholds.sensitivity,
      },
    };
  }

  analyze(frame: Frame): MotionDetection | null {
    if (frame.width !== this.width || frame.height !== this.height) {
      this.resize(frame.width, frame.height);
    }
    const { width, height } = this;
    const pixels = width * height;
    if (frame.luma.length < pixels) {
      throw new Error(`Frame is ${frame.luma.length} bytes but ${width}x${height} needs ${pixels}.`);
    }

    const background = this.background!;
    const warmup = Math.max(0, this.settings.warmupFrames ?? 10);

    if (!this.primed) {
      // The first frame after a start or reset defines the scene. Averaging onto
      // a zero-filled buffer would read as a full-frame change instead.
      background.set(frame.luma.subarray(0, pixels));
      this.primed = true;
      this.frames = 1;
      return null;
    }

    this.frames += 1;
    if (this.frames <= warmup) {
      const rate = 1 / this.frames;
      for (let index = 0; index < pixels; index += 1) {
        background[index] = background[index]! + (frame.luma[index]! - background[index]!) * rate;
      }
      return null;
    }

    const thresholds = resolveMotionThresholds(this.settings);
    const source = this.applyBlur(frame.luma);
    const mask = this.mask!;
    const filter = this.settings.colorFilter?.enabled === true ? this.settings.colorFilter : undefined;
    const rgb = filter === undefined ? undefined : frame.rgb;
    let changedPixels = 0;

    for (let index = 0; index < pixels; index += 1) {
      const value = source[index]!;
      const difference = value > background[index]! ? value - background[index]! : background[index]! - value;
      if (difference < thresholds.threshold) {
        mask[index] = 0;
        // Stable scene: let the model follow lighting and gradual drift.
        background[index] = background[index]! + (value - background[index]!) * BACKGROUND_ALPHA;
        continue;
      }
      if (rgb !== undefined && !passesColorFilter(rgb, index, filter)) {
        mask[index] = 0;
        continue;
      }
      mask[index] = 1;
      changedPixels += 1;
      background[index] = background[index]! + (value - background[index]!) * CHANGED_ALPHA;
    }

    const denoise = Math.min(3, Math.max(0, Math.round(this.settings.denoise ?? 0)));
    const changed = denoise > 0 && changedPixels > 0 ? this.erode(mask, denoise) : mask;

    const { flipped, percent } = this.applyZones(changed);
    this.lastPercent = percent;
    const boxes = this.boxes(flipped);

    // Motion needs both a share of changed cells and at least one surviving blob:
    // a handful of hot pixels must not open a recording.
    const detected = this.zones.activeCells > 0 && percent >= thresholds.percentThreshold && boxes.length > 0;
    if (detected) {
      this.lastMotionAt = frame.timestamp;
      this.lastDetectedAt = frame.timestamp;
      this.peakPercent = Math.max(this.peakPercent, percent);
      this.active = true;
    } else if (this.active) {
      const hangoverMs = Math.max(0, this.settings.postMotionSeconds ?? 0) * 1000;
      if (this.lastMotionAt !== undefined && frame.timestamp - this.lastMotionAt >= hangoverMs) {
        this.active = false;
        this.peakPercent = 0;
      }
    }

    this.analysed += 1;
    const detection: MotionDetection = {
      cameraId: frame.cameraId,
      timestamp: frame.timestamp,
      motion: this.active,
      changedPercent: round2(percent),
      cells: this.cellMask!,
      boxes,
      ...(boxes.length === 0 ? {} : { region: unionOf(boxes) }),
    };
    return detection;
  }

  /** 3x3 (or twice-applied) box blur; suppresses sensor grain without erasing blobs. */
  private applyBlur(luma: Uint8Array): Uint8Array {
    const radius = Math.min(2, Math.max(0, Math.round(this.settings.blurRadius ?? 0)));
    if (radius === 0) return luma;
    let source: Uint8Array = luma;
    for (let pass = 0; pass < radius; pass += 1) {
      this.boxBlur3(source);
      source = this.blurred!;
    }
    return source;
  }

  private boxBlur3(source: Uint8Array): void {
    const { width, height } = this;
    const temp = this.blurTemp!;
    const output = this.blurred!;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const left = source[row + (x > 0 ? x - 1 : x)]!;
        const middle = source[row + x]!;
        const right = source[row + (x + 1 < width ? x + 1 : x)]!;
        temp[row + x] = left + middle + right;
      }
    }
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      const up = (y > 0 ? y - 1 : y) * width;
      const down = (y + 1 < height ? y + 1 : y) * width;
      for (let x = 0; x < width; x += 1) {
        output[row + x] = ((temp[up + x]! + temp[row + x]! + temp[down + x]!) / 9) | 0;
      }
    }
  }

  /**
   * Removes isolated changed pixels: a single hot pixel is noise, a real object is
   * a cluster. `strength` is the number of changed 4-neighbours a pixel needs.
   */
  private erode(mask: Uint8Array, strength: number): Uint8Array {
    const { width, height } = this;
    const output = this.eroded!;
    const needed = Math.min(4, strength);
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = row + x;
        if (mask[index] !== 1) {
          output[index] = 0;
          continue;
        }
        let neighbours = 0;
        if (x > 0 && mask[index - 1] === 1) neighbours += 1;
        if (x + 1 < width && mask[index + 1] === 1) neighbours += 1;
        if (y > 0 && mask[index - width] === 1) neighbours += 1;
        if (y + 1 < height && mask[index + width] === 1) neighbours += 1;
        output[index] = neighbours >= needed ? 1 : 0;
      }
    }
    return output;
  }

  private applyZones(mask: Uint8Array): { flipped: Uint8Array; percent: number } {
    const { width, height } = this;
    const zones = this.zones;
    const counts = this.cellCounts!;
    const cellMask = this.cellMask!;
    counts.fill(0);
    cellMask.fill(0);

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      const zoneRow = zones.rowOfY[y]! * zones.cols;
      for (let x = 0; x < width; x += 1) {
        if (mask[row + x] === 1) {
          const cell = zoneRow + zones.colOfX[x]!;
          counts[cell] = counts[cell]! + 1;
        }
      }
    }

    const threshold = resolveMotionThresholds(this.settings).threshold;
    let flippedCells = 0;
    for (let index = 0; index < counts.length; index += 1) {
      if (zones.active[index] !== 1) continue;
      const total = zones.cellPixels[index]!;
      if (total === 0) continue;
      if (counts[index]! * 100 >= threshold * total && counts[index]! > 0) {
        cellMask[index] = 1;
        flippedCells += 1;
      }
    }

    const percent = zones.activeCells === 0 ? 0 : (flippedCells / zones.activeCells) * 100;
    return { flipped: cellMask, percent };
  }

  /** Merges adjacent flipped cells into boxes and drops specks. */
  private boxes(flipped: Uint8Array): Box[] {
    const zones = this.zones;
    const { cols, rows } = zones;
    const { width, height } = this;
    const visited = new Uint8Array(flipped.length);
    const minBlobPercent = Math.max(0, this.settings.minBlobPercent ?? 0.2);
    const framePixels = width * height;
    const found: Array<{ box: Box; area: number }> = [];

    for (let start = 0; start < flipped.length; start += 1) {
      if (flipped[start] !== 1 || visited[start] === 1) continue;
      const queue = [start];
      visited[start] = 1;
      let minCol = cols;
      let maxCol = -1;
      let minRow = rows;
      let maxRow = -1;
      let cellCount = 0;
      let blobPixels = 0;

      while (queue.length > 0) {
        const index = queue.pop()!;
        const row = Math.floor(index / cols);
        const col = index - row * cols;
        minCol = Math.min(minCol, col);
        maxCol = Math.max(maxCol, col);
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
        cellCount += 1;
        blobPixels += zones.cellPixels[index]!;
        for (const [dRow, dCol] of NEIGHBOURS) {
          const nextRow = row + dRow;
          const nextCol = col + dCol;
          if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) continue;
          const next = nextRow * cols + nextCol;
          if (flipped[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }

      const areaPercent = (blobPixels / framePixels) * 100;
      if (cellCount === 0 || areaPercent < minBlobPercent) continue;
      const x = zones.colStart[minCol] ?? 0;
      const y = zones.rowStart[minRow] ?? 0;
      const right = zones.colStart[maxCol + 1] ?? width;
      const bottom = zones.rowStart[maxRow + 1] ?? height;
      found.push({
        box: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
        area: blobPixels,
      });
    }

    found.sort((left, right) => right.area - left.area);
    // Keep the biggest motion regions; a frame full of noise must not produce
    // hundreds of boxes for the UI (or for the AI crop step).
    return found.slice(0, MAX_BOXES).map((entry) => entry.box);
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function passesColorFilter(
  rgb: Uint8Array | Uint32Array,
  pixel: number,
  filter: NonNullable<MotionSettings['colorFilter']> | undefined,
): boolean {
  if (filter === undefined) return true;
  const offset = pixel * 3;
  const r = rgb[offset] ?? 0;
  const g = rgb[offset + 1] ?? 0;
  const b = rgb[offset + 2] ?? 0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  const saturation = ((max - min) / max) * 100;
  if (filter.minSaturation !== undefined && saturation < filter.minSaturation) return false;
  const ranges = filter.hueRanges ?? [];
  if (ranges.length === 0) return true;
  const hue = hueOf(r, g, b, max, min);
  return ranges.some((range) => (range.from <= range.to ? hue >= range.from && hue <= range.to : hue >= range.from || hue <= range.to));
}

function hueOf(r: number, g: number, b: number, max: number, min: number): number {
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function unionOf(boxes: Box[]): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toGrid(zones: CompiledZones) {
  return {
    cols: zones.cols,
    rows: zones.rows,
    mode: zones.mode,
    cells: Array.from({ length: zones.rows }, (_unused, row) =>
      Array.from({ length: zones.cols }, (_cell, col) => zones.selected[row * zones.cols + col] === 1),
    ),
  };
}

export { compileZones, hasActiveCells };
