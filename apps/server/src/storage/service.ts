import { readdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ResolvedIcamifyConfig, StorageVolume } from '@icamify/core';
import {
  createArchiveTarget,
  describeArchiveProvider,
  RetentionEngine,
  type ArchivePlan,
  type DiskUsage,
  type RecordingIndex,
  type RecordingSegment,
  type RetentionPolicy,
  type RetentionSweepResult,
  type RetentionVolume,
  type VolumeStats,
} from '@icamify/storage';
import type { StoragePaths } from '../storage-paths.ts';

/**
 * Storage lifecycle.
 *
 * The retention engine only understands numbers; this service is where the
 * configuration is translated (GB → bytes, hours → milliseconds), where the
 * timer lives, and where filesystem facts the engine cannot know about — orphaned
 * detection snapshots — are cleaned up.
 *
 * A volume whose archive target cannot be built is kept, with the error attached:
 * the NVR keeps recording and the storage panel shows why nothing is being
 * archived, rather than the process refusing to start over a remote bucket.
 */

export type StorageServiceEvent =
  | { type: 'storage:sweep'; volumes: RetentionSweepResult[] }
  | { type: 'storage:warning'; volumeId: string; message: string; freeBytes: number; freePercent: number }
  | { type: 'storage:prune'; snapshotsRemoved: number; eventsRemoved: number; bytesFreed: number };

export interface StorageServiceOptions {
  config: ResolvedIcamifyConfig;
  index: RecordingIndex;
  paths: StoragePaths;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (event: StorageServiceEvent) => void;
  /** Test seam for `statfs`. */
  diskUsage?: (path: string) => Promise<DiskUsage>;
  /** Set false to keep sweeps manual (tests, diagnostics). */
  startTimer?: boolean;
}

export interface SnapshotUsage {
  count: number;
  bytes: number;
}

export interface StorageOverview {
  volumes: VolumeStats[];
  totals: {
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
    segmentCount: number;
    snapshotBytes: number;
    snapshotCount: number;
  };
  policy: RetentionPolicy & { warnAtPercent: number; storeDetectionsDays: number };
  archiveProviders: Array<{ id: string; type: string; label: string; enabled: boolean }>;
  cameras: Array<{ cameraId: string; name: string; bytes: number; segments: number }>;
  lastSweep?: RetentionSweepResult[];
}

const GIB = 1024 ** 3;
const HOUR = 3_600_000;
/** Warnings repeat at most this often per volume; a full disk is not news every minute. */
const WARNING_INTERVAL_MS = 15 * 60_000;

export class StorageService {
  /** The real engine. */
  readonly engine: RetentionEngine;
  readonly policy: RetentionPolicy;

  private readonly options: StorageServiceOptions;
  /** Shares volumes and the index, but reports instead of unlinking. */
  private readonly preview: RetentionEngine;
  private readonly warnedAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private firstSweep: NodeJS.Timeout | undefined;
  private lastSweepResult: RetentionSweepResult[] | undefined;
  private started = false;

  constructor(options: StorageServiceOptions) {
    this.options = options;
    const purge = options.config.storage.purge ?? {};
    this.policy = {
      enabled: purge.enabled !== false,
      intervalSeconds: Math.max(30, Math.round(purge.intervalSeconds ?? 300)),
      strategy: purge.strategy ?? 'oldest-first',
      batchSize: Math.max(1, Math.round(purge.batchSize ?? 50)),
      dryRun: purge.dryRun === true,
      protectFlagged: purge.protectFlagged !== false,
    };
    const volumes = buildVolumes(options.config, options.paths, options.log);
    const common = {
      index: options.index,
      volumes,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.diskUsage === undefined ? {} : { diskUsage: options.diskUsage }),
    };
    this.engine = new RetentionEngine({ ...common, policy: this.policy });
    this.preview = new RetentionEngine({ ...common, policy: { ...this.policy, dryRun: true } });
  }

  get volumes(): RetentionVolume[] {
    return this.engine.volumes;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.policy.enabled) {
      this.options.log?.('storage: retention is disabled (storage.purge.enabled = false)');
      return;
    }
    if (this.policy.dryRun) this.options.log?.('storage: retention is in dry-run mode; nothing will be deleted');
    const intervalMs = this.policy.intervalSeconds * 1000;
    this.timer = setInterval(() => void this.scheduledSweep(), intervalMs);
    this.timer.unref?.();
    // A full disk must not wait for the first interval after a restart.
    this.firstSweep = setTimeout(() => void this.scheduledSweep(), Math.min(5_000, intervalMs));
    this.firstSweep.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.firstSweep !== undefined) clearTimeout(this.firstSweep);
    this.timer = undefined;
    this.firstSweep = undefined;
    this.started = false;
    await this.engine.close();
  }

  /**
   * One pass. `dryRun` is an explicit override, never a policy change.
   *
   * A real sweep also prunes detection history: an operator pressing "sweep now"
   * expects everything storage-related to be reclaimed, not just video files.
   */
  async sweep(options: { volumeId?: string; dryRun?: boolean } = {}): Promise<RetentionSweepResult[]> {
    const engine = options.dryRun === true ? this.preview : this.engine;
    const results = await engine.sweep(options.volumeId);
    if (options.dryRun !== true) {
      this.lastSweepResult = results;
      const pruned = await this.pruneDetections();
      if (pruned.snapshotsRemoved > 0 || pruned.eventsRemoved > 0) {
        this.options.onEvent?.({ type: 'storage:prune', ...pruned });
      }
    }
    return results;
  }

  async stats(volumeId?: string): Promise<VolumeStats[]> {
    return await this.engine.stats(volumeId);
  }

  async protect(segmentId: string, protectedFlag: boolean): Promise<void> {
    await this.engine.protect(segmentId, protectedFlag);
  }

  /** Deletes one segment now (an operator action), file first, then the row. */
  async deleteSegment(segment: RecordingSegment): Promise<void> {
    await unlink(segment.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.options.index.markDeleted(segment.id, this.now());
    this.options.log?.(`storage: deleted ${segment.path} on request`);
  }

  async snapshots(): Promise<SnapshotUsage> {
    let count = 0;
    let bytes = 0;
    for (const file of await this.walkSnapshots(this.options.paths.snapshotsDir)) {
      count += 1;
      bytes += file.bytes;
    }
    return { count, bytes };
  }

  /**
   * Prunes detection history and its snapshots.
   *
   * Events are removed by age first, then any snapshot older than the same cutoff
   * that no surviving event references is unlinked — so a starred/AI event never
   * loses its evidence while the file is still current.
   */
  async pruneDetections(): Promise<{ snapshotsRemoved: number; eventsRemoved: number; bytesFreed: number }> {
    const days = this.options.config.ai.storeDetectionsDays ?? 0;
    if (!(days > 0)) return { snapshotsRemoved: 0, eventsRemoved: 0, bytesFreed: 0 };
    const cutoff = this.now() - days * 24 * HOUR;
    const eventsRemoved = this.options.index.pruneEvents(cutoff);
    const referenced = new Set(this.options.index.snapshotRefs());
    let snapshotsRemoved = 0;
    let bytesFreed = 0;
    for (const file of await this.walkSnapshots(this.options.paths.snapshotsDir)) {
      if (file.mtimeMs >= cutoff) continue;
      if (referenced.has(file.relative)) continue;
      try {
        await unlink(file.path);
        snapshotsRemoved += 1;
        bytesFreed += file.bytes;
      } catch {
        // A snapshot that vanished between the listing and the unlink is fine.
      }
    }
    return { snapshotsRemoved, eventsRemoved, bytesFreed };
  }

  async overview(): Promise<StorageOverview> {
    const volumes = await this.stats();
    const snapshots = await this.snapshots();
    const cameras = (this.options.config.cameras ?? []).map((camera) => {
      const stats = this.options.index.stats({ cameraId: camera.id });
      return { cameraId: camera.id, name: camera.name, bytes: stats.bytes, segments: stats.segments };
    });
    return {
      volumes,
      totals: {
        usedBytes: volumes.reduce((total, volume) => total + volume.usedBytes, 0),
        freeBytes: volumes.reduce((total, volume) => total + volume.freeBytes, 0),
        totalBytes: volumes.reduce((total, volume) => total + volume.totalBytes, 0),
        segmentCount: volumes.reduce((total, volume) => total + volume.segmentCount, 0),
        snapshotBytes: snapshots.bytes,
        snapshotCount: snapshots.count,
      },
      policy: {
        ...this.policy,
        warnAtPercent: this.options.config.storage.warnAtPercent ?? 90,
        storeDetectionsDays: this.options.config.ai.storeDetectionsDays ?? 0,
      },
      archiveProviders: (this.options.config.storage.archiveProviders ?? []).map((provider) => ({
        id: provider.id,
        type: provider.type,
        label: describeArchiveProvider(provider),
        enabled: provider.enabled !== false,
      })),
      cameras,
      ...(this.lastSweepResult === undefined ? {} : { lastSweep: this.lastSweepResult }),
    };
  }

  private async scheduledSweep(): Promise<void> {
    try {
      const results = await this.sweep();
      const changed = results.some(
        (result) => result.deleted.length > 0 || result.archived.length > 0 || result.errors.length > 0,
      );
      if (changed) this.options.onEvent?.({ type: 'storage:sweep', volumes: results });
      await this.checkDiskPressure();
    } catch (error) {
      this.options.log?.(`storage: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async checkDiskPressure(): Promise<void> {
    const warnAt = this.options.config.storage.warnAtPercent ?? 90;
    const now = this.now();
    for (const volume of await this.stats()) {
      if (volume.totalBytes === 0) {
        if (volume.error !== undefined) {
          this.options.onEvent?.({
            type: 'storage:warning',
            volumeId: volume.volumeId,
            message: volume.error,
            freeBytes: 0,
            freePercent: 0,
          });
        }
        continue;
      }
      const freePercent = (volume.freeBytes / volume.totalBytes) * 100;
      if (freePercent >= warnAt) continue;
      const last = this.warnedAt.get(volume.volumeId) ?? 0;
      if (now - last < WARNING_INTERVAL_MS) continue;
      this.warnedAt.set(volume.volumeId, now);
      this.options.onEvent?.({
        type: 'storage:warning',
        volumeId: volume.volumeId,
        freeBytes: volume.freeBytes,
        freePercent: Math.round(freePercent * 10) / 10,
        message: `Volume "${volume.volumeId}" is ${Math.round(freePercent)}% free (warning at ${warnAt}%).`,
      });
    }
  }

  private async walkSnapshots(
    dir: string,
    prefix = '',
  ): Promise<Array<{ relative: string; path: string; bytes: number; mtimeMs: number }>> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: Array<{ relative: string; path: string; bytes: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push(...(await this.walkSnapshots(absolute, relative)));
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await stat(absolute).catch(() => undefined);
      if (stats === undefined) continue;
      files.push({ relative, path: absolute, bytes: stats.size, mtimeMs: stats.mtimeMs });
    }
    return files;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/**
 * One volume per configured entry; with no entries, the recordings directory is
 * the volume, so retention works out of the box without any `storage.volumes`.
 */
export function buildVolumes(
  config: ResolvedIcamifyConfig,
  paths: StoragePaths,
  log?: (line: string) => void,
): RetentionVolume[] {
  const root = paths.rootDir;
  const configured = config.storage.volumes ?? [];
  const entries: Array<Pick<StorageVolume, 'maxSizeGb' | 'maxAgeHours' | 'minFreeDiskGb' | 'archive'> & {
    id: string;
    path: string;
    priority: number;
  }> =
    configured.length === 0
      ? [{ id: config.storage.defaultVolume ?? 'default', path: paths.recordingsDir, priority: 100 }]
      : configured.map((volume) => ({
          id: volume.id,
          path: volume.path,
          priority: volume.priority ?? 100,
          ...(volume.maxSizeGb === undefined ? {} : { maxSizeGb: volume.maxSizeGb }),
          ...(volume.maxAgeHours === undefined ? {} : { maxAgeHours: volume.maxAgeHours }),
          ...(volume.minFreeDiskGb === undefined ? {} : { minFreeDiskGb: volume.minFreeDiskGb }),
          ...(volume.archive === undefined ? {} : { archive: volume.archive }),
        }));

  return entries.map((entry) => {
    const volume: RetentionVolume = {
      id: entry.id,
      path: isAbsolute(entry.path) ? entry.path : resolve(root, entry.path),
      priority: entry.priority,
      ...(entry.maxSizeGb === undefined ? {} : { maxSizeBytes: Math.round(entry.maxSizeGb * GIB) }),
      ...(entry.maxAgeHours === undefined ? {} : { maxAgeMs: Math.round(entry.maxAgeHours * HOUR) }),
      ...(entry.minFreeDiskGb === undefined ? {} : { minFreeBytes: Math.round(entry.minFreeDiskGb * GIB) }),
    };
    if (entry.archive?.enabled !== true) return volume;

    const archiveConfig = entry.archive;
    const provider = (config.storage.archiveProviders ?? []).find((candidate) => candidate.id === archiveConfig.providerId);
    if (provider === undefined) {
      return { ...volume, archiveError: `archive provider "${archiveConfig.providerId ?? ''}" is not configured` };
    }
    let plan: ArchivePlan;
    try {
      plan = {
        target: createArchiveTarget(provider),
        afterMs: Math.round((archiveConfig.afterHours ?? 24) * HOUR),
        keepLocalMs: Math.round((archiveConfig.keepLocalDays ?? 7) * 24 * HOUR),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.(`storage: volume "${entry.id}" cannot archive: ${message}`);
      return { ...volume, archiveError: message };
    }
    return { ...volume, archive: plan };
  });
}
