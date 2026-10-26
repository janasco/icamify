<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { AiDetectionResult, AiStatus, AiStatusResponse, CameraView } from '../types';

/**
 * AI settings for one camera.
 *
 * The label filter and confidence floor are the two knobs that decide whether an
 * alert is useful, so they are editable at runtime and persisted server-side.
 * "Detect now" runs one analysis through the real pipeline: the fastest way to
 * find out that a detector is unreachable or misconfigured is to ask it.
 */

const props = defineProps<{ camera: CameraView }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved', status: AiStatus): void }>();

const TASKS = [
  { value: 'object', label: 'Object' },
  { value: 'face', label: 'Face' },
  { value: 'lpr', label: 'Licence plate' },
  { value: 'scene', label: 'Scene' },
] as const;

const status = ref<AiStatus | null>(null);
const enabled = ref(true);
const task = ref<'object' | 'face' | 'lpr' | 'scene'>('object');
const labels = ref('');
const minConfidence = ref(0.4);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const error = ref<string | null>(null);
const result = ref<AiDetectionResult | null>(null);

const capabilities = computed(() => status.value?.capabilities ?? []);
const availableTasks = computed(() =>
  TASKS.filter((entry) => capabilities.value.length === 0 || capabilities.value.includes(entry.value)),
);

onMounted(() => {
  void load();
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await api<AiStatusResponse>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ai`);
    status.value = response.ai;
    if (response.ai === null) {
      error.value = 'This camera has no AI configuration and no provider is available.';
      return;
    }
    enabled.value = response.ai.enabled;
    task.value = response.ai.task;
    labels.value = response.ai.labels.join(', ');
    minConfidence.value = response.ai.minConfidence;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const response = await api<{ ai: AiStatus }>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ai`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: enabled.value,
        task: task.value,
        labels: labels.value
          .split(',')
          .map((label) => label.trim())
          .filter((label) => label.length > 0),
        minConfidence: minConfidence.value,
      }),
    });
    status.value = response.ai;
    emit('saved', response.ai);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function detectNow(): Promise<void> {
  testing.value = true;
  error.value = null;
  result.value = null;
  try {
    const response = await api<AiDetectionResult>(`/api/cameras/${encodeURIComponent(props.camera.id)}/ai/detect`, {
      method: 'POST',
    });
    result.value = response;
    if (response.ai !== null && response.ai !== undefined) status.value = response.ai;
    if (response.detections.length === 0 && response.reason !== undefined) error.value = response.reason;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <h2>AI detection · {{ camera.name }}</h2>
          <div class="muted" style="font-size: 12px">
            {{ status?.providerName ?? status?.providerId ?? 'no provider' }}
            <template v-if="status"> · {{ status.analyses }} analyses · {{ status.detections }} detections</template>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </div>

      <div v-if="loading" class="muted">Loading…</div>

      <template v-else>
        <div v-if="status?.lastError" class="banner" style="position: static; margin-bottom: 12px">
          {{ status.lastError }}
        </div>

        <div class="field">
          <label>
            <input v-model="enabled" type="checkbox" style="width: auto" />
            Analyse motion events with AI
          </label>
        </div>

        <div class="field">
          <label for="ai-task">Detection task</label>
          <select id="ai-task" v-model="task" class="select">
            <option v-for="entry in availableTasks" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
          </select>
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            The provider must declare the capability; available: {{ capabilities.join(', ') || 'unknown' }}
          </div>
        </div>

        <div class="field">
          <label for="ai-labels">Labels (comma separated, empty = every label)</label>
          <input id="ai-labels" v-model="labels" placeholder="person, car" />
        </div>

        <div class="field">
          <label for="ai-confidence">Minimum confidence · {{ Math.round(minConfidence * 100) }}%</label>
          <input id="ai-confidence" v-model.number="minConfidence" type="range" min="0" max="1" step="0.05" />
        </div>

        <div class="muted" style="font-size: 12px">
          Crop to the motion region: {{ status?.cropToMotion ? 'yes' : 'no' }} · snapshots:
          {{ status?.saveSnapshots ? 'on' : 'off' }} · interval {{ status?.intervalMs ?? 0 }} ms · circuit
          {{ status?.circuit ?? 'unknown' }}
        </div>

        <div v-if="result" style="margin-top: 14px">
          <div class="muted" style="font-size: 12px; margin-bottom: 6px">
            {{ result.detections.length }} detection{{ result.detections.length === 1 ? '' : 's' }} in
            {{ result.latencyMs }} ms
          </div>
          <div v-for="(detection, index) in result.detections" :key="index" class="detection-row">
            <span class="pill ok">{{ detection.label }}</span>
            <span class="mono">{{ Math.round(detection.confidence * 100) }}%</span>
            <span v-if="detection.box" class="mono muted">
              {{ detection.box.x.toFixed(2) }}, {{ detection.box.y.toFixed(2) }} ·
              {{ detection.box.width.toFixed(2) }}×{{ detection.box.height.toFixed(2) }}
            </span>
            <a
              v-if="result.snapshot && result.eventIds?.[0]"
              :href="`/api/events/${encodeURIComponent(result.eventIds[0])}/snapshot`"
              target="_blank"
              rel="noopener"
              >snapshot</a
            >
          </div>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>

        <div class="modal-actions">
          <button class="primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
          <button :disabled="testing" @click="detectNow">{{ testing ? 'Running…' : 'Detect now' }}</button>
          <div class="spacer"></div>
          <button class="ghost" @click="emit('close')">Close</button>
        </div>
      </template>
    </div>
  </div>
</template>
