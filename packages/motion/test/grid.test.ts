import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ZoneGrid } from '@icamify/core';
import { compileZones, fullFrameZones, hasActiveCells } from '../src/grid.ts';

const WIDTH = 40;
const HEIGHT = 30;

function grid(cols: number, rows: number, selected: (col: number, row: number) => boolean, mode: 'include' | 'exclude' = 'include'): ZoneGrid {
  return {
    cols,
    rows,
    mode,
    cells: Array.from({ length: rows }, (_unused, row) =>
      Array.from({ length: cols }, (_cell, col) => selected(col, row)),
    ),
  };
}

describe('compileZones', () => {
  it('maps every pixel to exactly one cell and records cell areas', () => {
    const zones = compileZones(grid(4, 3, () => true), WIDTH, HEIGHT);
    assert.equal(zones.cols, 4);
    assert.equal(zones.rows, 3);
    assert.equal(zones.activeCells, 12);

    const area = zones.cellPixels.reduce((total, value) => total + value, 0);
    assert.equal(area, WIDTH * HEIGHT, 'cell areas must tile the frame exactly');

    for (let x = 0; x < WIDTH; x += 1) assert.ok(zones.colOfX[x]! >= 0 && zones.colOfX[x]! < 4);
    for (let y = 0; y < HEIGHT; y += 1) assert.ok(zones.rowOfY[y]! >= 0 && zones.rowOfY[y]! < 3);
  });

  it('treats include masks as "monitor only these cells"', () => {
    const zones = compileZones(grid(4, 3, (col) => col < 2), WIDTH, HEIGHT);
    assert.equal(zones.activeCells, 6);
    assert.equal(zones.active[0], 1);
    assert.equal(zones.active[3], 0);
    assert.ok(hasActiveCells(zones));
  });

  it('treats exclude masks as "ignore these cells"', () => {
    const zones = compileZones(grid(4, 3, (col) => col < 2, 'exclude'), WIDTH, HEIGHT);
    assert.equal(zones.activeCells, 6);
    assert.equal(zones.active[0], 0);
    assert.equal(zones.active[3], 1);
  });

  it('reports an all-excluded mask as having no active cells', () => {
    const zones = compileZones(grid(4, 3, () => false), WIDTH, HEIGHT);
    assert.equal(zones.activeCells, 0);
    assert.equal(hasActiveCells(zones), false);
  });

  it('clamps absurd grid sizes instead of allocating wild arrays', () => {
    const zones = compileZones(grid(2, 2, () => true), WIDTH, HEIGHT);
    assert.equal(zones.colStart.length, 3);
    assert.equal(zones.colStart[0], 0);
    assert.equal(zones.colStart[2], WIDTH);
  });

  it('builds a full-frame mask for cameras without zone configuration', () => {
    const zones = fullFrameZones(WIDTH, HEIGHT, 8, 6);
    assert.equal(zones.activeCells, 48);
    assert.equal(zones.cellPixels.reduce((total, value) => total + value, 0), WIDTH * HEIGHT);
  });
});
