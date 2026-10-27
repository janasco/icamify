import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Recording index storage.
 *
 * The filesystem is the source of truth for recordings; SQLite is only the index
 * that makes the timeline queryable. Node 24 ships `node:sqlite`, so the whole
 * index is dependency-free, and a corrupt database can always be rebuilt by
 * rescanning the recording directories.
 */

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  camera_id   TEXT NOT NULL,
  volume_id   TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL UNIQUE,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL,
  has_motion  INTEGER NOT NULL DEFAULT 0,
  has_alert   INTEGER NOT NULL DEFAULT 0,
  protected   INTEGER NOT NULL DEFAULT 0,
  event_id    TEXT,
  deleted_at  INTEGER,
  archived_at INTEGER,
  archived_by TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_camera_time ON segments(camera_id, started_at);
CREATE INDEX IF NOT EXISTS idx_segments_started ON segments(started_at);
CREATE INDEX IF NOT EXISTS idx_segments_live ON segments(deleted_at, started_at);
CREATE INDEX IF NOT EXISTS idx_segments_volume ON segments(volume_id, ended_at);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  camera_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  peak_percent REAL,
  label        TEXT,
  boxes        TEXT,
  confidence   REAL,
  provider_id  TEXT,
  snapshot     TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_camera_time ON events(camera_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events(kind, started_at);

CREATE TABLE IF NOT EXISTS segment_events (
  segment_id TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  PRIMARY KEY (segment_id, event_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
  /** Runs the schema on open (default true). */
  migrate?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new DatabaseSync(options.path);
  if (options.path !== ':memory:') {
    // WAL keeps the recorder's inserts from blocking timeline reads.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (options.migrate !== false) {
    db.exec(SCHEMA);
    migrate(db);
  }
  return db;
}

/**
 * Additive migration.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing v1 database untouched, so new
 * columns are added explicitly. ADD COLUMN is safe to attempt and cheap to check
 * first, which keeps the index usable across upgrades without a rebuild.
 */
function migrate(db: DatabaseSync): void {
  ensureColumns(db, 'events', {
    confidence: 'REAL',
    provider_id: 'TEXT',
    snapshot: 'TEXT',
  });
  // v3: retention records which segments already reached an archive target, so a
  // repeated sweep does not upload the same object again.
  ensureColumns(db, 'segments', {
    archived_at: 'INTEGER',
    archived_by: 'TEXT',
  });
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
}

function ensureColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  for (const [name, type] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined;
  return row?.value === undefined ? 0 : Number(row.value);
}

/** SQLite has no boolean type; storing 0/1 keeps queries indexable. */
export function toInt(value: boolean | undefined): number {
  return value === true ? 1 : 0;
}

export function fromInt(value: unknown): boolean {
  return typeof value === 'number' ? value !== 0 : value === 1 || value === true;
}
