import { activeSchedules, type CameraConfig, type Credentials, type PtzPreset, type ResolvedIcamifyConfig } from '@icamify/core';
import { maskUrl } from '@icamify/media';
import {
  OnvifClient,
  OnvifError,
  discoverDevices,
  type DiscoveredDevice,
  type DiscoveryRunOptions,
  type DeviceInfo,
  type MediaProfile,
  type OnvifClientOptions,
  type PtzVector,
} from '@icamify/onvif';

/**
 * ONVIF/PTZ orchestration.
 *
 * The ONVIF package speaks SOAP; this service decides *which* endpoint a camera
 * has, caches one client per camera, and runs preset patrols. It is also where the
 * "a human wins" rule lives: any manual move pauses the tour for a minute, so an
 * operator looking at something is not fought by an automated pan.
 *
 * Endpoint resolution is deliberately forgiving: an explicit `ptz.host`, an ONVIF
 * source, or the host of an RTSP URL all work, because cameras are configured for
 * recording far more often than for PTZ and nobody wants to duplicate a host.
 */

export interface PtzPresetView {
  name: string;
  token?: string;
  pan?: number;
  tilt?: number;
  zoom?: number;
  /** Present on the device but not in the configuration. */
  source?: 'config' | 'device';
}

export interface PtzPatrolView {
  enabled: boolean;
  running: boolean;
  pausedUntil?: number;
  presets: string[];
  dwellSeconds: number;
  nextPreset?: string;
}

export interface PtzStatusView {
  cameraId: string;
  supported: boolean;
  reachable: boolean;
  /** Reason control is unavailable or the last operation failed. */
  reason?: string;
  endpoint?: string;
  profileToken?: string;
  presets: PtzPresetView[];
  patrol: PtzPatrolView;
}

export interface PtzScanDevice extends DiscoveredDevice {
  /** True when a configured camera already points at this host. */
  configured: boolean;
}

export interface OnvifScanResult {
  devices: PtzScanDevice[];
  warnings: string[];
}

export interface OnvifDescribeResult {
  host: string;
  port: number;
  device: DeviceInfo;
  profiles: MediaProfile[];
  /** Credentials and tokens stripped, because a camera may echo them. */
  streamUri?: string;
  snapshotUri?: string;
  presets: Array<{ name: string; token?: string }>;
  ptzSupported: boolean;
}

export interface OnvifServiceOptions {
  config: ResolvedIcamifyConfig;
  log?: (line: string) => void;
  now?: () => number;
  clientFactory?: (options: OnvifClientOptions) => OnvifClient;
  scanner?: (options: DiscoveryRunOptions) => Promise<DiscoveredDevice[]>;
}

interface Endpoint {
  host: string;
  port: number;
  path?: string;
  secure?: boolean;
  credentials?: Credentials;
  profileToken?: string;
}

interface CameraState {
  client?: OnvifClient;
  endpoint?: Endpoint;
  reachable: boolean;
  lastError?: string;
  loggedError?: string;
  profileToken?: string;
  devicePresets: PtzPreset[];
  pausedUntil?: number;
  patrolIndex: number;
  timer?: NodeJS.Timeout;
  patrolOverride?: boolean;
}

/** A manual move wins for this long before the tour resumes. */
const MANUAL_PAUSE_MS = 60_000;
const MIN_DWELL_SECONDS = 5;

export class OnvifService {
  private readonly options: OnvifServiceOptions;
  private readonly states = new Map<string, CameraState>();
  private started = false;

  constructor(options: OnvifServiceOptions) {
    this.options = options;
  }

  get discoveryEnabled(): boolean {
    return this.options.config.onvif.discovery?.enabled !== false;
  }

  /** Cameras with a usable ONVIF endpoint. */
  controlledCameraIds(): string[] {
    return (this.options.config.cameras ?? [])
      .filter((camera) => this.canControl(camera))
      .map((camera) => camera.id);
  }

  canControl(camera: CameraConfig): boolean {
    if (camera.ptz?.enabled === false) return false;
    return this.endpointFor(camera) !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const camera of this.options.config.cameras ?? []) {
      if (camera.ptz?.patrol?.enabled === true && this.canControl(camera)) this.startPatrol(camera);
    }
    const count = this.controlledCameraIds().length;
    if (count > 0) this.options.log?.(`onvif: PTZ control available for ${count} camera(s)`);
  }

  /** Stops patrol timers on shutdown; PTZ stop for one camera is `stop(cameraId)`. */
  async shutdown(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) clearInterval(state.timer);
      state.timer = undefined;
    }
    this.started = false;
  }

  // -- discovery ------------------------------------------------------------

  async scan(options: { timeoutMs?: number } = {}): Promise<OnvifScanResult> {
    const discovery = this.options.config.onvif.discovery ?? {};
    const warnings: string[] = [];
    if (!this.discoveryEnabled) {
      return { devices: [], warnings: ['discovery is disabled (onvif.discovery.enabled = false)'] };
    }
    const scanner = this.options.scanner ?? discoverDevices;
    const devices = await scanner({
      ...(discovery.multicastAddress === undefined ? {} : { multicastAddress: discovery.multicastAddress }),
      ...(discovery.multicastPort === undefined ? {} : { multicastPort: discovery.multicastPort }),
      ...(discovery.subnets === undefined ? {} : { subnets: discovery.subnets }),
      timeoutMs: Math.max(500, options.timeoutMs ?? discovery.timeoutMs ?? 3000),
      onWarning: (message) => warnings.push(message),
    });
    const configured = new Set(
      (this.options.config.cameras ?? [])
        .map((camera) => this.endpointFor(camera)?.host)
        .filter((host): host is string => host !== undefined),
    );
    return {
      devices: devices.map((device) => ({ ...device, configured: configured.has(device.host) })),
      warnings,
    };
  }

  /** Device details for a host found by discovery, or entered by hand. */
  async describe(
    target: { host: string; port?: number; credentials?: Credentials },
  ): Promise<OnvifDescribeResult> {
    const client = this.createClient({ host: target.host, port: target.port ?? 80, credentials: target.credentials });
    const [device, profiles] = await Promise.all([client.deviceInfo(), client.mediaProfiles()]);
    const profileToken = profiles[0]?.token;
    const streamUri = profileToken === undefined ? undefined : await client.streamUri(profileToken).catch(() => undefined);
    const snapshotUri = profileToken === undefined ? undefined : await client.snapshotUri(profileToken).catch(() => undefined);
    const presets = await client.presets().catch(() => []);
    return {
      host: target.host,
      port: target.port ?? 80,
      device,
      profiles,
      ...(streamUri === undefined ? {} : { streamUri: maskUrl(streamUri) }),
      ...(snapshotUri === undefined ? {} : { snapshotUri: maskUrl(snapshotUri) }),
      presets: presets.map((preset) => ({ name: preset.name, ...(preset.token === undefined ? {} : { token: preset.token }) })),
      ptzSupported: presets.length > 0,
    };
  }

  // -- status ---------------------------------------------------------------

  status(cameraId: string): PtzStatusView {
    const camera = this.requireCamera(cameraId);
    const endpoint = this.canControl(camera) ? this.endpointFor(camera) : undefined;
    const state = this.states.get(camera.id);
    const configPresets: PtzPresetView[] = (camera.ptz?.presets ?? []).map((preset) => ({
      name: preset.name,
      source: 'config' as const,
      ...(preset.token === undefined ? {} : { token: preset.token }),
      ...(preset.pan === undefined ? {} : { pan: preset.pan }),
      ...(preset.tilt === undefined ? {} : { tilt: preset.tilt }),
      ...(preset.zoom === undefined ? {} : { zoom: preset.zoom }),
    }));
    const known = new Set(configPresets.map((preset) => preset.name));
    const devicePresets: PtzPresetView[] = (state?.devicePresets ?? [])
      .filter((preset) => !known.has(preset.name))
      .map((preset) => ({
        name: preset.name,
        source: 'device' as const,
        ...(preset.token === undefined ? {} : { token: preset.token }),
      }));

    const patrol = camera.ptz?.patrol;
    const patrolEnabled = state?.patrolOverride ?? patrol?.enabled === true;
    return {
      cameraId: camera.id,
      supported: endpoint !== undefined,
      reachable: state?.reachable === true,
      ...(state?.lastError === undefined ? {} : { reason: state.lastError }),
      ...(endpoint === undefined ? { reason: 'no ONVIF endpoint: set ptz.host or use an ONVIF/RTSP stream' } : {}),
      ...(endpoint === undefined ? {} : { endpoint: `http://${endpoint.host}:${endpoint.port}${endpoint.path ?? '/onvif/device_service'}` }),
      ...(state?.profileToken === undefined && endpoint?.profileToken === undefined
        ? {}
        : { profileToken: state?.profileToken ?? endpoint?.profileToken }),
      presets: [...configPresets, ...devicePresets],
      patrol: {
        enabled: patrolEnabled,
        running: state?.timer !== undefined,
        ...(state?.pausedUntil === undefined ? {} : { pausedUntil: state.pausedUntil }),
        presets: patrol?.presets ?? [],
        dwellSeconds: patrol?.dwellSeconds ?? 15,
        ...(this.nextPatrolPreset(camera) === undefined ? {} : { nextPreset: this.nextPatrolPreset(camera) }),
      },
    };
  }

  /** Loads the device's own presets, so the UI can offer them. */
  async refresh(cameraId: string): Promise<PtzStatusView> {
    const camera = this.requireCamera(cameraId);
    const state = this.state(camera.id);
    try {
      const client = this.clientFor(camera);
      const [presets, profiles] = await Promise.all([client.presets(), client.mediaProfiles().catch(() => [])]);
      state.devicePresets = presets;
      state.profileToken = state.profileToken ?? profiles[0]?.token ?? state.endpoint?.profileToken;
      state.reachable = true;
      state.lastError = undefined;
      state.loggedError = undefined;
      return this.status(camera.id);
    } catch (error) {
      this.recordError(camera.id, error);
      throw error;
    }
  }

  // -- control --------------------------------------------------------------

  async move(cameraId: string, vector: Partial<PtzVector>, durationMs: number): Promise<void> {
    const camera = this.requireCamera(cameraId);
    await this.run(camera, async (client) => {
      await client.continuousMove(vector, durationMs);
      // Cameras can ignore `Timeout`; stopping explicitly is the only guarantee.
      const timer = setTimeout(() => {
        void client.stop().catch(() => undefined);
      }, Math.max(1000, durationMs) + 250);
      timer.unref?.();
      this.pausePatrol(camera.id);
    });
  }

  async stop(cameraId: string): Promise<void> {
    const camera = this.requireCamera(cameraId);
    await this.run(camera, async (client) => {
      await client.stop();
      this.pausePatrol(camera.id);
    });
  }

  async gotoPreset(cameraId: string, name: string): Promise<void> {
    const camera = this.requireCamera(cameraId);
    await this.applyPreset(camera, name, { pause: true });
  }

  async setPatrol(cameraId: string, enabled: boolean): Promise<PtzStatusView> {
    const camera = this.requireCamera(cameraId);
    const state = this.state(camera.id);
    state.patrolOverride = enabled;
    if (state.timer !== undefined) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
    if (enabled) {
      if (camera.ptz?.patrol === undefined) {
        throw new OnvifError('unsupported', 'This camera has no PTZ patrol configured.');
      }
      state.pausedUntil = undefined;
      this.startPatrol(camera);
    }
    return this.status(camera.id);
  }

  // -- internals ------------------------------------------------------------

  private async applyPreset(camera: CameraConfig, name: string, options: { pause: boolean }): Promise<void> {
    const preset = (camera.ptz?.presets ?? []).find((candidate) => candidate.name === name);
    await this.run(camera, async (client) => {
      let token = preset?.token;
      if (token === undefined) {
        const devicePresets = await client.presets().catch(() => []);
        token = devicePresets.find((candidate) => candidate.name === name)?.token;
      }
      if (token !== undefined) {
        await client.gotoPresetToken(token);
        return;
      }
      if (preset !== undefined && (preset.pan !== undefined || preset.tilt !== undefined || preset.zoom !== undefined)) {
        await client.absoluteMove({
          ...(preset.pan === undefined ? {} : { pan: preset.pan }),
          ...(preset.tilt === undefined ? {} : { tilt: preset.tilt }),
          ...(preset.zoom === undefined ? {} : { zoom: preset.zoom }),
        });
        return;
      }
      await client.gotoPreset(name);
    });
    if (options.pause) this.pausePatrol(camera.id);
  }

  /** Runs one client operation, folding success/failure into the camera state. */
  private async run(camera: CameraConfig, operation: (client: OnvifClient) => Promise<void>): Promise<void> {
    const client = this.clientFor(camera);
    try {
      await operation(client);
      const state = this.state(camera.id);
      state.reachable = true;
      state.lastError = undefined;
      state.loggedError = undefined;
    } catch (error) {
      this.recordError(camera.id, error);
      throw error;
    }
  }

  private recordError(cameraId: string, error: unknown): void {
    const state = this.state(cameraId);
    state.reachable = false;
    state.lastError = error instanceof Error ? error.message : String(error);
    if (state.loggedError !== state.lastError) {
      state.loggedError = state.lastError;
      this.options.log?.(`camera ${cameraId}: PTZ: ${state.lastError}`);
    }
  }

  private startPatrol(camera: CameraConfig): void {
    const dwell = Math.max(MIN_DWELL_SECONDS, camera.ptz?.patrol?.dwellSeconds ?? 15);
    const state = this.state(camera.id);
    if (state.timer !== undefined) clearInterval(state.timer);
    const timer = setInterval(() => this.tickPatrol(camera), dwell * 1000);
    timer.unref?.();
    state.timer = timer;
  }

  private tickPatrol(camera: CameraConfig): void {
    const state = this.state(camera.id);
    const now = this.now();
    if (state.pausedUntil !== undefined && now < state.pausedUntil) return;
    const patrol = camera.ptz?.patrol;
    const enabled = state.patrolOverride ?? patrol?.enabled === true;
    const names = patrol?.presets ?? [];
    if (!enabled || names.length === 0) return;
    if (patrol?.scheduleIds !== undefined && patrol.scheduleIds.length > 0) {
      const active = activeSchedules(this.options.config.schedules, new Date(now), patrol.scheduleIds).active;
      if (!active) return;
    }
    const name = patrol?.randomize === true ? (names[Math.floor(Math.random() * names.length)] as string) : (names[state.patrolIndex % names.length] as string);
    state.patrolIndex += 1;
    void this.applyPreset(camera, name, { pause: false }).catch(() => undefined);
  }

  private nextPatrolPreset(camera: CameraConfig): string | undefined {
    const names = camera.ptz?.patrol?.presets ?? [];
    if (names.length === 0) return undefined;
    const state = this.state(camera.id);
    return names[state.patrolIndex % names.length];
  }

  private pausePatrol(cameraId: string): void {
    const camera = this.options.config.cameras.find((candidate) => candidate.id === cameraId);
    if (camera?.ptz?.patrol === undefined) return;
    this.state(cameraId).pausedUntil = this.now() + MANUAL_PAUSE_MS;
  }

  private state(cameraId: string): CameraState {
    let state = this.states.get(cameraId);
    if (state === undefined) {
      state = { reachable: false, devicePresets: [], patrolIndex: 0 };
      this.states.set(cameraId, state);
    }
    return state;
  }

  private clientFor(camera: CameraConfig): OnvifClient {
    const endpoint = this.endpointFor(camera);
    if (endpoint === undefined) {
      throw new OnvifError('unsupported', `Camera "${camera.id}" has no ONVIF endpoint for PTZ control.`);
    }
    const state = this.state(camera.id);
    state.endpoint = endpoint;
    if (state.client === undefined) {
      state.client = this.createClient({
        host: endpoint.host,
        port: endpoint.port,
        ...(endpoint.path === undefined ? {} : { path: endpoint.path }),
        ...(endpoint.secure === undefined ? {} : { secure: endpoint.secure }),
        ...(endpoint.credentials === undefined ? {} : { credentials: endpoint.credentials }),
        ...(endpoint.profileToken === undefined ? {} : { profileToken: endpoint.profileToken }),
        timeoutMs: this.options.config.onvif.defaults?.timeoutMs ?? 8000,
      });
    }
    return state.client;
  }

  private createClient(options: OnvifClientOptions): OnvifClient {
    return (this.options.clientFactory ?? ((clientOptions: OnvifClientOptions) => new OnvifClient(clientOptions)))(options);
  }

  /**
   * Where a camera's ONVIF service lives:
   * explicit `ptz.host` → ONVIF source → RTSP source host (ONVIF is HTTP, port 80).
   */
  private endpointFor(camera: CameraConfig): Endpoint | undefined {
    const defaults = this.options.config.onvif.defaults ?? {};
    const sharedCredentials: Credentials | undefined =
      defaults.username === undefined && defaults.password === undefined
        ? undefined
        : { ...(defaults.username === undefined ? {} : { username: defaults.username }), ...(defaults.password === undefined ? {} : { password: defaults.password }) };

    const configuredHost = camera.ptz?.host;
    if (configuredHost !== undefined && configuredHost.length > 0) {
      return {
        host: configuredHost,
        port: camera.ptz?.port ?? 80,
        ...(sharedCredentials === undefined ? {} : { credentials: sharedCredentials }),
        ...(camera.ptz?.profileToken === undefined ? {} : { profileToken: camera.ptz.profileToken }),
      };
    }

    const main = camera.streams.main;
    if (main.type === 'onvif') {
      const credentials = main.credentials ?? sharedCredentials;
      return {
        host: main.host,
        port: main.port ?? 80,
        ...(credentials === undefined ? {} : { credentials }),
        ...(camera.ptz?.profileToken === undefined
          ? main.profileToken === undefined
            ? {}
            : { profileToken: main.profileToken }
          : { profileToken: camera.ptz.profileToken }),
      };
    }

    if (main.type === 'rtsp') {
      try {
        const url = new URL(main.url);
        const fromUrl: Credentials | undefined =
          url.username.length === 0 && url.password.length === 0
            ? undefined
            : { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
        const credentials = main.credentials ?? fromUrl ?? sharedCredentials;
        return {
          host: url.hostname,
          port: 80,
          ...(credentials === undefined ? {} : { credentials }),
          ...(camera.ptz?.profileToken === undefined ? {} : { profileToken: camera.ptz.profileToken }),
        };
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private requireCamera(cameraId: string): CameraConfig {
    const camera = (this.options.config.cameras ?? []).find((candidate) => candidate.id === cameraId);
    if (camera === undefined) {
      throw new OnvifError('invalid-target', `Camera "${cameraId}" does not exist.`);
    }
    return camera;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
