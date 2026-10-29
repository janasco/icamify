<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { LayoutConfig, LayoutTile } from '../types';

/**
 * Grid layout editor.
 *
 * A dashboard is a matrix of cells; a tile occupies a rectangle of them. Editing is
 * direct manipulation — drag to move, drag the bottom-right corner to resize — and
 * every intermediate position is rejected locally if it would overlap another tile,
 * so what is on screen is always a layout the server will accept.
 *
 * Nothing is persisted until Save: a half-dragged grid must not become the default
 * for everyone else watching the same NVR.
 */

const props = defineProps<{
  layout: LayoutConfig;
  cameras: Array<{ id: string; name: string }>;
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved', layout: LayoutConfig): void }>();

const MAX_GRID = 8;
const name = ref(props.layout.name);
const columns = ref(clamp(props.layout.columns, 1, MAX_GRID));
const rows = ref(clamp(props.layout.rows, 1, MAX_GRID));
const tiles = ref<LayoutTile[]>(
  (props.layout.tiles ?? []).map((tile) => ({
    cameraId: tile.cameraId,
    x: tile.x,
    y: tile.y,
    width: tile.width ?? 1,
    height: tile.height ?? 1,
    ...(tile.stream === undefined ? {} : { stream: tile.stream }),
  })),
);
const selected = ref<string | null>(null);
const board = ref<HTMLElement | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);

interface DragState {
  cameraId: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: LayoutTile;
  cellWidth: number;
  cellHeight: number;
  lastDx: number;
  lastDy: number;
}

/** Kept out of reactivity: a drag must not re-render on every pointer event. */
let drag: DragState | null = null;

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
});

function tileStyle(tile: LayoutTile): Record<string, string> {
  return {
    gridColumn: `${tile.x + 1} / span ${tile.width ?? 1}`,
    gridRow: `${tile.y + 1} / span ${tile.height ?? 1}`,
  };
}

function cameraName(cameraId: string): string {
  return props.cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
}

function isPlaced(cameraId: string): boolean {
  return tiles.value.some((tile) => tile.cameraId === cameraId);
}

function remove(cameraId: string): void {
  tiles.value = tiles.value.filter((tile) => tile.cameraId !== cameraId);
}

function onBoardClick(event: MouseEvent): void {
  if (selected.value === null) return;
  const cell = cellFromPoint(event);
  if (cell === undefined) return;
  if (tiles.value.some((tile) => covers(tile, cell.x, cell.y))) return;
  const cameraId = selected.value;
  tiles.value = [...tiles.value, { cameraId, x: cell.x, y: cell.y, width: 1, height: 1 }];
  selected.value = null;
}

function onPointerDown(event: PointerEvent, tile: LayoutTile, mode: 'move' | 'resize'): void {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const rect = board.value?.getBoundingClientRect();
  if (rect === undefined || rect.width === 0 || rect.height === 0) return;
  drag = {
    cameraId: tile.cameraId,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    origin: { cameraId: tile.cameraId, x: tile.x, y: tile.y, width: tile.width ?? 1, height: tile.height ?? 1 },
    cellWidth: rect.width / columns.value,
    cellHeight: rect.height / rows.value,
    lastDx: 0,
    lastDy: 0,
  };
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (drag === null) return;
  const dx = Math.round((event.clientX - drag.startX) / drag.cellWidth);
  const dy = Math.round((event.clientY - drag.startY) / drag.cellHeight);
  if (dx === drag.lastDx && dy === drag.lastDy) return;
  drag.lastDx = dx;
  drag.lastDy = dy;
  applyDrag(dx, dy);
}

function onPointerUp(): void {
  drag = null;
}

/**
 * Applies an incremental drag. Overlapping positions are simply not applied, which
 * gives the grid a hard edge: tiles slide until they touch another tile.
 */
function applyDrag(dx: number, dy: number): void {
  if (drag === null) return;
  const origin = drag.origin;
  const originWidth = origin.width ?? 1;
  const originHeight = origin.height ?? 1;
  let x = origin.x;
  let y = origin.y;
  let width = originWidth;
  let height = originHeight;

  if (drag.mode === 'move') {
    x = clamp(origin.x + dx, 0, columns.value - originWidth);
    y = clamp(origin.y + dy, 0, rows.value - originHeight);
  } else {
    width = clamp(originWidth + dx, 1, columns.value - origin.x);
    height = clamp(originHeight + dy, 1, rows.value - origin.y);
  }

  const candidate: LayoutTile = { cameraId: drag.cameraId, x, y, width, height };
  if (tiles.value.some((tile) => tile.cameraId !== candidate.cameraId && overlaps(candidate, tile))) return;

  tiles.value = tiles.value.map((tile) => (tile.cameraId === candidate.cameraId ? candidate : tile));
}

function cellFromPoint(point: { clientX: number; clientY: number }): { x: number; y: number } | undefined {
  const rect = board.value?.getBoundingClientRect();
  if (rect === undefined || rect.width === 0 || rect.height === 0) return undefined;
  const x = Math.floor(((point.clientX - rect.left) / rect.width) * columns.value);
  const y = Math.floor(((point.clientY - rect.top) / rect.height) * rows.value);
  if (x < 0 || y < 0 || x >= columns.value || y >= rows.value) return undefined;
  return { x, y };
}

function setColumns(value: string | number): void {
  columns.value = clamp(Number(value), 1, MAX_GRID);
  prune();
}

function setRows(value: string | number): void {
  rows.value = clamp(Number(value), 1, MAX_GRID);
  prune();
}

/** Shrinking the grid must not leave tiles floating outside it. */
function prune(): void {
  const next: LayoutTile[] = [];
  for (const tile of tiles.value) {
    const width = Math.min(tile.width ?? 1, columns.value);
    const height = Math.min(tile.height ?? 1, rows.value);
    const x = Math.min(tile.x, columns.value - width);
    const y = Math.min(tile.y, rows.value - height);
    if (x < 0 || y < 0) continue;
    const candidate: LayoutTile = { ...tile, x, y, width, height };
    if (next.some((other) => overlaps(candidate, other))) continue;
    next.push(candidate);
  }
  tiles.value = next;
}

function autoFill(): void {
  const next = [...tiles.value];
  for (const camera of props.cameras) {
    if (next.some((tile) => tile.cameraId === camera.id)) continue;
    const cell = firstFreeCell(next, columns.value, rows.value);
    if (cell === undefined) break;
    next.push({ cameraId: camera.id, x: cell.x, y: cell.y, width: 1, height: 1 });
  }
  tiles.value = next;
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const payload = {
      id: props.layout.id,
      name: name.value.trim().length === 0 ? props.layout.name : name.value.trim(),
      columns: columns.value,
      rows: rows.value,
      tiles: tiles.value,
      ...(props.layout.isDefault === undefined ? {} : { isDefault: props.layout.isDefault }),
    };
    const response = await api<{ layout: LayoutConfig }>(`/api/layouts/${encodeURIComponent(props.layout.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    emit('saved', response.layout);
    emit('close');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

function covers(tile: LayoutTile, x: number, y: number): boolean {
  return x >= tile.x && x < tile.x + (tile.width ?? 1) && y >= tile.y && y < tile.y + (tile.height ?? 1);
}

function overlaps(left: LayoutTile, right: LayoutTile): boolean {
  return (
    left.x < right.x + (right.width ?? 1) &&
    right.x < left.x + (left.width ?? 1) &&
    left.y < right.y + (right.height ?? 1) &&
    right.y < left.y + (left.height ?? 1)
  );
}

function firstFreeCell(
  list: ReadonlyArray<LayoutTile>,
  cols: number,
  count: number,
): { x: number; y: number } | undefined {
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!list.some((tile) => covers(tile, x, y))) return { x, y };
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card wide">
      <header class="modal-head">
        <div>
          <h2>Layout · {{ layout.name }}</h2>
          <p class="muted" style="margin: 2px 0 0; font-size: 12px">
            Drag a tile to move it · drag its corner to resize · {{ tiles.length }} tile(s) in a
            {{ columns }}×{{ rows }} grid
          </p>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </header>

      <div class="layout-editor">
        <aside class="layout-palette">
          <div class="layout-palette-head">Cameras</div>
          <button
            v-for="camera in cameras"
            :key="camera.id"
            class="palette-item"
            :class="{ active: selected === camera.id, placed: isPlaced(camera.id) }"
            :disabled="isPlaced(camera.id)"
            @click="selected = selected === camera.id ? null : camera.id"
          >
            <span class="name">{{ camera.name }}</span>
            <span class="mono">{{ isPlaced(camera.id) ? 'placed' : 'add' }}</span>
          </button>
          <p v-if="cameras.length === 0" class="hint">No cameras configured.</p>
          <p v-else-if="selected !== null" class="hint">Click an empty cell to place it.</p>
        </aside>

        <div class="layout-board-wrap">
          <div
            ref="board"
            class="layout-board"
            :style="{ '--cols': String(columns), '--rows': String(rows) }"
            @click="onBoardClick"
          >
            <div v-for="cell in columns * rows" :key="cell" class="layout-cell" />
            <div
              v-for="tile in tiles"
              :key="tile.cameraId"
              class="layout-tile"
              :style="tileStyle(tile)"
              @pointerdown.stop="onPointerDown($event, tile, 'move')"
            >
              <span class="layout-tile-name">{{ cameraName(tile.cameraId) }}</span>
              <span class="layout-tile-size mono">{{ tile.width ?? 1 }}×{{ tile.height ?? 1 }}</span>
              <button class="layout-tile-remove" title="Remove tile" @pointerdown.stop @click.stop="remove(tile.cameraId)">
                ✕
              </button>
              <span class="layout-resize" title="Resize" @pointerdown.stop="onPointerDown($event, tile, 'resize')" />
            </div>
          </div>
        </div>
      </div>

      <div class="zone-toolbar" style="margin-top: 12px">
        <label class="mono" for="layout-columns">Columns</label>
        <select id="layout-columns" :value="columns" @change="setColumns(($event.target as HTMLSelectElement).value)">
          <option v-for="count in MAX_GRID" :key="count" :value="count">{{ count }}</option>
        </select>
        <label class="mono" for="layout-rows">Rows</label>
        <select id="layout-rows" :value="rows" @change="setRows(($event.target as HTMLSelectElement).value)">
          <option v-for="count in MAX_GRID" :key="count" :value="count">{{ count }}</option>
        </select>
        <span class="spacer"></span>
        <button class="ghost" @click="autoFill">Auto-fill cameras</button>
        <button class="ghost" @click="tiles = []">Clear</button>
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>

      <footer class="modal-actions">
        <span class="spacer"></span>
        <button @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save layout' }}</button>
      </footer>
    </div>
  </div>
</template>
