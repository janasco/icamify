<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CameraView, RecordingSegment } from '../types';

/**
 * Recorded clips.
 *
 * This is the storage-facing half of the UI: newest first, with inline playback
 * straight from the range-capable file endpoint. The visual timeline (scrubbing
 * across a day) is the next phase; what matters here is that a clip exists, is
 * playable and can be downloaded.
 */

const props = defineProps<{
  clips: RecordingSegment[];
  cameras: CameraView[];
  loading: boolean;
  error: string | null;
  total: number;
}>();

const emit = defineEmits<{ (event: 'close'): void; (event: 'refresh'): void }>();

const selectedId = ref<string | null>(null);

const selected = computed(() => props.clips.find((clip) => clip.id === selectedId.value) ?? null);

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
</script>

<template>
  <aside class="drawer">
    <header class="drawer-head">
      <div>
        <strong>Recordings</strong>
        <div class="muted" style="font-size: 12px">{{ total }} clip{{ total === 1 ? '' : 's' }} indexed</div>
      </div>
      <div class="spacer"></div>
      <button class="icon-button" title="Refresh" :disabled="loading" @click="emit('refresh')">↻</button>
      <button class="icon-button" title="Close" @click="emit('close')">✕</button>
    </header>

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
  </aside>
</template>
