<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { OnvifDescribeResult, OnvifScanDevice, OnvifScanResult } from '../types';

/**
 * ONVIF discovery and inspection.
 *
 * A scan is explicit (it is UDP multicast to the whole subnet) and results are
 * read-only: the console never writes camera entries, because the configuration
 * file stays the source of truth. What the operator gets instead is everything
 * needed to write that entry — device service XAddr, RTSP URI and preset names —
 * plus a copy-ready snippet.
 */

const emit = defineEmits<{ (event: 'close'): void }>();

const discovery = ref<{ enabled: boolean; multicastAddress?: string; timeoutMs?: number } | null>(null);
const devices = ref<OnvifScanDevice[]>([]);
const warnings = ref<string[]>([]);
const scanning = ref(false);
const inspected = ref<OnvifScanDevice | null>(null);
const details = ref<OnvifDescribeResult | null>(null);
const inspecting = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const timeoutMs = ref(3000);
const username = ref('');
const password = ref('');

onMounted(async () => {
  try {
    const info = await api<{ discovery: { enabled: boolean; multicastAddress?: string; timeoutMs?: number } }>('/api/onvif');
    discovery.value = info.discovery;
    if (info.discovery.timeoutMs !== undefined) timeoutMs.value = info.discovery.timeoutMs;
    if (!info.discovery.enabled) {
      error.value = 'WS-Discovery is disabled in the server configuration (onvif.discovery.enabled = false).';
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  }
});

async function scan(): Promise<void> {
  scanning.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await api<OnvifScanResult>('/api/onvif/scan', {
      method: 'POST',
      body: JSON.stringify({ timeoutMs: timeoutMs.value }),
    });
    devices.value = result.devices;
    warnings.value = result.warnings;
    notice.value = result.devices.length === 0 ? 'No device answered the probe.' : `${result.devices.length} device(s) found.`;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    scanning.value = false;
  }
}

async function inspect(device: OnvifScanDevice): Promise<void> {
  inspected.value = device;
  details.value = null;
  inspecting.value = true;
  error.value = null;
  try {
    details.value = await api<OnvifDescribeResult>('/api/onvif/describe', {
      method: 'POST',
      body: JSON.stringify({
        host: device.host,
        port: device.port ?? 80,
        ...(username.value.length === 0 ? {} : { username: username.value, password: password.value }),
      }),
    });
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    inspecting.value = false;
  }
}

/** Ready-to-paste configuration for the inspected device. */
function snippet(): string {
  const device = inspected.value;
  if (device === null) return '';
  const profiles = details.value?.profiles ?? [];
  const sub = profiles.find((profile) => profile.token !== profiles[0]?.token);
  const camera = {
    id: slug(device.name ?? device.host),
    name: device.name ?? `Camera ${device.host}`,
    streams: {
      main: {
        type: 'rtsp',
        url: details.value?.streamUri ?? `rtsp://${device.host}:554/stream1`,
        credentials: { username: '${CAMERA_USER}', password: '${CAMERA_PASS}' },
      },
      ...(sub === undefined ? {} : { sub: { type: 'rtsp', url: `rtsp://${device.host}:554/stream2` } }),
    },
    ptz: { host: device.host, port: device.port ?? 80, presets: (details.value?.presets ?? []).map((preset) => ({ name: preset.name, token: preset.token })) },
  };
  return JSON.stringify(camera, null, 2);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'camera'
  );
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = `${label} copied.`;
  } catch {
    error.value = 'The browser refused clipboard access; select the text and copy it manually.';
  }
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-card wide">
      <header class="modal-head">
        <div>
          <h2>ONVIF discovery</h2>
          <p class="muted" style="margin: 2px 0 0; font-size: 12px">
            WS-Discovery probe
            <template v-if="discovery?.multicastAddress !== undefined"> · {{ discovery.multicastAddress }}</template>
            · {{ devices.length }} device(s)
          </p>
        </div>
        <div class="spacer"></div>
        <button class="icon-button" title="Close" @click="emit('close')">✕</button>
      </header>

      <div class="onvif-toolbar">
        <button class="primary" :disabled="scanning || discovery?.enabled === false" @click="scan">
          {{ scanning ? 'Scanning…' : 'Scan subnet' }}
        </button>
        <label class="mono muted" for="onvif-timeout" style="font-size: 12px">timeout</label>
        <input id="onvif-timeout" v-model.number="timeoutMs" type="number" min="500" max="15000" step="500" style="width: 90px" />
        <span class="mono muted" style="font-size: 12px">ms</span>
        <span class="spacer"></span>
        <input v-model="username" placeholder="camera user" autocomplete="off" style="width: 130px" />
        <input v-model="password" type="password" placeholder="password" autocomplete="off" style="width: 130px" />
      </div>
      <p class="hint" style="margin: 6px 0 0">
        Credentials are used for this inspection only and are never stored. Leave them blank for cameras that answer anonymously.
      </p>

      <div class="onvif-body">
        <div class="onvif-list">
          <div v-if="devices.length === 0 && !scanning" class="hint" style="padding: 6px 0">
            Nothing discovered yet. Scan to probe the local subnet.
          </div>
          <button
            v-for="device in devices"
            :key="device.urn"
            class="onvif-device"
            :class="{ active: inspected?.urn === device.urn }"
            @click="inspect(device)"
          >
            <div class="onvif-device-head">
              <strong>{{ device.name ?? device.host }}</strong>
              <span v-if="device.configured" class="pill ok" style="padding: 0 6px">configured</span>
            </div>
            <span class="mono muted">{{ device.host }}:{{ device.port ?? 80 }}</span>
            <span v-if="device.hardware !== undefined" class="muted" style="font-size: 11px">{{ device.hardware }}</span>
          </button>
        </div>

        <div class="onvif-detail">
          <div v-if="inspecting" class="hint">Reading device details…</div>
          <div v-else-if="details === null" class="hint">Select a device to read its device service, profiles and presets.</div>
          <template v-else>
            <div class="onvif-facts">
              <span class="pill mono">{{ details.device.manufacturer ?? 'unknown' }} {{ details.device.model ?? '' }}</span>
              <span class="pill mono">fw {{ details.device.firmwareVersion ?? '—' }}</span>
              <span class="pill mono">sn {{ details.device.serialNumber ?? '—' }}</span>
              <span class="pill" :class="details.ptzSupported ? 'ok' : 'warn'">
                {{ details.ptzSupported ? `${details.presets.length} presets` : 'no presets reported' }}
              </span>
            </div>

            <div class="onvif-uri">
              <span class="muted">RTSP</span>
              <code>{{ details.streamUri ?? 'not advertised' }}</code>
              <button v-if="details.streamUri !== undefined" class="ghost" @click="copy(details.streamUri, 'RTSP URI')">Copy</button>
            </div>
            <div v-if="details.snapshotUri !== undefined" class="onvif-uri">
              <span class="muted">Snapshot</span>
              <code>{{ details.snapshotUri }}</code>
            </div>

            <table class="onvif-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Resolution</th>
                  <th>Codec</th>
                  <th>FPS</th>
                  <th>Bitrate</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="profile in details.profiles" :key="profile.token">
                  <td class="mono">{{ profile.name }} <span class="muted">{{ profile.token }}</span></td>
                  <td class="mono">{{ profile.width ?? '—' }}×{{ profile.height ?? '—' }}</td>
                  <td class="mono">{{ profile.encoding ?? '—' }}</td>
                  <td class="mono">{{ profile.fps ?? '—' }}</td>
                  <td class="mono">{{ profile.bitrateKbps === undefined ? '—' : `${profile.bitrateKbps} kbps` }}</td>
                </tr>
              </tbody>
            </table>

            <div v-if="details.presets.length > 0" class="onvif-facts">
              <span v-for="preset in details.presets" :key="preset.token ?? preset.name" class="pill mono">
                {{ preset.name }} <template v-if="preset.token !== undefined">#{{ preset.token }}</template>
              </span>
            </div>

            <div class="ptz-block-head" style="margin-top: 10px">
              <span>Configuration snippet</span>
              <span class="spacer"></span>
              <button class="ghost" @click="copy(snippet(), 'Snippet')">Copy JSON</button>
            </div>
            <pre class="onvif-snippet">{{ snippet() }}</pre>
          </template>
        </div>
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-else-if="notice !== null" class="hint">{{ notice }}</p>
      <p v-for="warning in warnings" :key="warning" class="hint">warning: {{ warning }}</p>

      <footer class="modal-actions">
        <span class="hint">Cameras are added in the configuration file; the snippet above is ready to paste.</span>
        <span class="spacer"></span>
        <button @click="emit('close')">Close</button>
      </footer>
    </div>
  </div>
</template>
