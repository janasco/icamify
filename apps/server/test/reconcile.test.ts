import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { cameraRecordingPaths } from '@icamify/media';
import { RecordingIndex } from '@icamify/storage';
import { reconcileRecordings } from '../src/recording/reconcile.ts';
import { testConfig } from './helpers.ts';

/**
 * Reconciliation is the safety net between FFmpeg and SQLite. These tests cover the
 * three repairs it makes and — more importantly — the one non-repair: an unmounted
 * volume must never be mistaken for a library that was deleted.
 */

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; index: RecordingIndex } {
  const root = mkdtempSync(join(tmpdir(), 'icamify-reconcile-'));
  roots.push(root);
  return { root, index: RecordingIndex.open(':memory:') };
}

function config(root: string) {
  return testConfig({ storageRoot: root });
}

function writeSegment(configValue: ReturnType<typeof config>, day: string, name: string, bytes = 1024): string {
  const camera = configValue.cameras[0]!;
  const paths = cameraRecordingPaths(configValue, camera);
  const dir = join(paths.cameraDir, day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.${paths.extension}`);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

describe('reconcileRecordings', () => {
  it('indexes a finished file that has no row', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const path = writeSegment(value, '20260102', '120000-continuous', 2048);

    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.indexed, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.errors, 0);
    const segment = index.getSegmentByPath(path);
    assert.ok(segment, 'the file should be indexed');
    assert.equal(segment.cameraId, 'front-door');
    assert.equal(segment.startedAt, new Date(2026, 0, 2, 12, 0, 0).getTime());
    assert.equal(segment.bytes, 2048);
    assert.equal(segment.reason, 'continuous');
    assert.equal(segment.hasMotion, false);
  });

  it('marks motion and alert segments accordingly', async () => {
    const { root, index } = fixture();
    const value = config(root);
    writeSegment(value, '20260103', '010203-motion');
    writeSegment(value, '20260103', '010204-alert');

    await reconcileRecordings({ config: value, index });

    const segments = index.listSegments({ order: 'asc' });
    assert.equal(segments.length, 2);
    assert.equal(segments[0]?.hasMotion, true);
    assert.equal(segments[0]?.hasAlert, false);
    assert.equal(segments[1]?.hasAlert, true);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    const { root, index } = fixture();
    const value = config(root);
    writeSegment(value, '20260104', '080000-continuous');

    await reconcileRecordings({ config: value, index });
    const second = await reconcileRecordings({ config: value, index });

    assert.equal(second.indexed, 0);
    assert.equal(second.restored, 0);
    assert.equal(second.missing, 0);
    assert.equal(index.listSegments().length, 1);
  });

  it('tombstones a row whose file is gone', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const path = writeSegment(value, '20260105', '090000-continuous');
    await reconcileRecordings({ config: value, index });
    const indexed = index.getSegmentByPath(path);
    assert.ok(indexed);

    rmSync(join(path), { force: true });
    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.missing, 1);
    const row = index.getSegment(indexed.id);
    assert.ok(row?.deletedAt !== undefined, 'the row should be tombstoned');
    assert.equal(index.listSegments().length, 0, 'a tombstoned row is not listed by default');
  });

  it('restores a tombstone whose file is still playable', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const path = writeSegment(value, '20260106', '100000-continuous');
    await reconcileRecordings({ config: value, index });
    const row = index.getSegmentByPath(path);
    assert.ok(row);
    index.markDeleted(row.id);

    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.restored, 1);
    assert.equal(index.getSegment(row.id)?.deletedAt, undefined);
    assert.equal(index.listSegments().length, 1);
  });

  it('refreshes a row whose byte count disagrees with the file', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const path = writeSegment(value, '20260107', '110000-continuous', 100);
    await reconcileRecordings({ config: value, index });

    writeFileSync(path, Buffer.alloc(500, 2));
    utimesSync(path, new Date(), new Date());
    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.refreshed, 1);
    assert.equal(index.getSegmentByPath(path)?.bytes, 500);
  });

  it('does not tombstone anything when the volume is not mounted', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const camera = value.cameras[0]!;
    const paths = cameraRecordingPaths(value, camera);
    // A row that points into a directory that does not exist: the classic unmounted
    // NAS. Every row must survive, and the camera must be reported.
    const ghost = join(paths.cameraDir, '20260108', '120000-continuous.mkv');
    const row = index.insertSegment({
      cameraId: camera.id,
      volumeId: paths.volumeId,
      path: ghost,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 30_000,
      bytes: 10,
      reason: 'continuous',
    });

    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.errors, 1);
    assert.equal(result.missing, 0);
    assert.match(result.cameras[0]?.error ?? '', /not mounted/);
    assert.equal(index.getSegment(row.id)?.deletedAt, undefined);
  });

  it('ignores in-flight segments and foreign file names', async () => {
    const { root, index } = fixture();
    const value = config(root);
    const camera = value.cameras[0]!;
    const paths = cameraRecordingPaths(value, camera);
    mkdirSync(join(paths.hotDir, '20260109'), { recursive: true });
    writeFileSync(join(paths.hotDir, '20260109', '120000.mkv'), Buffer.alloc(4));
    mkdirSync(join(paths.cameraDir, '20260109'), { recursive: true });
    writeFileSync(join(paths.cameraDir, '20260109', 'notes.txt'), 'hello');
    writeFileSync(join(paths.cameraDir, '20260109', 'random-name.mkv'), Buffer.alloc(4));

    const result = await reconcileRecordings({ config: value, index });

    assert.equal(result.indexed, 0);
    assert.equal(result.cameras[0]?.files, 0);
    assert.equal(result.skipped, 1, 'random-name.mkv is not a segment of ours');
    assert.equal(index.listSegments().length, 0);
  });
});
