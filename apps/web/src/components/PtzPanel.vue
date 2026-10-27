<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { CameraView, PtzStatus } from '../types';

/**
 * PTZ control pad.
 *
 * Moves are `ContinuousMove` with an explicit stop timeout: a click pans for the
 * selected duration, not until the arrow is released, which keeps every action a
 * single request the server can bound. A manual move also pauses any running
 * patrol on the server for a minute, so the pad never fights the tour.
 */

const props = defineProps<{ camera: CameraView }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const status = ref<PtzStatus | null>(null);
const loading = ref(true);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const speed = ref(0.6);
const durationMs = ref(500);
const now = ref(Date.now());

const padBusy = computed(() => busy.value !== null);
const patrolPausedFor = computed(() => {
  const pausedUntil = status.value?.patrol.pausedUntil;
  if (pausedUntil === undefined) return 0;
  return Math.max(0, Math.ceil((pausedUntil - now.value) / 1000));
});
const configuredPresets = computed(() => (status.value?.presets ?? []).filter((preset) => preset.source !== 'device'));
const devicePresets = computed(() => (status.value?.presets ?? []).filter((preset) => preset.source === 'device'));

let clock: number | null = null;

onMounted(() => {
  void load();
  window.addEventListener('keydown', onKey);
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (clock !== null) window.clearInterval(clock);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    status.value = await api<PtzStatus>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz`);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function refreshPresets(): Promise<void> {
  busy.value = 'presets';
  error.value = null;
  try {
    status.value = await api<PtzStatus>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz/refresh`, {
      method: 'POST',
    });
    notice.value = `Loaded ${devicePresets.value.length} preset(s) from the camera.`;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = null;
  }
}

async function move(pan: number, tilt: number, zoom = 0): Promise<void> {
  await act('move', async () => {
    await api(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz/move`, {
      method: 'POST',
      body: JSON.stringify({ pan: pan * speed.value, tilt: tilt * speed.value, zoom: zoom * speed.value, durationMs: durationMs.value }),
    });
    notice.value = `Moved ${describeVector(pan, tilt, zoom)} for ${durationMs.value} ms.`;
  });
}

async function stop(): Promise<void> {
  await act('stop', async () => {
    await api(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz/stop`, { method: 'POST' });
    notice.value = 'Stopped.';
  });
}

async function goto(name: string): Promise<void> {
  await act(`preset:${name}`, async () => {
    await api(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz/preset`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    notice.value = `Moved to “${name}”. Patrol paused for a minute.`;
  });
}

async function togglePatrol(): Promise<void> {
  if (status.value === null) return;
  const enabled = !status.value.patrol.enabled;
  await act('patrol', async () => {
    status.value = await api<PtzStatus>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ptz/patrol`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    notice.value = enabled ? 'Patrol started.' : 'Patrol stopped.';
  });
}

async function act(key: string, run: () => Promise<void>): Promise<void> {
  if (busy.value !== null) return;
  busy.value = key;
  error.value = null;
  try {
    await run();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = null;
  }
}

function describeVector(pan: number, tilt: number, zoom: number): string {
  const parts = [
    ...(pan === 0 ? [] : [pan > 0 ? 'right' : 'left']),
    ...(tilt === 0 ? [] : [tilt > 0 ? 'up' : 'down']),
    ...(zoom === 0 ? [] : [zoom > 0 ? 'zoom in' : 'zoom out']),
  ];
  return parts.join(' + ') || 'nothing';
}

/** Arrow keys mirror the pad while it is open; Space is the emergency stop. */
function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (busy.value !== null) return;
  const keys: Record<string, [number, number, number]> = {
    ArrowUp: [0, 1, 0],
    ArrowDown: [0, -1, 0],
    ArrowLeft: [-1, 0, 0],
    ArrowRight: [1, 0, 0],
    '+': [0, 0, 1],
    '=': [0, 0, 1],
    '-': [0, 0, -1],
  };
  if (event.key === ' ' || event.key === 'Escape') {
    event.preventDefault();
    if (event.key === 'Escape') emit('close');
    else void stop();
    return;
  }
  const vector = keys[event.key];
  if (vector === undefined) return;
  event.preventDefault();
  void move(vector[0], vector[1], vector[2]);
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card">
      <header class="modal-head">
        <div>
          <h2>PTZ · {{ camera.name }}</h2>
          <p class="muted" style="margin: 2px 0 0; font-size: 12px">
            <template v-if="status?.endpoint !== undefined">{{ status.endpoint }}</template>
            <template v-else>{{ camera.source.label }} · {{ camera.source.masked }}</template>
            <template v-if="status?.profileToken !== undefined"> · profile {{ status.profileToken }}</template>
          </p>
        </div>
        <div class="spacer"></div>
        <span v-if="status" class="pill" :class="status.reachable ? 'ok' : 'warn'">
          <span class="dot" :class="status.reachable ? 'live' : 'warn'"></span>
          {{ status.reachable ? 'online' : 'not contacted' }}
        </span>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </header>

      <div v-if="loading" class="empty" style="padding: 24px">Loading PTZ state…</div>

      <div v-else-if="status === null || !status.supported" class="hint">
        <strong>No PTZ control for this camera.</strong>
        <p style="margin: 6px 0 0">{{ status?.reason ?? 'The server did not report an ONVIF endpoint.' }}</p>
        <p style="margin: 6px 0 0">
          Set <code>ptz.host</code> in the camera's configuration, or use an <code>onvif</code>/<code>rtsp</code> main stream so the
          host can be derived.
        </p>
      </div>

      <template v-else>
        <div class="ptz-layout">
          <div class="ptz-pad">
            <button class="ptz-key" :disabled="padBusy" title="Up-left" @click="move(-1, 1)">↖</button>
            <button class="ptz-key" :disabled="padBusy" title="Up" @click="move(0, 1)">↑</button>
            <button class="ptz-key" :disabled="padBusy" title="Up-right" @click="move(1, 1)">↗</button>
            <button class="ptz-key" :disabled="padBusy" title="Left" @click="move(-1, 0)">←</button>
            <button class="ptz-key stop" :disabled="padBusy" title="Stop" @click="stop()">■</button>
            <button class="ptz-key" :disabled="padBusy" title="Right" @click="move(1, 0)">→</button>
            <button class="ptz-key" :disabled="padBusy" title="Down-left" @click="move(-1, -1)">↙</button>
            <button class="ptz-key" :disabled="padBusy" title="Down" @click="move(0, -1)">↓</button>
            <button class="ptz-key" :disabled="padBusy" title="Down-right" @click="move(1, -1)">↘</button>
          </div>

          <div class="ptz-side">
            <div class="ptz-zoom">
              <button :disabled="padBusy" title="Zoom in" @click="move(0, 0, 1)">Zoom +</button>
              <button :disabled="padBusy" title="Zoom out" @click="move(0, 0, -1)">Zoom −</button>
            </div>

            <div class="slider-row" style="margin-top: 6px">
              <label for="ptz-speed">Speed</label>
              <input id="ptz-speed" v-model.number="speed" type="range" min="0.1" max="1" step="0.1" />
              <span class="mono">{{ Math.round(speed * 100) }}%</span>
            </div>

            <div class="ptz-mode-row">
              <span class="muted" style="font-size: 12px">Step</span>
              <div class="group">
                <button v-for="step in [250, 500, 1000, 2000]" :key="step" :class="{ active: durationMs === step }" @click="durationMs = step">
                  {{ step }}ms
                </button>
              </div>
            </div>

            <div class="ptz-patrol">
              <div class="ptz-block-head">
                <span>Patrol</span>
                <span v-if="status.patrol.enabled" class="pill ok" style="padding: 0 6px">
                  {{ status.patrol.running ? 'running' : 'enabled' }}
                </span>
              </div>
              <template v-if="status.patrol.presets.length === 0">
                <p class="hint" style="margin: 4px 0 0">Add <code>ptz.patrol.presets</code> to tour this camera automatically.</p>
              </template>
              <template v-else>
                <p class="hint" style="margin: 4px 0 6px">
                  {{ status.patrol.presets.join(' → ') }} every {{ status.patrol.dwellSeconds }}s
                  <template v-if="status.patrol.nextPreset !== undefined"> · next: {{ status.patrol.nextPreset }}</template>
                </p>
                <p v-if="patrolPausedFor > 0" class="hint" style="margin: 0 0 6px; color: var(--warn)">
                  Paused after a manual move for {{ patrolPausedFor }}s.
                </p>
                <button :disabled="busy !== null" @click="togglePatrol">
                  {{ status.patrol.enabled ? 'Stop patrol' : 'Start patrol' }}
                </button>
              </template>
            </div>
          </div>
        </div>

        <div class="ptz-presets">
          <div class="ptz-block-head">
            <span>Presets</span>
            <span class="spacer"></span>
            <button class="ghost" :disabled="busy !== null" @click="refreshPresets">
              {{ busy === 'presets' ? 'Reading…' : 'Read from camera' }}
            </button>
          </div>
          <p v-if="status.presets.length === 0" class="hint" style="margin: 4px 0 0">
            No presets configured and the camera has not been read yet.
          </p>
          <div class="ptz-preset-grid">
            <button
              v-for="preset in configuredPresets"
              :key="`config-${preset.name}`"
              class="ptz-preset"
              :disabled="busy !== null"
              @click="goto(preset.name)"
            >
              <strong>{{ preset.name }}</strong>
              <span class="mono muted">
                {{ preset.token !== undefined ? `token ${preset.token}` : preset.pan !== undefined ? 'position' : 'by name' }}
              </span>
            </button>
            <button
              v-for="preset in devicePresets"
              :key="`device-${preset.name}`"
              class="ptz-preset device"
              :disabled="busy !== null"
              @click="goto(preset.name)"
            >
              <strong>{{ preset.name }}</strong>
              <span class="mono muted">on camera</span>
            </button>
          </div>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>
        <p v-else-if="notice" class="hint">{{ notice }}</p>
        <p v-if="status.reason !== undefined && status.reachable" class="hint">Last camera error: {{ status.reason }}</p>
      </template>

      <footer class="modal-actions">
        <span class="hint">Arrow keys move · Space stops · Esc closes</span>
        <span class="spacer"></span>
        <button @click="emit('close')">Close</button>
      </footer>
    </div>
  </div>
</template>
