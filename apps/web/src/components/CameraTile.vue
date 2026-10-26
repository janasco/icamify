<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LivePlayer, type PlayerPhase, type StreamMeta } from '../live';
import type { CameraView } from '../types';

const props = defineProps<{ camera: CameraView }>();

const tile = ref<HTMLDivElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const mode = ref<'mse' | 'mjpeg'>('mse');
const phase = ref<PlayerPhase>('connecting');
const meta = ref<StreamMeta | null>(null);
const fatal = ref<string | null>(null);
const notice = ref<string | null>(null);
const imageKey = ref(0);

let player: LivePlayer | null = null;
let noticeTimer: number | null = null;

const mseSupported = computed(() => {
  const mse = props.camera.status.transports.find((entry) => entry.transport === 'mse');
  return mse?.available !== false;
});

const stateClass = computed(() => {
  if (mode.value === 'mjpeg') return phase.value === 'failed' ? 'err' : 'warn';
  if (phase.value === 'playing') return 'live';
  if (phase.value === 'failed') return 'err';
  return 'warn';
});

const stateLabel = computed(() => {
  if (mode.value === 'mjpeg') return phase.value === 'failed' ? 'offline' : 'mjpeg';
  if (phase.value === 'playing') return 'live';
  if (phase.value === 'failed') return 'error';
  if (phase.value === 'retrying') return 'retrying';
  return 'connecting';
});

const resolution = computed(() => {
  if (meta.value?.width !== undefined && meta.value.height !== undefined) {
    return `${meta.value.width}×${meta.value.height}`;
  }
  return undefined;
});

function setNotice(message: string): void {
  notice.value = message;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.value = null;
    noticeTimer = null;
  }, 5000);
}

function startMse(): void {
  player?.stop();
  phase.value = 'connecting';
  fatal.value = null;
  meta.value = null;
  if (!mseSupported.value) {
    useMjpeg('MSE live view is disabled on the server.');
    return;
  }
  const element = video.value;
  if (element === null) return;

  player = new LivePlayer({
    cameraId: props.camera.id,
    video: element,
    callbacks: {
      onPhase: (next) => {
        phase.value = next;
        if (next === 'playing') notice.value = null;
      },
      onMeta: (next) => {
        meta.value = next;
      },
      onFatal: (message) => {
        useMjpeg(message);
      },
      onNotice: (message) => {
        setNotice(message);
      },
    },
  });
  player.start();
}

function useMjpeg(reason: string): void {
  player?.stop();
  player = null;
  mode.value = 'mjpeg';
  fatal.value = reason;
  phase.value = 'buffering';
  imageKey.value += 1;
}

function retry(): void {
  mode.value = 'mse';
  fatal.value = null;
  imageKey.value += 1;
  phase.value = 'connecting';
  void nextTick(startMse);
}

function onImageLoad(): void {
  phase.value = 'playing';
}

function onImageError(): void {
  phase.value = 'failed';
  fatal.value = fatal.value ?? 'The camera did not return an MJPEG frame.';
}

async function openSnapshot(): Promise<void> {
  window.open(props.camera.snapshotUrl, '_blank', 'noopener');
}

async function goFullscreen(): Promise<void> {
  const element = tile.value;
  if (element === null) return;
  if (document.fullscreenElement === element) {
    await document.exitFullscreen().catch(() => undefined);
    return;
  }
  await element.requestFullscreen?.().catch(() => undefined);
}

onMounted(() => {
  void nextTick(startMse);
});

onBeforeUnmount(() => {
  player?.stop();
  player = null;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
});

watch(
  () => props.camera.id,
  () => {
    player?.stop();
    player = null;
    mode.value = 'mse';
    fatal.value = null;
    notice.value = null;
    void nextTick(startMse);
  },
);
</script>

<template>
  <div ref="tile" class="tile" @dblclick="goFullscreen">
    <video v-show="mode === 'mse'" ref="video" muted playsinline autoplay></video>
    <img
      v-if="mode === 'mjpeg'"
      :key="imageKey"
      :src="`${camera.mjpegUrl}?v=${imageKey}`"
      alt=""
      @load="onImageLoad"
      @error="onImageError"
    />

    <div class="tile-overlay">
      <div class="tile-top">
        <div style="min-width: 0">
          <div class="tile-name">{{ camera.name }}</div>
          <div class="tile-meta">
            <span>{{ camera.source.label }}</span>
            <span v-if="camera.recording.enabled" class="pill" style="padding: 0 6px">REC</span>
            <span v-if="camera.motion.enabled" class="pill" style="padding: 0 6px">MOTION</span>
            <span v-if="camera.ai.enabled" class="pill" style="padding: 0 6px">AI</span>
          </div>
        </div>
        <div class="spacer"></div>
        <div class="tile-actions">
          <button class="icon-button" title="Snapshot" @click.stop="openSnapshot">◉</button>
          <button class="icon-button" title="Reconnect" @click.stop="retry">↻</button>
        </div>
        <span class="state-badge" :class="stateClass"><span class="dot" :class="stateClass"></span>{{ stateLabel }}</span>
      </div>

      <div>
        <div v-if="fatal" class="banner">
          <span style="flex: 1">{{ fatal }}</span>
          <button class="ghost" @click.stop="retry">Retry</button>
        </div>
        <div v-else-if="notice" class="banner info">{{ notice }}</div>
        <div class="tile-bottom">
          <span class="mono">{{ resolution ?? (mode === 'mjpeg' ? 'MJPEG' : '—') }}</span>
          <span v-if="meta?.codec" class="mono muted">{{ meta.codec }}</span>
          <span class="spacer"></span>
          <span v-if="camera.status.viewers > 0">{{ camera.status.viewers }} viewer{{ camera.status.viewers === 1 ? '' : 's' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
