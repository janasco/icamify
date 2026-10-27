/**
 * Storage contracts.
 *
 * The database is the index; the filesystem is the source of truth. On startup
 * the index is reconciled against the disk so a crash mid-segment cannot leave a
 * phantom entry in the timeline.
 *
 * Everything here is data: quotas are expressed in bytes and milliseconds, and
 * the conversion from the human units in the configuration happens once, in the
 * storage service.
 */

export type SegmentReason = 'continuous' | 'motion' | 'alert' | 'scheduled' | 'manual';

export type RecordingEventKind = 'motion' | 'ai.object' | 'ai.face' | 'ai.lpr' | 'ai.scene' | 'rule' | 'manual';

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
  /** When the segment was copied to an archive target. */
  archivedAt?: number;
  /** Archive provider that holds the copy. */
  archivedBy?: string;
}

/** A motion/AI/rule occurrence; segments link to it. */
export interface RecordedEvent {
  id: string;
  cameraId: string;
  kind: RecordingEventKind;
  startedAt: number;
  endedAt?: number;
  /** Peak share of zone cells that changed, for motion events. */
  peakPercent?: number;
  /** Human label, e.g. "person". */
  label?: string;
  /** Detection boxes as reported by the detector (opaque here). */
  boxes?: unknown;
  /** Highest confidence among the detections this event came from (0..1). */
  confidence?: number;
  /** AI provider that produced the detection, when there was one. */
  providerId?: string;
  /** Saved JPEG of the frame, relative to the snapshots directory. */
  snapshot?: string;
}

/** Effective ceilings for one volume. Omitted fields mean "no limit". */
export interface VolumeLimits {
  maxSizeBytes?: number;
  maxAgeHours?: number;
  minFreeBytes?: number;
}

export interface VolumeStats {
  volumeId: string;
  path: string;
  /** Bytes of recordings indexed on this volume. */
  usedBytes: number;
  /** Filesystem free space, which also counts data iCamify did not write. */
  freeBytes: number;
  totalBytes: number;
  diskUsedBytes: number;
  segmentCount: number;
  oldestAt?: number;
  limits: VolumeLimits;
  archive?: { providerId: string; label: string; afterHours: number; keepLocalDays: number };
  /** Filesystem problem (missing mount, permission denied); quotas cannot apply. */
  error?: string;
}

export type RetentionDeleteReason = 'age' | 'size' | 'disk-floor';

export interface RetentionDeletedSegment {
  segmentId: string;
  path: string;
  bytes: number;
  reason: RetentionDeleteReason;
}

export interface RetentionArchivedSegment {
  segmentId: string;
  providerId: string;
  key: string;
  bytes: number;
}

export interface RetentionSweepResult {
  volumeId: string;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  /** Segments retention was allowed to consider (protected clips excluded). */
  scannedSegments: number;
  scannedBytes: number;
  deleted: RetentionDeletedSegment[];
  archived: RetentionArchivedSegment[];
  freedBytes: number;
  errors: Array<{ segmentId?: string; path?: string; message: string }>;
}

export interface RetentionPolicy {
  enabled: boolean;
  intervalSeconds: number;
  strategy: 'oldest-first' | 'largest-first' | 'lowest-priority-first';
  batchSize: number;
  dryRun: boolean;
  /** When true (default), a starred clip is never a deletion candidate. */
  protectFlagged: boolean;
}

export interface RetentionManager {
  /** One purge pass; idempotent and safe to call concurrently (it serializes). */
  sweep(volumeId?: string): Promise<RetentionSweepResult[]>;
  /** Current usage, quotas and free disk for every volume. */
  stats(volumeId?: string): Promise<VolumeStats[]>;
  /** Marks a segment as user-protected; retention then never deletes it. */
  protect(segmentId: string, protectedFlag: boolean): Promise<void>;
}

export { StorageError, type StorageErrorCode } from './errors.ts';
export { openDatabase, schemaVersion, SCHEMA_VERSION, type OpenDatabaseOptions } from './db.ts';
export {
  RecordingIndex,
  type EventInput,
  type EventPatch,
  type EventQuery,
  type SegmentInput,
  type SegmentPatch,
  type SegmentQuery,
  type SegmentStats,
} from './recordings.ts';
export {
  createArchiveTarget,
  LocalArchiveTarget,
  S3ArchiveTarget,
  SftpArchiveTarget,
  archiveObjectKey,
  buildS3Url,
  describeArchiveProvider,
  keySegments,
  sanitizeKeySegment,
  signAwsV4,
  sftpBatch,
  type ArchiveTarget,
  type S3ArchiveOptions,
  type S3Location,
  type SftpArchiveOptions,
} from './archive/index.ts';
export {
  RetentionEngine,
  type ArchivePlan,
  type DiskUsage,
  type RetentionEngineOptions,
  type RetentionVolume,
} from './retention.ts';

export const STORAGE_VERSION = '0.2.0';
