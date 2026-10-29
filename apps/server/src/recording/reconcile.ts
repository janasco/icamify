import { readdir, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { join } from 'node:path';
import type { ResolvedIcamifyConfig } from '@icamify/core';
import { cameraRecordingPaths } from '@icamify/media';
import type { RecordingIndex, RecordingSegment, SegmentReason } from '@icamify/storage';

/**
 * Boot-time reconciliation between the recording index and the filesystem.
 *
 * The filesystem is the source of truth. FFmpeg can be killed between the moment a
 * file is renamed into place and the moment its row is written, a segment can be
 * deleted by hand, and a crash can leave a tombstone for a file that was never
 * unlinked. This scanner repairs all three:
 *
 * - a playable file with no row is indexed (so the timeline shows it again);
 * - a file that is still present while its row is tombstoned is restored;
 * - a row whose file is gone is tombstoned, so playback offers a clear 410 instead
 *   of a broken clip.
 *
 * The one thing it must never do is tombstone everything because a volume is not
 * mounted: an unreadable camera directory is reported and left completely alone.
 */

export interface ReconcileCameraResult {
  cameraId: string;
  cameraDir: string;
  /** Playable files found on disk. */
  files: number;
  /** Files that had no row and were added. */
  indexed: number;
  /** Rows whose size or end time disagreed with the file and were corrected. */
  refreshed: number;
  /** Tombstoned rows whose file is still on disk. */
  restored: number;
  /** Rows whose file disappeared and were tombstoned. */
  missing: number;
  /** Files whose name did not look like a segment of ours. */
  skipped: number;
  /** Directory could not be read; nothing was changed for this camera. */
  error?: string;
}

export interface ReconcileResult {
  startedAt: number;
  finishedAt: number;
  cameras: ReconcileCameraResult[];
  indexed: number;
  refreshed: number;
  restored: number;
  missing: number;
  skipped: number;
  errors: number;
}

export interface ReconcileOptions {
  config: ResolvedIcamifyConfig;
  index: RecordingIndex;
  log?: (line: string) => void;
  now?: () => number;
}

interface ScannedFile {
  path: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  reason: SegmentReason;
}

const DAY_DIRECTORY = /^(\d{4})(\d{2})(\d{2})$/;
/**
 * `HHMMSS-<reason>[-n]`, written by `finalSegmentPath`. The date lives in the day
 * directory, so the name alone cannot be parsed without its parent.
 */
const SEGMENT_NAME = /^(\d{2})(\d{2})(\d{2})-(continuous|motion|alert|scheduled|manual)(?:-(\d+))?$/;

const PAGE = 500;
/** Safety stop for a pathological index; 500k rows is far past any real library. */
const MAX_PAGES = 1_000;

export async function reconcileRecordings(options: ReconcileOptions): Promise<ReconcileResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const cameras: ReconcileCameraResult[] = [];

  for (const camera of options.config.cameras ?? []) {
    const paths = cameraRecordingPaths(options.config, camera);
    const result: ReconcileCameraResult = {
      cameraId: camera.id,
      cameraDir: paths.cameraDir,
      files: 0,
      indexed: 0,
      refreshed: 0,
      restored: 0,
      missing: 0,
      skipped: 0,
    };
    try {
      const scan = await scanCamera(paths.cameraDir, paths.extension);
      result.files = scan.files.length;
      result.skipped = scan.skipped;
      if (!scan.readable) {
        // A missing mount must not look like "every recording was deleted".
        result.error = 'recording directory is missing or unreadable (volume not mounted?)';
        cameras.push(result);
        continue;
      }

      const rows = collectSegments(options.index, camera.id);
      const byPath = new Map(rows.map((row) => [row.path, row]));
      const found = new Set<string>();

      for (const file of scan.files) {
        found.add(file.path);
        const row = byPath.get(file.path);
        const input = {
          cameraId: camera.id,
          volumeId: paths.volumeId,
          path: file.path,
          startedAt: file.startedAt,
          endedAt: file.endedAt,
          bytes: file.bytes,
          reason: file.reason,
          hasMotion: file.reason === 'motion' || file.reason === 'alert',
          hasAlert: file.reason === 'alert',
        } as const;

        if (row === undefined) {
          options.index.insertSegment(input);
          result.indexed += 1;
          continue;
        }
        if (row.deletedAt !== undefined) {
          options.index.restoreSegment(row.id);
          options.index.insertSegment(input);
          result.restored += 1;
          continue;
        }
        if (row.bytes !== file.bytes || Math.abs(row.endedAt - file.endedAt) > 1_000) {
          options.index.insertSegment(input);
          result.refreshed += 1;
        }
      }

      const prefix = paths.cameraDir.endsWith(sep) ? paths.cameraDir : `${paths.cameraDir}${sep}`;
      for (const row of rows) {
        if (found.has(row.path) || row.deletedAt !== undefined) continue;
        // Only rows this directory owns: a volume that moved must not tombstone a
        // library that is still indexed at its old path.
        if (!row.path.startsWith(prefix)) continue;
        options.index.markDeleted(row.id, startedAt);
        result.missing += 1;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    if (result.error !== undefined) options.log?.(`reconcile: ${camera.id}: ${result.error}`);
    cameras.push(result);
  }

  const total = (pick: (result: ReconcileCameraResult) => number): number =>
    cameras.reduce((sum, camera) => sum + pick(camera), 0);
  const summary: ReconcileResult = {
    startedAt,
    finishedAt: now(),
    cameras,
    indexed: total((camera) => camera.indexed),
    refreshed: total((camera) => camera.refreshed),
    restored: total((camera) => camera.restored),
    missing: total((camera) => camera.missing),
    skipped: total((camera) => camera.skipped),
    errors: cameras.filter((camera) => camera.error !== undefined).length,
  };
  return summary;
}

/** One camera's directory tree: `<cameraDir>/<YYYYMMDD>/<HHMMSS>-<reason>.ext`. */
async function scanCamera(
  cameraDir: string,
  extension: string,
): Promise<{ files: ScannedFile[]; skipped: number; readable: boolean }> {
  let days;
  try {
    days = await readdir(cameraDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      return { files: [], skipped: 0, readable: false };
    }
    throw error;
  }

  const suffix = `.${extension}`;
  const files: ScannedFile[] = [];
  let skipped = 0;

  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dayMatch = DAY_DIRECTORY.exec(day.name);
    // `.hot` and anything else that is not a day bucket is deliberately ignored:
    // in-flight segments are not playable and must never be indexed.
    if (dayMatch === null) continue;
    const dayDir = join(cameraDir, day.name);
    const entries = await readdir(dayDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const match = SEGMENT_NAME.exec(entry.name.slice(0, -suffix.length));
      if (match === null) {
        skipped += 1;
        continue;
      }
      const path = join(dayDir, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      const startedAt = new Date(
        Number(dayMatch[1]),
        Number(dayMatch[2]) - 1,
        Number(dayMatch[3]),
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
      ).getTime();
      if (!Number.isFinite(startedAt)) {
        skipped += 1;
        continue;
      }
      files.push({
        path,
        startedAt,
        // mtime is the last packet FFmpeg wrote, i.e. when the segment ended.
        endedAt: Math.max(startedAt + 1_000, Math.round(info.mtimeMs)),
        bytes: info.size,
        reason: match[4] as SegmentReason,
      });
    }
  }

  files.sort((left, right) => left.startedAt - right.startedAt);
  return { files, skipped, readable: true };
}

function collectSegments(index: RecordingIndex, cameraId: string): RecordingSegment[] {
  const rows: RecordingSegment[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = index.listSegments({
      cameraId,
      includeDeleted: true,
      limit: PAGE,
      offset: page * PAGE,
      order: 'asc',
    });
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}
