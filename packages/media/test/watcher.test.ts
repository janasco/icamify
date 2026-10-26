import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SegmentWindow } from '../src/record/prebuffer.ts';
import { hotSegmentName } from '../src/record/paths.ts';
import { SegmentWatcher, type ClosedSegment } from '../src/record/watcher.ts';

/**
 * Files are written with an explicit mtime so the watcher's staleness rule can be
 * driven by an injected clock instead of by sleeping.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'icamify-watcher-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function segmentFile(at: Date, bytes = 32, offsetSeconds = 0, mtimeAt = at.getTime() + offsetSeconds * 1000 + 3500): Promise<string> {
  const time = new Date(at.getTime() + offsetSeconds * 1000);
  const path = join(dir, `${hotSegmentName(time)}.mkv`);
  await writeFile(path, Buffer.alloc(bytes, 1));
  const stamp = new Date(mtimeAt);
  await utimes(path, stamp, stamp);
  return path;
}

function collect(watcher: SegmentWatcher): ClosedSegment[] {
  const seen: ClosedSegment[] = [];
  watcher.onClosed((segment) => seen.push(segment));
  return seen;
}

describe('SegmentWatcher', () => {
  it('closes a segment once a newer one appears', async () => {
    const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const watcher = new SegmentWatcher({ dir, extension: 'mkv', segmentSeconds: 4, now: () => at.getTime() + 500 });
    const seen = collect(watcher);

    const first = await segmentFile(at, 100, 0, at.getTime() + 4000);
    assert.deepEqual(await watcher.sweep(), [], 'the newest segment stays open');

    await segmentFile(at, 200, 4, at.getTime() + 8000);
    const closed = await watcher.sweep();
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.path, first);
    assert.equal(closed[0]!.bytes, 100);
    assert.equal(seen.length, 1);
    assert.equal(closed[0]!.endedAt, at.getTime() + 4000);
  });

  it('closes the newest segment when it has gone stale', async () => {
    const stamp = new Date(Date.UTC(2026, 0, 2, 8, 0, 0));
    let now = stamp.getTime() + 500;
    const watcher = new SegmentWatcher({ dir, extension: 'mkv', segmentSeconds: 2, now: () => now });
    await segmentFile(stamp, 64, 0, stamp.getTime() + 1000);
    assert.deepEqual(await watcher.sweep(), [], 'fresh files are still being written');

    // Two seconds of segment means 3s of silence is stale.
    now += 4000;
    const closed = await watcher.sweep();
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.bytes, 64);
  });

  it('closes everything on flush, e.g. after FFmpeg exits', async () => {
    const stamp = new Date(Date.UTC(2026, 0, 3, 9, 0, 0));
    const watcher = new SegmentWatcher({ dir, extension: 'mkv', segmentSeconds: 3600, now: () => stamp.getTime() });
    await segmentFile(stamp, 16, 0, stamp.getTime() + 500);
    const flushed = await watcher.flush();
    assert.equal(flushed.length, 1);
    assert.deepEqual(await watcher.flush(), [], 'flush is idempotent');
  });

  it('ignores files that are not ours', async () => {
    const stamp = new Date(Date.UTC(2026, 0, 4, 10, 0, 0));
    const watcher = new SegmentWatcher({ dir, extension: 'mkv', segmentSeconds: 2, now: () => stamp.getTime() + 5000 });
    await writeFile(join(dir, 'notes.txt'), 'hello');
    await writeFile(join(dir, 'not-a-timestamp.mkv'), 'x');
    assert.deepEqual(await watcher.sweep(), []);
  });

  it('survives a directory that does not exist yet', async () => {
    const watcher = new SegmentWatcher({
      dir: join(dir, 'missing'),
      extension: 'mkv',
      segmentSeconds: 4,
      now: () => Date.now(),
    });
    assert.deepEqual(await watcher.sweep(), []);
  });

  it('does not re-emit a segment it already reported', async () => {
    const stamp = new Date(Date.UTC(2026, 0, 5, 11, 0, 0));
    const watcher = new SegmentWatcher({ dir, extension: 'mkv', segmentSeconds: 2, now: () => stamp.getTime() });
    const first = await segmentFile(stamp, 8, 0, stamp.getTime() + 500);
    await segmentFile(stamp, 8, 2, stamp.getTime() + 2500);
    await watcher.sweep();
    await utimes(first, stamp, stamp);
    assert.deepEqual(await watcher.sweep(), []);
  });
});

describe('SegmentWindow', () => {
  function closed(at: number, durationMs = 1000, bytes = 10): ClosedSegment {
    return { path: `/hot/${at}.mkv`, name: `${at}`, startedAt: at, endedAt: at + durationMs, bytes, mtimeMs: at + durationMs };
  }

  it('orders entries and reports overlap', () => {
    const window = new SegmentWindow();
    window.push(closed(6000));
    window.push(closed(2000));
    assert.equal(window.size, 2);
    assert.equal(window.bytes, 20);
    assert.equal(window.spanMs, 2000);

    assert.deepEqual(
      window.overlapping(5000, 7000).map((entry) => entry.startedAt),
      [6000],
    );
    assert.deepEqual(
      window.overlapping(2500, 5000).map((entry) => entry.startedAt),
      [2000],
    );
  });

  it('takes overlapping entries out of the ring exactly once', () => {
    const window = new SegmentWindow();
    window.push(closed(2000));
    window.push(closed(6000));
    const taken = window.takeOverlapping(1000, 7000);
    assert.equal(taken.length, 2);
    assert.equal(window.size, 0);
    assert.equal(window.takeOverlapping(1000, 7000).length, 0);
  });

  it('expires entries older than the window', () => {
    const window = new SegmentWindow();
    window.push(closed(1000));
    window.push(closed(5000));
    const expired = window.expire(4000);
    assert.deepEqual(
      expired.map((entry) => entry.startedAt),
      [1000],
    );
    assert.equal(window.size, 1);
  });

  it('clears everything and reports it', () => {
    const window = new SegmentWindow();
    window.push(closed(1000));
    assert.equal(window.clear().length, 1);
    assert.equal(window.size, 0);
    assert.deepEqual(window.all(), []);
  });
});
