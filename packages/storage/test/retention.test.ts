import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { RecordingIndex } from '../src/recordings.ts';
import { RetentionEngine, type DiskUsage, type RetentionVolume } from '../src/retention.ts';
import type { ArchiveTarget } from '../src/archive/types.ts';
import { LocalArchiveTarget } from '../src/archive/local.ts';
import type { RetentionPolicy, SegmentReason } from '../src/index.ts';

/**
 * Retention is tested against a real filesystem, not a mock: the whole point of
 * the module is that the row and the file disappear together.
 */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const POLICY: RetentionPolicy = {
  enabled: true,
  intervalSeconds: 300,
  strategy: 'oldest-first',
  batchSize: 10,
  dryRun: false,
  protectFlagged: true,
};

interface FixtureOptions {
  policy?: Partial<RetentionPolicy>;
  limits?: Omit<RetentionVolume, 'id' | 'path' | 'priority'>;
  diskUsage?: (path: string) => Promise<DiskUsage>;
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'icamify-retention-'));
  roots.push(root);
  const recordings = join(root, 'recordings');
  mkdirSync(recordings, { recursive: true });
  const index = new RecordingIndex({ path: ':memory:' });
  const volume: RetentionVolume = { id: 'default', path: recordings, priority: 100, ...options.limits };
  const policy: RetentionPolicy = { ...POLICY, ...options.policy };
  const engine = new RetentionEngine({
    index,
    volumes: [volume],
    policy,
    now: () => NOW,
    ...(options.diskUsage === undefined ? {} : { diskUsage: options.diskUsage }),
  });

  const add = (
    name: string,
    startedAt: number,
    bytes = 100,
    extra: { reason?: SegmentReason; endedAt?: number; volumeId?: string } = {},
  ) => {
    const path = join(recordings, name);
    writeFileSync(path, Buffer.alloc(bytes, 7));
    return index.insertSegment({
      cameraId: 'front-door',
      volumeId: extra.volumeId ?? 'default',
      path,
      startedAt,
      endedAt: extra.endedAt ?? startedAt + 60_000,
      bytes,
      reason: extra.reason ?? 'continuous',
    });
  };

  return { root, recordings, index, volume, engine, add };
}

describe('RetentionEngine age policy', () => {
  it('deletes segments older than maxAgeHours and tombstones them', async () => {
    const { add, engine, index } = fixture({ limits: { maxAgeMs: DAY } });
    const old = add('old.mkv', NOW - 3 * DAY);
    const fresh = add('fresh.mkv', NOW - HOUR);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 1);
    assert.equal(result?.deleted[0]?.segmentId, old.id);
    assert.equal(result?.deleted[0]?.reason, 'age');
    assert.equal(result?.freedBytes, 100);
    assert.equal(existsSync(old.path), false, 'the file is unlinked');
    assert.equal(existsSync(fresh.path), true);
    assert.equal(index.getSegment(old.id) !== undefined, true, 'the row is tombstoned, not dropped');
    assert.deepEqual(index.listSegments().map((segment) => segment.id), [fresh.id]);
    engine.close();
  });

  it('never deletes a protected clip while protectFlagged is on', async () => {
    const { add, engine, index } = fixture({ limits: { maxAgeMs: DAY } });
    const starred = add('starred.mkv', NOW - 5 * DAY);
    index.protect(starred.id, true);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 0);
    assert.equal(result?.scannedSegments, 0, 'protected clips are not even candidates');
    assert.equal(existsSync(starred.path), true);
    engine.close();
  });

  it('deletes protected clips when the policy allows it', async () => {
    const { add, engine, index } = fixture({ limits: { maxAgeMs: DAY }, policy: { protectFlagged: false } });
    const starred = add('starred.mkv', NOW - 5 * DAY);
    index.protect(starred.id, true);
    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 1);
    assert.equal(existsSync(starred.path), false);
    engine.close();
  });

  it('does nothing when the quota is disabled for the volume', async () => {
    const { add, engine } = fixture();
    const old = add('old.mkv', NOW - 30 * DAY);
    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 0);
    assert.equal(existsSync(old.path), true);
    engine.close();
  });
});

describe('RetentionEngine size and disk policies', () => {
  it('deletes oldest-first until the volume is under its ceiling', async () => {
    const { add, engine } = fixture({ limits: { maxSizeBytes: 250 } });
    const first = add('a.mkv', NOW - 3 * HOUR);
    add('b.mkv', NOW - 2 * HOUR);
    add('c.mkv', NOW - HOUR);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 1);
    assert.equal(result?.deleted[0]?.segmentId, first.id);
    assert.equal(result?.deleted[0]?.reason, 'size');
    assert.equal(result?.freedBytes, 100);
    engine.close();
  });

  it('honours largest-first ordering', async () => {
    const tight = fixture({ limits: { maxSizeBytes: 200 }, policy: { strategy: 'largest-first' } });
    const oldest = tight.add('oldest-small.mkv', NOW - 3 * HOUR, 50);
    const largest = tight.add('largest.mkv', NOW - 2 * HOUR, 150);
    tight.add('newest-small.mkv', NOW - HOUR, 50);

    const [result] = await tight.engine.sweep();
    assert.equal(result?.deleted.length, 1);
    assert.equal(result?.deleted[0]?.segmentId, largest.id, 'the biggest file goes first');
    assert.equal(existsSync(oldest.path), true);
    tight.engine.close();
  });

  it('sweeps in batches and stops exactly at the ceiling', async () => {
    const { add, engine } = fixture({ limits: { maxSizeBytes: 120 }, policy: { batchSize: 1 } });
    for (let index = 0; index < 4; index += 1) add(`seg-${index}.mkv`, NOW - (4 - index) * HOUR, 100);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 3, '300 bytes must go to reach 100 ≤ 120');
    assert.equal(result?.freedBytes, 300);
    engine.close();
  });

  it('frees disk down to the configured floor', async () => {
    const diskUsage = async (): Promise<DiskUsage> => ({ freeBytes: 0, totalBytes: 10_000 });
    const { add, engine } = fixture({ limits: { minFreeBytes: 250 }, diskUsage });
    add('a.mkv', NOW - 3 * HOUR);
    add('b.mkv', NOW - 2 * HOUR);
    add('c.mkv', NOW - HOUR);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 3);
    assert.equal(result?.deleted.every((entry) => entry.reason === 'disk-floor'), true);
    engine.close();
  });

  it('accounts for space freed earlier in the same sweep', async () => {
    const diskUsage = async (): Promise<DiskUsage> => ({ freeBytes: 50, totalBytes: 10_000 });
    const { add, engine } = fixture({ limits: { minFreeBytes: 150 }, diskUsage });
    add('a.mkv', NOW - 2 * HOUR);
    add('b.mkv', NOW - HOUR);
    add('c.mkv', NOW);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 1, '50 free + 100 freed reaches the 150 floor');
    engine.close();
  });

  it('reports a filesystem error instead of deleting when disk usage is unreadable', async () => {
    const diskUsage = async (): Promise<DiskUsage> => ({ freeBytes: 0, totalBytes: 0, error: 'statfs failed' });
    const { add, engine } = fixture({ diskUsage });
    add('a.mkv', NOW);
    const stats = await engine.stats();
    assert.equal(stats[0]?.error, 'statfs failed');
    engine.close();
  });
});

describe('RetentionEngine dry run', () => {
  it('reports what it would delete without touching files or rows', async () => {
    const { add, engine, index } = fixture({ limits: { maxAgeMs: DAY }, policy: { dryRun: true } });
    const old = add('old.mkv', NOW - 3 * DAY);

    const [result] = await engine.sweep();
    assert.equal(result?.dryRun, true);
    assert.equal(result?.deleted.length, 1);
    assert.equal(result?.freedBytes, 100);
    assert.equal(existsSync(old.path), true, 'dry run keeps the file');
    assert.equal(index.listSegments().length, 1, 'dry run keeps the row');
    engine.close();
  });
});

describe('RetentionEngine archive policy', () => {
  function archiveFixture(keepLocalDays: number, target?: ArchiveTarget) {
    const base = fixture();
    const archiveRoot = join(base.root, 'archive');
    const local = new LocalArchiveTarget({ id: 'nas', type: 'local', path: archiveRoot });
    base.volume.archive = {
      target: target ?? local,
      afterMs: HOUR,
      keepLocalMs: keepLocalDays * DAY,
    };
    return { ...base, archiveRoot, local };
  }

  it('copies an old segment to the archive and deletes the local file', async () => {
    const { add, engine, index, archiveRoot } = archiveFixture(0);
    const old = add('old.mkv', NOW - 2 * HOUR);

    const [result] = await engine.sweep();
    assert.equal(result?.archived.length, 1);
    assert.equal(result?.archived[0]?.providerId, 'nas');
    const copy = join(archiveRoot, 'front-door', new Date(old.startedAt).toISOString().slice(0, 10), 'old.mkv');
    assert.equal(existsSync(copy), true, 'the archived copy exists');
    assert.equal(existsSync(old.path), false, 'the local copy is gone');
    assert.equal(result?.deleted[0]?.reason, 'age');
    assert.equal(index.getSegment(old.id)?.archivedBy, 'nas');
    engine.close();
  });

  it('keeps the local copy for the configured window', async () => {
    const { add, engine, archiveRoot } = archiveFixture(7);
    const old = add('old.mkv', NOW - 2 * HOUR);
    const [result] = await engine.sweep();
    assert.equal(result?.archived.length, 1);
    assert.equal(result?.deleted.length, 0);
    assert.equal(existsSync(old.path), true);
    const copy = join(archiveRoot, 'front-door', new Date(old.startedAt).toISOString().slice(0, 10), 'old.mkv');
    assert.equal(existsSync(copy), true);
    engine.close();
  });

  it('does not upload the same object twice', async () => {
    const { add, engine, archiveRoot } = archiveFixture(7);
    add('old.mkv', NOW - 2 * HOUR);
    await engine.sweep();
    const [second] = await engine.sweep();
    assert.equal(second?.archived.length, 0, 'already archived');
    assert.equal(existsSync(join(archiveRoot, 'front-door', new Date(NOW - 2 * HOUR).toISOString().slice(0, 10), 'old.mkv')), true);
    engine.close();
  });

  it('keeps the file when the archive upload fails', async () => {
    const failing: ArchiveTarget = {
      providerId: 'broken',
      label: 'broken-target',
      upload: async () => {
        throw new Error('network down');
      },
      close: async () => undefined,
    };
    const { add, engine } = archiveFixture(0, failing);
    const old = add('old.mkv', NOW - 2 * HOUR);

    const [result] = await engine.sweep();
    assert.equal(result?.deleted.length, 0);
    assert.equal(existsSync(old.path), true, 'a failed archive must never lose footage');
    assert.equal(result?.errors.length, 1);
    assert.match(result?.errors[0]?.message ?? '', /network down/);
    engine.close();
  });

  it('reports a target that could not be built and keeps recording', async () => {
    const { add, engine, volume } = fixture();
    volume.archiveError = 'no credentials';
    const old = add('old.mkv', NOW - 2 * HOUR);
    // maxAgeHours is undefined: nothing should be deleted, but the error surfaces.
    const [result] = await engine.sweep();
    assert.equal(result?.errors[0]?.message, 'archive unavailable: no credentials');
    assert.equal(existsSync(old.path), true);
    engine.close();
  });
});

describe('RetentionEngine concurrency and stats', () => {
  it('serializes overlapping sweeps', async () => {
    const { add, engine } = fixture({ limits: { maxAgeMs: DAY } });
    add('old.mkv', NOW - 3 * DAY);

    const [first, second] = await Promise.all([engine.sweep(), engine.sweep()]);
    const deletions = [...(first ?? []), ...(second ?? [])].reduce((total, result) => total + result.deleted.length, 0);
    assert.equal(deletions, 1, 'the second sweep sees the first one’s work');
    engine.close();
  });

  it('maps configured limits into readable units', async () => {
    const diskUsage = async (): Promise<DiskUsage> => ({ freeBytes: 500, totalBytes: 1_000 });
    const { add, engine } = fixture({
      limits: { maxSizeBytes: 2 * 1024 ** 3, maxAgeMs: 48 * HOUR, minFreeBytes: 1024 ** 3 },
      diskUsage,
    });
    add('a.mkv', NOW - HOUR, 128);
    const [stats] = await engine.stats();
    assert.equal(stats?.limits.maxSizeBytes, 2 * 1024 ** 3);
    assert.equal(stats?.limits.maxAgeHours, 48);
    assert.equal(stats?.limits.minFreeBytes, 1024 ** 3);
    assert.equal(stats?.freeBytes, 500);
    assert.equal(stats?.diskUsedBytes, 500);
    assert.equal(stats?.usedBytes, 128);
    assert.equal(stats?.segmentCount, 1);
    assert.equal(stats?.oldestAt, NOW - HOUR);
    engine.close();
  });

  it('sweeps only the requested volume', async () => {
    const base = fixture();
    const secondDir = join(base.root, 'second');
    mkdirSync(secondDir, { recursive: true });
    const second: RetentionVolume = { id: 'second', path: secondDir, priority: 50, maxAgeMs: DAY };
    const engine = new RetentionEngine({
      index: base.index,
      volumes: [base.volume, second],
      policy: POLICY,
      now: () => NOW,
      diskUsage: async () => ({ freeBytes: 100, totalBytes: 1000 }),
    });

    const first = base.add('one.mkv', NOW - 3 * DAY);
    const otherPath = join(secondDir, 'two.mkv');
    writeFileSync(otherPath, Buffer.alloc(10, 1));
    base.index.insertSegment({
      cameraId: 'garage',
      volumeId: 'second',
      path: otherPath,
      startedAt: NOW - 3 * DAY,
      endedAt: NOW - 3 * DAY + 1000,
      bytes: 10,
      reason: 'continuous',
    });

    const results = await engine.sweep('second');
    assert.equal(results.length, 1);
    assert.equal(results[0]?.volumeId, 'second');
    assert.equal(existsSync(first.path), true, 'the unrequested volume keeps its files');
    assert.equal(existsSync(otherPath), false);
    engine.close();
  });
});
