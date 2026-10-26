import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AiCapability, CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import {
  AiError,
  Gateway,
  jpegSize,
  labelMatches,
  normalizeBox,
  remapBox,
  unionBox,
  type CropRect,
  type Detection,
  type ProviderStatus,
} from '@icamify/ai';
import type { RecordingIndex, RecordedEvent } from '@icamify/storage';
import type { NormalizedBox } from '../motion/service.ts';
import type { RecordingManager } from '../recording/manager.ts';
import { resolveStoragePaths } from '../storage-paths.ts';
import { snapshotRelativePath, writeSnapshot } from './snapshots.ts';

/**
 * AI analysis service.
 *
 * Turns a motion episode into a detection result:
 * motion → grab one frame (cropped to the motion region when asked) → detector →
 * filter by the camera's labels → save a snapshot → index an event → hand the
 * result to the rule engine.
 *
 * The throttling and in-flight guards live here rather than in the gateway,
 * because "how often may this camera be analysed" is a camera policy, while the
 * gateway only owns provider capacity.
 */

export interface CapturedFrame {
  jpeg: Buffer;
  width: number;
  height: number;
}

export type CaptureFrame = (
  camera: CameraConfig,
  options: { crop?: CropRect; maxWidth: number },
) => Promise<CapturedFrame>;

export type AiDetectionBox = NormalizedBox;

export interface AiDetectionView {
  label: string;
  confidence: number;
  box?: AiDetectionBox;
}

export interface AiStatusView {
  cameraId: string;
  enabled: boolean;
  providerId?: string;
  providerName?: string;
  task: AiCapability;
  capabilities: AiCapability[];
  labels: string[];
  minConfidence: number;
  intervalMs: number;
  cropToMotion: boolean;
  saveSnapshots: boolean;
  analyses: number;
  detections: number;
  lastDetectionAt?: number;
  lastLatencyMs?: number;
  lastLabels: string[];
  lastError?: string;
  circuit: 'closed' | 'open' | 'unknown';
  /** Normalized rectangle sent to the detector on the last run, when cropped. */
  lastCrop?: { x: number; y: number; width: number; height: number };
}

export interface AiDetectionSummary {
  cameraId: string;
  cameraName: string;
  at: number;
  task: AiCapability;
  providerId: string;
  detections: AiDetectionView[];
  boxes: NormalizedBox[];
  latencyMs: number;
  /** Relative snapshot path when one was saved. */
  snapshot?: string;
  eventIds: string[];
  /** True when the caller asked for this analysis rather than motion. */
  manual: boolean;
}

export type AiServiceEvent =
  | { type: 'ai:detection'; summary: AiDetectionSummary }
  | { type: 'ai:error'; cameraId: string; at: number; message: string }
  | { type: 'ai:status'; cameraId: string; status: AiStatusView };

export interface AiOverride {
  task?: AiCapability;
  labels?: string[];
  minConfidence?: number;
  enabled?: boolean;
}

export type AiOverrides = Record<string, AiOverride>;

export interface AiServiceOptions {
  config: ResolvedIcamifyConfig;
  /** Gateway owned by the caller (tests) or created from config. */
  gateway?: Gateway;
  capture: CaptureFrame;
  index?: RecordingIndex;
  recording?: RecordingManager;
  snapshotsDir?: string;
  overridesPath?: string;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (event: AiServiceEvent) => void;
  /** Fires for every non-empty result; the rule engine listens here. */
  onDetections?: (summary: AiDetectionSummary) => void;
  /** Set to false in tests that drive the service directly. */
  autoStart?: boolean;
}

interface CameraRuntime {
  camera: CameraConfig;
  providerId?: string;
  task: AiCapability;
  capabilities: AiCapability[];
  labels: string[];
  minConfidence: number;
  intervalMs: number;
  cropToMotion: boolean;
  saveSnapshots: boolean;
  analyses: number;
  detections: number;
  lastDetectionAt?: number;
  lastLatencyMs?: number;
  lastLabels: string[];
  lastError?: string;
  lastAttemptAt: number;
  inFlight: boolean;
  lastCrop?: CropRect;
}

const DEFAULT_TASK_ORDER: AiCapability[] = ['object', 'face', 'lpr', 'scene'];

export class AiService {
  readonly gateway: Gateway;

  private readonly options: AiServiceOptions;
  private readonly runtime = new Map<string, CameraRuntime>();
  private readonly overridesPath: string;
  private overrides: AiOverrides = {};
  private started = false;
  private readonly ownsGateway: boolean;

  constructor(options: AiServiceOptions) {
    this.options = options;
    this.ownsGateway = options.gateway === undefined;
    this.gateway =
      options.gateway ??
      new Gateway({
        providers: options.config.ai.providers ?? [],
        ...(options.log === undefined ? {} : { log: options.log }),
      });
    this.overridesPath =
      options.overridesPath ?? join(resolveStoragePaths(options.config).stateDir, 'ai-overrides.json');
  }

  get enabled(): boolean {
    return this.options.config.ai.enabled !== false;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadOverrides();
    for (const camera of this.options.config.cameras ?? []) {
      if (camera.enabled === false || camera.ai?.enabled !== true) continue;
      this.prepare(camera);
    }
    const configured = (this.options.config.ai.providers ?? []).length;
    this.options.log?.(
      `ai: ${this.runtime.size} camera(s) analysing, ${configured} provider(s) configured` +
        (this.gateway.providerIds().length === 0 ? ' (no provider can serve a camera yet)' : ''),
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.ownsGateway) await this.gateway.close();
  }

  statuses(): AiStatusView[] {
    return [...this.runtime.values()].map((runtime) => this.view(runtime));
  }

  status(cameraId: string): AiStatusView | undefined {
    const runtime = this.runtime.get(cameraId);
    return runtime === undefined ? undefined : this.view(runtime);
  }

  /** Status for the API: a camera with AI configured but no runtime still answers. */
  viewForCamera(camera: CameraConfig): AiStatusView | undefined {
    const runtime = this.runtime.get(camera.id);
    if (runtime !== undefined) return this.view(runtime);
    // A runtime override is enough on its own: an operator can enable AI from the
    // console on a camera whose config has no `ai` block yet.
    if (camera.ai === undefined && this.overrides[camera.id] === undefined) return undefined;
    return this.staticView(camera);
  }

  providerStatuses(): ProviderStatus[] {
    return this.gateway.status();
  }

  async health(): Promise<Array<{ providerId: string; ok: boolean; latencyMs?: number; detail?: string }>> {
    return await this.gateway.health();
  }

  overridesFor(cameraId: string): AiOverride | undefined {
    return this.overrides[cameraId];
  }

  /** Applies runtime changes (task, label filter, threshold, enabled). */
  async configure(cameraId: string, patch: AiOverride): Promise<AiStatusView> {
    const camera = (this.options.config.cameras ?? []).find((candidate) => candidate.id === cameraId);
    if (camera === undefined) throw new Error(`Camera "${cameraId}" does not exist.`);

    const override: AiOverride = { ...(this.overrides[cameraId] ?? {}) };
    if (patch.task !== undefined) {
      if (!['object', 'face', 'lpr', 'scene'].includes(patch.task)) {
        throw new Error(`task must be one of: object, face, lpr, scene`);
      }
      override.task = patch.task;
    }
    if (patch.labels !== undefined) {
      if (!Array.isArray(patch.labels)) throw new Error('labels must be an array of strings.');
      override.labels = patch.labels
        .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
        .map((label) => label.trim());
    }
    if (patch.minConfidence !== undefined) {
      const value = Number(patch.minConfidence);
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('minConfidence must be between 0 and 1.');
      override.minConfidence = value;
    }
    if (patch.enabled !== undefined) override.enabled = patch.enabled === true;
    this.overrides[cameraId] = override;

    if (this.started && this.isCameraEnabled(camera)) this.prepare(camera);
    else this.runtime.delete(cameraId);
    const runtime = this.runtime.get(cameraId);
    if (runtime !== undefined) this.emitStatus(runtime);

    await this.saveOverrides();
    const status = this.viewForCamera(camera);
    if (status === undefined) throw new Error(`Camera "${cameraId}" has no AI configuration.`);
    return status;
  }

  /**
   * Runs one analysis. Safe to call on every motion heartbeat: the per-camera
   * interval and the in-flight guard make extra calls cheap no-ops.
   */
  async analyze(
    cameraId: string,
    options: { boxes?: NormalizedBox[]; manual?: boolean } = {},
  ): Promise<AiDetectionSummary | undefined> {
    const camera = this.options.config.cameras.find((candidate) => candidate.id === cameraId);
    if (camera === undefined) throw new Error(`Camera "${cameraId}" does not exist.`);
    if (this.options.config.ai.enabled === false) return undefined;
    if (!this.isCameraEnabled(camera) && options.manual !== true) return undefined;

    const runtime = this.runtime.get(cameraId) ?? this.prepare(camera);
    if (runtime === undefined) return undefined;

    const now = this.now();
    // A slow detector must not build a backlog: one analysis at a time per camera.
    if (runtime.inFlight) return undefined;
    const providerId = runtime.providerId;
    if (providerId === undefined) {
      this.fail(runtime, now, `No AI provider is available for camera "${camera.name}". Check ai.providers and camera.ai.providerId.`);
      return undefined;
    }
    if (this.gateway.provider(providerId) === undefined) {
      // Fail before spending an FFmpeg spawn on a detector that cannot exist.
      this.fail(runtime, now, `AI provider "${providerId}" is not configured.`);
      return undefined;
    }
    if (options.manual !== true && now - runtime.lastAttemptAt < runtime.intervalMs) return undefined;
    runtime.lastAttemptAt = now;
    runtime.inFlight = true;

    try {
      const crop = this.cropFor(runtime, options.boxes);
      runtime.lastCrop = crop;
      const maxWidth = this.options.config.storage.snapshot?.maxWidth ?? 1280;
      const frame = await this.options.capture(camera, {
        maxWidth,
        ...(crop === undefined ? {} : { crop }),
      });

      const startedAt = now;
      const detections = await this.gateway.detect(providerId, {
        camera: { id: camera.id, name: camera.name },
        image: frame.jpeg,
        mimeType: 'image/jpeg',
        task: runtime.task,
        ...(runtime.labels.length === 0 ? {} : { labels: runtime.labels }),
        minConfidence: runtime.minConfidence,
      });
      runtime.lastLatencyMs = this.now() - startedAt;

      const kept = this.finalizeDetections(detections, frame, crop, runtime);
      runtime.analyses += 1;
      runtime.lastError = undefined;
      if (kept.length === 0) {
        runtime.lastLabels = [];
        this.emitStatus(runtime);
        return undefined;
      }

      runtime.detections += kept.length;
      runtime.lastDetectionAt = this.now();
      runtime.lastLabels = [...new Set(kept.map((detection) => detection.label))];

      const snapshot = await this.saveSnapshot(camera, kept, frame, runtime);
      const eventIds = this.indexDetections(camera, runtime, kept, snapshot);
      const summary: AiDetectionSummary = {
        cameraId: camera.id,
        cameraName: camera.name,
        at: this.now(),
        task: runtime.task,
        providerId,
        detections: kept,
        boxes: kept.flatMap((detection) => (detection.box === undefined ? [] : [detection.box])),
        latencyMs: runtime.lastLatencyMs ?? 0,
        ...(snapshot === undefined ? {} : { snapshot }),
        eventIds,
        manual: options.manual === true,
      };

      this.options.onEvent?.({ type: 'ai:detection', summary });
      this.options.onDetections?.(summary);
      this.emitStatus(runtime);
      return summary;
    } catch (error) {
      this.fail(runtime, this.now(), message(error));
      return undefined;
    } finally {
      runtime.inFlight = false;
    }
  }

  /** Rebuilds the runtime for a camera from config + overrides. */
  private prepare(camera: CameraConfig): CameraRuntime | undefined {
    const override = this.overrides[camera.id];
    const providerId = this.gateway.resolveProviderId(camera.ai?.providerId, this.options.config.ai.defaultProviderId);
    const capabilities = providerId === undefined ? [] : this.gateway.capabilitiesOf(providerId);
    const task = this.selectTask(override?.task, capabilities);
    const runtime: CameraRuntime = {
      camera,
      ...(providerId === undefined ? {} : { providerId }),
      task,
      capabilities,
      labels: override?.labels ?? camera.ai?.labels ?? [],
      minConfidence: override?.minConfidence ?? camera.ai?.minConfidence ?? 0.4,
      intervalMs: Math.max(0, camera.ai?.intervalMs ?? 2000),
      cropToMotion: camera.ai?.cropToMotion === true,
      saveSnapshots: camera.ai?.saveSnapshots === true || camera.ai?.snapshotOnAlert === true,
      analyses: 0,
      detections: 0,
      lastLabels: [],
      lastAttemptAt: 0,
      inFlight: false,
    };
    this.runtime.set(camera.id, runtime);
    return runtime;
  }

  private selectTask(override: AiCapability | undefined, capabilities: AiCapability[]): AiCapability {
    if (override !== undefined) return override;
    // With several declared capabilities, prefer object detection: it is what
    // motion-triggered alerting needs in the overwhelming majority of installs.
    const preferred = DEFAULT_TASK_ORDER.find((task) => capabilities.includes(task));
    return preferred ?? 'object';
  }

  private isCameraEnabled(camera: CameraConfig): boolean {
    if (this.options.config.ai.enabled === false) return false;
    const override = this.overrides[camera.id];
    if (override?.enabled === false) return false;
    if (override?.enabled === true) return true;
    return camera.ai?.enabled === true;
  }

  private cropFor(runtime: CameraRuntime, boxes: NormalizedBox[] | undefined): CropRect | undefined {
    if (!runtime.cropToMotion) return undefined;
    if (runtime.task === 'scene') return undefined;
    if (boxes === undefined || boxes.length === 0) return undefined;
    return unionBox(boxes);
  }

  /**
   * Filters and normalizes detections.
   *
   * Boxes come back in pixels of the *submitted* image; when that image was a
   * crop, they are remapped into full-frame 0..1 coordinates so the overlay and
   * the timeline can draw them on the uncropped video.
   */
  private finalizeDetections(
    detections: Detection[],
    frame: CapturedFrame,
    crop: CropRect | undefined,
    runtime: CameraRuntime,
  ): AiDetectionView[] {
    const size = jpegSize(frame.jpeg) ?? { width: frame.width, height: frame.height };
    const limited = detections.slice(0, Math.max(1, this.options.config.ai.maxDetectionsPerFrame ?? 50));
    const result: AiDetectionView[] = [];
    for (const detection of limited) {
      const label = detection.label.trim();
      if (label.length === 0) continue;
      if (!labelMatches(label, runtime.labels)) continue;
      if (detection.confidence < runtime.minConfidence) continue;

      if (detection.box === undefined) {
        result.push({ label, confidence: round3(detection.confidence) });
        continue;
      }
      const pixelBox = detection.box.normalized === true
        ? {
            x: detection.box.x * size.width,
            y: detection.box.y * size.height,
            width: detection.box.width * size.width,
            height: detection.box.height * size.height,
          }
        : detection.box;
      const relative = normalizeBox(pixelBox, size);
      const box = crop === undefined ? relative : remapBox(relative, crop);
      result.push({
        label,
        confidence: round3(detection.confidence),
        box: {
          x: round3(clamp01(box.x)),
          y: round3(clamp01(box.y)),
          width: round3(clamp01(Math.min(box.width, 1 - box.x))),
          height: round3(clamp01(Math.min(box.height, 1 - box.y))),
          normalized: true,
        },
      });
    }
    return result;
  }

  private async saveSnapshot(
    camera: CameraConfig,
    detections: AiDetectionView[],
    frame: CapturedFrame,
    runtime: CameraRuntime,
  ): Promise<string | undefined> {
    if (!runtime.saveSnapshots) return undefined;
    const at = this.now();
    const relative = snapshotRelativePath(camera.id, at, detections.map((detection) => detection.label));
    const root = this.options.snapshotsDir ?? resolveStoragePaths(this.options.config).snapshotsDir;
    try {
      return await writeSnapshot(root, relative, frame.jpeg);
    } catch (error) {
      this.options.log?.(`camera ${camera.id}: could not save detection snapshot: ${message(error)}`);
      return undefined;
    }
  }

  private indexDetections(
    camera: CameraConfig,
    runtime: CameraRuntime,
    detections: AiDetectionView[],
    snapshot: string | undefined,
  ): string[] {
    const index = this.options.index;
    if (index === undefined) return [];
    const kind = `ai.${runtime.task}` as const;
    const byLabel = new Map<string, AiDetectionView[]>();
    for (const detection of detections) {
      const list = byLabel.get(detection.label) ?? [];
      list.push(detection);
      byLabel.set(detection.label, list);
    }

    const ids: string[] = [];
    for (const [label, group] of byLabel) {
      try {
        const event: RecordedEvent = index.insertEvent({
          cameraId: camera.id,
          kind,
          startedAt: this.now(),
          label,
          confidence: Math.max(...group.map((detection) => detection.confidence)),
          providerId: runtime.providerId,
          ...(group.some((detection) => detection.box !== undefined)
            ? { boxes: group.flatMap((detection) => (detection.box === undefined ? [] : [detection.box])) }
            : {}),
          ...(snapshot === undefined ? {} : { snapshot }),
        });
        ids.push(event.id);
      } catch (error) {
        this.options.log?.(`camera ${camera.id}: could not index AI event: ${message(error)}`);
      }
    }
    return ids;
  }

  private fail(runtime: CameraRuntime, at: number, error: string): void {
    runtime.lastError = error;
    this.options.log?.(`camera ${runtime.camera.id}: ai: ${error}`);
    this.options.onEvent?.({ type: 'ai:error', cameraId: runtime.camera.id, at, message: error });
    this.emitStatus(runtime);
  }

  private emitStatus(runtime: CameraRuntime): void {
    this.options.onEvent?.({ type: 'ai:status', cameraId: runtime.camera.id, status: this.view(runtime) });
  }

  private view(runtime: CameraRuntime): AiStatusView {
    const provider = runtime.providerId === undefined ? undefined : this.gateway.status().find((entry) => entry.id === runtime.providerId);
    return {
      cameraId: runtime.camera.id,
      enabled: this.isCameraEnabled(runtime.camera),
      ...(runtime.providerId === undefined ? {} : { providerId: runtime.providerId }),
      ...(provider === undefined ? {} : { providerName: provider.name }),
      task: runtime.task,
      capabilities: [...runtime.capabilities],
      labels: [...runtime.labels],
      minConfidence: runtime.minConfidence,
      intervalMs: runtime.intervalMs,
      cropToMotion: runtime.cropToMotion,
      saveSnapshots: runtime.saveSnapshots,
      analyses: runtime.analyses,
      detections: runtime.detections,
      ...(runtime.lastDetectionAt === undefined ? {} : { lastDetectionAt: runtime.lastDetectionAt }),
      ...(runtime.lastLatencyMs === undefined ? {} : { lastLatencyMs: runtime.lastLatencyMs }),
      lastLabels: [...runtime.lastLabels],
      ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
      circuit: provider?.circuit ?? 'unknown',
      ...(runtime.lastCrop === undefined ? {} : { lastCrop: runtime.lastCrop }),
    };
  }

  private staticView(camera: CameraConfig): AiStatusView {
    const override = this.overrides[camera.id];
    const providerId = this.gateway.resolveProviderId(camera.ai?.providerId, this.options.config.ai.defaultProviderId);
    const capabilities = providerId === undefined ? [] : this.gateway.capabilitiesOf(providerId);
    const provider = providerId === undefined ? undefined : this.gateway.status().find((entry) => entry.id === providerId);
    return {
      cameraId: camera.id,
      enabled: this.isCameraEnabled(camera),
      ...(providerId === undefined ? {} : { providerId }),
      ...(provider === undefined ? {} : { providerName: provider.name }),
      task: this.selectTask(override?.task, capabilities),
      capabilities,
      labels: override?.labels ?? camera.ai?.labels ?? [],
      minConfidence: override?.minConfidence ?? camera.ai?.minConfidence ?? 0.4,
      intervalMs: Math.max(0, camera.ai?.intervalMs ?? 2000),
      cropToMotion: camera.ai?.cropToMotion === true,
      saveSnapshots: camera.ai?.saveSnapshots === true || camera.ai?.snapshotOnAlert === true,
      analyses: 0,
      detections: 0,
      lastLabels: [],
      circuit: provider?.circuit ?? 'unknown',
    };
  }

  private async loadOverrides(): Promise<void> {
    try {
      const text = await readFile(this.overridesPath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.overrides = sanitizeOverrides(parsed as Record<string, unknown>);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.log?.(`could not read AI overrides (${this.overridesPath}): ${message(error)}`);
      }
    }
  }

  private async saveOverrides(): Promise<void> {
    try {
      await mkdir(dirname(this.overridesPath), { recursive: true });
      await writeFile(this.overridesPath, `${JSON.stringify(this.overrides, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.options.log?.(`could not persist AI overrides (${this.overridesPath}): ${message(error)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function sanitizeOverrides(input: Record<string, unknown>): AiOverrides {
  const result: AiOverrides = {};
  for (const [cameraId, value] of Object.entries(input)) {
    if (value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const override: AiOverride = {};
    if (entry.task === 'object' || entry.task === 'face' || entry.task === 'lpr' || entry.task === 'scene') {
      override.task = entry.task;
    }
    if (Array.isArray(entry.labels)) {
      override.labels = entry.labels.filter((label): label is string => typeof label === 'string');
    }
    if (typeof entry.minConfidence === 'number' && entry.minConfidence >= 0 && entry.minConfidence <= 1) {
      override.minConfidence = entry.minConfidence;
    }
    if (typeof entry.enabled === 'boolean') override.enabled = entry.enabled;
    result[cameraId] = override;
  }
  return result;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function message(error: unknown): string {
  return error instanceof AiError || error instanceof Error ? error.message : String(error);
}
