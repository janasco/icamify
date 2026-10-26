import { isAbsolute, resolve } from 'node:path';
import type { ResolvedIcamifyConfig } from '@icamify/core';

/**
 * Storage directories, resolved once.
 *
 * Relative paths in the configuration are relative to `storage.rootDir` (which is
 * itself relative to the process working directory), so nothing downstream has to
 * remember which base applies. Keeping this in one function means the index, the
 * snapshots and the recorders can never disagree about where `data/` is.
 */

export interface StoragePaths {
  rootDir: string;
  recordingsDir: string;
  snapshotsDir: string;
  stateDir: string;
  tempDir: string;
}

export function resolveStoragePaths(config: ResolvedIcamifyConfig): StoragePaths {
  const root = absolute(config.storage.rootDir ?? './data');
  return {
    rootDir: root,
    recordingsDir: absolute(config.storage.recordingsDir ?? 'recordings', root),
    snapshotsDir: absolute(config.storage.snapshotsDir ?? 'snapshots', root),
    stateDir: absolute(config.storage.stateDir ?? 'state', root),
    tempDir: absolute(config.storage.tempDir ?? 'tmp', root),
  };
}

function absolute(path: string, base = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
