import type { ArchiveProvider } from '@icamify/core';

/**
 * An archive destination.
 *
 * The retention manager only knows this interface: it hands over a finished
 * segment's absolute path and a key (camera/day/file), and the target decides
 * whether that becomes a copy, an S3 PUT or an SFTP transfer. Targets never
 * delete local files — retention owns that decision, because it also owns the
 * index row that has to be tombstoned in the same breath.
 */
export interface ArchiveTarget {
  readonly providerId: string;
  /** Human-readable destination, for logs and the storage panel. */
  readonly label: string;
  upload(path: string, key: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * Object key for a recorded file: `camera/YYYY-MM-DD/file`.
 *
 * Keys are deliberately derived from the recording rather than from a running
 * counter, so re-uploading after a crash overwrites the same object instead of
 * filling the archive with duplicates.
 */
export function archiveObjectKey(input: {
  cameraId: string;
  startedAt: number;
  /** Base name of the recorded file. */
  fileName: string;
}): string {
  const day = new Date(input.startedAt).toISOString().slice(0, 10);
  return `${sanitizeKeySegment(input.cameraId)}/${day}/${sanitizeKeySegment(input.fileName)}`;
}

/** Replaces anything outside a conservative object-name alphabet. */
export function sanitizeKeySegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length === 0 ? 'unnamed' : cleaned;
}

/**
 * Splits a key into safe segments, rejecting traversal.
 *
 * A key is built from configuration and file names, both of which an operator
 * controls; this is the last line of defence before a path joins an archive
 * root.
 */
export function keySegments(key: string): string[] {
  const segments = key.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return ['unnamed'];
  return segments.map((segment) => {
    if (segment === '.' || segment === '..' || segment.includes('\0')) return '_';
    return sanitizeKeySegment(segment);
  });
}

export function describeArchiveProvider(provider: ArchiveProvider): string {
  switch (provider.type) {
    case 's3':
      return `s3://${provider.bucket}${provider.prefix === undefined ? '' : `/${provider.prefix.replace(/^\/+|\/+$/g, '')}`}`;
    case 'sftp':
      return `sftp://${provider.username === undefined ? '' : `${provider.username}@`}${provider.host}/${provider.remoteDir.replace(/^\/+|\/+$/g, '')}`;
    case 'local':
      return provider.path;
  }
}
