<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CameraTile from './CameraTile.vue';
import ClipsPanel from './ClipsPanel.vue';
import MotionEditor from './MotionEditor.vue';
import { api, errorMessage } from '../api';
import type {
  AuthMe,
  CameraList,
  CameraView,
  LayoutList,
  MotionRuntime,
  MotionStatus,
  RecordingList,
  RecordingSegment,
  SystemInfo,
} from '../types';

const props = defineProps<{ me: AuthMe }>();
const emit = defineEmits<{ (event: 'sign-out'): void; (event: 'sign-in'): void }>();

const cameras = ref<CameraView[]>([]);
const layouts = ref<LayoutList | null>(null);
const system = ref<SystemInfo | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const connected = ref(false);
const columns = ref<number>(readNumber('icamify.columns', 0));
const order = ref<string[]>(readJson<string[]>('icamify.order', []));
const focusId = ref<string | null>(readString('icamify.focus'));
const dragId = ref<string | null>(null);
const dropId = ref<string | null>(null);
const motionRuntime = ref<Record<string, MotionRuntime>>({});
const clipsOpen = ref(false);
const clips = ref<RecordingSegment[]>([]);
const clipsTotal = ref(0);
const clipsLoading = ref(false);
const clipsError = ref<string | null>(null);
const newClips = ref(0);
const editing = ref<CameraView | null>(null);

const canConfigure = computed(() => props.me.user?.role !== 'viewer');

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let pollTimer: number | null = null;
let disposed = false;

const defaultLayout = computed(() => {
  const list = layouts.value?.layouts ?? [];
  return list.find((layout) => layout.isDefault) ?? list[0];
});

const columnsValue = computed(() => (columns.value > 0 ? columns.value : autoColumns(cameras.value.length)));

const ordered = computed(() => {
  const rank = new Map(order.value.map((id, index) => [id, index]));
  return [...cameras.value].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return (left.ui.order ?? 1000) - (right.ui.order ?? 1000) || left.name.localeCompare(right.name);
  });
});

const displayed = computed(() => (focusId.value === null ? ordered.value : ordered.value.filter((camera) => camera.id === focusId.value)));

const liveCount = computed(() => cameras.value.filter((camera) => camera.status.state === 'live').length);
const viewerCount = computed(() => cameras.value.reduce((total, camera) => total + camera.status.viewers, 0));

async function load(): Promise<void> {
  loadError.value = null;
  try {
    const [list, layoutList, info] = await Promise.all([
      api<CameraList>('/api/cameras'),
      api<LayoutList>('/api/layouts').catch(() => null),
      api<SystemInfo>('/api/system').catch(() => null),
    ]);
    cameras.value = list.cameras;
    layouts.value = layoutList;
    system.value = info;

    if (order.value.length === 0) {
      const fromLayout = (defaultLayout.value?.tiles ?? [])
        .slice()
        .sort((left, right) => left.y - right.y || left.x - right.x)
        .map((tile) => tile.cameraId);
      const extra = list.cameras.map((camera) => camera.id).filter((id) => !fromLayout.includes(id));
      if (fromLayout.length > 0) persistOrder([...fromLayout, ...extra]);
    }
    if (columns.value === 0 && defaultLayout.value !== undefined) {
      columns.value = defaultLayout.value.columns;
      persist('icamify.columns', String(columns.value));
    }
    if (focusId.value !== null && !list.cameras.some((camera) => camera.id === focusId.value)) {
      focusId.value = null;
      persist('icamify.focus', '');
    }
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function applyCamera(camera: CameraView): void {
  const index = cameras.value.findIndex((candidate) => candidate.id === camera.id);
  if (index === -1) {
    cameras.value = [...cameras.value, camera];
    return;
  }
  const next = [...cameras.value];
  next[index] = camera;
  cameras.value = next;
}

function connectControl(): void {
  if (disposed) return;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  let next: WebSocket;
  try {
    next = new WebSocket(`${protocol}://${window.location.host}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;

  next.onopen = () => {
    connected.value = true;
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  next.onmessage = (event: MessageEvent<string>) => {
    if (typeof event.data !== 'string') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'welcome' || message.type === 'cameras') {
      const list = message.cameras;
      if (Array.isArray(list)) cameras.value = list as CameraView[];
      return;
    }
    if (message.type === 'camera:status' && typeof message.camera === 'object' && message.camera !== null) {
      applyCamera(message.camera as CameraView);
      return;
    }
    if (message.type === 'motion' && typeof message.cameraId === 'string') {
      motionRuntime.value = {
        ...motionRuntime.value,
        [message.cameraId]: {
          cameraId: message.cameraId,
          active: message.active === true,
          at: typeof message.at === 'number' ? message.at : Date.now(),
          percent: typeof message.percent === 'number' ? message.percent : 0,
          ...(typeof message.peakPercent === 'number' ? { peakPercent: message.peakPercent } : {}),
          ...(Array.isArray(message.boxes) ? { boxes: message.boxes as MotionRuntime['boxes'] } : {}),
        },
      };
      return;
    }
    if (message.type === 'recording:segment' && typeof message.segment === 'object' && message.segment !== null) {
      const segment = message.segment as RecordingSegment;
      clips.value = [segment, ...clips.value].slice(0, 100);
      clipsTotal.value += 1;
      newClips.value += 1;
    }
  };
  next.onclose = () => {
    connected.value = false;
    socket = null;
    scheduleReconnect();
    startPolling();
  };
  next.onerror = () => {
    // `close` follows and owns the retry.
  };
}

function scheduleReconnect(): void {
  if (disposed || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectControl();
  }, 2500);
}

/** While the socket is down, status updates still need a source. */
function startPolling(): void {
  if (pollTimer !== null || disposed) return;
  pollTimer = window.setInterval(() => {
    void api<CameraList>('/api/cameras')
      .then((list) => {
        cameras.value = list.cameras;
      })
      .catch(() => undefined);
  }, 10_000);
}

function currentIds(): string[] {
  return ordered.value.map((camera) => camera.id);
}

function persistOrder(ids: string[]): void {
  order.value = ids;
  persist('icamify.order', JSON.stringify(ids));
}

function reorder(fromId: string, toId: string): void {
  if (fromId === toId) return;
  const ids = currentIds();
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1) return;
  const [moved] = ids.splice(from, 1);
  if (moved === undefined) return;
  ids.splice(to, 0, moved);
  persistOrder(ids);
}

function onDragStart(event: DragEvent, cameraId: string): void {
  dragId.value = cameraId;
  event.dataTransfer?.setData('text/plain', cameraId);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}

function onDrop(event: DragEvent, cameraId: string): void {
  event.preventDefault();
  const from = dragId.value ?? event.dataTransfer?.getData('text/plain') ?? null;
  dragId.value = null;
  dropId.value = null;
  if (from !== null) reorder(from, cameraId);
}

function setColumns(value: number): void {
  columns.value = value;
  persist('icamify.columns', String(value));
}

function setFocus(cameraId: string | null): void {
  focusId.value = focusId.value === cameraId ? null : cameraId;
  persist('icamify.focus', focusId.value ?? '');
}

function toggleClips(): void {
  clipsOpen.value = !clipsOpen.value;
  if (clipsOpen.value) void loadClips();
}

async function loadClips(): Promise<void> {
  clipsLoading.value = true;
  clipsError.value = null;
  try {
    const query = new URLSearchParams({ limit: '60', order: 'desc' });
    if (focusId.value !== null) query.set('cameraId', focusId.value);
    const list = await api<RecordingList>(`/api/recordings?${query.toString()}`);
    clips.value = list.segments;
    clipsTotal.value = list.total;
    newClips.value = 0;
  } catch (error) {
    clipsError.value = errorMessage(error);
  } finally {
    clipsLoading.value = false;
  }
}

function onMotionSaved(status: MotionStatus): void {
  const camera = cameras.value.find((candidate) => candidate.id === status.cameraId);
  if (camera !== undefined) {
    applyCamera({ ...camera, motion: { ...camera.motion, active: status.motion, sensitivity: status.thresholds.sensitivity } });
  }
}

watch(focusId, () => {
  if (clipsOpen.value) void loadClips();
});

function railDot(camera: CameraView): string {
  if (!camera.enabled) return '';
  if (camera.status.state === 'live') return 'live';
  if (camera.status.state === 'restarting') return 'warn';
  if (camera.status.lastError !== undefined) return 'err';
  return '';
}

function statusSummary(camera: CameraView): string {
  if (!camera.enabled) return 'disabled';
  if (camera.status.state === 'live') return `${camera.status.viewers} viewing`;
  return camera.status.state;
}

onMounted(() => {
  void load();
  connectControl();
});

onBeforeUnmount(() => {
  disposed = true;
  socket?.close();
  socket = null;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  if (pollTimer !== null) window.clearInterval(pollTimer);
});

function autoColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the UI still works in-session.
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = readString(key);
  if (raw === null || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number): number {
  const raw = readString(key);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
</script>

<template>
  <header class="topbar">
    <div class="brand">iCamify <span>NVR console</span></div>
    <span class="pill" :class="connected ? 'ok' : 'warn'">
      <span class="dot" :class="connected ? 'live' : 'warn'"></span>
      {{ connected ? 'live updates' : 'polling' }}
    </span>
    <span class="pill"><span class="dot" :class="liveCount > 0 ? 'live' : ''"></span>{{ liveCount }} live</span>
    <span class="pill">{{ viewerCount }} viewer{{ viewerCount === 1 ? '' : 's' }}</span>

    <div class="spacer"></div>

    <span v-if="system?.ffmpeg" class="pill mono">ffmpeg {{ system.ffmpeg.version }}</span>
    <span class="pill">v{{ system?.version ?? '0.1.0' }}</span>

    <template v-if="props.me.authenticated">
      <span class="pill">{{ props.me.user?.username }} · {{ props.me.user?.role }}</span>
      <button @click="emit('sign-out')">Sign out</button>
    </template>
    <template v-else>
      <span class="pill warn">anonymous</span>
      <button class="primary" @click="emit('sign-in')">Sign in</button>
    </template>
  </header>

  <div class="shell">
    <aside class="rail">
      <div class="rail-head">Cameras</div>
      <div class="rail-list">
        <button class="rail-item" :class="{ active: focusId === null }" @click="setFocus(null)">
          <span class="dot"></span>
          <span class="name">All cameras</span>
          <span class="count">{{ cameras.length }}</span>
        </button>
        <button
          v-for="camera in ordered"
          :key="camera.id"
          class="rail-item"
          :class="{ active: focusId === camera.id }"
          @click="setFocus(camera.id)"
        >
          <span class="dot" :class="railDot(camera)"></span>
          <span class="name">{{ camera.name }}</span>
          <span class="count">{{ statusSummary(camera) }}</span>
        </button>
        <div v-if="cameras.length === 0 && !loading" class="rail-empty">No cameras configured.</div>
      </div>
    </aside>

    <section class="stage">
      <div class="toolbar">
        <span class="muted" style="font-size: 12px">Grid</span>
        <div class="group">
          <button :class="{ active: columns === 0 }" @click="setColumns(0)">Auto</button>
          <button v-for="count in [1, 2, 3, 4]" :key="count" :class="{ active: columns === count }" @click="setColumns(count)">
            {{ count }}
          </button>
        </div>
        <span class="spacer"></span>
        <span v-if="system" class="pill mono">{{ system.transports.ladder.join(' → ') }}</span>
        <button :class="{ primary: clipsOpen }" @click="toggleClips">
          Clips<span v-if="newClips > 0 && !clipsOpen" class="new-clip-badge">+{{ newClips }}</span>
        </button>
        <button @click="load" :disabled="loading">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>

      <div class="grid-wrap">
        <div v-if="loadError" class="empty">
          <strong>Could not load cameras</strong>
          <span>{{ loadError }}</span>
          <button @click="load">Retry</button>
        </div>

        <div v-else-if="cameras.length === 0 && !loading" class="empty">
          <strong>No cameras yet</strong>
          <span>Add a camera to <code>cameras[]</code> in the configuration, then restart iCamify.</span>
        </div>

        <div v-else class="grid" :style="{ '--cols': String(columnsValue) }">
          <div
            v-for="camera in displayed"
            :key="camera.id"
            class="tile-shell"
            draggable="true"
            :class="{ dragging: dragId === camera.id, 'drop-target': dropId === camera.id }"
            @dragstart="onDragStart($event, camera.id)"
            @dragend="dragId = null; dropId = null"
            @dragover.prevent="dropId = camera.id"
            @dragleave="dropId = dropId === camera.id ? null : dropId"
            @drop="onDrop($event, camera.id)"
          >
            <CameraTile
              :camera="camera"
              :motion="motionRuntime[camera.id] ?? null"
              :can-configure="canConfigure"
              @configure="editing = camera"
            />
          </div>
        </div>
      </div>

      <div class="footer-note">
        <span>Drag tiles to reorder · double-click a tile for fullscreen</span>
        <span v-if="system">WebRTC: {{ system.transports.webrtc.available ? 'available' : (system.transports.webrtc.reason ?? 'unavailable') }}</span>
        <span v-if="clipsOpen" class="mono">{{ clipsTotal }} clips</span>
      </div>
    </section>

    <ClipsPanel
      v-if="clipsOpen"
      :clips="clips"
      :cameras="cameras"
      :loading="clipsLoading"
      :error="clipsError"
      :total="clipsTotal"
      @refresh="loadClips"
      @close="clipsOpen = false"
    />

    <MotionEditor v-if="editing" :camera="editing" @close="editing = null" @saved="onMotionSaved" />
  </div>
</template>
