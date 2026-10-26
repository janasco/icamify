import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

/**
 * Detection snapshot storage.
 *
 * Snapshots are plain JPEGs under `storage.snapshotsDir`, addressed by a relative
 * path stored on the event row. Everything that turns such a path back into a
 * file goes through `resolveSnapshotPath`, so a crafted path cannot escape the
 * directory.
 */

export function snapshotRelativePath(cameraId: string, at: number, labels: ReadonlyArray<string>): string {
  const date = new Date(at);
  const day = date.toISOString().slice(0, 10);
  const time = date.toISOString().slice(11, 19).replaceAll(':', '');
  const slug = [...new Set(labels)]
    .join('-')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 40);
  return `${cameraId}/${day}/${time}-${slug || 'detection'}.jpg`;
}

/** Writes the JPEG and returns its relative path; throws on filesystem errors. */
export async function writeSnapshot(root: string, relativePath: string, jpeg: Buffer): Promise<string> {
  const absolute = join(root, ...relativePath.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, jpeg);
  return relativePath;
}

/** Absolute path for a stored snapshot, or `undefined` when it escapes the root. */
export function resolveSnapshotPath(root: string, relativePath: string): string | undefined {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) return undefined;
  const base = resolve(root);
  const target = resolve(base, normalize(relativePath.split('/').join('/')));
  const prefix = relative(base, target);
  if (prefix.startsWith('..') || isAbsolute(prefix)) return undefined;
  return target;
}
