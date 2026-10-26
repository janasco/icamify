import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CameraConfig } from '@icamify/core';
import {
  cameraRecordingPaths,
  hotSegmentName,
  type IngestSupervisor,
  type MediaEngine,
} from '@icamify/media';
import { RecordingManager, type RecordingHubEvent } from '../src/recording/manager.ts';
import { EMPTY_AUTH, request, testConfig, testStorageRoot, waitFor, withServer } from './helpers.ts';

/**
 * Recording is verified at two levels: the manager (recorder ↔ index ↔ events) with
 * a fake FFmpeg, and the HTTP surface with a seeded index. Real FFmpeg recording is
 * exercised by the end-to-end check, not by unit tests.
 */

function fakeMedia(): MediaEngine {
  const host = {
    start() {
      return {
        pid: 9001,
        async stop() {
          // FFmpeg is not really running.
        },
      } as unknown as IngestSupervisor;
    },
  };
  return host as unknown as MediaEngine;
}

function recordingCamera(overrides: Partial<CameraConfig['recording']> = {}): CameraConfig {
  return {
    id: 'rec-cam',
    name: 'Recording camera',
    streams: { main: { type: 'file', path: '/videos/sample.mp4', loop: true } },
    profiles: { record: 'record-main', detect: 'detect-sub' },
    recording: { mode: 'continuous', segmentMinutes: 1, ...overrides },
  };
}

async function writeHot(hotDir: string, atMs: number, bytes = 64): Promise<string> {
  const path = join(hotDir, `${hotSegmentName(new Date(atMs))}.mkv`);
  await writeFile(path, Buffer.alloc(bytes, 3));
  const stamp = new Date(atMs + 200);
  await utimes(path, stamp, stamp);
  return path;
}

describe('RecordingManager', () => {
  test('adopts continuous segments into the index and emits them', async () => {
    const camera = recordingCamera();
    const config = testConfig({ cameras: [camera], storageRoot: join(testStorageRoot(), 'manager-continuous') });
    const events: RecordingHubEvent[] = [];
    const manager = new RecordingManager({
      config,
      media: fakeMedia(),
      pollIntervalMs: 20,
      log: () => {},
      onEvent: (event) => events.push(event),
    });

    try {
      await manager.start();
      const paths = cameraRecordingPaths(config, camera);
      await waitFor(() => (existsSync(paths.hotDir) ? true : undefined), 2000, 'hot directory');

      const base = Date.now();
      await writeHot(paths.hotDir, base);
      await writeHot(paths.hotDir, base + 1000);

      const segments = await waitFor(
        () => {
          const found = manager.index.listSegments({ cameraId: camera.id });
          return found.length > 0 ? found : undefined;
        },
        4000,
        'indexed segment',
      );

      assert.equal(segments[0]!.reason, 'continuous');
      assert.equal(segments[0]!.cameraId, camera.id);
      assert.equal(existsSync(segments[0]!.path), true, 'the adopted file exists');
      assert.equal(manager.index.stats({ cameraId: camera.id }).bytes > 0, true);
      assert.ok(events.some((event) => event.type === 'recording:segment'));
    } finally {
      await manager.stop();
      manager.close();
    }
  });

  test('creates an event and clips around a motion trigger', async () => {
    const camera = recordingCamera({ mode: 'motion', preBufferSeconds: 2, postRollSeconds: 1 });
    const config = testConfig({ cameras: [camera], storageRoot: join(testStorageRoot(), 'manager-motion') });
    const manager = new RecordingManager({
      config,
      media: fakeMedia(),
      pollIntervalMs: 20,
      log: () => {},
    });

    try {
      await manager.start();
      const paths = cameraRecordingPaths(config, camera);
      await waitFor(() => (existsSync(paths.hotDir) ? true : undefined), 2000, 'hot directory');

      const base = Date.now();
      await writeHot(paths.hotDir, base);
      await writeHot(paths.hotDir, base + 1000);
      await waitFor(() => ((manager.status(camera.id)?.bufferedSegments ?? 0) > 0 ? true : undefined), 4000, 'pre-buffered segment');

      manager.trigger(camera.id, 'motion', Date.now(), { peakPercent: 4.25, boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] });

      const events = await waitFor(
        () => {
          const found = manager.index.listEvents({ cameraId: camera.id });
          return found.length > 0 ? found : undefined;
        },
        4000,
        'motion event',
      );
      assert.equal(events[0]!.kind, 'motion');
      assert.equal(events[0]!.peakPercent, 4.25);

      const segments = await waitFor(
        () => {
          const found = manager.index.listSegments({ cameraId: camera.id });
          return found.length > 0 ? found : undefined;
        },
        4000,
        'adopted pre-roll',
      );
      assert.equal(segments[0]!.reason, 'motion');
      assert.deepEqual(segments[0]!.eventIds, [events[0]!.id]);
      assert.equal(segments[0]!.hasMotion, true);
    } finally {
      await manager.stop();
      manager.close();
    }
  });

  test('ignores cameras with recording off', async () => {
    const camera: CameraConfig = { ...recordingCamera(), recording: { mode: 'off' } };
    const config = testConfig({ cameras: [camera], storageRoot: join(testStorageRoot(), 'manager-off') });
    const manager = new RecordingManager({ config, media: fakeMedia(), log: () => {} });
    try {
      await manager.start();
      assert.equal(manager.startedRecorders, 0);
      assert.equal(manager.status(camera.id), undefined);
    } finally {
      await manager.stop();
      manager.close();
    }
  });
});

describe('recording API', () => {
  test('lists, details and streams clips with byte ranges', async () => {
    const root = join(testStorageRoot(), 'api-clips');
    await withServer(testConfig({ auth: EMPTY_AUTH, storageRoot: root }), async (server) => {
      const clip = join(root, 'api-clip.mkv');
      await mkdir(root, { recursive: true });
      await writeFile(clip, Buffer.from('01234567'));

      const segment = server.recording.index.insertSegment({
        cameraId: 'front-door',
        path: clip,
        startedAt: Date.now() - 5000,
        endedAt: Date.now(),
        bytes: 8,
        reason: 'continuous',
      });

      const list = await request(server, '/api/recordings?cameraId=front-door');
      assert.equal(list.status, 200);
      const body = list.json as { segments: Array<{ id: string }>; total: number };
      assert.equal(body.total, 1);
      assert.equal(body.segments[0]?.id, segment.id);

      const detail = await request(server, `/api/recordings/${segment.id}`);
      assert.equal(detail.status, 200);
      assert.equal((detail.json as { segment: { path: string } }).segment.path, clip);

      const partial = await request(server, `/api/recordings/${segment.id}/file`, {
        headers: { range: 'bytes=2-4' },
      });
      assert.equal(partial.status, 206);
      assert.equal(partial.text, '234');
      assert.equal(partial.headers.get('content-range'), 'bytes 2-4/8');
      assert.equal(partial.headers.get('content-type'), 'video/x-matroska');

      const whole = await request(server, `/api/recordings/${segment.id}/file`);
      assert.equal(whole.status, 200);
      assert.equal(whole.text, '01234567');

      const invalid = await request(server, `/api/recordings/${segment.id}/file`, {
        headers: { range: 'bytes=99-200' },
      });
      assert.equal(invalid.status, 416);

      const missing = await request(server, '/api/recordings/does-not-exist');
      assert.equal(missing.status, 404);
    });
  });

  test('reports a clip whose file disappeared', async () => {
    const root = join(testStorageRoot(), 'api-missing');
    await withServer(testConfig({ auth: EMPTY_AUTH, storageRoot: root }), async (server) => {
      const segment = server.recording.index.insertSegment({
        cameraId: 'front-door',
        path: join(root, 'never-existed.mkv'),
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        bytes: 0,
        reason: 'motion',
      });
      const response = await request(server, `/api/recordings/${segment.id}/file`);
      assert.equal(response.status, 410);
      assert.equal((response.json as { error: { code: string } }).error.code, 'recording-missing');
    });
  });

  test('exposes recorder status and recent clips per camera', async () => {
    const root = join(testStorageRoot(), 'api-status');
    await withServer(testConfig({ auth: EMPTY_AUTH, storageRoot: root }), async (server) => {
      const response = await request(server, '/api/cameras/front-door/recording');
      assert.equal(response.status, 200);
      const body = response.json as { status: unknown; stats: { segments: number }; recent: unknown[] };
      assert.equal(body.status, null, 'this camera records nothing');
      assert.equal(body.stats.segments, 0);
      assert.deepEqual(body.recent, []);

      const missing = await request(server, '/api/cameras/nope/recording');
      assert.equal(missing.status, 404);
    });
  });

  test('exposes motion status and persists zone edits', async () => {
    const camera: CameraConfig = {
      id: 'motion-cam',
      name: 'Motion camera',
      streams: { main: { type: 'file', path: '/videos/sample.mp4' } },
      profiles: { detect: 'detect-sub' },
      // Disabled: the status endpoint must still report zones without spawning FFmpeg.
      motion: { enabled: false, sensitivity: 50 },
    };
    await withServer(testConfig({ auth: EMPTY_AUTH, cameras: [camera] }), async (server) => {
      const status = await request(server, '/api/cameras/motion-cam/motion');
      assert.equal(status.status, 200);
      const body = status.json as { motion: { zones: { cols: number; rows: number }; activeCells: number } };
      assert.equal(body.motion.zones.cols, 16);
      assert.equal(body.motion.activeCells, 256);

      const cells = Array.from({ length: 16 }, (_unused, row) =>
        Array.from({ length: 16 }, (_cell, col) => row >= 8 && col < 8),
      );
      const update = await request(server, '/api/cameras/motion-cam/motion', {
        method: 'PUT',
        body: JSON.stringify({ sensitivity: 80, zones: { cols: 16, rows: 16, cells } }),
      });
      assert.equal(update.status, 200);
      const updated = update.json as { motion: { activeCells: number; thresholds: { sensitivity: number } } };
      assert.equal(updated.motion.activeCells, 64);
      assert.equal(updated.motion.thresholds.sensitivity, 80);

      const reread = await request(server, '/api/cameras/motion-cam/motion');
      const again = reread.json as { motion: { activeCells: number; thresholds: { sensitivity: number } } };
      assert.equal(again.motion.activeCells, 64, 'the override survives a read');

      const allActive = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => false));
      const empty = await request(server, '/api/cameras/motion-cam/motion', {
        method: 'PUT',
        body: JSON.stringify({ zones: { cols: 16, rows: 16, cells: allActive } }),
      });
      assert.equal(empty.status, 400, 'a matrix that monitors nothing is rejected');
    });
  });
});
