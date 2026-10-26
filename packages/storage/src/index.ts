import type { ArchiveProvider, StorageVolume } from '@icamify/core';

/**
 * Storage contracts (Phase 5).
 *
 * The database is the index; the filesystem is the source of truth. On startup
 * the index is reconciled against the disk so a crash mid-segment cannot leave a
 * phantom entry in the timeline.
 */

export type SegmentReason = 'continuous' | 'motion' | 'alert' | 'scheduled' | 'manual';

export interface RecordingSegment {
  id: string;
  cameraId: string;
  volumeId: string;
  /** Absolute path of the finalized file. */
  path: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  reason: SegmentReason;
  hasMotion: boolean;
  hasAlert: boolean;
  /** Event ids linked to this segment (motion, AI detections, rule hits). */
  eventIds: string[];
  /** Set when the user starred the clip; retention never deletes it. */
  protected?: boolean;
}

export interface VolumeStats {
  volumeId: string;
  path: string;
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
  segmentCount: number;
  oldestAt?: number;
}

export interface RetentionSweepResult {
  volumeId: string;
  deleted: Array<{ segmentId: string; path: string; bytes: number; reason: 'age' | 'size' | 'disk-floor' }>;
  archived: Array<{ segmentId: string; providerId: string }>;
  freedBytes: number;
  errors: Array<{ segmentId?: string; path?: string; message: string }>;
  dryRun: boolean;
}

export interface RetentionManager {
  /** One purge pass; idempotent and safe to call concurrently (it serializes). */
  sweep(volumeId?: string): Promise<RetentionSweepResult[]>;
  stats(volumeId?: string): Promise<VolumeStats[]>;
  /** Marks a segment as user-protected. */
  protect(segmentId: string, protectedFlag: boolean): Promise<void>;
}

export interface ArchiveTarget {
  readonly providerId: string;
  upload(path: string, key: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface VolumeContext {
  volume: StorageVolume;
  archive?: ArchiveTarget;
  archiveProvider?: ArchiveProvider;
}
