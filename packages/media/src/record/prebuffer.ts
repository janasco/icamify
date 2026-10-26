import type { ClosedSegment } from './watcher.ts';

/**
 * The pre-buffer ring.
 *
 * This is the "rolling memory buffer" requirement, implemented the way an NVR
 * actually does it: the encoder never restarts, so there is no way to add
 * pre-roll after the fact. Instead the camera always segments continuously into
 * a hot directory, and already-closed segments sit here until either a trigger
 * adopts them or the window slides past them and they are deleted.
 *
 * Segments are whole files, so keeping a buffer costs disk, never CPU, and
 * adopting one is a rename.
 */

export interface BufferedSegment {
  path: string;
  name: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
}

export class SegmentWindow {
  private items: BufferedSegment[] = [];

  get size(): number {
    return this.items.length;
  }

  get bytes(): number {
    return this.items.reduce((total, item) => total + item.bytes, 0);
  }

  /** Seconds of footage currently buffered (sum of segment durations). */
  get spanMs(): number {
    return this.items.reduce((total, item) => total + Math.max(0, item.endedAt - item.startedAt), 0);
  }

  push(segment: ClosedSegment): BufferedSegment {
    const buffered: BufferedSegment = {
      path: segment.path,
      name: segment.name,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      bytes: segment.bytes,
    };
    this.items.push(buffered);
    this.items.sort((left, right) => left.startedAt - right.startedAt);
    return buffered;
  }

  all(): BufferedSegment[] {
    return [...this.items];
  }

  /** Segments intersecting [from, to] — what a trigger window has to keep. */
  overlapping(from: number, to: number): BufferedSegment[] {
    return this.items.filter((item) => item.endedAt >= from && item.startedAt <= to);
  }

  /** Removes and returns the overlapping segments. */
  takeOverlapping(from: number, to: number): BufferedSegment[] {
    const taken = this.overlapping(from, to);
    const takenPaths = new Set(taken.map((item) => item.path));
    this.items = this.items.filter((item) => !takenPaths.has(item.path));
    return taken;
  }

  /** Removes and returns everything that ended before `before`. */
  expire(before: number): BufferedSegment[] {
    const expired = this.items.filter((item) => item.endedAt < before);
    if (expired.length === 0) return [];
    const expiredPaths = new Set(expired.map((item) => item.path));
    this.items = this.items.filter((item) => !expiredPaths.has(item.path));
    return expired;
  }

  clear(): BufferedSegment[] {
    const items = this.items;
    this.items = [];
    return items;
  }
}
