import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecordingIndex } from '../src/recordings.ts';
import { schemaVersion } from '../src/db.ts';

function index(): RecordingIndex {
  return new RecordingIndex({ path: ':memory:' });
}

const CAM = 'front-door';
const OTHER = 'garage';

function segment(overrides: Partial<Parameters<RecordingIndex['insertSegment']>[0]> = {}) {
  return {
    cameraId: CAM,
    volumeId: 'default',
    path: `/data/${CAM}/20260101-120000.mkv`,
    startedAt: 1_000,
    endedAt: 4_600_000,
    bytes: 1024,
    reason: 'motion' as const,
    hasMotion: true,
    ...overrides,
  };
}

describe('RecordingIndex', () => {
  it('creates its schema on open', () => {
    const db = index();
    assert.equal(schemaVersion(db['db'] as never), 1);
    db.close();
  });

  it('inserts and reads a segment', () => {
    const db = index();
    const inserted = db.insertSegment(segment());
    assert.equal(inserted.cameraId, CAM);
    assert.equal(inserted.bytes, 1024);
    assert.equal(inserted.hasMotion, true);
    assert.deepEqual(inserted.eventIds, []);
    assert.equal(db.getSegment(inserted.id)?.path, `/data/${CAM}/20260101-120000.mkv`);
    assert.equal(db.getSegmentByPath(`/data/${CAM}/20260101-120000.mkv`)?.id, inserted.id);
    db.close();
  });

  it('re-indexes an existing path instead of duplicating it', () => {
    const db = index();
    const first = db.insertSegment(segment());
    const again = db.insertSegment(segment({ endedAt: 5_000_000, bytes: 2048 }));
    assert.equal(again.id, first.id);
    assert.equal(again.bytes, 2048);
    assert.equal(db.countSegments(), 1);
    db.close();
  });

  it('filters by camera, time window and flags', () => {
    const db = index();
    db.insertSegment(segment({ path: '/a.mkv', startedAt: 1_000 }));
    db.insertSegment(segment({ path: '/b.mkv', startedAt: 2_000, reason: 'continuous', hasMotion: false }));
    db.insertSegment(segment({ path: '/c.mkv', startedAt: 3_000, cameraId: OTHER }));

    assert.equal(db.listSegments({ cameraId: CAM }).length, 2);
    assert.equal(db.listSegments({ cameraId: OTHER }).length, 1);
    assert.equal(db.listSegments({ from: 2_000, to: 3_000 }).length, 1);
    assert.equal(db.listSegments({ hasMotion: false }).length, 1);
    assert.equal(db.listSegments({ reason: 'continuous' }).length, 1);
    assert.equal(db.countSegments({ cameraId: CAM }), 2);
    db.close();
  });

  it('orders results for timeline playback or latest-clips lists', () => {
    const db = index();
    db.insertSegment(segment({ path: '/a.mkv', startedAt: 1_000 }));
    db.insertSegment(segment({ path: '/b.mkv', startedAt: 2_000 }));
    db.insertSegment(segment({ path: '/c.mkv', startedAt: 3_000 }));
    assert.deepEqual(
      db.listSegments({ cameraId: CAM, order: 'asc' }).map((row) => row.startedAt),
      [1_000, 2_000, 3_000],
    );
    assert.deepEqual(
      db.listSegments({ cameraId: CAM }).map((row) => row.startedAt),
      [3_000, 2_000, 1_000],
    );
    db.close();
  });

  it('paginates with a bounded limit', () => {
    const db = index();
    for (let index = 0; index < 5; index += 1) {
      db.insertSegment(segment({ path: `/seg-${index}.mkv`, startedAt: 1_000 + index }));
    }
    const page = db.listSegments({ limit: 2, offset: 1, order: 'asc' });
    assert.deepEqual(
      page.map((row) => row.startedAt),
      [1_001, 1_002],
    );
    assert.equal(db.listSegments({ limit: 10_000 }).length, 5, 'limits are clamped, not rejected');
    db.close();
  });

  it('updates flags and sizes after finalization', () => {
    const db = index();
    const inserted = db.insertSegment(segment({ path: '/partial.mkv', endedAt: 1_000, bytes: 0 }));
    const finalized = db.finalizeSegment(inserted.id, { endedAt: 9_000, bytes: 4096 });
    assert.equal(finalized?.bytes, 4096);
    const flagged = db.updateSegment(inserted.id, { hasAlert: true, reason: 'alert' });
    assert.equal(flagged?.hasAlert, true);
    assert.equal(flagged?.reason, 'alert');
    db.close();
  });

  it('links segments to events and returns them on read', () => {
    const db = index();
    const event = db.insertEvent({ cameraId: CAM, kind: 'motion', startedAt: 1_000, peakPercent: 4.2 });
    db.insertSegment(segment({ path: '/linked.mkv', eventId: event.id }));
    const stored = db.listSegments({ cameraId: CAM })[0]!;
    assert.deepEqual(stored.eventIds, [event.id]);
    assert.equal(db.getEvent(event.id)?.peakPercent, 4.2);
    db.close();
  });

  it('closes events and reports counts', () => {
    const db = index();
    const event = db.insertEvent({ cameraId: CAM, kind: 'motion', startedAt: 1_000 });
    assert.equal(event.endedAt, undefined);
    const closed = db.updateEvent(event.id, { endedAt: 5_000, boxes: [{ x: 1, y: 2, width: 3, height: 4 }] });
    assert.equal(closed?.endedAt, 5_000);
    assert.deepEqual(closed?.boxes, [{ x: 1, y: 2, width: 3, height: 4 }]);
    assert.equal(db.eventCount(), 1);
    assert.equal(db.eventCount(OTHER), 0);
    db.close();
  });

  it('filters events by kind and window', () => {
    const db = index();
    db.insertEvent({ cameraId: CAM, kind: 'motion', startedAt: 1_000 });
    db.insertEvent({ cameraId: CAM, kind: 'ai.object', startedAt: 2_000, label: 'person' });
    assert.equal(db.listEvents({ kind: 'ai.object' }).length, 1);
    assert.equal(db.listEvents({ from: 1_500 }).length, 1);
    assert.equal(db.listEvents({ cameraId: CAM, order: 'asc' }).length, 2);
    db.close();
  });

  it('aggregates storage usage', () => {
    const db = index();
    db.insertSegment(segment({ path: '/a.mkv', bytes: 100, startedAt: 1_000, endedAt: 2_000 }));
    db.insertSegment(segment({ path: '/b.mkv', bytes: 200, startedAt: 3_000, endedAt: 4_000 }));
    const stats = db.stats({ cameraId: CAM });
    assert.equal(stats.segments, 2);
    assert.equal(stats.bytes, 300);
    assert.equal(stats.oldestAt, 1_000);
    assert.equal(stats.newestAt, 4_000);
    db.close();
  });

  it('tombstones deleted segments without losing the row', () => {
    const db = index();
    const inserted = db.insertSegment(segment());
    db.markDeleted(inserted.id, 9_999);
    assert.equal(db.listSegments().length, 0);
    assert.equal(db.listSegments({ includeDeleted: true }).length, 1);
    assert.equal(db.stats().segments, 0);
    db.close();
  });

  it('prunes by age but never deletes protected clips', () => {
    const db = index();
    const old = db.insertSegment(segment({ path: '/old.mkv', startedAt: 1_000, endedAt: 2_000 }));
    const kept = db.insertSegment(segment({ path: '/kept.mkv', startedAt: 3_000, endedAt: 4_000 }));
    const starred = db.insertSegment(segment({ path: '/starred.mkv', startedAt: 5_000, endedAt: 6_000 }));
    db.protect(starred.id, true);

    const removed = db.markDeletedBefore(8_000);
    assert.equal(removed, 2);
    const remaining = db.listSegments({ order: 'asc' });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, starred.id);
    assert.equal(db.getSegment(old.id) !== undefined, true, 'rows are tombstoned, not dropped');
    assert.equal(db.getSegment(kept.id) !== undefined, true);
    db.close();
  });

  it('prunes events and their links', () => {
    const db = index();
    const event = db.insertEvent({ cameraId: CAM, kind: 'motion', startedAt: 1_000, endedAt: 2_000 });
    db.insertSegment(segment({ path: '/linked.mkv', eventId: event.id }));
    assert.equal(db.pruneEvents(3_000), 1);
    assert.equal(db.eventCount(), 0);
    assert.deepEqual(db.listSegments()[0]!.eventIds, []);
    db.close();
  });

  it('persists across reopen', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/icamify-index-${Date.now()}.db`;
    const first = new RecordingIndex({ path });
    first.insertSegment(segment({ path: '/persisted.mkv' }));
    first.close();

    const second = new RecordingIndex({ path });
    assert.equal(second.countSegments(), 1);
    second.close();
  });
});
