# @icamify/storage — recording index, quotas and retention

**Phase:** 3 (index implemented) · 4 (detection fields) · 5 (retention/archive).

The filesystem is the source of truth; SQLite only answers "which clips exist, what
happened in them, and where are they". A lost or truncated database costs a rescan,
never footage.

## Implemented

```
src/
  db.ts          # node:sqlite connection, pragmas (WAL), schema + versioning
  recordings.ts  # RecordingIndex: segments, events, links, stats, tombstones
  index.ts       # public contracts
```

Node 24's built-in `node:sqlite` means the index adds no dependency.

### Schema

```sql
segments(id, camera_id, volume_id, path UNIQUE, started_at, ended_at, bytes,
         reason, has_motion, has_alert, protected, event_id, deleted_at, created_at)
events(id, camera_id, kind, started_at, ended_at, peak_percent, label, boxes,
       confidence, provider_id, snapshot, created_at)
segment_events(segment_id, event_id)          -- one clip can belong to several events
meta(key, value)                              -- schema_version
```

Indexes cover `(camera_id, started_at)`, `started_at` and
`(deleted_at, started_at)` — the three shapes the timeline and the purge loop use.

### API

```ts
const index = new RecordingIndex({ path: '<stateDir>/recordings.db' });

index.insertSegment({ cameraId, volumeId, path, startedAt, endedAt, bytes, reason, eventId });
index.listSegments({ cameraId, from, to, reason, hasMotion, limit, offset, order: 'asc' });
index.stats({ cameraId });              // count, bytes, oldest, newest
index.markDeletedBefore(cutoff);        // tombstones + returns the row count
index.insertEvent({ cameraId, kind: 'motion', startedAt, peakPercent, boxes });
index.updateEvent(id, { endedAt });     // closes the episode
index.pruneEvents(cutoff);
```

Behaviour worth knowing:

- **Re-indexing is idempotent.** `insertSegment` upserts on `path`, so a restart or
  a rescan cannot duplicate a clip.
- **Deletion is a tombstone.** `deleted_at` hides a row from every query without
  losing the audit trail; `includeDeleted` exposes it.
- **Protected clips are never purged.** `markDeletedBefore()` skips
  `protected = 1`, which is what a starred clip becomes.
- **Timestamps are epoch milliseconds** and are the only ordering. File names are
  local-time strings for humans; the index never parses them for truth.
- **Detections are events, not a second table.** An AI detection is an `ai.object`
  / `ai.face` / `ai.lpr` / `ai.scene` row with `label`, `confidence`, `provider_id`,
  the normalized `boxes` and, when saved, the `snapshot` path. `listEvents()` can
  filter by `label` (case-insensitive substring), `providerId`, `kind` and window.
- **Schema upgrades are additive.** `CREATE TABLE IF NOT EXISTS` plus a checked
  `ALTER TABLE ... ADD COLUMN` migration (schema version 2) upgrades a v1 database
  in place; the recording files are never touched.

## Planned (Phase 5)

```
reconcile.ts   # disk <-> index reconciliation on boot and after crashes
quota.ts       # size/age accounting per volume and per camera
retention.ts   # purge loop (age -> size -> disk floor), batching, dry run
archive/       # local, S3 (SigV4) and SFTP targets
lock.ts        # single-writer lock so two purge loops cannot race
```

Retention order (detection rows and snapshots join the same purge in Phase 5):

1. **Disk floor** — free space below `minFreeDiskGb` deletes oldest unprotected
   clips first (this wins over age/size).
2. **Age** — `maxAgeHours`.
3. **Size** — while over `maxSizeGb`, delete per `strategy` (`oldest-first`,
   `largest-first`, `lowest-priority-first`).
4. **Archive** — upload before deletion when a provider is configured, delete
   locally only after verification.

Safety rules for the purge loop: only paths inside a configured volume are ever
deleted (resolved, traversal- and symlink-checked), files younger than 60 s are
skipped, `purge.dryRun` only logs, and open alerts are protected when
`protectFlagged` is true.

**Until Phase 5 ships, nothing purges.** Clip files accumulate under the recordings
tree and the disk will fill.
