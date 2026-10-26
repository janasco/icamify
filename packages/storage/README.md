# @icamify/storage — recordings, quotas and retention

**Phase:** 5.

## Planned layout

```
src/
  paths.ts         # filenameTemplate expansion, volume resolution per camera
  index-db.ts      # SQLite (node:sqlite) schema + queries for segments/events
  reconcile.ts     # disk <-> index reconciliation on boot and after crashes
  quota.ts         # size/age accounting per volume and per camera
  retention.ts     # purge loop (age -> size -> disk floor), batching, dry run
  archive/
    local.ts       # move to a second mount
    s3.ts          # SigV4 PUT, multipart for big segments
    sftp.ts        # key or password auth
  lock.ts          # single-writer lock so two purge loops cannot race
```

## Retention order

1. **Disk floor** — if free space < `minFreeDiskGb`, delete oldest unprotected
   segments until the floor is restored (this always wins over age/size).
2. **Age** — delete segments older than `maxAgeHours`.
3. **Size** — while `usedBytes > maxSizeGb`, delete according to `strategy`
   (`oldest-first`, `largest-first`, `lowest-priority-first`), oldest event first.
4. **Archive** — before deletion, if the volume has an enabled archive provider,
   upload segments older than `afterHours`; delete locally after
   `keepLocalDays` once verified.

Every deletion is logged with path, size and reason, and emitted as a
`storage.purge` event so the UI can show a toast and the rules engine can fire
`storage.warning` / `storage.critical`.

## Safety

- Only paths that resolve inside a configured volume are ever deleted (path
  traversal guard, symlinks resolved and rejected).
- Files newer than 60 seconds are skipped by purgers to avoid deleting the
  segment currently being written.
- `purge.dryRun` logs intended deletions without touching disk.
- Retention never deletes `protected` segments or segments linked to an open
  alert when `protectFlagged` is true.
