<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CameraView, RecordedEvent, RecordingSegment } from '../types';

/**
 * The right-hand drawer: finalized clips and the event log.
 *
 * The clips tab is storage; the events tab is what the AI and rule layers
 * produced (detections, rule hits). Both share the drawer because an operator
 * investigating an alert wants the snapshot and the clip in one place.
 */

const props = defineProps<{
  clips: RecordingSegment[];
  cameras: CameraView[];
  loading: boolean;
  error: string | null;
  total: number;
  tab: 'clips' | 'events';
  events: RecordedEvent[];
  eventsLoading: boolean;
  eventsError: string | null;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'refresh'): void;
  (event: 'refresh-events'): void;
  (event: 'tab', tab: 'clips' | 'events'): void;
}>();

const selectedId = ref<string | null>(null);

const selected = computed(() => props.clips.find((clip) => clip.id === selectedId.value) ?? null);
const alertCount = computed(() => props.events.filter((event) => event.kind === 'rule').length);

watch(
  () => props.clips,
  (clips) => {
    if (selectedId.value !== null && !clips.some((clip) => clip.id === selectedId.value)) {
      selectedId.value = null;
    }
  },
);

function cameraName(cameraId: string): string {
  return props.cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
}

function fileUrl(segment: RecordingSegment): string {
  return `/api/recordings/${encodeURIComponent(segment.id)}/file`;
}

function snapshotUrl(event: RecordedEvent): string | undefined {
  return event.snapshot === undefined ? undefined : `/api/events/${encodeURIComponent(event.id)}/snapshot`;
}

function clockOf(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function durationOf(segment: RecordingSegment): string {
  const seconds = Math.max(0, Math.round((segment.endedAt - segment.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function kindClass(kind: string): string {
  if (kind === 'rule') return 'alert';
  if (kind.startsWith('ai.')) return 'motion';
  return '';
}
</script>

<template>
  <aside class="drawer">
    <header class="drawer-head">
      <div>
        <strong>{{ tab === 'clips' ? 'Recordings' : 'Events' }}</strong>
        <div class="muted" style="font-size: 12px">
          <template v-if="tab === 'clips'">{{ total }} clip{{ total === 1 ? '' : 's' }} indexed</template>
          <template v-else>{{ events.length }} event{{ events.length === 1 ? '' : 's' }} · {{ alertCount }} alert{{ alertCount === 1 ? '' : 's' }}</template>
        </div>
      </div>
      <div class="spacer"></div>
      <button
        class="icon-button"
        title="Refresh"
        :disabled="tab === 'clips' ? loading : eventsLoading"
        @click="tab === 'clips' ? emit('refresh') : emit('refresh-events')"
      >
        ↻
      </button>
      <button class="icon-button" title="Close" @click="emit('close')">✕</button>
    </header>

    <div class="tab-row">
      <button :class="{ active: tab === 'clips' }" @click="emit('tab', 'clips')">Clips</button>
      <button :class="{ active: tab === 'events' }" @click="emit('tab', 'events')">Events</button>
    </div>

    <template v-if="tab === 'clips'">
      <div v-if="selected" class="clip-player">
        <video :key="selected.id" :src="fileUrl(selected)" controls autoplay playsinline></video>
        <div class="clip-player-meta">
          <span class="mono">{{ clockOf(selected.startedAt) }}</span>
          <span class="pill">{{ selected.reason }}</span>
          <span class="spacer"></span>
          <a :href="fileUrl(selected)" :download="`${selected.cameraId}-${selected.id}.mkv`">Download</a>
        </div>
      </div>

      <div v-if="error" class="banner info" style="position: static; margin: 10px 12px">{{ error }}</div>

      <div class="clip-list">
        <div v-if="loading && clips.length === 0" class="rail-empty">Loading clips…</div>
        <div v-else-if="clips.length === 0" class="rail-empty">
          No recordings yet. Clips appear here as soon as a segment is finalized.
        </div>
        <button
          v-for="clip in clips"
          :key="clip.id"
          class="clip-row"
          :class="{ active: clip.id === selectedId }"
          @click="selectedId = clip.id"
        >
          <span class="clip-dot" :class="{ motion: clip.hasMotion, alert: clip.hasAlert }"></span>
          <span class="clip-main">
            <span class="clip-title">{{ cameraName(clip.cameraId) }}</span>
            <span class="clip-sub mono">{{ clockOf(clip.startedAt) }}</span>
          </span>
          <span class="clip-meta">
            <span>{{ durationOf(clip) }}</span>
            <span class="muted">{{ sizeOf(clip.bytes) }}</span>
          </span>
        </button>
      </div>
    </template>

    <template v-else>
      <div v-if="eventsError" class="banner info" style="position: static; margin: 10px 12px">{{ eventsError }}</div>

      <div class="clip-list">
        <div v-if="eventsLoading && events.length === 0" class="rail-empty">Loading events…</div>
        <div v-else-if="events.length === 0" class="rail-empty">
          No events yet. Motion, AI detections and rule hits appear here.
        </div>
        <div v-for="event in events" :key="event.id" class="clip-row event-row">
          <span class="clip-dot" :class="kindClass(event.kind)"></span>
          <span class="clip-main">
            <span class="clip-title">
              {{ event.label ?? event.kind }}
              <span v-if="event.confidence !== undefined" class="muted mono">{{ Math.round(event.confidence * 100) }}%</span>
            </span>
            <span class="clip-sub mono">{{ cameraName(event.cameraId) }} · {{ clockOf(event.startedAt) }}</span>
          </span>
          <span class="clip-meta">
            <span class="mono" style="font-size: 11px">{{ event.kind }}</span>
            <a v-if="snapshotUrl(event)" :href="snapshotUrl(event)" target="_blank" rel="noopener">snapshot</a>
          </span>
        </div>
      </div>
    </template>
  </aside>
</template>
