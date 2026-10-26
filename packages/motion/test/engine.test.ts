import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MotionSettings, ZoneGrid } from '@icamify/core';
import { createMotionEngine, type Frame } from '../src/index.ts';

const WIDTH = 32;
const HEIGHT = 24;

function settings(overrides: Partial<MotionSettings> = {}): MotionSettings {
  return {
    enabled: true,
    // Explicit knobs, so the tests do not depend on the sensitivity curve.
    threshold: 20,
    percentThreshold: 1,
    warmupFrames: 2,
    blurRadius: 0,
    denoise: 0,
    minBlobPercent: 0.2,
    postMotionSeconds: 0,
    cooldownSeconds: 0,
    ...overrides,
  };
}

function grid(select: (col: number, row: number) => boolean = () => true, mode: 'include' | 'exclude' = 'include'): ZoneGrid {
  const cols = 4;
  const rows = 3;
  return {
    cols,
    rows,
    mode,
    cells: Array.from({ length: rows }, (_unused, row) => Array.from({ length: cols }, (_cell, col) => select(col, row))),
  };
}

function blank(timestamp: number, value = 100): Frame {
  const luma = new Uint8Array(WIDTH * HEIGHT).fill(value);
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3).fill(value);
  return { cameraId: 'cam', timestamp, width: WIDTH, height: HEIGHT, luma, rgb };
}

function paint(frame: Frame, rect: { x: number; y: number; width: number; height: number }, value: number, rgb?: [number, number, number]): Frame {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const pixel = y * WIDTH + x;
      frame.luma[pixel] = value;
      const offset = pixel * 3;
      if (rgb === undefined) {
        frame.rgb![offset] = value;
        frame.rgb![offset + 1] = value;
        frame.rgb![offset + 2] = value;
      } else {
        frame.rgb![offset] = rgb[0];
        frame.rgb![offset + 1] = rgb[1];
        frame.rgb![offset + 2] = rgb[2];
      }
    }
  }
  return frame;
}

/** Feeds the warmup frames every test needs before detection starts. */
function warm(engine: ReturnType<typeof createMotionEngine>): void {
  engine.analyze(blank(0));
  engine.analyze(blank(100));
}

describe('PixelMotionEngine', () => {
  it('returns null while warming up and reports no motion for a static scene', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    assert.equal(engine.analyze(blank(0)), null);
    assert.equal(engine.analyze(blank(100)), null);
    const detection = engine.analyze(blank(200));
    assert.ok(detection !== null);
    assert.equal(detection.motion, false);
    assert.equal(detection.changedPercent, 0);
    assert.deepEqual(detection.boxes, []);
  });

  it('detects a moving block and reports a box around it', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    const detection = engine.analyze(paint(blank(300), { x: 4, y: 4, width: 8, height: 8 }, 255));
    assert.ok(detection !== null);
    assert.equal(detection.motion, true);
    assert.ok(detection.changedPercent > 0);
    assert.equal(detection.boxes.length, 1);
    const box = detection.boxes[0]!;
    assert.ok(box.x <= 4 && box.y <= 4, 'box must contain the changed region');
    assert.ok(box.x + box.width >= 12 && box.y + box.height >= 12);
    assert.ok(detection.region !== undefined);
  });

  it('reports the flipped cells for the UI overlay', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    const detection = engine.analyze(paint(blank(300), { x: 0, y: 0, width: 8, height: 8 }, 255));
    assert.ok(detection !== null);
    // Cell (0,0) covers x 0..8 / y 0..8 on a 4x3 grid over 32x24.
    assert.equal(detection.cells[0], 1);
    assert.equal(detection.cells[1], 0);
  });

  it('ignores changes outside include zones', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings(),
      zones: grid((col) => col >= 2),
    });
    warm(engine);
    const left = engine.analyze(paint(blank(300), { x: 0, y: 0, width: 8, height: 8 }, 255));
    assert.ok(left !== null);
    assert.equal(left.motion, false, 'left half is not monitored');
    assert.equal(left.changedPercent, 0);

    const right = engine.analyze(paint(blank(400), { x: 20, y: 8, width: 8, height: 8 }, 255));
    assert.ok(right !== null);
    assert.equal(right.motion, true, 'right half is monitored');
  });

  it('ignores changes inside exclude zones', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings(),
      zones: grid((col) => col < 2, 'exclude'),
    });
    warm(engine);
    const left = engine.analyze(paint(blank(300), { x: 0, y: 0, width: 8, height: 8 }, 255));
    assert.ok(left !== null);
    assert.equal(left.motion, false);
  });

  it('holds motion open for postMotionSeconds after the last change', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings({ postMotionSeconds: 1 }),
      zones: grid(),
    });
    warm(engine);
    const detected = engine.analyze(paint(blank(1000), { x: 4, y: 4, width: 8, height: 8 }, 255));
    assert.ok(detected !== null);
    assert.equal(detected.motion, true);

    // The object leaves: the background model was never overwritten by it, so
    // the return to the original scene is not a new detection — only hangover
    // keeps motion reported.
    const hanging = engine.analyze(blank(1200));
    assert.ok(hanging !== null);
    assert.equal(hanging.motion, true, 'hangover keeps the trigger open');

    const stillHanging = engine.analyze(blank(1900));
    assert.ok(stillHanging !== null);
    assert.equal(stillHanging.motion, true);

    const settled = engine.analyze(blank(2100));
    assert.ok(settled !== null);
    assert.equal(settled.motion, false);
  });

  it('clears the background model on reset', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    engine.analyze(paint(blank(300), { x: 4, y: 4, width: 8, height: 8 }, 255));
    engine.reset();
    assert.equal(engine.analyze(blank(400)), null, 'warmup restarts after reset');
  });

  it('applies a colour filter to changed pixels', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings({ colorFilter: { enabled: true, minSaturation: 30 } }),
      zones: grid(),
    });
    warm(engine);

    const grey = engine.analyze(paint(blank(300), { x: 4, y: 4, width: 8, height: 8 }, 200, [200, 200, 200]));
    assert.ok(grey !== null);
    assert.equal(grey.motion, false, 'a bright but colourless change is filtered out');

    const red = engine.analyze(paint(blank(400), { x: 4, y: 4, width: 8, height: 8 }, 200, [220, 40, 40]));
    assert.ok(red !== null);
    assert.equal(red.motion, true, 'a saturated change passes');
  });

  it('drops isolated pixels when denoise is enabled', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings({ denoise: 1 }), zones: grid() });
    warm(engine);
    const speck = blank(300);
    speck.luma[5 * WIDTH + 5] = 255;
    const detection = engine.analyze(speck);
    assert.ok(detection !== null);
    assert.equal(detection.motion, false);
  });

  it('requires a blob above minBlobPercent, not just changed cells', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings({ minBlobPercent: 20 }),
      zones: grid(),
    });
    warm(engine);
    // One cell is 64 px of 768 (8.3%): over the cell threshold but under the blob floor.
    const detection = engine.analyze(paint(blank(300), { x: 0, y: 0, width: 8, height: 8 }, 255));
    assert.ok(detection !== null);
    assert.equal(detection.changedPercent > 1, true);
    assert.deepEqual(detection.boxes, []);
    assert.equal(detection.motion, false);
  });

  it('survives a resolution change by rebuilding its model', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    const resized: Frame = {
      cameraId: 'cam',
      timestamp: 300,
      width: 64,
      height: 48,
      luma: new Uint8Array(64 * 48).fill(100),
      rgb: new Uint8Array(64 * 48 * 3).fill(100),
    };
    assert.equal(engine.analyze(resized), null, 'a new geometry restarts warmup');
    const stats = engine.stats();
    assert.equal(stats.width, 64);
    assert.equal(stats.height, 48);
  });

  it('reports zone and threshold state for the UI', () => {
    const engine = createMotionEngine({
      cameraId: 'cam',
      settings: settings({ sensitivity: 80 }),
      zones: grid((col) => col !== 0),
    });
    const stats = engine.stats();
    assert.equal(stats.zones.cols, 4);
    assert.equal(stats.zones.activeCells, 9);
    assert.equal(stats.zones.totalCells, 12);
    assert.equal(stats.thresholds.sensitivity, 80);
  });

  it('reconfigures zones without recreating the engine', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    engine.resize(WIDTH, HEIGHT);
    engine.configure({ zones: grid((col) => col >= 2) });
    const detection = engine.analyze(paint(blank(300), { x: 0, y: 0, width: 8, height: 8 }, 255));
    assert.ok(detection !== null);
    assert.equal(detection.motion, false);
  });

  it('adapts the background to an unchanged scene so a still image stops triggering', () => {
    const engine = createMotionEngine({ cameraId: 'cam', settings: settings(), zones: grid() });
    warm(engine);
    engine.analyze(paint(blank(300), { x: 4, y: 4, width: 16, height: 16 }, 255));
    let last = null;
    for (let index = 0; index < 1200; index += 1) {
      last = engine.analyze(paint(blank(400 + index * 100), { x: 4, y: 4, width: 16, height: 16 }, 255));
    }
    assert.ok(last !== null);
    assert.equal(last.motion, false, 'a permanently bright region becomes the background');
  });
});
