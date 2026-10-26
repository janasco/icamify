import type { MotionSettings, ZoneGrid } from '@icamify/core';

/**
 * Motion detection contracts (Phase 3).
 *
 * The engine consumes small raw frames (luma, 320x180 by default) produced by
 * the `detect` pipeline, compares them with a background model, applies the zone
 * matrix and emits debounced motion events with bounding boxes for AI cropping.
 */

export interface Frame {
  cameraId: string;
  /** Monotonic capture timestamp in epoch milliseconds. */
  timestamp: number;
  width: number;
  height: number;
  /** 8-bit luma plane, width x height. */
  luma: Uint8Array;
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
  /** Active cells that flipped, row-major, 0/1 per cell. */
  cells: Uint8Array;
  /** Merged changed regions after min-blob filtering, in source pixels. */
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
  configure(options: MotionEngineOptions): void;
}

export interface MotionEvent {
  cameraId: string;
  startedAt: number;
  endedAt?: number;
  peakPercent: number;
  boxes: Box[];
}
