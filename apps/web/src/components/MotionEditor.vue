<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { CameraView, MotionResponse, MotionStatus } from '../types';

/**
 * The visual zone matrix.
 *
 * `include` means "only the painted cells are monitored"; `exclude` means "the
 * painted cells are ignored". Cells are painted with a click-drag, because a
 * 16x16 grid of checkboxes is unusable with a mouse and impossible on a tablet.
 *
 * Saving writes a runtime override through the API (persisted under the state
 * directory), so the config file stays the source of truth for a fresh install
 * while a tuned mask survives restarts.
 */

const props = defineProps<{ camera: CameraView }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved', status: MotionStatus): void }>();

const status = ref<MotionStatus | null>(null);
const cells = ref<boolean[][]>([]);
const cols = ref(16);
const rows = ref(16);
const mode = ref<'include' | 'exclude'>('include');
const sensitivity = ref(50);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const paintValue = ref<boolean | null>(null);

const activeCells = computed(() => cells.value.flat().filter(Boolean).length);
const includesEverything = computed(() => mode.value === 'include' && activeCells.value === cols.value * rows.value);

onMounted(() => {
  void load();
  window.addEventListener('pointerup', stopPainting);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', stopPainting);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api<MotionResponse>(`/api/cameras/${encodeURIComponent(props.camera.id)}/motion`);
    const motion = response.motion;
    status.value = motion;
    if (motion === null) {
      error.value = 'This camera has no motion configuration.';
      return;
    }
    cols.value = motion.zones.cols;
    rows.value = motion.zones.rows;
    mode.value = motion.zones.mode;
    sensitivity.value = motion.settings.sensitivity;
    cells.value = motion.zones.cells.map((row) => [...row]);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

function setCell(row: number, col: number, value: boolean): void {
  const target = cells.value[row];
  if (target === undefined || target[col] === value) return;
  target[col] = value;
}

function pointerDown(row: number, col: number, event: PointerEvent): void {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const current = cells.value[row]?.[col] ?? false;
  paintValue.value = !current;
  setCell(row, col, paintValue.value);
}

function pointerEnter(row: number, col: number): void {
  if (paintValue.value === null) return;
  setCell(row, col, paintValue.value);
}

function stopPainting(): void {
  paintValue.value = null;
}

function fill(value: boolean): void {
  cells.value = Array.from({ length: rows.value }, () => Array.from({ length: cols.value }, () => value));
}

function invert(): void {
  cells.value = cells.value.map((row) => row.map((cell) => !cell));
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const response = await api<{ motion: MotionStatus }>(`/api/cameras/${encodeURIComponent(props.camera.id)}/motion`, {
      method: 'PUT',
      body: JSON.stringify({
        sensitivity: sensitivity.value,
        zones: { cols: cols.value, rows: rows.value, mode: mode.value, cells: cells.value },
      }),
    });
    emit('saved', response.motion);
    emit('close');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card">
      <header class="modal-head">
        <div>
          <h2>Motion zones · {{ camera.name }}</h2>
          <p class="muted" style="margin: 2px 0 0; font-size: 12px">
            {{ mode === 'include' ? 'Painted cells are monitored' : 'Painted cells are ignored' }} ·
            {{ activeCells }} / {{ cols * rows }} cells active
          </p>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </header>

      <div v-if="loading" class="empty" style="padding: 30px">Loading motion settings…</div>

      <template v-else>
        <div class="zone-toolbar">
          <div class="group">
            <button :class="{ active: mode === 'include' }" @click="mode = 'include'">Include</button>
            <button :class="{ active: mode === 'exclude' }" @click="mode = 'exclude'">Exclude</button>
          </div>
          <button class="ghost" @click="fill(true)">Fill</button>
          <button class="ghost" @click="fill(false)">Clear</button>
          <button class="ghost" @click="invert">Invert</button>
          <span class="spacer"></span>
          <span v-if="status" class="pill mono">
            {{ status.analysis.width }}×{{ status.analysis.height }} @ {{ status.analysis.fps }}fps
          </span>
        </div>

        <div
          class="zone-grid"
          :style="{ '--zone-cols': String(cols) }"
          role="grid"
          aria-label="Motion zone matrix"
          @pointerleave="stopPainting"
        >
          <div v-for="(row, rowIndex) in cells" :key="rowIndex" class="zone-row" role="row">
            <span
              v-for="(cell, colIndex) in row"
              :key="colIndex"
              class="zone-cell"
              :class="{ on: cell, excluded: mode === 'exclude' && cell }"
              role="gridcell"
              :aria-selected="cell"
              @pointerdown="pointerDown(rowIndex, colIndex, $event)"
              @pointerenter="pointerEnter(rowIndex, colIndex)"
            />
          </div>
        </div>

        <div class="slider-row">
          <label for="sensitivity">Sensitivity</label>
          <input id="sensitivity" v-model.number="sensitivity" type="range" min="1" max="100" step="1" />
          <span class="mono">{{ sensitivity }}</span>
        </div>
        <p class="hint" style="margin-top: 4px">
          <template v-if="status">
            Effective thresholds: {{ status.thresholds.threshold }} luma per pixel,
            {{ status.thresholds.percentThreshold }}% of active cells.
            <template v-if="!status.thresholds.derivedFromSensitivity">
              This camera pins thresholds in its config file, so the slider has no effect.
            </template>
          </template>
          <template v-if="includesEverything">The whole frame is monitored.</template>
        </p>

        <p v-if="error" class="error-text">{{ error }}</p>

        <footer class="modal-actions">
          <button class="ghost" @click="fill(true); mode = 'include'">Reset to full frame</button>
          <span class="spacer"></span>
          <button @click="emit('close')">Cancel</button>
          <button class="primary" :disabled="saving || activeCells === 0" @click="save">
            {{ saving ? 'Saving…' : 'Save zones' }}
          </button>
        </footer>
      </template>
    </div>
  </div>
</template>
