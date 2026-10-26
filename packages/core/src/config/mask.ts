/**
 * The visual zone matrix.
 *
 * The UI paints an N x M grid of inclusion/exclusion cells; on disk it is
 * stored as one row per line of '1' (active) and '0' (ignored), separated by
 * '/'. That format is compact, diffable and easy to validate.
 */

export interface ZoneMaskInput {
  cols?: number;
  rows?: number;
  cells?: string;
  mode?: 'include' | 'exclude';
}

export interface ZoneMaskError {
  message: string;
  code: 'mask-rows' | 'mask-cols' | 'mask-empty' | 'mask-chars';
}

export const DEFAULT_GRID = 16;

export function decodeZoneMask(cells: string | undefined, cols = DEFAULT_GRID, rows = DEFAULT_GRID): boolean[][] {
  if (!cells) return Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));
  return cells.split('/').map((row) => [...row].map((ch) => ch === '1'));
}

export function encodeZoneMask(grid: boolean[][]): string {
  return grid.map((row) => row.map((active) => (active ? '1' : '0')).join('')).join('/');
}

export function allActiveMask(cols = DEFAULT_GRID, rows = DEFAULT_GRID): string {
  return encodeZoneMask(Array.from({ length: rows }, () => Array.from({ length: cols }, () => true)));
}

export function zoneMaskIssues(mask: ZoneMaskInput | undefined, basePath: string): ZoneMaskError[] {
  if (!mask) return [];
  const cols = mask.cols ?? DEFAULT_GRID;
  const rows = mask.rows ?? DEFAULT_GRID;
  const issues: ZoneMaskError[] = [];

  if (!mask.cells) return issues;

  if (/[^01/]/.test(mask.cells)) {
    issues.push({ message: `${basePath}.cells may only contain '0', '1' and '/'`, code: 'mask-chars' });
    return issues;
  }

  const lines = mask.cells.split('/');
  if (lines.length !== rows) {
    issues.push({
      message: `${basePath}.cells has ${lines.length} rows but zones.rows is ${rows}`,
      code: 'mask-rows',
    });
  }
  const badRow = lines.findIndex((line) => line.length !== cols);
  if (badRow !== -1) {
    issues.push({
      message: `${basePath}.cells row ${badRow + 1} has ${lines[badRow]!.length} cells but zones.cols is ${cols}`,
      code: 'mask-cols',
    });
  }
  if (!lines.some((line) => line.includes('1'))) {
    issues.push({
      message: `${basePath}.cells ignores every cell; motion can never be detected`,
      code: 'mask-empty',
    });
  }

  return issues;
}

/** Zone state as the API/UI sees it. */
export interface ZoneGrid {
  cols: number;
  rows: number;
  cells: boolean[][];
  mode: 'include' | 'exclude';
}

export function toZoneGrid(mask: ZoneMaskInput | undefined): ZoneGrid {
  const cols = mask?.cols ?? DEFAULT_GRID;
  const rows = mask?.rows ?? DEFAULT_GRID;
  return {
    cols,
    rows,
    cells: decodeZoneMask(mask?.cells, cols, rows),
    mode: mask?.mode ?? 'include',
  };
}

/** Number of active cells (the denominator for percentThreshold). */
export function activeCellCount(grid: ZoneGrid): number {
  return grid.cells.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}
