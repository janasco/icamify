import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHotSegmentName } from './paths.ts';

/**
 * Watches the hot directory for segments FFmpeg has finished writing.
 *
 * FFmpeg's segment muxer gives no callback, so completion has to be inferred.
 * Two rules, both conservative:
 * - a newer segment exists, which means the muxer has moved on (names are
 *   timestamp-ordered), or
 * - the file has not been touched for longer than a segment could reasonably
 *   take, which catches the last segment before a restart or shutdown.
 *
 * Polling rather than `fs.watch` is deliberate: inotify is not portable, and a
 * directory listing of a handful of small names every second costs nothing.
 */

export interface ClosedSegment {
  path: string;
  /** File name without the extension, e.g. `20260101-120000`. */
  name: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  mtimeMs: number;
}

export interface SegmentWatcherOptions {
  dir: string;
  extension: string;
  /** Nominal segment length, used to decide when the last file is stale. */
  segmentSeconds: number;
  pollIntervalMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
  /** Called after every scan, so the recorder can expire buffers on a timer. */
  onSweep?: () => void;
}

interface Candidate {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export class SegmentWatcher {
  private readonly options: SegmentWatcherOptions;
  private readonly emitted = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private listener: ((segment: ClosedSegment) => void) | undefined;
  private sweeping: Promise<ClosedSegment[]> | undefined;

  constructor(options: SegmentWatcherOptions) {
    this.options = options;
  }

  onClosed(listener: (segment: ClosedSegment) => void): void {
    this.listener = listener;
  }

  start(): void {
    if (this.timer !== undefined) return;
    const interval = Math.max(100, this.options.pollIntervalMs ?? 1000);
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.options.onError?.(error instanceof Error ? error.message : String(error));
      });
    }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /** One scan. Serialized so two overlapping sweeps cannot double-emit. */
  sweep(): Promise<ClosedSegment[]> {
    if (this.sweeping !== undefined) return this.sweeping;
    this.sweeping = this.scan(false).finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  /** Closes everything still open; used after FFmpeg exits. */
  async flush(): Promise<ClosedSegment[]> {
    const closed = await this.scan(true);
    return closed;
  }

  /** Files currently on disk, whether or not they have been emitted. */
  async pending(): Promise<number> {
    const files = await this.list();
    return files.filter((file) => !this.emitted.has(file.name)).length;
  }

  private async scan(closeAll: boolean): Promise<ClosedSegment[]> {
    const files = await this.list();
    const now = (this.options.now ?? Date.now)();
    const staleAfterMs = this.staleAfterMs();
    const closed: ClosedSegment[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      if (this.emitted.has(file.name)) continue;
      const isNewest = index === files.length - 1;
      const stale = now - file.mtimeMs >= staleAfterMs;
      if (!closeAll && isNewest && !stale) continue;

      const startedAt = parseHotSegmentName(file.name);
      if (startedAt === undefined) continue;
      this.emitted.add(file.name);
      const segment: ClosedSegment = {
        path: file.path,
        name: file.name,
        startedAt,
        // mtime is when the last packet landed, i.e. the segment's end.
        endedAt: Math.max(startedAt + 200, Math.round(file.mtimeMs)),
        bytes: file.size,
        mtimeMs: file.mtimeMs,
      };
      closed.push(segment);
    }

    for (const segment of closed) this.listener?.(segment);
    this.options.onSweep?.();
    return closed;
  }

  private async list(): Promise<Candidate[]> {
    const suffix = `.${this.options.extension}`;
    let entries;
    try {
      entries = await readdir(this.options.dir, { withFileTypes: true });
    } catch {
      // The directory may not exist yet while FFmpeg is starting.
      return [];
    }

    const files: Candidate[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const name = entry.name.slice(0, -suffix.length);
      if (parseHotSegmentName(name) === undefined) continue;
      const path = join(this.options.dir, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined) continue;
      files.push({ name, path, mtimeMs: info.mtimeMs, size: info.size });
    }
    files.sort((left, right) => left.name.localeCompare(right.name));
    return files;
  }

  private staleAfterMs(): number {
    return Math.max(2000, Math.round(this.options.segmentSeconds * 1000 * 1.5));
  }
}
