# @icamify/storage — recording index, retention and archive

**Phase:** 3 (index) · 4 (detection fields) · 5 (retention engine + archive targets).

The filesystem is the source of truth; SQLite only answers "which clips exist, what
happened in them, and where are they". A lost or truncated database costs a rescan,
never footage.

## Implemented

```
src/
  db.ts            # node:sqlite connection, pragmas (WAL), schema + additive migrations
  recordings.ts    # RecordingIndex: segments, events, links, stats, tombstones, archive state
  retention.ts     # RetentionEngine: archive → age → size → disk floor, dry run, batching
  archive/local.ts # copy into a directory (NAS mount, external disk)
  archive/s3.ts    # SigV4 PutObject, streamed with UNSIGNED-PAYLOAD
  archive/sftp.ts  # OpenSSH `sftp -b` batch, key authentication only
  archive/types.ts # ArchiveTarget contract + object-key rules
  errors.ts        # StorageError with a stable code
  index.ts         # public contracts
```

Node 24's built-in `node:sqlite` and `node:crypto` mean the package still adds no
dependency.

### Schema (version 3)

```sql
segments(id, camera_id, volume_id, path UNIQUE, started_at, ended_at, bytes,
         reason, has_motion, has_alert, protected, event_id, deleted_at,
         archived_at, archived_by, created_at)
events(id, camera_id, kind, started_at, ended_at, peak_percent, label, boxes,
       confidence, provider_id, snapshot, created_at)
segment_events(segment_id, event_id)          -- one clip can belong to several events
meta(key, value)                              -- schema_version
```

Indexes cover `(camera_id, started_at)`, `started_at`, `(deleted_at, started_at)`
and `(volume_id, ended_at)` — the shapes the timeline and the sweep use.

### Index API

```ts
const index = new RecordingIndex({ path: '<stateDir>/recordings.db' });

index.insertSegment({ cameraId, volumeId, path, startedAt, endedAt, bytes, reason, eventId });
index.listSegments({ cameraId, from, to, reason, hasMotion, limit, offset, order });
index.stats({ cameraId, volumeId });    // count, bytes, oldest, newest
index.markDeleted(id);                  // tombstone (retention or an operator)
index.markArchived(id, providerId);     // a copy exists remotely
index.protect(id, true);                // starred: never a purge candidate
index.insertEvent({ cameraId, kind, startedAt, label, confidence, providerId, boxes, snapshot });
index.listEvents({ cameraId, kind, label, providerId, from, to });
index.pruneEvents(cutoff);
index.snapshotRefs();                   // snapshot paths still referenced
```

Behaviour worth knowing:

- **Re-indexing is idempotent.** `insertSegment` upserts on `path`, so a restart or
  a rescan cannot duplicate a clip.
- **Deletion is a tombstone.** `deleted_at` hides a row from every query without
  losing the audit trail; `includeDeleted` exposes it.
- **Timestamps are epoch milliseconds** and are the only ordering. File names are
  local-time strings for humans; the index never parses them for truth.
- **Detections are events, not a second table.** `label`, `confidence`,
  `provider_id`, normalized `boxes` and the `snapshot` path live on the row.

### Retention

```ts
const engine = new RetentionEngine({
  index,
  volumes: [
    {
      id: 'hot', path: '/mnt/nvr', priority: 100,
      maxSizeBytes: 500 * 1024 ** 3, maxAgeMs: 48 * 3_600_000, minFreeBytes: 50 * 1024 ** 3,
      archive: { target, afterMs: 24 * 3_600_000, keepLocalMs: 7 * 86_400_000 },
    },
  ],
  policy: { enabled: true, intervalSeconds: 300, strategy: 'oldest-first', batchSize: 50, dryRun: false, protectFlagged: true },
});

await engine.stats();          // bytes, free disk, limits, archive state
await engine.sweep('hot');     // one pass; concurrent calls are serialized
```

Sweep order, each step able to make the next unnecessary:

1. **Archive** — copy segments past `afterHours`; delete the local file only when
   `keepLocalDays` is 0, otherwise leave it for the age pass.
2. **Age** — delete everything older than `maxAgeMs`.
3. **Size** — delete according to `strategy` until `maxSizeBytes` is met.
4. **Disk floor** — delete until the filesystem has `minFreeBytes`, accounting for
   everything already freed in this pass.

Rules that are absolute:

- A starred clip is never a candidate while `protectFlagged` is on.
- A file is **never** deleted when it was supposed to be archived and the upload
  failed; the error is reported and the footage stays.
- An unlink happens before the tombstone. A row pointing at a missing file is
  recoverable; a file with no row is invisible footage.
- A missing file (`ENOENT`) still tombstones the row, so a manual cleanup cannot
  wedge the sweep.
- `dryRun` computes the same result and touches neither the file nor the row.

### Archive targets

`ArchiveTarget` is `{ providerId, label, upload(path, key), close() }`; the key is
`cameraId/YYYY-MM-DD/fileName`, so re-uploading after a crash overwrites instead of
duplicating.

- **local** — `copyFile` into the configured directory, then verify the size.
  Traversal in a key is neutralized (`..` becomes `_`).
- **s3** — SigV4 `PutObject` signed with `node:crypto`, payload streamed with
  `UNSIGNED-PAYLOAD` (no double read of a multi-GB file). Works against AWS and
  MinIO/Ceph (custom endpoints default to path style). The signer matches the
  documented AWS example byte for byte, which is a test.
- **sftp** — `sftp -b` batch over the OpenSSH client. Consequence, stated in the
  error message: key authentication only. A password cannot be fed to batch mode
  without `sshpass`, and pretending otherwise would leave a silent archive.

```

## Not implemented

- **Index ↔ disk reconciliation on boot** (`reconcile.ts`): rows are trusted and
  `ENOENT` is tolerated, but a full rescan after an out-of-band delete is not
  written.
- **Cloud archive providers other than S3-compatible ones** (Azure Blob, GCS).
- **Per-camera quotas**: quotas are per volume; camera-level fairness is not
  modelled.
