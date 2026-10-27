import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ArchiveLocal } from '@icamify/core';
import { StorageError } from '../errors.ts';
import { describeArchiveProvider, keySegments, type ArchiveTarget } from './types.ts';

/**
 * Copy-to-directory archiver (a NAS mount, an external disk, a synced folder).
 *
 * This is the archive target that always works: no credentials, no network
 * protocol, and a failed copy leaves the source untouched, so retention can keep
 * the file instead of losing it.
 */
export class LocalArchiveTarget implements ArchiveTarget {
  readonly providerId: string;
  readonly label: string;
  private readonly root: string;

  constructor(provider: ArchiveLocal) {
    this.providerId = provider.id;
    this.label = describeArchiveProvider(provider);
    this.root = resolve(provider.path);
  }

  async upload(path: string, key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw new StorageError('archive-failed', 'Archive cancelled.', { providerId: this.providerId });
    }
    if (isAbsolute(key)) {
      throw new StorageError('archive-invalid-key', `Archive key must be relative, got "${key}".`, {
        providerId: this.providerId,
      });
    }
    const target = join(this.root, ...keySegments(key));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
    const [copied, source] = await Promise.all([stat(target), stat(path)]);
    if (copied.size !== source.size) {
      throw new StorageError(
        'archive-failed',
        `Archived copy is ${copied.size} bytes but the source is ${source.size}.`,
        { providerId: this.providerId },
      );
    }
  }

  async close(): Promise<void> {
    // Nothing to release; kept so every target has the same lifecycle.
  }
}
