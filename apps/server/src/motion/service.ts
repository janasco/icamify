import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CameraConfig, MotionSettings, ResolvedIcamifyConfig, ZoneGrid } from '@icamify/core';
import {
  activeCellCount,
  encodeZoneMask,
  resolveMotionThresholds,
  toZoneGrid,
} from '@icamify/core';
import {
  PixelMotionEngine,
  RawFrameReader,
  compileZones,
  hasActiveCells,
  type Box,
  type Frame,
  type MotionDetection,
} from '@icamify/motion';
import { resolveProfileForPurpose, type IngestSupervisor, type MediaEngine } from '@icamify/media';
import { resolveStoragePaths } from '../storage-paths.ts';

/**
 * Motion service.
 *
 * One `detect` pipeline per camera: FFmpeg decodes the sub-stream down to a tiny
 * grayscale rawvideo and the motion engine never sees a container. This layer
 * owns the lifecycle (start/stop/restart reporting), the debounced motion episode
 * (start → peak → end), and the runtime tuning API (sensitivity and the zone
 * matrix), which is persisted so a restart does not silently undo an operator's
 * mask.
 */

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized: true;
}

export interface MotionAnalysis {
  width: number;
  height: number;
  fps: number;
  pixelFormat: 'gray' | 'rgb24';
}

export interface MotionThresholds {
  threshold: number;
  percentThreshold: number;
  sensitivity: number;
  derivedFromSensitivity: boolean;
}

export interface MotionStatusView {
  cameraId: string;
  enabled: boolean;
  running: boolean;
  state: 'idle' | 'starting' | 'running' | 'stalled' | 'error';
  analysis: MotionAnalysis;
  settings: {
    sensitivity: number;
    intervalMs: number;
    postMotionSeconds: number;
    minBlobPercent: number;
    denoise: number;
    blurRadius: number;
    colorFilter: boolean;
  };
  thresholds: MotionThresholds;
  zones: ZoneGrid;
  activeCells: number;
  totalCells: number;
  motion: boolean;
  lastPercent: number;
  peakPercent: number;
  lastMotionAt?: number;
  lastFrameAt?: number;
  frames: number;
  analysed: number;
  boxes: NormalizedBox[];
  lastError?: string;
}

export type MotionServiceEvent =
  | { type: 'motion:start'; cameraId: string; at: number; percent: number; peakPercent: number; boxes: NormalizedBox[] }
  | { type: 'motion'; cameraId: string; at: number; percent: number; peakPercent: number; boxes: NormalizedBox[] }
  | { type: 'motion:end'; cameraId: string; at: number; percent: number; peakPercent: number; boxes: NormalizedBox[] }
  | { type: 'motion:status'; cameraId: string; status: MotionStatusView };

export interface MotionOverride {
  sensitivity?: number;
  zones?: { cols: number; rows: number; cells: string; mode: 'include' | 'exclude' };
}

export type MotionOverrides = Record<string, MotionOverride>;

export interface MotionServiceOptions {
  config: ResolvedIcamifyConfig;
  media: MediaEngine;
  log?: (line: string) => void;
  now?: () => number;
  onEvent?: (event: MotionServiceEvent) => void;
  /**
   * Called when an episode starts and again at most once per second while it
   * continues. A recorder treats the repeat calls as a heartbeat that extends its
   * recording window, so a person standing in frame keeps recording instead of
   * stopping when the first post-roll expires.
   */
  onMotionStart?: (
    cameraId: string,
    at: number,
    detail: { peakPercent: number; boxes: NormalizedBox[]; episodeId?: string },
  ) => void;
  /** Fires once, when the debounced episode ends, with its real duration. */
  onMotionEnd?: (
    cameraId: string,
    at: number,
    detail: { episodeId: string; startedAt: number; durationSeconds: number; peakPercent: number; boxes: NormalizedBox[] },
  ) => void;
  /** Defaults to `<stateDir>/motion-overrides.json`. */
  overridesPath?: string;
  /** Set to false to build the service without starting pipelines (tests). */
  autoStart?: boolean;
}

export interface MotionPatch {
  sensitivity?: number;
  zones?: { cols?: number; rows?: number; cells?: string | boolean[][]; mode?: 'include' | 'exclude' };
}

interface Episode {
  id: string;
  startedAt: number;
  peakPercent: number;
  boxes: NormalizedBox[];
}

interface WorkerRuntime {
  camera: CameraConfig;
  settings: MotionSettings;
  zones: ZoneGrid;
  analysis: MotionAnalysis;
  engine: PixelMotionEngine;
  reader: RawFrameReader;
  supervisor?: IngestSupervisor;
  state: MotionStatusView['state'];
  frames: number;
  analysed: number;
  lastPercent: number;
  peakPercent: number;
  motion: boolean;
  lastMotionAt?: number;
  lastFrameAt?: number;
  boxes: NormalizedBox[];
  episode?: Episode;
  lastEmitAt: number;
  lastStatusAt: number;
  lastError?: string;
}

const DEFAULT_ANALYSIS_FPS = 5;
const EMIT_INTERVAL_MS = 1000;

export class MotionService {
  private readonly options: MotionServiceOptions;
  private readonly workers = new Map<string, WorkerRuntime>();
  private readonly overridesPath: string;
  private overrides: MotionOverrides = {};
  private started = false;

  constructor(options: MotionServiceOptions) {
    this.options = options;
    this.overridesPath = options.overridesPath ?? join(resolveStoragePaths(options.config).stateDir, 'motion-overrides.json');
  }

  get workerCount(): number {
    return this.workers.size;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadOverrides();
    for (const camera of this.options.config.cameras ?? []) {
      if (camera.enabled === false) continue;
      if (camera.motion?.enabled !== true) continue;
      this.startCamera(camera);
    }
  }

  async stop(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(
      workers.map(async (worker) => {
        try {
          await worker.supervisor?.stop();
        } catch (error) {
          this.options.log?.(`camera ${worker.camera.id}: motion stop failed: ${message(error)}`);
        }
      }),
    );
    this.started = false;
  }

  status(cameraId: string): MotionStatusView | undefined {
    const worker = this.workers.get(cameraId);
    return worker === undefined ? undefined : view(worker);
  }

  /**
   * Status for the API: a camera without a running worker (motion disabled, or the
   * pipeline failed to start) still reports its zones and thresholds, because that
   * is exactly what an operator needs in order to fix it.
   */
  viewForCamera(camera: CameraConfig): MotionStatusView | undefined {
    const worker = this.workers.get(camera.id);
    if (worker !== undefined) return view(worker);
    if (camera.motion === undefined) return undefined;
    return staticView(this.options.config, camera, this.overrides[camera.id]);
  }

  statuses(): MotionStatusView[] {
    return [...this.workers.values()].map(view);
  }

  activeCameras(): string[] {
    return [...this.workers.values()].filter((worker) => worker.motion).map((worker) => worker.camera.id);
  }

  /**
   * Applies runtime tuning. Zones are stored in the same compact mask format the
   * config file uses, so an operator can copy a working mask into config.json.
   */
  async configure(cameraId: string, patch: MotionPatch): Promise<MotionStatusView> {
    const camera = (this.options.config.cameras ?? []).find((candidate) => candidate.id === cameraId);
    if (camera === undefined) throw new Error(`Camera "${cameraId}" does not exist.`);

    const override: MotionOverride = { ...(this.overrides[cameraId] ?? {}) };
    if (patch.sensitivity !== undefined) {
      if (!Number.isFinite(patch.sensitivity)) throw new Error('sensitivity must be a number.');
      override.sensitivity = Math.max(1, Math.min(100, Math.round(patch.sensitivity)));
    }
    if (patch.zones !== undefined) {
      const current = toZoneGrid(this.workers.get(cameraId)?.settings.zones ?? mergedSettings(this.options.config, camera, this.overrides[cameraId]).zones);
      const zones = normalizeZones(patch.zones, current);
      if (!hasActiveCells(compileZones(zones, 1, 1))) {
        throw new Error('The zone matrix monitors nothing; at least one cell must stay active.');
      }
      override.zones = { cols: zones.cols, rows: zones.rows, cells: encodeZoneMask(zones.cells), mode: zones.mode };
    }
    this.overrides[cameraId] = override;

    const worker = this.workers.get(cameraId);
    if (worker === undefined) {
      // Only spawn a pipeline for a camera that actually wants motion detection;
      // otherwise the override is just saved and reported.
      if (this.started && camera.motion?.enabled === true) this.startCamera(camera);
    } else {
      const settings = mergedSettings(this.options.config, camera, override);
      worker.settings = settings;
      worker.zones = toZoneGrid(settings.zones);
      worker.engine.configure({ settings, zones: worker.zones });
      this.emitStatus(worker);
    }

    await this.saveOverrides();
    const status = this.viewForCamera(camera);
    if (status === undefined) throw new Error(`Camera "${cameraId}" has no motion configuration.`);
    return status;
  }

  /** The persisted overrides, for the admin configuration view. */
  overridesFor(cameraId: string): MotionOverride | undefined {
    return this.overrides[cameraId];
  }

  private startCamera(camera: CameraConfig): void {
    const settings = mergedSettings(this.options.config, camera, this.overrides[camera.id]);
    let zones = toZoneGrid(settings.zones);
    if (!hasActiveCells(compileZones(zones, 1, 1))) {
      // A mask that monitors nothing would look identical to "no motion": make
      // the mistake loud and fall back to the full frame rather than going dark.
      this.options.log?.(
        `camera ${camera.id}: motion zone matrix monitors no cells; falling back to the full frame`,
      );
      zones = {
        cols: zones.cols,
        rows: zones.rows,
        mode: 'include',
        cells: Array.from({ length: zones.rows }, () => Array.from({ length: zones.cols }, () => true)),
      };
    }

    const analysis = analysisFor(this.options.config, camera, settings);
    const engine = new PixelMotionEngine({ cameraId: camera.id, settings, zones });
    engine.resize(analysis.width, analysis.height, compileZones(zones, analysis.width, analysis.height));

    const worker: WorkerRuntime = {
      camera,
      settings,
      zones,
      analysis,
      engine,
      reader: new RawFrameReader({
        cameraId: camera.id,
        width: analysis.width,
        height: analysis.height,
        pixelFormat: analysis.pixelFormat,
      }),
      state: 'starting',
      frames: 0,
      analysed: 0,
      lastPercent: 0,
      peakPercent: 0,
      motion: false,
      boxes: [],
      lastEmitAt: 0,
      lastStatusAt: 0,
    };
    this.workers.set(camera.id, worker);

    try {
      worker.supervisor = this.options.media.start(this.options.config, camera, 'detect', {
        detect: {
          width: analysis.width,
          height: analysis.height,
          fps: analysis.fps,
          grayscale: analysis.pixelFormat === 'gray',
        },
        onStdout: (chunk) => this.onStdout(worker, chunk),
        onEvent: (event) => {
          if (event.type === 'running') {
            worker.state = 'running';
            this.emitStatus(worker);
          } else if (event.type === 'degraded' || event.type === 'gave-up') {
            worker.state = 'error';
            worker.lastError = event.type === 'gave-up' ? event.reason : `motion pipeline failed ${event.failures} times`;
            this.emitStatus(worker);
          } else if (event.type === 'exited' && !event.requested) {
            worker.state = 'stalled';
            this.emitStatus(worker);
          } else if (event.type === 'stderr') {
            worker.lastError = event.line;
          }
        },
      });
      this.emitStatus(worker);
    } catch (error) {
      worker.state = 'error';
      worker.lastError = message(error);
      this.options.log?.(`camera ${camera.id}: motion pipeline could not start: ${worker.lastError}`);
      this.emitStatus(worker);
    }
  }

  private onStdout(worker: WorkerRuntime, chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = worker.reader.push(chunk, () => this.now());
    } catch (error) {
      worker.lastError = message(error);
      return;
    }
    for (const frame of frames) this.handleFrame(worker, frame);
  }

  private handleFrame(worker: WorkerRuntime, frame: Frame): void {
    worker.frames += 1;
    worker.lastFrameAt = frame.timestamp;
    let detection: MotionDetection | null;
    try {
      detection = worker.engine.analyze(frame);
    } catch (error) {
      worker.lastError = message(error);
      worker.state = 'error';
      this.emitStatus(worker);
      return;
    }
    if (detection === null) return;

    worker.analysed += 1;
    worker.lastPercent = detection.changedPercent;
    const boxes = normalizeBoxes(detection.boxes, frame.width, frame.height);

    if (detection.motion) {
      worker.lastMotionAt = frame.timestamp;
      worker.boxes = boxes;
      worker.peakPercent = Math.max(worker.peakPercent, detection.changedPercent);
      if (worker.episode === undefined) {
        const episode: Episode = {
          id: randomUUID(),
          startedAt: frame.timestamp,
          peakPercent: detection.changedPercent,
          boxes,
        };
        worker.episode = episode;
        worker.motion = true;
        this.options.onMotionStart?.(worker.camera.id, frame.timestamp, {
          peakPercent: detection.changedPercent,
          boxes,
          episodeId: episode.id,
        });
        this.emit({
          type: 'motion:start',
          cameraId: worker.camera.id,
          at: frame.timestamp,
          percent: detection.changedPercent,
          peakPercent: worker.episode.peakPercent,
          boxes,
        });
      } else {
        const episode = worker.episode;
        episode.peakPercent = Math.max(episode.peakPercent, detection.changedPercent);
        episode.boxes = boxes;
        const now = this.now();
        if (now - worker.lastEmitAt >= EMIT_INTERVAL_MS) {
          worker.lastEmitAt = now;
          // Heartbeat: keeps the recorder's trigger window open while motion lasts.
          this.options.onMotionStart?.(worker.camera.id, frame.timestamp, {
            peakPercent: episode.peakPercent,
            boxes,
            episodeId: episode.id,
          });
          this.emit({
            type: 'motion' as const,
            cameraId: worker.camera.id,
            at: frame.timestamp,
            percent: detection.changedPercent,
            peakPercent: episode.peakPercent,
            boxes,
          });
        }
      }
      this.maybeEmitStatus(worker);
      return;
    }

    if (worker.episode !== undefined) {
      const episode = worker.episode;
      this.emit({
        type: 'motion:end',
        cameraId: worker.camera.id,
        at: frame.timestamp,
        percent: detection.changedPercent,
        peakPercent: episode.peakPercent,
        boxes: episode.boxes,
      });
      this.options.onMotionEnd?.(worker.camera.id, frame.timestamp, {
        episodeId: episode.id,
        startedAt: episode.startedAt,
        durationSeconds: Math.max(0, (frame.timestamp - episode.startedAt) / 1000),
        peakPercent: episode.peakPercent,
        boxes: episode.boxes,
      });
      worker.episode = undefined;
      worker.motion = false;
      worker.boxes = [];
      worker.peakPercent = 0;
      this.emitStatus(worker);
    }
  }

  private emit(event: MotionServiceEvent): void {
    this.options.onEvent?.(event);
  }

  private emitStatus(worker: WorkerRuntime): void {
    this.options.onEvent?.({ type: 'motion:status', cameraId: worker.camera.id, status: view(worker) });
  }

  /** Status pushes are throttled: at 5 fps per camera the raw events are noise. */
  private maybeEmitStatus(worker: WorkerRuntime): void {
    const now = this.now();
    if (now - worker.lastStatusAt < EMIT_INTERVAL_MS) return;
    worker.lastStatusAt = now;
    this.emitStatus(worker);
  }

  private async loadOverrides(): Promise<void> {
    try {
      const text = await readFile(this.overridesPath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.overrides = sanitizeOverrides(parsed as Record<string, unknown>);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.options.log?.(`could not read motion overrides (${this.overridesPath}): ${message(error)}`);
      }
    }
  }

  private async saveOverrides(): Promise<void> {
    try {
      await mkdir(dirname(this.overridesPath), { recursive: true });
      await writeFile(this.overridesPath, `${JSON.stringify(this.overrides, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.options.log?.(`could not persist motion overrides (${this.overridesPath}): ${message(error)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function view(worker: WorkerRuntime): MotionStatusView {
  const thresholds = resolveMotionThresholds(worker.settings);
  return {
    cameraId: worker.camera.id,
    enabled: worker.camera.motion?.enabled === true,
    running: worker.state === 'running',
    state: worker.state,
    analysis: worker.analysis,
    settings: {
      sensitivity: thresholds.sensitivity,
      intervalMs: worker.settings.intervalMs ?? 200,
      postMotionSeconds: worker.settings.postMotionSeconds ?? 0,
      minBlobPercent: worker.settings.minBlobPercent ?? 0,
      denoise: worker.settings.denoise ?? 0,
      blurRadius: worker.settings.blurRadius ?? 0,
      colorFilter: worker.settings.colorFilter?.enabled === true,
    },
    thresholds: {
      threshold: thresholds.threshold,
      percentThreshold: thresholds.percentThreshold,
      sensitivity: thresholds.sensitivity,
      derivedFromSensitivity: thresholds.derivedFromSensitivity,
    },
    zones: worker.zones,
    activeCells: activeCellCount(worker.zones),
    totalCells: worker.zones.cols * worker.zones.rows,
    motion: worker.motion,
    lastPercent: round2(worker.lastPercent),
    peakPercent: round2(worker.peakPercent),
    ...(worker.lastMotionAt === undefined ? {} : { lastMotionAt: worker.lastMotionAt }),
    ...(worker.lastFrameAt === undefined ? {} : { lastFrameAt: worker.lastFrameAt }),
    frames: worker.frames,
    analysed: worker.analysed,
    boxes: worker.boxes,
    ...(worker.lastError === undefined ? {} : { lastError: worker.lastError }),
  };
}

function staticView(
  config: ResolvedIcamifyConfig,
  camera: CameraConfig,
  override: MotionOverride | undefined,
): MotionStatusView {
  const settings = mergedSettings(config, camera, override);
  const zones = toZoneGrid(settings.zones);
  const thresholds = resolveMotionThresholds(settings);
  return {
    cameraId: camera.id,
    enabled: camera.motion?.enabled === true,
    running: false,
    state: 'idle',
    analysis: analysisFor(config, camera, settings),
    settings: {
      sensitivity: thresholds.sensitivity,
      intervalMs: settings.intervalMs ?? 200,
      postMotionSeconds: settings.postMotionSeconds ?? 0,
      minBlobPercent: settings.minBlobPercent ?? 0,
      denoise: settings.denoise ?? 0,
      blurRadius: settings.blurRadius ?? 0,
      colorFilter: settings.colorFilter?.enabled === true,
    },
    thresholds: {
      threshold: thresholds.threshold,
      percentThreshold: thresholds.percentThreshold,
      sensitivity: thresholds.sensitivity,
      derivedFromSensitivity: thresholds.derivedFromSensitivity,
    },
    zones,
    activeCells: activeCellCount(zones),
    totalCells: zones.cols * zones.rows,
    motion: false,
    lastPercent: 0,
    peakPercent: 0,
    frames: 0,
    analysed: 0,
    boxes: [],
  };
}

/** Camera settings win over global settings; a runtime override wins over both. */
export function mergedSettings(
  config: ResolvedIcamifyConfig,
  camera: CameraConfig,
  override: MotionOverride | undefined,
): MotionSettings {
  const base: MotionSettings = { ...config.motion, ...camera.motion };
  if (override?.sensitivity !== undefined) {
    base.sensitivity = override.sensitivity;
    // A slider is an operator saying "use the curve", so explicit knobs from the
    // config stop applying for this camera.
    delete base.threshold;
    delete base.percentThreshold;
  }
  if (override?.zones !== undefined) {
    base.zones = { ...override.zones };
  }
  if (base.zones !== undefined) {
    base.zones = { ...base.zones, cols: base.zones.cols ?? 16, rows: base.zones.rows ?? 16 };
  }
  return base;
}

function analysisFor(config: ResolvedIcamifyConfig, camera: CameraConfig, settings: MotionSettings): MotionAnalysis {
  let width = 320;
  let height = 180;
  let fps: number | undefined;
  try {
    const profile = resolveProfileForPurpose(config, camera, 'detect').profile;
    width = profile.video.width ?? width;
    height = profile.video.height ?? height;
    fps = profile.video.fps;
  } catch {
    // Missing detect profile: the plan will fail with a clear error at start; the
    // analysis geometry still has to be sane for the engine.
  }
  const derived = Math.max(1, Math.round(1000 / (settings.intervalMs ?? 200)));
  const colorFilter = settings.colorFilter?.enabled === true;
  return {
    width: Math.max(16, Math.round(width)),
    height: Math.max(16, Math.round(height)),
    fps: Math.max(1, Math.min(30, Math.round(fps ?? derived))),
    pixelFormat: colorFilter ? 'rgb24' : 'gray',
  };
}

function normalizeZones(
  patch: NonNullable<MotionPatch['zones']>,
  current: ZoneGrid,
): ZoneGrid {
  const cols = clampGrid(patch.cols ?? current.cols);
  const rows = clampGrid(patch.rows ?? current.rows);
  const mode = patch.mode ?? current.mode;

  if (Array.isArray(patch.cells)) {
    const cells = Array.from({ length: rows }, (_unused, row) =>
      Array.from({ length: cols }, (_cell, col) => patch.cells?.[row]?.[col] === true),
    );
    return { cols, rows, mode, cells };
  }

  if (typeof patch.cells === 'string') {
    const decoded = patch.cells.split('/');
    const cells = Array.from({ length: rows }, (_unused, row) =>
      Array.from({ length: cols }, (_cell, col) => decoded[row]?.[col] === '1'),
    );
    return { cols, rows, mode, cells };
  }

  return toZoneGrid({ cols, rows, mode, cells: encodeZoneMask(current.cells) });
}

function clampGrid(value: number): number {
  if (!Number.isFinite(value)) return 16;
  return Math.max(2, Math.min(64, Math.round(value)));
}

function sanitizeOverrides(input: Record<string, unknown>): MotionOverrides {
  const result: MotionOverrides = {};
  for (const [cameraId, value] of Object.entries(input)) {
    if (value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const override: MotionOverride = {};
    if (typeof entry.sensitivity === 'number') override.sensitivity = Math.max(1, Math.min(100, Math.round(entry.sensitivity)));
    const zones = entry.zones;
    if (zones !== null && typeof zones === 'object') {
      const zone = zones as Record<string, unknown>;
      if (typeof zone.cells === 'string') {
        override.zones = {
          cols: typeof zone.cols === 'number' ? clampGrid(zone.cols) : 16,
          rows: typeof zone.rows === 'number' ? clampGrid(zone.rows) : 16,
          cells: zone.cells,
          mode: zone.mode === 'exclude' ? 'exclude' : 'include',
        };
      }
    }
    result[cameraId] = override;
  }
  return result;
}

function normalizeBoxes(boxes: Box[], width: number, height: number): NormalizedBox[] {
  return boxes.map((box) => ({
    x: round3(box.x / width),
    y: round3(box.y / height),
    width: round3(box.width / width),
    height: round3(box.height / height),
    normalized: true,
  }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
