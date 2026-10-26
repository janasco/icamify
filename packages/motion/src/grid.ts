import { toZoneGrid, type ZoneGrid, type ZoneMaskInput } from '@icamify/core';

/**
 * The zone matrix, compiled for the hot loop.
 *
 * `cells` in the config are "selected" cells. How selection is interpreted
 * depends on `mode`:
 * - `include` (default): only selected cells are monitored — you paint the area
 *   that matters (a driveway, a till, a doorway).
 * - `exclude`: selected cells are ignored — you paint what must never trigger,
 *   such as a tree line that moves in the wind or a public footpath.
 *
 * Both compile to a single `active` bitmap, because the pixel loop must not
 * branch on mode per pixel.
 */

export interface CompiledZones {
  cols: number;
  rows: number;
  mode: 'include' | 'exclude';
  /** 1 where the operator selected the cell. */
  selected: Uint8Array;
  /** 1 where motion counts. */
  active: Uint8Array;
  activeCells: number;
  /** Pixels per cell, used to turn a pixel count into a percentage. */
  cellPixels: Uint32Array;
  /** Cell index per pixel column/row; precomputed to keep the loop branchless. */
  colOfX: Uint16Array;
  rowOfY: Uint16Array;
  colStart: Uint32Array;
  rowStart: Uint32Array;
}

export function compileZones(zones: ZoneGrid, width: number, height: number): CompiledZones {
  const cols = Math.max(1, Math.min(128, Math.round(zones.cols)));
  const rows = Math.max(1, Math.min(128, Math.round(zones.rows)));
  const total = cols * rows;
  const selected = new Uint8Array(total);
  const active = new Uint8Array(total);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const chosen = zones.cells[row]?.[col] === true;
      if (chosen) selected[index] = 1;
      if (zones.mode === 'exclude') {
        if (!chosen) active[index] = 1;
      } else if (chosen) {
        active[index] = 1;
      }
    }
  }

  let activeCells = 0;
  for (let index = 0; index < total; index += 1) activeCells += active[index] === 1 ? 1 : 0;

  const colStart = cellStarts(cols, width);
  const rowStart = cellStarts(rows, height);
  const cellPixels = new Uint32Array(total);
  for (let row = 0; row < rows; row += 1) {
    const rowSpan = (rowStart[row + 1] ?? height) - (rowStart[row] ?? 0);
    for (let col = 0; col < cols; col += 1) {
      const colSpan = (colStart[col + 1] ?? width) - (colStart[col] ?? 0);
      cellPixels[row * cols + col] = rowSpan * colSpan;
    }
  }

  const colOfX = new Uint16Array(Math.max(0, width));
  for (let col = 0; col < cols; col += 1) {
    const from = colStart[col] ?? 0;
    const to = colStart[col + 1] ?? width;
    for (let x = from; x < to; x += 1) colOfX[x] = col;
  }
  const rowOfY = new Uint16Array(Math.max(0, height));
  for (let row = 0; row < rows; row += 1) {
    const from = rowStart[row] ?? 0;
    const to = rowStart[row + 1] ?? height;
    for (let y = from; y < to; y += 1) rowOfY[y] = row;
  }

  return { cols, rows, mode: zones.mode, selected, active, activeCells, cellPixels, colOfX, rowOfY, colStart, rowStart };
}

export function compileZonesFromMask(mask: ZoneMaskInput | undefined, width: number, height: number): CompiledZones {
  return compileZones(toZoneGrid(mask), width, height);
}

/**
 * Guard for masks that would silently disable motion: an all-excluded include
 * mask, or an all-selected exclude mask, both leave zero active cells. The
 * caller decides whether to fall back to the full frame or refuse to start.
 */
export function hasActiveCells(zones: CompiledZones): boolean {
  return zones.activeCells > 0;
}

/** Full-frame mask, used as the fallback when a camera has no zone configuration. */
export function fullFrameZones(width: number, height: number, cols = 16, rows = 16): CompiledZones {
  return compileZones(
    {
      cols,
      rows,
      cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => true)),
      mode: 'include',
    },
    width,
    height,
  );
}

/** Cell boundary array of length `count + 1`; the last entry is the frame edge. */
function cellStarts(count: number, span: number): Uint32Array {
  const starts = new Uint32Array(count + 1);
  for (let index = 0; index <= count; index += 1) {
    starts[index] = Math.min(span, Math.round((index * span) / count));
  }
  starts[count] = span;
  return starts;
}
