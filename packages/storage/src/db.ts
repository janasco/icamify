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

export const SCHEMA_VERSION = 1;

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
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_camera_time ON segments(camera_id, started_at);
CREATE INDEX IF NOT EXISTS idx_segments_started ON segments(started_at);
CREATE INDEX IF NOT EXISTS idx_segments_live ON segments(deleted_at, started_at);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  camera_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  peak_percent REAL,
  label        TEXT,
  boxes        TEXT,
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
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
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
