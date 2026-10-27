import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMPTY_AUTH, request, testConfig, withServer } from './helpers.ts';

/**
 * Retention, timeline and clip management over real HTTP.
 *
 * The sweep is driven through the API rather than by calling the service, because
 * the interesting failure modes are authorization, volume naming and the
 * file/index pair, not the loop itself (which packages/storage tests directly).
 */

function storageRoot(): { root: string; recordings: string } {
  const root = mkdtempSync(join(tmpdir(), 'icamify-storage-api-'));
  const recordings = join(root, 'recordings');
  mkdirSync(recordings, { recursive: true });
  return { root, recordings };
}

function manualConfig(root: string) {
  const config = testConfig({ auth: EMPTY_AUTH, storageRoot: root });
  // Manual sweeps only: a background timer would race the assertions.
  config.storage.purge = {
    enabled: false,
    intervalSeconds: 300,
    strategy: 'oldest-first',
    batchSize: 50,
    dryRun: false,
    protectFlagged: true,
  };
  return config;
}

describe('GET /api/storage', () => {
  it('reports volume usage, quotas and archive providers', async () => {
    const { root, recordings } = storageRoot();
    const config = manualConfig(root);
    config.storage.volumes = [{ id: 'primary', path: 'recordings', maxSizeGb: 2, maxAgeHours: 48, minFreeDiskGb: 1 }];
    config.storage.archiveProviders = [{ id: 'nas', type: 'local', path: join(root, 'archive') }];

    await withServer(config, async (server) => {
      const file = join(recordings, 'one.mkv');
      writeFileSync(file, Buffer.alloc(500, 1));
      server.recording.index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'primary',
        path: file,
        startedAt: Date.now() - 60_000,
        endedAt: Date.now(),
        bytes: 500,
        reason: 'continuous',
      });

      const response = await request(server, '/api/storage');
      assert.equal(response.status, 200);
      const body = response.json as {
        volumes: Array<Record<string, unknown> & { limits: Record<string, number>; segmentCount: number }>;
        totals: { usedBytes: number; segmentCount: number };
        policy: { enabled: boolean; intervalSeconds: number };
        archiveProviders: Array<{ id: string; label: string }>;
        cameras: Array<{ cameraId: string; segments: number }>;
      };
      assert.equal(body.volumes.length, 1);
      assert.equal(body.volumes[0]?.volumeId, 'primary');
      assert.equal(body.volumes[0]?.segmentCount, 1);
      assert.equal(body.volumes[0]?.limits.maxSizeBytes, 2 * 1024 ** 3);
      assert.equal(body.volumes[0]?.limits.maxAgeHours, 48);
      assert.equal(body.volumes[0]?.limits.minFreeBytes, 1024 ** 3);
      assert.equal(body.totals.usedBytes, 500);
      assert.equal(body.policy.enabled, false);
      assert.deepEqual(body.archiveProviders.map((provider) => provider.id), ['nas']);
      assert.equal(body.cameras[0]?.cameraId, 'front-door');
      assert.equal(body.cameras[0]?.segments, 1);
    });
  });

  it('falls back to the recordings directory when no volume is configured', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    config.storage.volumes = [];
    await withServer(config, async (server) => {
      const response = await request(server, '/api/storage');
      assert.equal(response.status, 200);
      const body = response.json as { volumes: Array<{ volumeId: string; path: string }> };
      assert.equal(body.volumes[0]?.volumeId, 'default');
      assert.equal(body.volumes[0]?.path.endsWith('recordings'), true);
    });
  });
});

describe('POST /api/storage/sweep', () => {
  it('supports a dry run, then deletes for real', async () => {
    const { root, recordings } = storageRoot();
    const config = manualConfig(root);
    config.storage.volumes = [{ id: 'primary', path: 'recordings', maxAgeHours: 1 }];

    await withServer(config, async (server) => {
      const file = join(recordings, 'old.mkv');
      writeFileSync(file, Buffer.alloc(64, 1));
      const old = server.recording.index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'primary',
        path: file,
        startedAt: Date.now() - 3 * 3_600_000,
        endedAt: Date.now() - 3 * 3_600_000 + 60_000,
        bytes: 64,
        reason: 'continuous',
      });

      const dry = await request(server, '/api/storage/sweep', {
        method: 'POST',
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(dry.status, 200);
      const dryBody = dry.json as { volumes: Array<{ deleted: unknown[]; dryRun: boolean; freedBytes: number }> };
      assert.equal(dryBody.volumes[0]?.dryRun, true);
      assert.equal(dryBody.volumes[0]?.deleted.length, 1);
      assert.equal(dryBody.volumes[0]?.freedBytes, 64);
      assert.equal(existsSync(file), true, 'a dry run never unlinks');

      const real = await request(server, '/api/storage/sweep', { method: 'POST', body: '{}' });
      assert.equal(real.status, 200);
      const realBody = real.json as { volumes: Array<{ deleted: Array<{ reason: string }> }> };
      assert.equal(realBody.volumes[0]?.deleted[0]?.reason, 'age');
      assert.equal(existsSync(file), false);
      assert.equal(server.recording.index.listSegments().length, 0);
      assert.equal(server.recording.index.getSegment(old.id) !== undefined, true, 'the row is tombstoned');
    });
  });

  it('rejects an unknown volume', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    await withServer(config, async (server) => {
      const response = await request(server, '/api/storage/sweep', {
        method: 'POST',
        body: JSON.stringify({ volumeId: 'nope' }),
      });
      assert.equal(response.status, 404);
      const body = response.json as { error: { code: string } };
      assert.equal(body.error.code, 'volume-not-found');
    });
  });

  it('reports a volume whose archive target cannot be built', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    config.storage.volumes = [
      { id: 'primary', path: 'recordings', archive: { enabled: true, providerId: 'missing', afterHours: 1 } },
    ];
    await withServer(config, async (server) => {
      const response = await request(server, '/api/storage/sweep', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const body = response.json as { volumes: Array<{ errors: Array<{ message: string }> }> };
      assert.match(body.volumes[0]?.errors[0]?.message ?? '', /missing/);
    });
  });
});

describe('GET /api/timeline', () => {
  it('returns segments and events for one camera in chronological order', async () => {
    const { root, recordings } = storageRoot();
    const config = manualConfig(root);

    await withServer(config, async (server) => {
      const from = Date.now() - 3_600_000;
      const index = server.recording.index;
      const first = index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'default',
        path: (() => {
          const file = join(recordings, 'first.mkv');
          writeFileSync(file, Buffer.alloc(10, 1));
          return file;
        })(),
        startedAt: from + 1_000,
        endedAt: from + 61_000,
        bytes: 10,
        reason: 'motion',
        hasMotion: true,
      });
      const secondFile = join(recordings, 'second.mkv');
      writeFileSync(secondFile, Buffer.alloc(10, 1));
      index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'default',
        path: secondFile,
        startedAt: from + 120_000,
        endedAt: from + 180_000,
        bytes: 10,
        reason: 'continuous',
      });
      index.insertSegment({
        cameraId: 'garage',
        volumeId: 'default',
        path: (() => {
          const file = join(recordings, 'garage.mkv');
          writeFileSync(file, Buffer.alloc(10, 1));
          return file;
        })(),
        startedAt: from + 3_000,
        endedAt: from + 60_000,
        bytes: 10,
        reason: 'continuous',
      });
      const motion = index.insertEvent({ cameraId: 'front-door', kind: 'motion', startedAt: from + 5_000, endedAt: from + 20_000 });
      index.linkEvent(first.id, motion.id);
      index.insertEvent({ cameraId: 'front-door', kind: 'ai.object', startedAt: from + 130_000, label: 'person', confidence: 0.9, providerId: 'cpai' });

      const response = await request(
        server,
        `/api/timeline?cameraId=front-door&from=${from}&to=${from + 86_400_000}`,
      );
      assert.equal(response.status, 200);
      const body = response.json as {
        segments: Array<{ id: string; startedAt: number; hasMotion: boolean }>;
        events: Array<{ kind: string; label?: string }>;
        counts: { segments: number; events: number };
        truncated: boolean;
      };
      assert.equal(body.segments.length, 2);
      assert.deepEqual(
        body.segments.map((segment) => segment.startedAt),
        [from + 1_000, from + 120_000],
        'ascending, so the player can walk forward',
      );
      assert.equal(body.segments[0]?.hasMotion, true);
      assert.equal(body.events.length, 2);
      assert.deepEqual(body.events.map((event) => event.kind), ['motion', 'ai.object']);
      assert.equal(body.counts.segments, 2);
      assert.equal(body.truncated, false);
    });
  });

  it('rejects an inverted or oversized range', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    await withServer(config, async (server) => {
      const inverted = await request(server, '/api/timeline?from=2000&to=1000');
      assert.equal(inverted.status, 400);
      const huge = await request(server, '/api/timeline?from=0&to=99999999999');
      assert.equal(huge.status, 400);
      const body = huge.json as { error: { code: string } };
      assert.equal(body.error.code, 'range-too-large');
    });
  });
});

describe('clip management', () => {
  it('protects a clip from retention, then refuses to delete it until unprotected', async () => {
    const { root, recordings } = storageRoot();
    const config = manualConfig(root);
    config.storage.volumes = [{ id: 'primary', path: 'recordings', maxAgeHours: 1 }];

    await withServer(config, async (server) => {
      const file = join(recordings, 'starred.mkv');
      writeFileSync(file, Buffer.alloc(24, 1));
      const segment = server.recording.index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'primary',
        path: file,
        startedAt: Date.now() - 6 * 3_600_000,
        endedAt: Date.now() - 6 * 3_600_000 + 60_000,
        bytes: 24,
        reason: 'alert',
      });

      const protect = await request(server, `/api/recordings/${segment.id}/protect`, {
        method: 'POST',
        body: JSON.stringify({ protected: true }),
      });
      assert.equal(protect.status, 200);
      assert.equal((protect.json as { protected: boolean }).protected, true);

      const sweep = await request(server, '/api/storage/sweep', { method: 'POST', body: '{}' });
      assert.equal(sweep.status, 200);
      assert.equal(existsSync(file), true, 'a starred clip survives an age purge');

      const blocked = await request(server, `/api/recordings/${segment.id}`, { method: 'DELETE' });
      assert.equal(blocked.status, 409);
      assert.equal((blocked.json as { error: { code: string } }).error.code, 'recording-protected');

      await request(server, `/api/recordings/${segment.id}/protect`, {
        method: 'POST',
        body: JSON.stringify({ protected: false }),
      });
      const deleted = await request(server, `/api/recordings/${segment.id}`, { method: 'DELETE' });
      assert.equal(deleted.status, 200);
      assert.equal(existsSync(file), false);
      assert.equal(server.recording.index.listSegments().length, 0);
    });
  });

  it('404s on an unknown clip', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    await withServer(config, async (server) => {
      const missing = await request(server, '/api/recordings/nope/file');
      assert.equal(missing.status, 404);
      const protect = await request(server, '/api/recordings/nope/protect', { method: 'POST', body: '{}' });
      assert.equal(protect.status, 404);
      const playback = await request(server, '/api/recordings/nope/play.mp4');
      assert.equal(playback.status, 404);
    });
  });

  it('410s when the file backing a clip is gone', async () => {
    const { root } = storageRoot();
    const config = manualConfig(root);
    await withServer(config, async (server) => {
      const segment = server.recording.index.insertSegment({
        cameraId: 'front-door',
        volumeId: 'default',
        path: join(root, 'recordings', 'vanished.mkv'),
        startedAt: Date.now() - 60_000,
        endedAt: Date.now(),
        bytes: 10,
        reason: 'continuous',
      });
      const playback = await request(server, `/api/recordings/${segment.id}/play.mp4`);
      assert.equal(playback.status, 410);
      const body = playback.json as { error: { code: string } };
      assert.equal(body.error.code, 'recording-missing');
    });
  });
});
