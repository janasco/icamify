import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CameraConfig, ResolvedIcamifyConfig, StreamProfile } from '@icamify/core';
import { resolveProfileForPurpose, resolveRecordingsDir, selectStorageVolume } from '../plan.ts';

/**
 * Where recordings live.
 *
 * Every camera records into `<recordings>/<cameraId>/`, with an in-flight `.hot`
 * directory beside the finished clips. Hot segments stay on the same filesystem
 * as their final destination, so adopting a pre-buffered segment is a rename, not
 * a copy — a 5-second 4K remux is gigabytes and must never be copied just to be
 * kept.
 *
 * File names use the machine's local time (FFmpeg's `-strftime` writes local time
 * too); the index stores epoch milliseconds, so ordering and playback never depend
 * on the name.
 */

export type RecordingReason = 'continuous' | 'motion' | 'alert' | 'scheduled' | 'manual';

export interface CameraRecordingPaths {
  /** Recordings root for this camera's volume. */
  root: string;
  /** Volume id that owns the files, for the index and retention. */
  volumeId: string;
  cameraDir: string;
  /** In-flight segments, deleted or adopted. */
  hotDir: string;
  extension: string;
  /** strftime template passed to FFmpeg's segment muxer. */
  hotTemplate: string;
}

export function resolveRecordExtension(
  config: ResolvedIcamifyConfig,
  camera: CameraConfig,
): string {
  let profile: StreamProfile | undefined;
  try {
    profile = resolveProfileForPurpose(config, camera, 'record').profile;
  } catch {
    profile = undefined;
  }
  const container = profile?.container ?? config.storage.format ?? 'mkv';
  return container === 'mpegts' ? 'ts' : container;
}

export function cameraRecordingPaths(
  config: ResolvedIcamifyConfig,
  camera: CameraConfig,
): CameraRecordingPaths {
  const root = resolveRecordingsDir(config.storage, camera.id);
  const cameraDir = join(root, camera.id);
  const hotDir = join(cameraDir, '.hot');
  const extension = resolveRecordExtension(config, camera);
  return {
    root,
    volumeId: resolveVolumeId(config, camera.id),
    cameraDir,
    hotDir,
    extension,
    hotTemplate: join(hotDir, `%Y%m%d-%H%M%S.${extension}`),
  };
}

/**
 * Volume id that owns a camera's files.
 *
 * Must agree with `resolveRecordingsDir`, which uses the same selection: a file
 * stored on volume `hot` and indexed as volume `default` would never be purged, so
 * the two cannot be allowed to disagree.
 */
export function resolveVolumeId(config: ResolvedIcamifyConfig, cameraId: string): string {
  return selectStorageVolume(config.storage, cameraId)?.id ?? 'default';
}

/** Final, indexable path for a finished segment; never reused. */
export function finalSegmentPath(
  paths: CameraRecordingPaths,
  startedAt: number,
  reason: RecordingReason,
): string {
  const date = new Date(startedAt);
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const base = join(paths.cameraDir, day, `${time}-${reason}`);
  let candidate = `${base}.${paths.extension}`;
  let attempt = 1;
  while (existsSync(candidate)) {
    attempt += 1;
    candidate = `${base}-${attempt}.${paths.extension}`;
  }
  return candidate;
}

/** FFmpeg writes `YYYYMMDD-HHMMSS.ext` into the hot directory. */
export function hotSegmentName(at: Date): string {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${day}-${time}`;
}

/**
 * Parses a hot file name back into a local-time epoch. Returns undefined for
 * names that are not ours, so a stray file in `.hot` is ignored rather than
 * mistaken for footage.
 */
export function parseHotSegmentName(name: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (match === null) return undefined;
  const [, year, month, day, hours, minutes, seconds] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
