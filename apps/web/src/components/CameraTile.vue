<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LivePlayer, type PlayerPhase, type StreamMeta } from '../live';
import { WebRtcPlayer, type RtcPhase, type WebRtcSignaler } from '../rtc';
import type { AiRuntime, CameraView, MotionRuntime } from '../types';

const props = defineProps<{
  camera: CameraView;
  /** Live motion episode pushed over the control socket. */
  motion?: MotionRuntime | null;
  /** Live AI detections, cleared a few seconds after the last one. */
  ai?: AiRuntime | null;
  canConfigure?: boolean;
  /** Shared per-tab signaling channel; absent means MSE only. */
  signaler?: WebRtcSignaler | null;
  /** ICE servers from `/api/webrtc` (STUN, or a deployment's TURN). */
  webrtcIceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
}>();
const emit = defineEmits<{ (event: 'configure'): void; (event: 'ai-configure'): void; (event: 'ptz'): void }>();

const tile = ref<HTMLDivElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
/** The transport actually playing; the ladder is WebRTC → MSE → MJPEG. */
const mode = ref<'webrtc' | 'mse' | 'mjpeg'>('mse');
const phase = ref<PlayerPhase>('connecting');
const meta = ref<StreamMeta | null>(null);
const fatal = ref<string | null>(null);
const notice = ref<string | null>(null);
const imageKey = ref(0);

let player: LivePlayer | null = null;
let rtcPlayer: WebRtcPlayer | null = null;
let noticeTimer: number | null = null;

const recordingState = computed(() => props.camera.recording.state ?? 'off');
const motionActive = computed(() => props.motion?.active === true || props.camera.motion.active === true);
const motionBoxes = computed(() => props.motion?.boxes ?? []);
const aiDetections = computed(() => (props.ai?.detections ?? []).filter((detection) => detection.box !== undefined));
const aiLabels = computed(() => props.ai?.detections.map((detection) => detection.label) ?? []);
const aiBadge = computed(() => {
  const labels = aiLabels.value.length > 0 ? aiLabels.value : (props.camera.ai.lastLabels ?? []);
  if (labels.length === 0) return 'AI';
  return labels.slice(0, 2).join(' · ');
});

const mseSupported = computed(() => {
  const mse = props.camera.status.transports.find((entry) => entry.transport === 'mse');
  return mse?.available !== false;
});

/** WebRTC needs a registered media plane, an open control socket and a browser. */
const webrtcSupported = computed(() => {
  if (props.signaler == null) return false;
  if (typeof RTCPeerConnection === 'undefined') return false;
  const entry = props.camera.status.transports.find((candidate) => candidate.transport === 'webrtc');
  return entry?.available === true;
});

const transportLabel = computed(() => {
  if (mode.value === 'webrtc') return 'WebRTC';
  if (mode.value === 'mjpeg') return 'MJPEG';
  return 'MSE';
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

function startLive(): void {
  stopPlayers();
  fatal.value = null;
  notice.value = null;
  if (webrtcSupported.value) {
    startWebRtc();
    return;
  }
  mode.value = 'mse';
  startMse();
}

function startWebRtc(): void {
  const element = video.value;
  const signaler = props.signaler;
  if (element === null || signaler == null) {
    mode.value = 'mse';
    startMse();
    return;
  }
  mode.value = 'webrtc';
  phase.value = 'connecting';
  meta.value = null;
  rtcPlayer = new WebRtcPlayer({
    cameraId: props.camera.id,
    video: element,
    signaler,
    ...(props.webrtcIceServers === undefined ? {} : { iceServers: props.webrtcIceServers }),
    callbacks: {
      onPhase: (next: RtcPhase) => {
        phase.value = toPlayerPhase(next);
      },
      onFatal: (message) => {
        rtcPlayer = null;
        // A dead WebRTC path is a fallback, not an error banner: the tile keeps
        // playing over MSE and says which transport it ended up on.
        setNotice(`WebRTC unavailable (${message}) — using MSE.`);
        mode.value = 'mse';
        void nextTick(startMse);
      },
    },
  });
  void rtcPlayer.start();
}

function toPlayerPhase(next: RtcPhase): PlayerPhase {
  switch (next) {
    case 'playing':
      return 'playing';
    case 'failed':
      return 'failed';
    case 'negotiating':
      return 'connecting';
    default:
      return 'buffering';
  }
}

function stopPlayers(): void {
  player?.stop();
  player = null;
  rtcPlayer?.stop();
  rtcPlayer = null;
}

function startMse(): void {
  stopPlayers();
  mode.value = 'mse';
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
  stopPlayers();
  mode.value = 'mjpeg';
  fatal.value = reason;
  phase.value = 'buffering';
  imageKey.value += 1;
}

function retry(): void {
  fatal.value = null;
  imageKey.value += 1;
  phase.value = 'connecting';
  void nextTick(startLive);
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
  void nextTick(startLive);
});

onBeforeUnmount(() => {
  stopPlayers();
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
});

watch(
  () => props.camera.id,
  () => {
    stopPlayers();
    fatal.value = null;
    notice.value = null;
    void nextTick(startLive);
  },
);

// The engine can become available after the first render: werift loads lazily on
// the server, so a camera whose WebRTC flag flips should reconnect at once.
watch(
  () => webrtcSupported.value,
  (supported, was) => {
    if (supported === was) return;
    void nextTick(startLive);
  },
);
</script>

<template>
  <div ref="tile" class="tile" @dblclick="goFullscreen">
    <video v-show="mode === 'mse' || mode === 'webrtc'" ref="video" muted playsinline autoplay></video>
    <img
      v-if="mode === 'mjpeg'"
      :key="imageKey"
      :src="`${camera.mjpegUrl}?v=${imageKey}`"
      alt=""
      @load="onImageLoad"
      @error="onImageError"
    />

    <svg v-if="motionBoxes.length > 0" class="motion-boxes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <rect
        v-for="(box, index) in motionBoxes"
        :key="index"
        :x="box.x * 100"
        :y="box.y * 100"
        :width="box.width * 100"
        :height="box.height * 100"
      />
    </svg>

    <div v-if="aiDetections.length > 0" class="ai-boxes" aria-hidden="true">
      <div
        v-for="(detection, index) in aiDetections"
        :key="`${detection.label}-${index}`"
        class="ai-box"
        :style="{
          left: `${(detection.box?.x ?? 0) * 100}%`,
          top: `${(detection.box?.y ?? 0) * 100}%`,
          width: `${(detection.box?.width ?? 0) * 100}%`,
          height: `${(detection.box?.height ?? 0) * 100}%`,
        }"
      >
        <span class="ai-box-label">{{ detection.label }} {{ Math.round(detection.confidence * 100) }}%</span>
      </div>
    </div>

    <div class="tile-overlay">
      <div class="tile-top">
        <div style="min-width: 0">
          <div class="tile-name">{{ camera.name }}</div>
          <div class="tile-meta">
            <span>{{ camera.source.label }}</span>
            <span
              v-if="camera.recording.enabled"
              class="pill"
              :class="recordingState === 'recording' || recordingState === 'buffering' ? 'ok' : 'warn'"
              style="padding: 0 6px"
            >
              <span class="dot" :class="{ blink: recordingState === 'recording' }"></span>
              {{ recordingState === 'recording' ? 'REC' : recordingState === 'buffering' ? 'BUF' : 'REC' }}
            </span>
            <span v-if="camera.motion.enabled" class="pill" :class="{ warn: motionActive }" style="padding: 0 6px">
              {{ motionActive ? 'MOTION' : 'ZONES' }}
            </span>
            <span
              v-if="camera.ai.enabled"
              class="pill"
              :class="camera.ai.lastError ? 'err' : ai?.detections.length ? 'ok' : ''"
              style="padding: 0 6px"
              :title="camera.ai.lastError ?? `${camera.ai.providerName ?? camera.ai.providerId ?? 'AI'} · ${camera.ai.task ?? 'object'}`"
            >
              {{ aiBadge }}
            </span>
          </div>
        </div>
        <div class="spacer"></div>
        <div class="tile-actions">
          <button
            v-if="canConfigure && camera.motion.enabled"
            class="icon-button"
            title="Motion zones"
            @click.stop="emit('configure')"
          >
            ⚙
          </button>
          <button
            v-if="canConfigure && (camera.ai.enabled || camera.ai.providerId !== undefined)"
            class="icon-button"
            title="AI settings"
            @click.stop="emit('ai-configure')"
          >
            ✳
          </button>
          <button v-if="camera.ptz.supported" class="icon-button" title="PTZ control" @click.stop="emit('ptz')">✥</button>
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
          <span class="mono" :title="`Live transport: ${transportLabel}`">{{ transportLabel }}</span>
          <span class="mono">{{ resolution ?? (mode === 'mjpeg' ? 'JPEG' : '—') }}</span>
          <span v-if="meta?.codec" class="mono muted">{{ meta.codec }}</span>
          <span v-if="camera.recording.directToDisk === false" class="mono muted" title="Recording re-encodes: CPU cost follows resolution">re-encode</span>
          <span v-if="(camera.recording.bufferedSeconds ?? 0) > 0" class="mono muted">
            pre-buffer {{ camera.recording.bufferedSeconds }}s
          </span>
          <span v-if="motionActive && motion?.percent !== undefined" class="mono muted">{{ motion.percent }}%</span>
          <span v-if="ai?.latencyMs !== undefined" class="mono muted">ai {{ ai.latencyMs }}ms</span>
          <span class="spacer"></span>
          <span v-if="camera.status.viewers > 0">{{ camera.status.viewers }} viewer{{ camera.status.viewers === 1 ? '' : 's' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
