import type { MotionSettings } from '@icamify/core';
import type { ZoneGrid } from '@icamify/core';
import { PixelMotionEngine } from './engine.ts';

/**
 * Motion detection.
 *
 * The engine consumes small raw frames (luma, 320x180 by default) produced by the
 * `detect` pipeline, compares them with a background model, applies the zone
 * matrix and emits debounced motion events with bounding boxes for AI cropping.
 * Everything here is pure computation on typed arrays: no I/O, no FFmpeg, no clock
 * of its own beyond the frame timestamps the caller supplies.
 */

export interface Frame {
  cameraId: string;
  /** Monotonic capture timestamp in epoch milliseconds. */
  timestamp: number;
  width: number;
  height: number;
  /** 8-bit luma plane, width x height. */
  luma: Uint8Array;
  /** RGB24 plane, present only when the pipeline emits colour (colour filters). */
  rgb?: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when coordinates are 0..1 instead of pixels. */
  normalized?: boolean;
}

export interface MotionDetection {
  cameraId: string;
  timestamp: number;
  motion: boolean;
  /** Share of active zone cells that changed, 0..100. */
  changedPercent: number;
  /**
   * Flipped cells for the UI overlay, row-major, one 0/1 byte per cell.
   * This array is reused between frames; copy it if you need to retain it.
   */
  cells: Uint8Array;
  /** Merged changed regions after min-blob filtering, in analysis-frame pixels. */
  boxes: Box[];
  /** Union of boxes, used to crop the frame for AI. */
  region?: Box;
}

export interface MotionEngineOptions {
  settings: MotionSettings;
  zones: ZoneGrid;
}

export interface MotionEngine {
  readonly cameraId: string;
  /** Feed a frame; returns null while warming up. */
  analyze(frame: Frame): MotionDetection | null;
  /** Clears the background model, e.g. after a camera reconnect. */
  reset(): void;
  /** Adjusts sensitivity/zones without recreating the engine. */
  configure(options: Partial<MotionEngineOptions>): void;
}

export interface MotionEvent {
  cameraId: string;
  startedAt: number;
  endedAt?: number;
  peakPercent: number;
  boxes: Box[];
}

/** Convenience factory; the class is exported too for tests and type narrowing. */
export function createMotionEngine(options: MotionEngineOptions & { cameraId: string }): PixelMotionEngine {
  return new PixelMotionEngine(options);
}

export { PixelMotionEngine, type MotionEngineStats } from './engine.ts';
export {
  compileZones,
  compileZonesFromMask,
  fullFrameZones,
  hasActiveCells,
  type CompiledZones,
} from './grid.ts';
export { RawFrameReader, type PixelFormat, type RawFrameReaderOptions } from './frame.ts';

export const MOTION_VERSION = '0.1.0';
