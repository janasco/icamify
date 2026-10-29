<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AiEditor from './AiEditor.vue';
import CameraTile from './CameraTile.vue';
import ClipsPanel from './ClipsPanel.vue';
import LayoutEditor from './LayoutEditor.vue';
import MotionEditor from './MotionEditor.vue';
import OnvifDiscovery from './OnvifDiscovery.vue';
import PtzPanel from './PtzPanel.vue';
import StoragePanel from './StoragePanel.vue';
import TimelinePlayer from './TimelinePlayer.vue';
import { api, errorMessage } from '../api';
import { WebRtcSignaler } from '../rtc';
import type {
  AiRuntime,
  AiStatus,
  AlertRuntime,
  AuthMe,
  CameraList,
  CameraView,
  EventList,
  LayoutConfig,
  LayoutList,
  LayoutTile,
  MotionRuntime,
  MotionStatus,
  RecordedEvent,
  RecordingList,
  RecordingSegment,
  SystemInfo,
} from '../types';

const props = defineProps<{ me: AuthMe }>();
const emit = defineEmits<{ (event: 'sign-out'): void; (event: 'sign-in'): void }>();

const cameras = ref<CameraView[]>([]);
const layouts = ref<LayoutList | null>(null);
const system = ref<SystemInfo | null>(null);
/** ICE configuration published by the server; empty means the browser default. */
const webrtcIceServers = ref<Array<{ urls: string[]; username?: string; credential?: string }>>([]);
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
const editingAi = ref<CameraView | null>(null);
const editingPtz = ref<CameraView | null>(null);
const discoveryOpen = ref(false);
const aiRuntime = ref<Record<string, AiRuntime>>({});
const alerts = ref<AlertRuntime[]>([]);
const clipsTab = ref<'clips' | 'events'>('clips');
const events = ref<RecordedEvent[]>([]);
const eventsLoading = ref(false);
const eventsError = ref<string | null>(null);
const newAlerts = ref(0);
const timelineOpen = ref(false);
const storageOpen = ref(false);
const storageWarning = ref<string | null>(null);
const layoutEditorOpen = ref(false);
const layoutMode = ref<boolean>(readString('icamify.layoutMode') === '1');
const activeLayoutId = ref<string | null>(readString('icamify.layoutId'));

const canConfigure = computed(() => props.me.user?.role !== 'viewer');

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let pollTimer: number | null = null;
let disposed = false;

/**
 * One signaling channel per tab. The tiles share the control socket, which keeps
 * the authorization decision to one per browser session instead of one per tile.
 */
const signaler = new WebRtcSignaler({
  send: (message) => {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  },
});
/** Detections are transient: drop the boxes a few seconds after the last frame. */
const aiTimers = new Map<string, number>();

const defaultLayout = computed(() => {
  const list = layouts.value?.layouts ?? [];
  return list.find((layout) => layout.isDefault) ?? list[0];
});

const columnsValue = computed(() => (columns.value > 0 ? columns.value : autoColumns(cameras.value.length)));

/**
 * The layout the grid draws when "Layout" is on, and what the editor edits.
 * The stored layout wins; the flat reorderable grid is still the default view.
 */
const activeLayout = computed<LayoutConfig | null>(() => {
  const list = layouts.value?.layouts ?? [];
  const wanted = activeLayoutId.value === null ? undefined : list.find((layout) => layout.id === activeLayoutId.value);
  return wanted ?? defaultLayout.value ?? null;
});

const layoutTiles = computed(() => {
  const layout = activeLayout.value;
  if (layout === null) return [];
  const byId = new Map(cameras.value.map((camera) => [camera.id, camera]));
  return (layout.tiles ?? [])
    .map((tile) => ({ tile, camera: byId.get(tile.cameraId) }))
    .filter((entry): entry is { tile: LayoutTile; camera: CameraView } => entry.camera !== undefined)
    .filter((entry) => focusId.value === null || entry.tile.cameraId === focusId.value)
    .sort((left, right) => left.tile.y - right.tile.y || left.tile.x - right.tile.x);
});

const layoutActive = computed(() => layoutMode.value && layoutTiles.value.length > 0);

/** A layout to edit even on a fresh install, so the editor is never empty. */
const editorLayout = computed<LayoutConfig>(() => {
  const layout = activeLayout.value;
  if (layout !== null) return layout;
  const cols = columnsValue.value;
  return {
    id: 'default',
    name: 'Default grid',
    columns: cols,
    rows: Math.max(1, Math.min(8, Math.ceil(Math.max(1, cameras.value.length) / cols))),
    tiles: [],
  };
});

const cameraChoices = computed(() => cameras.value.map((camera) => ({ id: camera.id, name: camera.name })));

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
    const [list, layoutList, info, rtc] = await Promise.all([
      api<CameraList>('/api/cameras'),
      api<LayoutList>('/api/layouts').catch(() => null),
      api<SystemInfo>('/api/system').catch(() => null),
      api<{ iceServers?: Array<{ urls: string[]; username?: string; credential?: string }> }>('/api/webrtc').catch(() => null),
    ]);
    cameras.value = list.cameras;
    layouts.value = layoutList;
    if (
      activeLayoutId.value !== null &&
      !(layoutList?.layouts ?? []).some((layout) => layout.id === activeLayoutId.value)
    ) {
      activeLayoutId.value = layoutList?.defaultLayoutId ?? null;
      persist('icamify.layoutId', activeLayoutId.value ?? '');
    }
    system.value = info;
    webrtcIceServers.value = rtc?.iceServers ?? [];

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
    if (signaler.handleMessage(message)) return;
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
      return;
    }
    if (message.type === 'ai' && typeof message.cameraId === 'string') {
      const detections = Array.isArray(message.detections) ? (message.detections as AiRuntime['detections']) : [];
      aiRuntime.value = {
        ...aiRuntime.value,
        [message.cameraId]: {
          cameraId: message.cameraId,
          at: typeof message.at === 'number' ? message.at : Date.now(),
          task: typeof message.task === 'string' ? message.task : 'object',
          providerId: typeof message.providerId === 'string' ? message.providerId : '',
          detections,
          ...(typeof message.latencyMs === 'number' ? { latencyMs: message.latencyMs } : {}),
        },
      };
      scheduleAiClear(message.cameraId);
      return;
    }
    if (message.type === 'storage:warning' && typeof message.message === 'string') {
      storageWarning.value = message.message;
      return;
    }
    if (message.type === 'storage:sweep') {
      // The sweep may have removed clips that are on screen; a refresh keeps the
      // drawer from offering a tombstoned segment.
      if (clipsOpen.value) void loadClips();
      return;
    }
    if (message.type === 'alert' && typeof message.ruleId === 'string') {
      const alert: AlertRuntime = {
        ruleId: message.ruleId,
        ruleName: typeof message.ruleName === 'string' ? message.ruleName : message.ruleId,
        cameraId: typeof message.cameraId === 'string' ? message.cameraId : '',
        at: typeof message.at === 'number' ? message.at : Date.now(),
        kind: typeof message.kind === 'string' ? message.kind : 'motion',
        actions: Array.isArray(message.actions) ? (message.actions as AlertRuntime['actions']) : [],
        ...(typeof message.label === 'string' ? { label: message.label } : {}),
        ...(typeof message.confidence === 'number' ? { confidence: message.confidence } : {}),
        ...(typeof message.snapshot === 'string' ? { snapshot: message.snapshot } : {}),
        ...(typeof message.eventId === 'string' ? { eventId: message.eventId } : {}),
      };
      alerts.value = [alert, ...alerts.value].slice(0, 50);
      newAlerts.value += 1;
      return;
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

function scheduleAiClear(cameraId: string): void {
  const existing = aiTimers.get(cameraId);
  if (existing !== undefined) window.clearTimeout(existing);
  aiTimers.set(
    cameraId,
    window.setTimeout(() => {
      aiTimers.delete(cameraId);
      const next = { ...aiRuntime.value };
      delete next[cameraId];
      aiRuntime.value = next;
    }, 6000),
  );
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

function toggleLayoutMode(): void {
  layoutMode.value = !layoutMode.value;
  persist('icamify.layoutMode', layoutMode.value ? '1' : '0');
}

function onLayoutSaved(layout: LayoutConfig): void {
  const existing = layouts.value?.layouts ?? [];
  const next = existing.some((candidate) => candidate.id === layout.id)
    ? existing.map((candidate) => (candidate.id === layout.id ? layout : candidate))
    : [...existing, layout];
  layouts.value = {
    layouts: next,
    ...(layouts.value?.defaultLayoutId === undefined ? {} : { defaultLayoutId: layouts.value.defaultLayoutId }),
    stored: true,
    ...(layouts.value?.limits === undefined ? {} : { limits: layouts.value.limits }),
    cameras: layouts.value?.cameras ?? cameraChoices.value.map((camera) => ({ ...camera, order: 1000 })),
  };
  activeLayoutId.value = layout.id;
  layoutMode.value = true;
  persist('icamify.layoutId', layout.id);
  persist('icamify.layoutMode', '1');
}

function setFocus(cameraId: string | null): void {
  focusId.value = focusId.value === cameraId ? null : cameraId;
  persist('icamify.focus', focusId.value ?? '');
}

function toggleClips(): void {
  clipsOpen.value = !clipsOpen.value;
  if (!clipsOpen.value) return;
  if (clipsTab.value === 'clips') void loadClips();
  else void loadEvents();
}

function setTab(tab: 'clips' | 'events'): void {
  clipsTab.value = tab;
  if (tab === 'clips') {
    newClips.value = 0;
    void loadClips();
  } else {
    newAlerts.value = 0;
    void loadEvents();
  }
}

async function loadEvents(): Promise<void> {
  eventsLoading.value = true;
  eventsError.value = null;
  try {
    const query = new URLSearchParams({ limit: '80', order: 'desc' });
    if (focusId.value !== null) query.set('cameraId', focusId.value);
    const list = await api<EventList>(`/api/events?${query.toString()}`);
    events.value = list.events;
    newAlerts.value = 0;
  } catch (error) {
    eventsError.value = errorMessage(error);
  } finally {
    eventsLoading.value = false;
  }
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

function onAiSaved(status: AiStatus): void {
  const camera = cameras.value.find((candidate) => candidate.id === status.cameraId);
  if (camera === undefined) return;
  applyCamera({
    ...camera,
    ai: {
      ...camera.ai,
      enabled: status.enabled,
      ...(status.providerId === undefined ? {} : { providerId: status.providerId }),
      ...(status.providerName === undefined ? {} : { providerName: status.providerName }),
      task: status.task,
      labels: status.labels,
      minConfidence: status.minConfidence,
      ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
    },
  });
}

watch(focusId, () => {
  if (!clipsOpen.value) return;
  if (clipsTab.value === 'clips') void loadClips();
  else void loadEvents();
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
  for (const timer of aiTimers.values()) window.clearTimeout(timer);
  aiTimers.clear();
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
        <button
          v-if="layoutTiles.length > 0"
          :class="{ active: layoutMode }"
          title="Draw the saved layout instead of the flat grid"
          @click="toggleLayoutMode"
        >
          Layout
        </button>
        <button v-if="canConfigure" @click="layoutEditorOpen = true">Edit layout</button>
        <span class="spacer"></span>
        <span v-if="system" class="pill mono">{{ system.transports.ladder.join(' → ') }}</span>
        <button :class="{ primary: clipsOpen }" @click="toggleClips">
          Clips<span v-if="newClips > 0 && !clipsOpen" class="new-clip-badge">+{{ newClips }}</span>
        </button>
        <button
          :class="{ primary: clipsOpen && clipsTab === 'events' }"
          @click="clipsTab = 'events'; toggleClips()"
        >
          Events<span v-if="newAlerts > 0" class="new-clip-badge">+{{ newAlerts }}</span>
        </button>
        <button :class="{ primary: timelineOpen }" @click="timelineOpen = true">Timeline</button>
        <button v-if="canConfigure" :class="{ primary: discoveryOpen }" @click="discoveryOpen = true">Discover</button>
        <button :class="{ primary: storageOpen }" @click="storageOpen = true">
          Storage<span v-if="storageWarning !== null" class="new-clip-badge">!</span>
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

        <div
          v-else-if="layoutActive"
          class="grid layout-grid"
          :style="{
            '--cols': String(activeLayout?.columns ?? 1),
            '--rows': String(activeLayout?.rows ?? 1),
          }"
        >
          <div
            v-for="entry in layoutTiles"
            :key="entry.tile.cameraId"
            class="tile-shell"
            :style="{
              gridColumn: `${entry.tile.x + 1} / span ${entry.tile.width ?? 1}`,
              gridRow: `${entry.tile.y + 1} / span ${entry.tile.height ?? 1}`,
            }"
          >
            <CameraTile
              :camera="entry.camera"
              :motion="motionRuntime[entry.camera.id] ?? null"
              :ai="aiRuntime[entry.camera.id] ?? null"
              :can-configure="canConfigure"
              :signaler="signaler"
              :webrtc-ice-servers="webrtcIceServers"
              @configure="editing = entry.camera"
              @ai-configure="editingAi = entry.camera"
              @ptz="editingPtz = entry.camera"
            />
          </div>
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
              :ai="aiRuntime[camera.id] ?? null"
              :can-configure="canConfigure"
              :signaler="signaler"
              :webrtc-ice-servers="webrtcIceServers"
              @configure="editing = camera"
              @ai-configure="editingAi = camera"
              @ptz="editingPtz = camera"
            />
          </div>
        </div>
      </div>

      <div class="footer-note">
        <span>Drag tiles to reorder · double-click a tile for fullscreen</span>
        <span v-if="system">WebRTC: {{ system.transports.webrtc.available ? 'available' : (system.transports.webrtc.reason ?? 'unavailable') }}</span>
        <span v-if="clipsOpen" class="mono">{{ clipsTotal }} clips · {{ events.length }} events</span>
        <span v-if="alerts.length > 0" class="mono">last alert: {{ alerts[0]?.ruleName }}</span>
        <span v-if="storageWarning" class="mono" style="color: var(--warn)">{{ storageWarning }}</span>
      </div>
    </section>

    <ClipsPanel
      v-if="clipsOpen"
      :clips="clips"
      :cameras="cameras"
      :loading="clipsLoading"
      :error="clipsError"
      :total="clipsTotal"
      :tab="clipsTab"
      :events="events"
      :events-loading="eventsLoading"
      :events-error="eventsError"
      @refresh="loadClips"
      @refresh-events="loadEvents"
      @tab="setTab"
      @close="clipsOpen = false"
    />

    <MotionEditor v-if="editing" :camera="editing" @close="editing = null" @saved="onMotionSaved" />
    <AiEditor v-if="editingAi" :camera="editingAi" @close="editingAi = null" @saved="onAiSaved" />
    <PtzPanel v-if="editingPtz" :camera="editingPtz" @close="editingPtz = null" />
    <OnvifDiscovery v-if="discoveryOpen" @close="discoveryOpen = false" />
    <TimelinePlayer
      v-if="timelineOpen"
      :cameras="cameras"
      :initial-camera-id="focusId"
      @close="timelineOpen = false"
    />
    <StoragePanel v-if="storageOpen" :can-manage="canConfigure" @close="storageOpen = false" />
    <LayoutEditor
      v-if="layoutEditorOpen"
      :layout="editorLayout"
      :cameras="cameraChoices"
      @close="layoutEditorOpen = false"
      @saved="onLayoutSaved"
    />
  </div>
</template>
