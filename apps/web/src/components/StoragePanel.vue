<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { RetentionSweepResult, StorageOverview, VolumeStats } from '../types';

/**
 * Storage panel.
 *
 * Shows what the retention engine sees — quotas, free disk, archive state — and
 * lets an operator run the same sweep on demand, first as a dry run. Nothing here
 * configures the policy: that lives in `config.json`, where a quota change is
 * reviewable and survives a restart.
 */

const props = defineProps<{ canManage: boolean }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const data = ref<StorageOverview | null>(null);
const loading = ref(true);
const sweeping = ref(false);
const dryRun = ref(true);
const error = ref<string | null>(null);
const sweepResults = ref<RetentionSweepResult[] | null>(null);

const archiveConfigured = computed(() => data.value?.archiveProviders.filter((provider) => provider.enabled) ?? []);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api<StorageOverview>('/api/storage');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function sweep(): Promise<void> {
  sweeping.value = true;
  error.value = null;
  try {
    const response = await api<{ volumes: RetentionSweepResult[]; overview: StorageOverview }>('/api/storage/sweep', {
      method: 'POST',
      body: JSON.stringify({ dryRun: dryRun.value }),
    });
    sweepResults.value = response.volumes;
    data.value = response.overview;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    sweeping.value = false;
  }
}

function sizeOf(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function dayOf(at: number | undefined): string {
  if (at === undefined) return '—';
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Share of the configured ceiling, or of the whole disk when no ceiling exists. */
function usage(volume: VolumeStats): { percent: number; label: string; warn: boolean } {
  if (volume.limits.maxSizeBytes !== undefined && volume.limits.maxSizeBytes > 0) {
    const percent = (volume.usedBytes / volume.limits.maxSizeBytes) * 100;
    return { percent, label: `${sizeOf(volume.usedBytes)} of ${sizeOf(volume.limits.maxSizeBytes)}`, warn: percent >= 90 };
  }
  if (volume.totalBytes > 0) {
    const percent = (volume.diskUsedBytes / volume.totalBytes) * 100;
    return { percent, label: `${sizeOf(volume.diskUsedBytes)} of ${sizeOf(volume.totalBytes)} on disk`, warn: percent >= 90 };
  }
  return { percent: 0, label: 'disk usage unavailable', warn: true };
}

function sweepSummary(result: RetentionSweepResult): string {
  const parts: string[] = [];
  if (result.deleted.length > 0) {
    parts.push(`${result.deleted.length} deleted (${sizeOf(result.freedBytes)})`);
  }
  if (result.archived.length > 0) parts.push(`${result.archived.length} archived`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push('nothing to do');
  return `${result.volumeId}: ${parts.join(' · ')}${result.dryRun ? ' — dry run' : ''}`;
}

void load();
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>Storage</h2>
          <div class="muted" style="font-size: 12px">Quotas, free space and archive state</div>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Refresh" :disabled="loading" @click="load">↻</button>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </div>

      <div v-if="error" class="banner info" style="position: static; margin-bottom: 12px">{{ error }}</div>
      <div v-if="loading && data === null" class="rail-empty">Reading volumes…</div>

      <template v-if="data">
        <div class="storage-totals">
          <div><span class="muted">Recordings</span><strong>{{ sizeOf(data.totals.usedBytes) }}</strong></div>
          <div><span class="muted">Clips</span><strong>{{ data.totals.segmentCount }}</strong></div>
          <div><span class="muted">Free disk</span><strong>{{ sizeOf(data.totals.freeBytes) }}</strong></div>
          <div>
            <span class="muted">Snapshots</span>
            <strong>{{ sizeOf(data.totals.snapshotBytes) }}</strong>
            <small class="muted">({{ data.totals.snapshotCount }})</small>
          </div>
        </div>

        <div class="storage-policy muted">
          <span :class="data.policy.enabled ? 'pill ok' : 'pill warn'">
            retention {{ data.policy.enabled ? 'on' : 'off' }}
          </span>
          <span v-if="data.policy.dryRun" class="pill warn">dry run</span>
          <span>every {{ data.policy.intervalSeconds }}s</span>
          <span>· {{ data.policy.strategy }}</span>
          <span>· batches of {{ data.policy.batchSize }}</span>
          <span v-if="data.policy.protectFlagged">· starred clips kept</span>
          <span>· warn below {{ 100 - data.policy.warnAtPercent }}% free</span>
          <span v-if="data.policy.storeDetectionsDays > 0">· detections kept {{ data.policy.storeDetectionsDays }}d</span>
        </div>

        <div v-for="volume in data.volumes" :key="volume.volumeId" class="volume-card">
          <div class="volume-head">
            <strong>{{ volume.volumeId }}</strong>
            <span class="muted mono" style="font-size: 11px">{{ volume.path }}</span>
            <div class="spacer"></div>
            <span class="pill" :class="{ warn: usage(volume).warn }">{{ volume.segmentCount }} clips</span>
          </div>

          <div class="storage-meter" :class="{ warn: usage(volume).warn }">
            <span :style="{ width: `${Math.max(0.5, Math.min(100, usage(volume).percent))}%` }"></span>
          </div>

          <div class="volume-meta muted">
            <span>{{ usage(volume).label }}</span>
            <span>free {{ sizeOf(volume.freeBytes) }}</span>
            <span v-if="volume.limits.maxAgeHours !== undefined">max age {{ volume.limits.maxAgeHours }}h</span>
            <span v-if="volume.limits.minFreeBytes !== undefined">floor {{ sizeOf(volume.limits.minFreeBytes) }} free</span>
            <span>oldest {{ dayOf(volume.oldestAt) }}</span>
          </div>

          <div v-if="volume.archive" class="volume-meta">
            <span class="pill ok">archive {{ volume.archive.label }}</span>
            <span class="muted">
              after {{ volume.archive.afterHours }}h · local copy kept {{ volume.archive.keepLocalDays }}d
            </span>
          </div>
          <div v-if="volume.error" class="volume-meta">
            <span class="pill err">{{ volume.error }}</span>
          </div>
        </div>

        <div class="modal-actions">
          <label class="muted" style="font-size: 12px">
            <input v-model="dryRun" type="checkbox" :disabled="sweeping || !props.canManage" />
            dry run
          </label>
          <div class="spacer"></div>
          <button class="primary" :disabled="sweeping || !props.canManage" @click="sweep">
            {{ sweeping ? 'Sweeping…' : 'Run retention sweep' }}
          </button>
        </div>

        <div v-if="sweepResults" class="storage-results">
          <div v-for="result in sweepResults" :key="result.volumeId" class="detection-row">
            <span>{{ sweepSummary(result) }}</span>
            <span class="spacer"></span>
            <span class="muted mono" style="font-size: 11px">scanned {{ result.scannedSegments }}</span>
          </div>
          <div v-for="(problem, index) in sweepResults.flatMap((result) => result.errors)" :key="index" class="muted" style="font-size: 12px">
            {{ problem.message }}
          </div>
        </div>

        <template v-if="archiveConfigured.length > 0">
          <div class="storage-section-title">Archive targets</div>
          <div v-for="provider in archiveConfigured" :key="provider.id" class="detection-row">
            <span>{{ provider.id }}</span>
            <span class="muted mono">{{ provider.label }}</span>
            <span class="spacer"></span>
            <span class="pill">{{ provider.type }}</span>
          </div>
        </template>

        <div class="storage-section-title">Per camera</div>
        <div v-for="camera in data.cameras" :key="camera.cameraId" class="detection-row">
          <span>{{ camera.name }}</span>
          <span class="muted">{{ camera.segments }} clip{{ camera.segments === 1 ? '' : 's' }}</span>
          <span class="spacer"></span>
          <span class="mono">{{ sizeOf(camera.bytes) }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
