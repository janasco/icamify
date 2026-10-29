import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayoutConfig, LayoutTile, ResolvedIcamifyConfig, StreamKind } from '@icamify/core';

/**
 * Console layouts.
 *
 * The configuration file can ship layouts, but an operator resizing a tile in the
 * browser cannot (and should not) rewrite `icamify.json`: it is validated at boot,
 * may be read-only, and mixes secrets with presentation. Edits therefore live in
 * `<stateDir>/layouts.json`, which takes over once it exists — the layout grid is
 * UI state, not deployment configuration, and it survives restarts.
 *
 * Validation is strict enough that the UI cannot save a grid it cannot render:
 * bounds, overlap and unknown cameras are rejected with a message that names the
 * offending tile.
 */

export const MAX_LAYOUT_GRID = 8;
const MAX_TILES = 64;
const MAX_NAME = 80;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STREAMS: ReadonlySet<string> = new Set<StreamKind>(['sub', 'main']);

export class LayoutError extends Error {
  readonly code: string;
  readonly status = 400;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LayoutError';
    this.code = code;
  }
}

export interface LayoutServiceOptions {
  config: ResolvedIcamifyConfig;
  /** Directory that also holds the recording index and other mutable state. */
  stateDir: string;
  log?: (line: string) => void;
}

export interface LayoutListResult {
  layouts: LayoutConfig[];
  defaultLayoutId?: string;
  /** True when edits exist in the store (the configuration file no longer decides). */
  stored: boolean;
}

interface StoreFile {
  version: 1;
  layouts: LayoutConfig[];
}

export class LayoutService {
  private readonly options: LayoutServiceOptions;
  private readonly file: string;
  private layouts: LayoutConfig[] = [];
  private stored = false;
  private loading: Promise<void> | undefined;

  constructor(options: LayoutServiceOptions) {
    this.options = options;
    this.file = join(options.stateDir, 'layouts.json');
  }

  async list(): Promise<LayoutListResult> {
    await this.ensureLoaded();
    const defaultLayout = this.layouts.find((layout) => layout.isDefault) ?? this.layouts[0];
    return {
      layouts: this.layouts.map(cloneLayout),
      ...(defaultLayout === undefined ? {} : { defaultLayoutId: defaultLayout.id }),
      stored: this.stored,
    };
  }

  async get(id: string): Promise<LayoutConfig | undefined> {
    await this.ensureLoaded();
    const layout = this.layouts.find((candidate) => candidate.id === id);
    return layout === undefined ? undefined : cloneLayout(layout);
  }

  /**
   * Creates or replaces one layout. `id` comes from the URL for a PUT and is
   * authoritative, so a body that disagrees cannot silently rewrite another layout.
   */
  async save(input: unknown, id?: string): Promise<LayoutConfig> {
    await this.ensureLoaded();
    const layout = normalizeLayout(input, {
      cameraIds: this.cameraIds(),
      ...(id === undefined ? {} : { id }),
      ...(id === undefined ? {} : { existing: this.layouts.find((candidate) => candidate.id === id) }),
    });

    // Exactly one default: making a layout default demotes the previous one.
    if (layout.isDefault === true) {
      this.layouts = this.layouts.map((candidate) => ({ ...candidate, isDefault: false }));
    }
    const index = this.layouts.findIndex((candidate) => candidate.id === layout.id);
    if (index === -1) {
      if (this.layouts.length === 0) layout.isDefault = true;
      this.layouts.push(layout);
    } else {
      const previous = this.layouts[index]!;
      // A PUT that omits isDefault keeps the stored flag rather than flipping it.
      layout.isDefault = layout.isDefault ?? previous.isDefault;
      this.layouts[index] = layout;
    }
    await this.persist();
    this.options.log?.(`layouts: saved \"${layout.id}\" (${layout.columns}x${layout.rows}, ${layout.tiles?.length ?? 0} tile(s))`);
    return cloneLayout(layout);
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.layouts.findIndex((candidate) => candidate.id === id);
    if (index === -1) return false;
    const [removed] = this.layouts.splice(index, 1);
    // Never leave the console without a default layout.
    if (removed?.isDefault === true && this.layouts.length > 0) this.layouts[0]!.isDefault = true;
    await this.persist();
    this.options.log?.(`layouts: removed \"${id}\"`);
    return true;
  }

  async setDefault(id: string): Promise<LayoutConfig> {
    await this.ensureLoaded();
    if (!this.layouts.some((candidate) => candidate.id === id)) {
      throw new LayoutError('layout-not-found', `Layout \"${id}\" does not exist.`);
    }
    this.layouts = this.layouts.map((candidate) => ({ ...candidate, isDefault: candidate.id === id }));
    await this.persist();
    // Re-read: the map above replaced every object, so the pre-update one is stale.
    return cloneLayout(this.layouts.find((candidate) => candidate.id === id)!);
  }

  /** Drops stored edits and falls back to the configuration file. */
  async reset(): Promise<LayoutListResult> {
    this.layouts = (this.options.config.layouts ?? []).map(cloneLayout);
    this.stored = false;
    await this.persist();
    return await this.list();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loading === undefined) this.loading = this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    const fromConfig = (this.options.config.layouts ?? []).map(cloneLayout);
    let text: string | undefined;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      this.layouts = fromConfig;
      this.stored = false;
      return;
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoreFile>;
      if (!Array.isArray(parsed.layouts)) throw new Error('layouts is not an array');
      const cameraIds = this.cameraIds();
      const kept: LayoutConfig[] = [];
      for (const entry of parsed.layouts) {
        try {
          kept.push(normalizeLayout(entry, { cameraIds, tolerateUnknownCameras: true }));
        } catch (error) {
          // A camera removed from the config must not brick the console: the tile is
          // dropped and the rest of the layout is kept.
          this.options.log?.(
            `layouts: ignoring stored layout: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.layouts = kept.length > 0 ? kept : fromConfig;
      this.stored = kept.length > 0;
    } catch (error) {
      this.options.log?.(
        `layouts: ${this.file} is unreadable (${error instanceof Error ? error.message : String(error)}); using configured layouts`,
      );
      this.layouts = fromConfig;
      this.stored = false;
    }
  }

  private async persist(): Promise<void> {
    const payload: StoreFile = { version: 1, layouts: this.layouts };
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temp, this.file);
    this.stored = true;
  }

  private cameraIds(): Set<string> {
    return new Set((this.options.config.cameras ?? []).map((camera) => camera.id));
  }
}

export interface NormalizeOptions {
  cameraIds: ReadonlySet<string>;
  /** PUT: the id from the URL wins over whatever the body says. */
  id?: string;
  existing?: LayoutConfig | undefined;
  /**
   * Loading: tiles for cameras that no longer exist are dropped instead of
   * rejecting the whole stored file.
   */
  tolerateUnknownCameras?: boolean;
}

export function normalizeLayout(input: unknown, options: NormalizeOptions): LayoutConfig {
  if (typeof input !== 'object' || input === null) {
    throw new LayoutError('invalid-layout', 'A layout must be an object.');
  }
  const body = input as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : (options.existing?.name ?? '');
  if (name.length === 0) throw new LayoutError('invalid-name', 'name is required.');
  if (name.length > MAX_NAME) throw new LayoutError('invalid-name', `name must be at most ${MAX_NAME} characters.`);

  const id = options.id ?? (typeof body.id === 'string' && body.id.length > 0 ? body.id : slug(name));
  if (!ID_PATTERN.test(id)) {
    throw new LayoutError(
      'invalid-id',
      `id \"${id}\" must be lowercase letters, digits, dot, dash or underscore (max 64).`,
    );
  }

  const columns = integer(body.columns ?? options.existing?.columns, 'columns', 1, MAX_LAYOUT_GRID);
  const rows = integer(body.rows ?? options.existing?.rows, 'rows', 1, MAX_LAYOUT_GRID);

  const rawTiles = body.tiles ?? options.existing?.tiles ?? [];
  if (!Array.isArray(rawTiles)) throw new LayoutError('invalid-tiles', 'tiles must be an array.');
  if (rawTiles.length > MAX_TILES) {
    throw new LayoutError('too-many-tiles', `A layout can hold at most ${MAX_TILES} tiles.`);
  }

  const tiles: LayoutTile[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawTiles.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new LayoutError('invalid-tile', `tiles[${index}] must be an object.`);
    }
    const tile = raw as Record<string, unknown>;
    const cameraId = typeof tile.cameraId === 'string' ? tile.cameraId : '';
    if (cameraId.length === 0) {
      throw new LayoutError('invalid-tile', `tiles[${index}].cameraId is required.`);
    }
    if (!options.cameraIds.has(cameraId)) {
      if (options.tolerateUnknownCameras === true) continue;
      throw new LayoutError('unknown-camera', `tiles[${index}] references unknown camera \"${cameraId}\".`);
    }
    if (seen.has(cameraId)) {
      throw new LayoutError('duplicate-camera', `Camera \"${cameraId}\" appears more than once in this layout.`);
    }
    seen.add(cameraId);

    const x = integer(tile.x, `tiles[${index}].x`, 0, MAX_LAYOUT_GRID - 1);
    const y = integer(tile.y, `tiles[${index}].y`, 0, MAX_LAYOUT_GRID - 1);
    const width = integer(tile.width ?? 1, `tiles[${index}].width`, 1, MAX_LAYOUT_GRID);
    const height = integer(tile.height ?? 1, `tiles[${index}].height`, 1, MAX_LAYOUT_GRID);
    if (x + width > columns || y + height > rows) {
      throw new LayoutError(
        'tile-out-of-bounds',
        `Tile for \"${cameraId}\" (${x},${y} ${width}x${height}) exceeds the ${columns}x${rows} grid.`,
      );
    }
    for (const other of tiles) {
      if (overlaps({ x, y, width, height }, other)) {
        throw new LayoutError('tiles-overlap', `Tile for \"${cameraId}\" overlaps the tile for \"${other.cameraId}\".`);
      }
    }

    const tileConfig: LayoutTile = { cameraId, x, y, width, height };
    if (typeof tile.stream === 'string' && STREAMS.has(tile.stream)) tileConfig.stream = tile.stream as StreamKind;
    if (typeof tile.muted === 'boolean') tileConfig.muted = tile.muted;
    if (typeof tile.showOverlay === 'boolean') tileConfig.showOverlay = tile.showOverlay;
    tiles.push(tileConfig);
  }

  const layout: LayoutConfig = { id, name, columns, rows, tiles };
  const isDefault = body.isDefault ?? options.existing?.isDefault;
  if (typeof isDefault === 'boolean') layout.isDefault = isDefault;
  const autoFill = body.autoFill ?? options.existing?.autoFill;
  if (typeof autoFill === 'boolean') layout.autoFill = autoFill;
  return layout;
}

/** Grid overlap test on cell rectangles. */
export function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width?: number; height?: number },
): boolean {
  const rightWidth = right.width ?? 1;
  const rightHeight = right.height ?? 1;
  return (
    left.x < right.x + rightWidth &&
    right.x < left.x + left.width &&
    left.y < right.y + rightHeight &&
    right.y < left.y + left.height
  );
}

/** First free cell for a camera that is not placed yet, scanning row by row. */
export function firstFreeCell(
  tiles: ReadonlyArray<Pick<LayoutTile, 'x' | 'y' | 'width' | 'height'>>,
  columns: number,
  rows: number,
): { x: number; y: number } | undefined {
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      if (!tiles.some((tile) => overlaps({ x, y, width: 1, height: 1 }, tile))) return { x, y };
    }
  }
  return undefined;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new LayoutError('invalid-number', `${field} must be a whole number.`);
  }
  if (parsed < min || parsed > max) {
    throw new LayoutError('out-of-range', `${field} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length === 0 ? 'layout' : base;
}

function cloneLayout(layout: LayoutConfig): LayoutConfig {
  return {
    ...layout,
    tiles: (layout.tiles ?? []).map((tile) => ({ ...tile })),
  };
}
