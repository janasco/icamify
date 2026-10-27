import { statfs, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { archiveObjectKey, type ArchiveTarget } from './archive/types.ts';
import type { RecordingIndex } from './recordings.ts';
import type {
  RecordingSegment,
  RetentionDeleteReason,
  RetentionManager,
  RetentionPolicy,
  RetentionSweepResult,
  VolumeStats,
} from './index.ts';

/**
 * Retention.
 *
 * One sweep per volume, in a fixed order, because each step can make the next one
 * unnecessary and the cheapest correct answer is always "do nothing":
 *
 *   1. archive  — copy segments past the archive age, honouring the local keep window
 *   2. age      — delete everything older than `maxAgeHours`
 *   3. size     — delete oldest (or largest) until the volume is under `maxSizeGb`
 *   4. disk     — delete until the filesystem has `minFreeDiskGb` free
 *
 * Two rules are absolute:
 * - a starred clip is never touched while `protectFlagged` is on, and
 * - a file is never deleted when it was supposed to be archived and the upload
 *   failed. Losing footage to a network blip would be worse than exceeding quota.
 *
 * Every deletion unlinks first and tombstones second: a row pointing at a missing
 * file is recoverable (playback reports 410 and the file is re-scanned), a file
 * with no row is invisible footage.
 */

export interface ArchivePlan {
  target: ArchiveTarget;
  /** Copy once the segment is this old. */
  afterMs: number;
  /** How long the local copy stays after a successful upload (0 = delete now). */
  keepLocalMs: number;
}

export interface RetentionVolume {
  id: string;
  path: string;
  priority: number;
  maxSizeBytes?: number;
  maxAgeMs?: number;
  minFreeBytes?: number;
  archive?: ArchivePlan;
  /** Set when archiving was requested but the target could not be built. */
  archiveError?: string;
}

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
  error?: string;
}

export interface RetentionEngineOptions {
  index: RecordingIndex;
  volumes: RetentionVolume[];
  policy: RetentionPolicy;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam for `statfs`; the real filesystem is used otherwise. */
  diskUsage?: (path: string) => Promise<DiskUsage>;
}

const PAGE_SIZE = 200;
/** Stops a pathological index from turning one sweep into an unbounded loop. */
const MAX_PAGES = 1000;

export class RetentionEngine implements RetentionManager {
  readonly policy: RetentionPolicy;

  private readonly options: RetentionEngineOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RetentionEngineOptions) {
    this.options = options;
    this.policy = options.policy;
  }

  get volumes(): RetentionVolume[] {
    return this.options.volumes;
  }

  /** Sweeps are serialized: two concurrent passes would race the same files. */
  sweep(volumeId?: string): Promise<RetentionSweepResult[]> {
    const run = this.queue.then(() => this.runSweep(volumeId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async stats(volumeId?: string): Promise<VolumeStats[]> {
    const stats: VolumeStats[] = [];
    for (const volume of this.select(volumeId)) {
      const aggregate = this.options.index.stats({ volumeId: volume.id });
      const usage = await this.usage(volume.path);
      stats.push({
        volumeId: volume.id,
        path: volume.path,
        usedBytes: aggregate.bytes,
        freeBytes: usage.freeBytes,
        totalBytes: usage.totalBytes,
        diskUsedBytes: Math.max(0, usage.totalBytes - usage.freeBytes),
        segmentCount: aggregate.segments,
        limits: {
          ...(volume.maxSizeBytes === undefined ? {} : { maxSizeBytes: volume.maxSizeBytes }),
          ...(volume.maxAgeMs === undefined ? {} : { maxAgeHours: round(volume.maxAgeMs / 3_600_000) }),
          ...(volume.minFreeBytes === undefined ? {} : { minFreeBytes: volume.minFreeBytes }),
        },
        ...(aggregate.oldestAt === undefined ? {} : { oldestAt: aggregate.oldestAt }),
        ...(volume.archive === undefined
          ? {}
          : {
              archive: {
                providerId: volume.archive.target.providerId,
                label: volume.archive.target.label,
                afterHours: round(volume.archive.afterMs / 3_600_000),
                keepLocalDays: round(volume.archive.keepLocalMs / 86_400_000),
              },
            }),
        ...(usage.error === undefined ? {} : { error: usage.error }),
      });
    }
    return stats;
  }

  async protect(segmentId: string, protectedFlag: boolean): Promise<void> {
    this.options.index.protect(segmentId, protectedFlag);
  }

  async close(): Promise<void> {
    for (const volume of this.options.volumes) {
      await volume.archive?.target.close().catch(() => undefined);
    }
  }

  private async runSweep(volumeId?: string): Promise<RetentionSweepResult[]> {
    // Lowest priority first, so a full disk is relieved where footage matters least.
    const volumes = this.select(volumeId).sort((left, right) => left.priority - right.priority);
    const results: RetentionSweepResult[] = [];
    for (const volume of volumes) {
      try {
        results.push(await this.sweepVolume(volume));
      } catch (error) {
        results.push({
          volumeId: volume.id,
          dryRun: this.policy.dryRun,
          startedAt: this.now(),
          finishedAt: this.now(),
          scannedSegments: 0,
          scannedBytes: 0,
          deleted: [],
          archived: [],
          freedBytes: 0,
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    return results;
  }

  private async sweepVolume(volume: RetentionVolume): Promise<RetentionSweepResult> {
    const now = this.now();
    const result: RetentionSweepResult = {
      volumeId: volume.id,
      dryRun: this.policy.dryRun,
      startedAt: now,
      finishedAt: now,
      scannedSegments: 0,
      scannedBytes: 0,
      deleted: [],
      archived: [],
      freedBytes: 0,
      errors: [],
    };
    if (volume.archiveError !== undefined) {
      result.errors.push({ message: `archive unavailable: ${volume.archiveError}` });
    }

    let segments = await this.listAll(volume.id);
    if (this.policy.protectFlagged) segments = segments.filter((segment) => segment.protected !== true);
    result.scannedSegments = segments.length;
    result.scannedBytes = totalBytes(segments);

    // 1. Archive. Uploads happen before any deletion so a failed archive keeps the
    //    footage on disk instead of leaving a gap.
    if (volume.archive !== undefined && volume.archiveError === undefined) {
      for (const segment of [...segments].sort(byEnd)) {
        if (now - segment.endedAt < volume.archive.afterMs) continue;
        if (segment.archivedAt !== undefined) continue;
        if (!(await this.archive(volume, segment, result))) continue;
        if (volume.archive.keepLocalMs === 0) {
          await this.remove(volume, segment, 'age', result, { archiveFirst: false });
        }
      }
      segments = withoutDeleted(segments, result);
    }

    // 2. Age.
    if (volume.maxAgeMs !== undefined) {
      for (const segment of [...segments].sort(byEnd)) {
        if (now - segment.endedAt <= volume.maxAgeMs) continue;
        await this.remove(volume, segment, 'age', result);
      }
      segments = withoutDeleted(segments, result);
    }

    // 3. Size ceiling. Deleted in batches, and the loop stops as soon as the
    //    volume is under quota, because deleting more than necessary is data loss.
    if (volume.maxSizeBytes !== undefined) {
      let used = totalBytes(segments);
      let guard = 0;
      while (used > volume.maxSizeBytes && guard < MAX_PAGES) {
        guard += 1;
        const batch = this.order(segments).slice(0, Math.max(1, this.policy.batchSize));
        if (batch.length === 0) break;
        let progressed = false;
        for (const segment of batch) {
          if (used <= volume.maxSizeBytes) break;
          if (await this.remove(volume, segment, 'size', result)) {
            used -= segment.bytes;
            progressed = true;
          }
        }
        segments = withoutDeleted(segments, result);
        if (!progressed) break;
      }
    }

    // 4. Disk floor. statfs is sampled once; anything this sweep frees is added,
    //    because the kernel may not reflect an unlink in the next statfs call.
    if (volume.minFreeBytes !== undefined) {
      const usage = await this.usage(volume.path);
      let projectedFree = usage.freeBytes + result.freedBytes;
      let guard = 0;
      while (projectedFree < volume.minFreeBytes && guard < MAX_PAGES) {
        guard += 1;
        const next = this.order(segments)[0];
        if (next === undefined) break;
        if (await this.remove(volume, next, 'disk-floor', result)) projectedFree += next.bytes;
        segments = withoutDeleted(segments, result);
      }
    }

    result.finishedAt = this.now();
    return result;
  }

  private async archive(
    volume: RetentionVolume,
    segment: RecordingSegment,
    result: RetentionSweepResult,
  ): Promise<boolean> {
    const plan = volume.archive;
    if (plan === undefined) return false;
    const key = archiveObjectKey({ cameraId: segment.cameraId, startedAt: segment.startedAt, fileName: basename(segment.path) });
    if (this.policy.dryRun) {
      result.archived.push({ segmentId: segment.id, providerId: plan.target.providerId, key, bytes: segment.bytes });
      return true;
    }
    try {
      await plan.target.upload(segment.path, key);
    } catch (error) {
      result.errors.push({
        segmentId: segment.id,
        path: segment.path,
        message: `archive to ${plan.target.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    try {
      this.options.index.markArchived(segment.id, plan.target.providerId, this.now());
    } catch (error) {
      // The copy exists but the row does not know it. Deleting now would risk a
      // second upload attempt later, so the safest outcome is to keep both.
      result.errors.push({
        segmentId: segment.id,
        path: segment.path,
        message: `archived but the index could not be updated: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    result.archived.push({ segmentId: segment.id, providerId: plan.target.providerId, key, bytes: segment.bytes });
    this.options.log?.(`archived ${segment.path} → ${plan.target.label}/${key}`);
    return true;
  }

  private async remove(
    volume: RetentionVolume,
    segment: RecordingSegment,
    reason: RetentionDeleteReason,
    result: RetentionSweepResult,
    options: { archiveFirst?: boolean } = {},
  ): Promise<boolean> {
    if (options.archiveFirst !== false && volume.archive !== undefined && volume.archiveError === undefined) {
      if (segment.archivedAt === undefined && !(await this.archive(volume, segment, result))) return false;
    }
    if (!this.policy.dryRun) {
      try {
        await unlink(segment.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          result.errors.push({
            segmentId: segment.id,
            path: segment.path,
            message: `could not delete: ${error instanceof Error ? error.message : String(error)}`,
          });
          return false;
        }
      }
      try {
        this.options.index.markDeleted(segment.id, this.now());
      } catch (error) {
        result.errors.push({
          segmentId: segment.id,
          path: segment.path,
          message: `deleted but the index could not be updated: ${error instanceof Error ? error.message : String(error)}`,
        });
        return false;
      }
    }
    result.deleted.push({ segmentId: segment.id, path: segment.path, bytes: segment.bytes, reason });
    result.freedBytes += segment.bytes;
    return true;
  }

  private order(segments: RecordingSegment[]): RecordingSegment[] {
    const list = [...segments];
    if (this.policy.strategy === 'largest-first') {
      return list.sort((left, right) => right.bytes - left.bytes || left.endedAt - right.endedAt);
    }
    // `lowest-priority-first` and `oldest-first` both delete the oldest footage
    // inside a volume; the volume order itself already honours priority.
    return list.sort(byEnd);
  }

  private select(volumeId?: string): RetentionVolume[] {
    return volumeId === undefined
      ? this.options.volumes
      : this.options.volumes.filter((volume) => volume.id === volumeId);
  }

  private async listAll(volumeId: string): Promise<RecordingSegment[]> {
    const segments: RecordingSegment[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = this.options.index.listSegments({
        volumeId,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        order: 'asc',
      });
      segments.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return segments;
  }

  private async usage(path: string): Promise<DiskUsage> {
    if (this.options.diskUsage !== undefined) return await this.options.diskUsage(path);
    try {
      const stats = await statfs(path);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch (error) {
      return {
        freeBytes: 0,
        totalBytes: 0,
        error: `cannot read disk usage for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function byEnd(left: RecordingSegment, right: RecordingSegment): number {
  return left.endedAt - right.endedAt || left.startedAt - right.startedAt;
}

function totalBytes(segments: RecordingSegment[]): number {
  return segments.reduce((total, segment) => total + segment.bytes, 0);
}

function withoutDeleted(segments: RecordingSegment[], result: RetentionSweepResult): RecordingSegment[] {
  if (result.deleted.length === 0) return segments;
  const deleted = new Set(result.deleted.map((entry) => entry.segmentId));
  return segments.filter((segment) => !deleted.has(segment.id));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
