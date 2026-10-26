import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CameraConfig, ResolvedIcamifyConfig, StreamProfile } from '@icamify/core';
import {
  MediaError,
  buildPipelinePlan,
  defaultOutputTemplate,
  resolveProfileForPurpose,
  selectSource,
} from '../src/index.ts';

const RECORD_COPY: StreamProfile = { copy: true, video: { codec: 'copy' }, container: 'mkv' };
const LIVE_H264: StreamProfile = {
  video: { codec: 'h264', width: 1280, height: 720, fps: 25, bitrateKbps: 1500 },
  audio: { codec: 'aac' },
  container: 'fmp4',
};

const CAMERA: CameraConfig = {
  id: 'front-door',
  name: 'Front door',
  streams: {
    main: { type: 'rtsp', url: 'rtsp://10.0.0.10/main' },
    sub: { type: 'rtsp', url: 'rtsp://10.0.0.10/sub' },
  },
  profiles: { record: 'record-copy', live: 'live-h264', detect: 'live-h264' },
  motion: { intervalMs: 500 },
};

function makeConfig(overrides: Partial<ResolvedIcamifyConfig> = {}): ResolvedIcamifyConfig {
  const base = {
    version: '1.0',
    system: {},
    auth: {},
    storage: { rootDir: './data', recordingsDir: 'recordings', format: 'mkv', segmentMinutes: 60 },
    streaming: {
      profiles: { 'record-copy': RECORD_COPY, 'live-h264': LIVE_H264 },
      defaults: { record: 'record-copy', live: 'live-h264', detect: 'live-h264' },
    },
    motion: {},
    cameras: [CAMERA],
    groups: [],
    layouts: [],
    schedules: [],
    rules: [],
    notifications: {},
    ai: {},
    onvif: {},
    plugins: {},
    ...overrides,
  };
  return base as unknown as ResolvedIcamifyConfig;
}

describe('profile resolution', () => {
  test('camera profile wins over the global default', () => {
    const config = makeConfig();
    const camera: CameraConfig = { ...CAMERA, profiles: { record: 'record-copy' } };
    assert.equal(resolveProfileForPurpose(config, camera, 'live').name, 'live-h264');
  });

  test('a camera with no profile and no default is an actionable error', () => {
    const config = makeConfig();
    config.streaming.defaults = {};
    const camera: CameraConfig = { ...CAMERA, profiles: {} };
    assert.throws(
      () => resolveProfileForPurpose(config, camera, 'detect'),
      (error: unknown) =>
        error instanceof MediaError &&
        error.code === 'invalid-argument' &&
        /streaming\.defaults\.detect/.test(error.detail ?? ''),
    );
  });

  test('a dangling profile reference lists what is defined', () => {
    const config = makeConfig();
    const camera: CameraConfig = { ...CAMERA, profiles: { record: 'nope' } };
    assert.throws(
      () => resolveProfileForPurpose(config, camera, 'record'),
      (error: unknown) => error instanceof MediaError && /record-copy, live-h264/.test(error.detail ?? ''),
    );
  });
});

describe('dual-stream selection', () => {
  test('recording reads the main stream, live and detect read the sub stream', () => {
    assert.deepEqual(selectSource(CAMERA, 'record'), CAMERA.streams.main);
    assert.deepEqual(selectSource(CAMERA, 'live'), CAMERA.streams.sub);
    assert.deepEqual(selectSource(CAMERA, 'detect'), CAMERA.streams.sub);
  });

  test('cameras without a sub stream fall back to the main stream', () => {
    const camera: CameraConfig = { ...CAMERA, streams: { main: CAMERA.streams.main } };
    assert.deepEqual(selectSource(camera, 'live'), CAMERA.streams.main);
  });
});

describe('pipeline plans', () => {
  test('recording is a copy remux into the storage layout', () => {
    const plan = buildPipelinePlan(makeConfig(), CAMERA, 'record');
    assert.equal(plan.profileName, 'record-copy');
    assert.equal(plan.sourceType, 'rtsp');
    const encoder = plan.args[plan.args.indexOf('-c:v') + 1];
    assert.equal(encoder, 'copy');
    assert.ok(plan.args.includes('segment'));
    const output = plan.args.at(-1) ?? '';
    assert.match(output, /^data\/recordings\/front-door\/%Y%m%d-%H%M%S\.mkv$/);
    assert.deepEqual(plan.warnings, []);
  });

  test('a re-encoding record profile is called out', () => {
    const config = makeConfig();
    const camera: CameraConfig = { ...CAMERA, profiles: { record: 'live-h264' } };
    const plan = buildPipelinePlan(config, camera, 'record');
    assert.match(plan.warnings.join('\n'), /requires a copy profile/);
    assert.equal(plan.args[plan.args.indexOf('-c:v') + 1], 'libx264');
  });

  test('live view uses the sub-stream and fragments MP4', () => {
    const plan = buildPipelinePlan(makeConfig(), CAMERA, 'live');
    assert.equal(plan.args.at(-1), 'pipe:1');
    assert.ok(plan.args.includes('rtsp://10.0.0.10/sub'), `expected sub stream, got ${plan.args.join(' ')}`);
    assert.equal(plan.args[plan.args.indexOf('-f') + 1], 'mp4');
  });

  test('motion analysis rate follows the configured interval', () => {
    const plan = buildPipelinePlan(makeConfig(), CAMERA, 'detect');
    const filter = plan.args[plan.args.indexOf('-vf') + 1] ?? '';
    assert.match(filter, /^fps=2,/);
    assert.match(filter, /scale=320:240/);
    assert.ok(plan.args.includes('rawvideo'));
  });

  test('global motion cadence applies when the camera does not override it', () => {
    const config = makeConfig({ motion: { intervalMs: 200 } });
    const camera: CameraConfig = { ...CAMERA, motion: { enabled: true } };
    const plan = buildPipelinePlan(config, camera, 'detect');
    assert.match(plan.args[plan.args.indexOf('-vf') + 1] ?? '', /^fps=5,/);
  });

  test('detect frame geometry can be overridden per call', () => {
    const plan = buildPipelinePlan(makeConfig(), CAMERA, 'detect', { detect: { width: 640, height: 360, fps: 8 } });
    assert.match(plan.args[plan.args.indexOf('-vf') + 1] ?? '', /^fps=8,scale=640:360/);
  });
});

describe('output template', () => {
  test('a camera-assigned volume wins over the recordings directory', () => {
    const config = makeConfig({
      storage: {
        rootDir: './data',
        recordingsDir: 'recordings',
        format: 'mkv',
        volumes: [
          { id: 'bulk', path: 'archive', priority: 50, cameraIds: ['front-door'] },
          { id: 'fast', path: 'fast', priority: 10, cameraIds: ['front-door'] },
        ],
      },
    });
    assert.equal(
      defaultOutputTemplate(config, CAMERA, { video: { codec: 'copy' }, container: 'mkv' }),
      'data/fast/front-door/%Y%m%d-%H%M%S.mkv',
    );
  });

  test('relative directories are resolved against rootDir', () => {
    const config = makeConfig({ storage: { rootDir: '/srv/nvr', recordingsDir: 'rec', format: 'mkv' } });
    assert.equal(
      defaultOutputTemplate(config, CAMERA, { video: { codec: 'copy' }, container: 'mkv' }),
      '/srv/nvr/rec/front-door/%Y%m%d-%H%M%S.mkv',
    );
  });

  test('uses the configured container and absolute directory', () => {
    const config = makeConfig({ storage: { recordingsDir: '/mnt/nvr/', format: 'mkv' } });
    assert.equal(
      defaultOutputTemplate(config, CAMERA, { video: { codec: 'copy' }, container: 'mp4' }),
      '/mnt/nvr/front-door/%Y%m%d-%H%M%S.mp4',
    );
  });

  test('mpegts segments use a .ts extension', () => {
    const config = makeConfig({ storage: { recordingsDir: '/mnt/nvr', format: 'mkv' } });
    assert.match(
      defaultOutputTemplate(config, CAMERA, { video: { codec: 'copy' }, container: 'mpegts' }),
      /\.ts$/,
    );
  });
});
