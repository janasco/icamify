import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fromInt, openDatabase, toInt, type OpenDatabaseOptions } from './db.ts';
import type { RecordedEvent, RecordingEventKind, RecordingSegment, SegmentReason } from './index.ts';

/**
 * The recording index.
 *
 * Two entities:
 * - `segments` are files on disk, one row per finalized file. They are what the
 *   timeline draws and what retention deletes.
 * - `events` are what happened (motion, an AI detection, a rule hit) and they
 *   link to segments, so "show me only the parts with a person" is a join instead
 *   of a filesystem scan.
 *
 * Segments have no pre-buffer concept: a pre-buffered file is only indexed once
 * it is adopted, so the timeline never shows footage that is about to be thrown
 * away.
 */

export interface SegmentInput {
  id?: string;
  cameraId: string;
  volumeId?: string;
  path: string;
  startedAt: number;
  endedAt: number;
  bytes?: number;
  reason: SegmentReason;
  hasMotion?: boolean;
  hasAlert?: boolean;
  eventId?: string;
  protected?: boolean;
}

export type SegmentPatch = Partial<Pick<RecordingSegment, 'endedAt' | 'bytes' | 'reason' | 'hasMotion' | 'hasAlert'>>;

export interface SegmentQuery {
  cameraId?: string;
  volumeId?: string;
  /** Inclusive lower bound on `startedAt`. */
  from?: number;
  /** Exclusive upper bound on `startedAt`. */
  to?: number;
  reason?: SegmentReason;
  hasMotion?: boolean;
  hasAlert?: boolean;
  /** Include tombstones left by retention. Off by default. */
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  /** `asc` for timeline playback, `desc` for "latest clips" lists. */
  order?: 'asc' | 'desc';
}

export interface SegmentStats {
  cameraId?: string;
  volumeId?: string;
  segments: number;
  bytes: number;
  oldestAt?: number;
  newestAt?: number;
}

export interface EventInput {
  id?: string;
  cameraId: string;
  kind: RecordingEventKind;
  startedAt: number;
  endedAt?: number;
  peakPercent?: number;
  label?: string;
  boxes?: unknown;
  confidence?: number;
  providerId?: string;
  snapshot?: string;
}

export interface EventPatch {
  endedAt?: number;
  peakPercent?: number;
  label?: string;
  boxes?: unknown;
  snapshot?: string;
}

export interface EventQuery {
  cameraId?: string;
  kind?: RecordingEventKind;
  /** Case-insensitive label filter ("person" matches "Person/Adult"). */
  label?: string;
  providerId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

const MAX_LIMIT = 500;

interface SegmentRow {
  id: string;
  camera_id: string;
  volume_id: string;
  path: string;
  started_at: number;
  ended_at: number;
  bytes: number;
  reason: string;
  has_motion: number;
  has_alert: number;
  protected: number;
  event_id: string | null;
  archived_at: number | null;
  archived_by: string | null;
}

interface EventRow {
  id: string;
  camera_id: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  peak_percent: number | null;
  label: string | null;
  boxes: string | null;
  confidence: number | null;
  provider_id: string | null;
  snapshot: string | null;
}

export class RecordingIndex {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: OpenDatabaseOptions) {
    this.path = options.path;
    this.db = openDatabase(options);
  }

  static open(path: string): RecordingIndex {
    return new RecordingIndex({ path });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -- segments --------------------------------------------------------------

  /**
   * Inserts a finalized segment. Re-indexing the same path (a restart, a rescanned
   * directory) updates the row instead of failing or duplicating it.
   */
  insertSegment(input: SegmentInput): RecordingSegment {
    const existing = this.getSegmentByPath(input.path);
    if (existing !== undefined) {
      this.db
        .prepare('UPDATE segments SET ended_at = ?, bytes = ?, camera_id = ?, volume_id = ? WHERE id = ?')
        .run(Math.round(input.endedAt), Math.round(input.bytes ?? 0), input.cameraId, input.volumeId ?? '', existing.id);
      return this.getSegment(existing.id)!;
    }

    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO segments
           (id, camera_id, volume_id, path, started_at, ended_at, bytes, reason, has_motion, has_alert, protected, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.cameraId,
        input.volumeId ?? '',
        input.path,
        Math.round(input.startedAt),
        Math.round(input.endedAt),
        Math.round(input.bytes ?? 0),
        input.reason,
        toInt(input.hasMotion),
        toInt(input.hasAlert),
        toInt(input.protected),
        input.eventId ?? null,
        Date.now(),
      );
    if (input.eventId !== undefined) this.linkEvent(id, input.eventId);
    return this.getSegment(id)!;
  }

  finalizeSegment(id: string, patch: { endedAt: number; bytes?: number }): RecordingSegment | undefined {
    this.db
      .prepare('UPDATE segments SET ended_at = ?, bytes = COALESCE(?, bytes) WHERE id = ?')
      .run(Math.round(patch.endedAt), patch.bytes === undefined ? null : Math.round(patch.bytes), id);
    return this.getSegment(id);
  }

  updateSegment(id: string, patch: SegmentPatch): RecordingSegment | undefined {
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    if (patch.endedAt !== undefined) {
      assignments.push('ended_at = ?');
      values.push(Math.round(patch.endedAt));
    }
    if (patch.bytes !== undefined) {
      assignments.push('bytes = ?');
      values.push(Math.round(patch.bytes));
    }
    if (patch.reason !== undefined) {
      assignments.push('reason = ?');
      values.push(patch.reason);
    }
    if (patch.hasMotion !== undefined) {
      assignments.push('has_motion = ?');
      values.push(toInt(patch.hasMotion));
    }
    if (patch.hasAlert !== undefined) {
      assignments.push('has_alert = ?');
      values.push(toInt(patch.hasAlert));
    }
    if (assignments.length === 0) return this.getSegment(id);
    values.push(id);
    this.db.prepare(`UPDATE segments SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    return this.getSegment(id);
  }

  getSegment(id: string): RecordingSegment | undefined {
    const row = this.db.prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined;
    return row === undefined ? undefined : mapSegment(row, this.eventIds(row.id));
  }

  getSegmentByPath(path: string): RecordingSegment | undefined {
    const row = this.db.prepare('SELECT * FROM segments WHERE path = ?').get(path) as SegmentRow | undefined;
    return row === undefined ? undefined : mapSegment(row, this.eventIds(row.id));
  }

  listSegments(query: SegmentQuery = {}): RecordingSegment[] {
    const { where, params } = segmentFilter(query);
    const limit = clampLimit(query.limit);
    const offset = Math.max(0, Math.round(query.offset ?? 0));
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(`SELECT * FROM segments ${where} ORDER BY started_at ${order}, created_at ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as SegmentRow[];
    return rows.map((row) => mapSegment(row, this.eventIds(row.id)));
  }

  countSegments(query: SegmentQuery = {}): number {
    const { where, params } = segmentFilter(query);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM segments ${where}`).get(...params) as { count: number };
    return Number(row.count);
  }

  stats(query: Pick<SegmentQuery, 'cameraId'> & { volumeId?: string } = {}): SegmentStats {
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: Array<string | number> = [];
    if (query.cameraId !== undefined) {
      clauses.push('camera_id = ?');
      params.push(query.cameraId);
    }
    if (query.volumeId !== undefined) {
      clauses.push('volume_id = ?');
      params.push(query.volumeId);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, MIN(started_at) AS oldest, MAX(ended_at) AS newest
         FROM segments WHERE ${clauses.join(' AND ')}`,
      )
      .get(...params) as { count: number; bytes: number; oldest: number | null; newest: number | null };
    return {
      ...(query.cameraId === undefined ? {} : { cameraId: query.cameraId }),
      ...(query.volumeId === undefined ? {} : { volumeId: query.volumeId }),
      segments: Number(row.count),
      bytes: Number(row.bytes),
      ...(row.oldest === null ? {} : { oldestAt: Number(row.oldest) }),
      ...(row.newest === null ? {} : { newestAt: Number(row.newest) }),
    };
  }

  protect(id: string, protectedFlag: boolean): void {
    this.db.prepare('UPDATE segments SET protected = ? WHERE id = ?').run(toInt(protectedFlag), id);
  }

  /** Tombstones a row; the caller deletes the file (retention, Phase 5). */
  markDeleted(id: string, at = Date.now()): void {
    this.db.prepare('UPDATE segments SET deleted_at = ? WHERE id = ?').run(at, id);
  }

  /** Records that a copy of the segment exists on an archive target. */
  markArchived(id: string, providerId: string, at = Date.now()): void {
    this.db.prepare('UPDATE segments SET archived_at = ?, archived_by = ? WHERE id = ?').run(at, providerId, id);
  }

  /** Every snapshot path still referenced by an event, for pruning orphans. */
  snapshotRefs(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT snapshot FROM events WHERE snapshot IS NOT NULL')
      .all() as unknown as Array<{ snapshot: string }>;
    return rows.map((row) => row.snapshot);
  }

  /** Tombstones every segment that ended before `before` and is not protected. */
  markDeletedBefore(before: number, query: Pick<SegmentQuery, 'cameraId' | 'volumeId'> = {}): number {
    const clauses = ['deleted_at IS NULL', 'ended_at < ?', 'protected = 0'];
    const params: Array<string | number> = [Math.round(before)];
    if (query.cameraId !== undefined) {
      clauses.push('camera_id = ?');
      params.push(query.cameraId);
    }
    if (query.volumeId !== undefined) {
      clauses.push('volume_id = ?');
      params.push(query.volumeId);
    }
    const result = this.db.prepare(`UPDATE segments SET deleted_at = ? WHERE ${clauses.join(' AND ')}`).run(Date.now(), ...params);
    return Number(result.changes);
  }

  linkEvent(segmentId: string, eventId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO segment_events (segment_id, event_id) VALUES (?, ?)').run(segmentId, eventId);
  }

  // -- events ----------------------------------------------------------------

  insertEvent(input: EventInput): RecordedEvent {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO events (id, camera_id, kind, started_at, ended_at, peak_percent, label, boxes, confidence, provider_id, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.cameraId,
        input.kind,
        Math.round(input.startedAt),
        input.endedAt === undefined ? null : Math.round(input.endedAt),
        input.peakPercent === undefined ? null : input.peakPercent,
        input.label ?? null,
        input.boxes === undefined ? null : JSON.stringify(input.boxes),
        input.confidence === undefined ? null : input.confidence,
        input.providerId ?? null,
        input.snapshot ?? null,
        Date.now(),
      );
    return this.getEvent(id)!;
  }

  updateEvent(id: string, patch: EventPatch): RecordedEvent | undefined {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.endedAt !== undefined) {
      assignments.push('ended_at = ?');
      values.push(Math.round(patch.endedAt));
    }
    if (patch.peakPercent !== undefined) {
      assignments.push('peak_percent = ?');
      values.push(patch.peakPercent);
    }
    if (patch.label !== undefined) {
      assignments.push('label = ?');
      values.push(patch.label);
    }
    if (patch.boxes !== undefined) {
      assignments.push('boxes = ?');
      values.push(JSON.stringify(patch.boxes));
    }
    if (patch.snapshot !== undefined) {
      assignments.push('snapshot = ?');
      values.push(patch.snapshot);
    }
    if (assignments.length === 0) return this.getEvent(id);
    values.push(id);
    this.db.prepare(`UPDATE events SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    return this.getEvent(id);
  }

  getEvent(id: string): RecordedEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return row === undefined ? undefined : mapEvent(row);
  }

  listEvents(query: EventQuery = {}): RecordedEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.cameraId !== undefined) {
      clauses.push('camera_id = ?');
      params.push(query.cameraId);
    }
    if (query.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    if (query.label !== undefined) {
      clauses.push('LOWER(label) LIKE ?');
      params.push(`%${query.label.toLowerCase()}%`);
    }
    if (query.providerId !== undefined) {
      clauses.push('provider_id = ?');
      params.push(query.providerId);
    }
    if (query.from !== undefined) {
      clauses.push('started_at >= ?');
      params.push(Math.round(query.from));
    }
    if (query.to !== undefined) {
      clauses.push('started_at < ?');
      params.push(Math.round(query.to));
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY started_at ${order} LIMIT ? OFFSET ?`)
      .all(...params, clampLimit(query.limit), Math.max(0, Math.round(query.offset ?? 0))) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  eventCount(cameraId?: string): number {
    const row =
      cameraId === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number })
        : (this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE camera_id = ?').get(cameraId) as { count: number });
    return Number(row.count);
  }

  /** Removes events that ended (or started) before `before`; returns the count. */
  pruneEvents(before: number): number {
    const result = this.db.prepare('DELETE FROM events WHERE COALESCE(ended_at, started_at) < ?').run(Math.round(before));
    this.db.exec('DELETE FROM segment_events WHERE event_id NOT IN (SELECT id FROM events)');
    return Number(result.changes);
  }

  private eventIds(segmentId: string): string[] {
    const rows = this.db
      .prepare('SELECT event_id FROM segment_events WHERE segment_id = ? ORDER BY event_id')
      .all(segmentId) as unknown as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }
}

function segmentFilter(query: SegmentQuery): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (query.includeDeleted !== true) clauses.push('deleted_at IS NULL');
  if (query.cameraId !== undefined) {
    clauses.push('camera_id = ?');
    params.push(query.cameraId);
  }
  if (query.volumeId !== undefined) {
    clauses.push('volume_id = ?');
    params.push(query.volumeId);
  }
  if (query.from !== undefined) {
    clauses.push('started_at >= ?');
    params.push(Math.round(query.from));
  }
  if (query.to !== undefined) {
    clauses.push('started_at < ?');
    params.push(Math.round(query.to));
  }
  if (query.reason !== undefined) {
    clauses.push('reason = ?');
    params.push(query.reason);
  }
  if (query.hasMotion !== undefined) {
    clauses.push('has_motion = ?');
    params.push(toInt(query.hasMotion));
  }
  if (query.hasAlert !== undefined) {
    clauses.push('has_alert = ?');
    params.push(toInt(query.hasAlert));
  }
  return { where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(limit)));
}

function mapSegment(row: SegmentRow, eventIds: string[]): RecordingSegment {
  return {
    id: row.id,
    cameraId: row.camera_id,
    volumeId: row.volume_id,
    path: row.path,
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    bytes: Number(row.bytes),
    reason: row.reason as SegmentReason,
    hasMotion: fromInt(row.has_motion),
    hasAlert: fromInt(row.has_alert),
    eventIds,
    ...(row.protected === 1 ? { protected: true } : {}),
    ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    ...(row.archived_by === null ? {} : { archivedBy: row.archived_by }),
  };
}

function mapEvent(row: EventRow): RecordedEvent {
  return {
    id: row.id,
    cameraId: row.camera_id,
    kind: row.kind as RecordingEventKind,
    startedAt: Number(row.started_at),
    ...(row.ended_at === null ? {} : { endedAt: Number(row.ended_at) }),
    ...(row.peak_percent === null ? {} : { peakPercent: Number(row.peak_percent) }),
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.boxes === null ? {} : { boxes: safeParse(row.boxes) }),
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    ...(row.provider_id === null ? {} : { providerId: row.provider_id }),
    ...(row.snapshot === null ? {} : { snapshot: row.snapshot }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
