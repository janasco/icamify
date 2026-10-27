import type { ArchiveProvider } from '@icamify/core';
import { StorageError } from '../errors.ts';
import { LocalArchiveTarget } from './local.ts';
import { S3ArchiveTarget } from './s3.ts';
import { SftpArchiveTarget } from './sftp.ts';
import { describeArchiveProvider, type ArchiveTarget } from './types.ts';

/**
 * Builds the target for a configured provider.
 *
 * A provider that cannot be built (missing credentials, unsupported auth) does
 * not abort startup: the caller records the error on the volume and reports it,
 * because losing the archive is survivable while losing the NVR is not. The error
 * is thrown only so the caller can decide.
 */
export function createArchiveTarget(provider: ArchiveProvider): ArchiveTarget {
  if (provider.enabled === false) {
    throw new StorageError('archive-unavailable', `Archive provider "${provider.id}" is disabled.`, {
      providerId: provider.id,
    });
  }
  switch (provider.type) {
    case 'local':
      return new LocalArchiveTarget(provider);
    case 's3':
      return new S3ArchiveTarget(provider);
    case 'sftp':
      return new SftpArchiveTarget(provider);
  }
}

export { LocalArchiveTarget } from './local.ts';
export { S3ArchiveTarget, buildS3Url, signAwsV4, type S3ArchiveOptions, type S3Location } from './s3.ts';
export { SftpArchiveTarget, sftpBatch, type SftpArchiveOptions } from './sftp.ts';
export {
  archiveObjectKey,
  describeArchiveProvider,
  keySegments,
  sanitizeKeySegment,
  type ArchiveTarget,
} from './types.ts';
