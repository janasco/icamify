import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG, type CameraConfig, type RecordingConfig, type ResolvedIcamifyConfig } from '@icamify/core';
import { CameraRecorder, hotSegmentName, type RecorderCallbacks, type RecorderPipelineHost, type RecorderStartOptions } from '../src/index.ts';
import type { IngestSupervisor } from '../src/ingest/supervisor.ts';

/**
 * These tests drive the recorder with `pollOnce()` instead of waiting for its
 * poll timer, so the pre-buffer, adoption and window logic is deterministic.
 */

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'icamify-recorder-'));
  created.push(dir);
  return dir;
}

function makeConfig(root: string): ResolvedIcamifyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.storage.rootDir = root;
  config.storage.preBufferSeconds = 5;
  config.storage.segmentMinutes = 15;
  return config;
}

function makeCamera(recording: RecordingConfig = {}): CameraConfig {
  return {
    id: 'cam1',
    name: 'Front door',
    streams: { main: { type: 'file', path: '/videos/sample.mp4', loop: true } },
    profiles: { record: 'record-main' },
    recording: { mode: 'motion', preBufferSeconds: 5, postRollSeconds: 3, segmentMinutes: 1, ...recording },
  };
}

interface FakeHost extends RecorderPipelineHost {
  starts: number;
  stops: number;
  options: RecorderStartOptions | undefined;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    starts: 0,
    stops: 0,
    options: undefined,
    start(_config, _camera, _purpose, options) {
      host.starts += 1;
      host.options = options;
      const supervisor = {
        pid: 4242,
        async stop() {
          host.stops += 1;
        },
      } as unknown as IngestSupervisor;
      return supervisor;
    },
  };
  return host;
}

interface Harness {
  recorder: CameraRecorder;
  host: FakeHost;
  hotDir: string;
  clock: { value: number };
  adopted: Array<Parameters<NonNullable<RecorderCallbacks['onAdopt']>>[0]>;
  dropped: Array<Parameters<NonNullable<RecorderCallbacks['onDrop']>>[0]>;
  triggers: Array<Parameters<NonNullable<RecorderCallbacks['onTrigger']>>[0]>;
  releases: Array<Parameters<NonNullable<RecorderCallbacks['onRelease']>>[0]>;
  errors: string[];
}

function harness(root: string, recording: RecordingConfig = {}, extra: { scheduleActive?: () => boolean } = {}): Harness {
  const clock = { value: Date.now() };
  const host = fakeHost();
  const adopted: Harness['adopted'] = [];
  const dropped: Harness['dropped'] = [];
  const triggers: Harness['triggers'] = [];
  const releases: Harness['releases'] = [];
  const errors: string[] = [];
  const recorder = new CameraRecorder({
    config: makeConfig(root),
    camera: makeCamera(recording),
    media: host,
    now: () => clock.value,
    pollIntervalMs: 600_000,
    ...(extra.scheduleActive === undefined ? {} : { scheduleActive: extra.scheduleActive }),
    eventIdFactory: () => 'evt-1',
    callbacks: {
      onAdopt: (segment) => adopted.push(segment),
      onDrop: (segment) => dropped.push(segment),
      onTrigger: (event) => triggers.push(event),
      onRelease: (event) => releases.push(event),
      onError: (message) => errors.push(message),
    },
  });
  return { recorder, host, hotDir: recorder.pathsForCamera.hotDir, clock, adopted, dropped, triggers, releases, errors };
}

async function writeHot(hotDir: string, atMs: number, extension = 'mkv', bytes = 128): Promise<string> {
  const path = join(hotDir, `${hotSegmentName(new Date(atMs))}.${extension}`);
  await writeFile(path, Buffer.alloc(bytes, 7));
  // Deterministic mtime: the watcher treats it as the segment's end time.
  const stamp = new Date(atMs + 200);
  await utimes(path, stamp, stamp);
  return path;
}

const SECOND = 1000;

describe('CameraRecorder', () => {
  it('does nothing when recording is off', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'off' });
    await h.recorder.start();
    assert.equal(h.host.starts, 0);
    assert.equal(h.recorder.status().state, 'off');
  });

  it('starts a segmenting copy pipeline into the hot directory', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 4 });
    await h.recorder.start();
    assert.equal(h.host.starts, 1);
    assert.equal(h.host.options?.segmentSeconds, 4, 'hot segment length follows the pre-buffer');
    assert.ok(h.host.options?.outputTemplate.endsWith('.hot/%Y%m%d-%H%M%S.mkv'));
    assert.equal(h.recorder.status().directToDisk, true);
    assert.equal(h.recorder.status().state, 'buffering');
    await h.recorder.stop();
  });

  it('adopts every segment in continuous mode', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'continuous' });
    await h.recorder.start();
    const first = await writeHot(h.hotDir, h.clock.value);
    await writeHot(h.hotDir, h.clock.value + SECOND);
    await h.recorder.pollOnce();

    assert.equal(h.adopted.length, 1);
    assert.equal(h.adopted[0]!.reason, 'continuous');
    assert.equal(h.adopted[0]!.volumeId, 'default');
    assert.equal(existsSync(first), false, 'the hot file is moved, not copied');
    assert.equal(existsSync(h.adopted[0]!.path), true);
    assert.ok(h.adopted[0]!.path.includes(join('cam1', 'recordings')) || h.adopted[0]!.path.includes('cam1'));

    const info = await stat(h.adopted[0]!.path);
    assert.equal(info.size, 128);
    await h.recorder.stop();
  });

  it('keeps closed segments in the pre-buffer instead of adopting them', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 5 });
    await h.recorder.start();
    await writeHot(h.hotDir, h.clock.value);
    await writeHot(h.hotDir, h.clock.value + SECOND);
    await h.recorder.pollOnce();

    assert.equal(h.adopted.length, 0);
    assert.equal(h.recorder.status().bufferedSegments, 1);
    assert.equal(h.recorder.status().bufferedBytes, 128);
    assert.equal(h.recorder.status().state, 'buffering');
    await h.recorder.stop();
  });

  it('adopts pre-roll and post-roll around a motion trigger', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 5, postRollSeconds: 3 });
    await h.recorder.start();

    const t0 = h.clock.value;
    await writeHot(h.hotDir, t0);
    await writeHot(h.hotDir, t0 + SECOND);
    await h.recorder.pollOnce();
    assert.equal(h.recorder.status().bufferedSegments, 1, 'one segment is buffered before the trigger');

    h.clock.value = t0 + 1500;
    h.recorder.trigger('motion', h.clock.value);
    await h.recorder.pollOnce();

    assert.equal(h.triggers.length, 1);
    assert.equal(h.triggers[0]!.kind, 'motion');
    assert.equal(h.triggers[0]!.eventId, 'evt-1');
    assert.equal(h.adopted.length, 1, 'the buffered segment is adopted as pre-roll');
    assert.equal(h.adopted[0]!.reason, 'motion');
    assert.equal(h.adopted[0]!.eventId, 'evt-1');
    assert.equal(h.recorder.status().state, 'recording');

    // A segment that closes while the window is open is adopted too.
    await writeHot(h.hotDir, t0 + 2500);
    await writeHot(h.hotDir, t0 + 3500);
    h.clock.value = t0 + 3500;
    await h.recorder.pollOnce();
    assert.equal(h.adopted.length, 3);
    assert.equal(h.adopted[1]!.eventId, 'evt-1');
    assert.equal(h.adopted[2]!.eventId, 'evt-1');

    // Once the post-roll passes, the window closes and live buffering resumes.
    h.clock.value = t0 + 10_000;
    await h.recorder.pollOnce();
    assert.equal(h.releases.length, 1);
    assert.equal(h.releases[0]!.eventId, 'evt-1');
    assert.equal(h.recorder.status().eventActive, false);

    await h.recorder.stop();
  });

  it('extends an open window when another trigger arrives', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 2, postRollSeconds: 2 });
    await h.recorder.start();
    const t0 = h.clock.value;
    h.recorder.trigger('motion', t0);
    await h.recorder.pollOnce();
    h.recorder.trigger('motion', t0 + 3000);
    await h.recorder.pollOnce();
    assert.equal(h.triggers.length, 1, 'one event covers the whole episode');
    const status = h.recorder.status();
    assert.equal(status.eventActive, true);
    assert.equal(status.windowEndsAt, t0 + 5000);
    await h.recorder.stop();
  });

  it('escalates an open motion window to an alert when a rule fires', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 2, postRollSeconds: 2 });
    await h.recorder.start();
    const t0 = h.clock.value;
    await writeHot(h.hotDir, t0);
    await writeHot(h.hotDir, t0 + SECOND);
    h.recorder.trigger('motion', t0 + 1500);
    await h.recorder.pollOnce();
    assert.equal(h.adopted[0]!.reason, 'motion');

    // The rule fires a second later: the episode is still open, but it is now an
    // alert, and every segment adopted from here on must say so.
    h.recorder.trigger('alert', t0 + 2500, { holdMs: 6000 });
    await h.recorder.pollOnce();
    await writeHot(h.hotDir, t0 + 3500);
    await writeHot(h.hotDir, t0 + 4500);
    h.clock.value = t0 + 4500;
    await h.recorder.pollOnce();

    assert.equal(h.triggers.length, 1, 'still one event for the whole episode');
    assert.ok(h.adopted.some((segment) => segment.reason === 'alert'), 'later segments are alerts');
    assert.equal(h.recorder.status().windowEndsAt, t0 + 8500, 'the rule clip length extends the window');
    await h.recorder.stop();
  });

  it('deletes buffered segments once they fall out of the pre-buffer', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'motion', preBufferSeconds: 5 });
    await h.recorder.start();
    const t0 = h.clock.value;
    const first = await writeHot(h.hotDir, t0);
    await writeHot(h.hotDir, t0 + SECOND);
    await h.recorder.pollOnce();
    assert.equal(h.recorder.status().bufferedSegments, 1);

    h.clock.value = t0 + 30_000;
    await h.recorder.pollOnce();
    assert.equal(h.recorder.status().bufferedSegments, 0);
    // Both age out: the buffered one expires, and the open segment closes stale
    // and is immediately too old to keep.
    assert.equal(h.dropped.length, 2);
    assert.equal(existsSync(first), false, 'the file is deleted, not leaked');
    await h.recorder.stop();
  });

  it('flushes the final segment when the recorder stops', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'continuous' });
    await h.recorder.start();
    await writeHot(h.hotDir, h.clock.value);
    await h.recorder.stop();

    assert.equal(h.host.stops, 1);
    assert.equal(h.adopted.length, 1, 'FFmpeg exit closes the last file');
    assert.equal(h.recorder.status().state, 'idle');
  });

  it('only adopts while a schedule is active', async () => {
    const root = await tempRoot();
    let open = false;
    const h = harness(root, { mode: 'scheduled', preBufferSeconds: 4 }, { scheduleActive: () => open });
    await h.recorder.start();

    await writeHot(h.hotDir, h.clock.value);
    await writeHot(h.hotDir, h.clock.value + SECOND);
    await h.recorder.pollOnce();
    assert.equal(h.adopted.length, 0, 'nothing is kept outside the window');

    open = true;
    await writeHot(h.hotDir, h.clock.value + 2 * SECOND);
    await writeHot(h.hotDir, h.clock.value + 3 * SECOND);
    h.clock.value += 3 * SECOND;
    await h.recorder.pollOnce();
    assert.ok(h.adopted.some((segment) => segment.reason === 'scheduled'));
    await h.recorder.stop();
  });

  it('flags a re-encoding profile as not direct-to-disk', async () => {
    const root = await tempRoot();
    const camera = makeCamera({ mode: 'continuous' });
    const recorder = new CameraRecorder({
      config: { ...makeConfig(root), streaming: { ...makeConfig(root).streaming } },
      camera: { ...camera, profiles: { record: 'live-sub' } },
      media: fakeHost(),
      now: () => Date.now(),
    });
    assert.equal(recorder.status().directToDisk, false);
  });

  it('removes stale hot files left by a previous crash', async () => {
    const root = await tempRoot();
    const h = harness(root, { mode: 'continuous' });
    await h.recorder.start();
    await h.recorder.stop();

    const orphan = await writeHot(h.hotDir, h.clock.value);
    h.clock.value += SECOND;
    await h.recorder.start();
    assert.equal(existsSync(orphan), false, 'unindexed leftovers are deleted on start');
    await h.recorder.stop();
  });
});
