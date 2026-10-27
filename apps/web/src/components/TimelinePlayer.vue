<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, errorMessage } from '../api';
import type { CameraView, RecordedEvent, RecordingSegment, TimelineResponse } from '../types';

/**
 * Timeline playback.
 *
 * One camera, one day. Recorded segments are blocks on a 24-hour lane, events are
 * ticks beneath them, and clicking anywhere on the lane asks the server to remux a
 * window starting at that instant (see `/api/recordings/:id/play.mp4`). The player
 * never downloads a whole day: it streams one window and the playhead says where
 * that window sits in the day.
 *
 * Day boundaries are local, because an operator investigating "last night" thinks
 * in local time even though the index stores epoch milliseconds.
 */

const props = defineProps<{ cameras: CameraView[]; initialCameraId?: string | null }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const cameraId = ref(props.initialCameraId ?? props.cameras[0]?.id ?? '');
const day = ref(todayInput());
const loading = ref(false);
const error = ref<string | null>(null);
const segments = ref<RecordingSegment[]>([]);
const events = ref<RecordedEvent[]>([]);
const truncated = ref(false);
const playback = ref<{ url: string; segment: RecordingSegment; startsAt: number } | null>(null);
const currentAt = ref<number | null>(null);
const video = ref<HTMLVideoElement | null>(null);

const dayStart = computed(() => {
  const parsed = Date.parse(`${day.value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : startOfDay(Date.now());
});
const dayEnd = computed(() => dayStart.value + 86_400_000);

const blocks = computed(() =>
  segments.value.map((segment) => {
    const left = percent(segment.startedAt);
    const right = percent(segment.endedAt);
    return { segment, left, width: Math.max(0.15, right - left) };
  }),
);

const markers = computed(() =>
  events.value.map((event) => ({
    event,
    left: percent(event.startedAt),
    kind: event.kind === 'rule' ? 'rule' : event.kind.startsWith('ai.') ? 'ai' : 'motion',
  })),
);

const playhead = computed(() => (currentAt.value === null ? null : percent(currentAt.value)));

const totals = computed(() => ({
  segments: segments.value.length,
  motion: segments.value.filter((segment) => segment.hasMotion).length,
  alerts: segments.value.filter((segment) => segment.hasAlert).length,
  bytes: segments.value.reduce((total, segment) => total + segment.bytes, 0),
}));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const query = new URLSearchParams({ from: String(dayStart.value), to: String(dayEnd.value) });
    if (cameraId.value.length > 0) query.set('cameraId', cameraId.value);
    const response = await api<TimelineResponse>(`/api/timeline?${query.toString()}`);
    segments.value = response.segments;
    events.value = response.events;
    truncated.value = response.truncated;
    if (playback.value !== null && !response.segments.some((segment) => segment.id === playback.value?.segment.id)) {
      playback.value = null;
      currentAt.value = null;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
    segments.value = [];
    events.value = [];
  } finally {
    loading.value = false;
  }
}

/** Picks the segment containing `at` (or the next one) and streams a window. */
function seekTo(at: number): void {
  const clamped = Math.max(dayStart.value, Math.min(dayEnd.value - 1000, at));
  const segment =
    segments.value.find((candidate) => clamped >= candidate.startedAt && clamped < candidate.endedAt) ??
    segments.value.find((candidate) => candidate.startedAt >= clamped) ??
    segments.value.at(-1);
  if (segment === undefined) return;
  const offset = Math.max(0, (clamped - segment.startedAt) / 1000);
  const duration = Math.max(1, Math.min(7200, Math.ceil((segment.endedAt - clamped) / 1000)));
  playback.value = {
    segment,
    startsAt: segment.startedAt + offset * 1000,
    url: `/api/recordings/${encodeURIComponent(segment.id)}/play.mp4?start=${offset.toFixed(2)}&duration=${duration}`,
  };
  currentAt.value = segment.startedAt + offset * 1000;
}

function onLaneClick(event: MouseEvent): void {
  const element = event.currentTarget as HTMLElement | null;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  seekTo(dayStart.value + ratio * 86_400_000);
}

function onTimeUpdate(): void {
  if (playback.value === null || video.value === null) return;
  currentAt.value = playback.value.startsAt + video.value.currentTime * 1000;
}

function stepDay(delta: number): void {
  const next = new Date(dayStart.value);
  next.setDate(next.getDate() + delta);
  day.value = inputDate(next);
}

function percent(at: number): number {
  return Math.max(0, Math.min(100, ((at - dayStart.value) / 86_400_000) * 100));
}

function blockTitle(segment: RecordingSegment): string {
  return `${clock(segment.startedAt)} – ${clock(segment.endedAt)} · ${segment.reason} · ${sizeOf(segment.bytes)}`;
}

function markerTitle(event: RecordedEvent): string {
  const label = event.label === undefined ? '' : ` ${event.label}`;
  const confidence = event.confidence === undefined ? '' : ` ${Math.round(event.confidence * 100)}%`;
  return `${clock(event.startedAt)} · ${event.kind}${label}${confidence}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function inputDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

function todayInput(): string {
  return inputDate(new Date());
}

watch([cameraId, day], () => void load());
void load();

onBeforeUnmount(() => {
  video.value?.pause();
});
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card timeline-card">
      <div class="modal-head">
        <div>
          <h2>Timeline</h2>
          <div class="muted" style="font-size: 12px">
            {{ totals.segments }} segment{{ totals.segments === 1 ? '' : 's' }} ·
            {{ totals.motion }} with motion · {{ totals.alerts }} alert{{ totals.alerts === 1 ? '' : 's' }} ·
            {{ sizeOf(totals.bytes) }}
          </div>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </div>

      <div class="timeline-toolbar">
        <select v-model="cameraId" class="select" style="width: auto; min-width: 160px">
          <option value="">All cameras</option>
          <option v-for="camera in props.cameras" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
        </select>
        <button @click="stepDay(-1)" title="Previous day">‹</button>
        <input v-model="day" type="date" style="width: auto" />
        <button @click="stepDay(1)" title="Next day">›</button>
        <button @click="day = todayInput()">Today</button>
        <div class="spacer"></div>
        <button @click="load" :disabled="loading">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>

      <div v-if="error" class="banner info" style="position: static; margin-bottom: 12px">{{ error }}</div>

      <div v-if="playback" class="timeline-player">
        <video
          :key="playback.url"
          ref="video"
          :src="playback.url"
          controls
          autoplay
          playsinline
          @timeupdate="onTimeUpdate"
        ></video>
        <div class="clip-player-meta">
          <span class="mono">{{ clock(playback.startsAt) }}</span>
          <span class="pill">{{ playback.segment.reason }}</span>
          <span class="muted mono">{{ playback.segment.cameraId }}</span>
          <span class="spacer"></span>
          <a :href="playback.url" target="_blank" rel="noopener">Open</a>
        </div>
      </div>

      <div class="timeline-lane" @click="onLaneClick">
        <div v-for="hour in 24" :key="hour" class="timeline-hour" :style="{ left: `${((hour - 1) / 24) * 100}%` }">
          <span class="timeline-hour-label">{{ String(hour - 1).padStart(2, '0') }}</span>
        </div>
        <button
          v-for="block in blocks"
          :key="block.segment.id"
          class="timeline-block"
          :class="{
            motion: block.segment.hasMotion && !block.segment.hasAlert,
            alert: block.segment.hasAlert,
            active: playback?.segment.id === block.segment.id,
          }"
          :style="{ left: `${block.left}%`, width: `${block.width}%` }"
          :title="blockTitle(block.segment)"
          @click.stop="seekTo(block.segment.startedAt)"
        ></button>
        <div v-if="playhead !== null" class="timeline-playhead" :style="{ left: `${playhead}%` }"></div>
        <div v-if="!loading && segments.length === 0" class="timeline-empty">
          No recordings for this camera on {{ day }}.
        </div>
      </div>

      <div class="timeline-events">
        <button
          v-for="marker in markers"
          :key="marker.event.id"
          class="timeline-tick"
          :class="marker.kind"
          :style="{ left: `${marker.left}%` }"
          :title="markerTitle(marker.event)"
          @click="seekTo(marker.event.startedAt)"
        ></button>
      </div>

      <div class="timeline-legend">
        <span><i class="swatch motion"></i>motion</span>
        <span><i class="swatch alert"></i>alert</span>
        <span><i class="swatch plain"></i>recorded</span>
        <span class="spacer"></span>
        <span class="muted">Click the lane to play from that moment</span>
        <span v-if="truncated" class="pill warn">truncated at 500 items</span>
      </div>
    </div>
  </div>
</template>
