import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CameraConfig } from '@icamify/core';
import { OnvifService } from '../src/onvif/service.ts';
import { EMPTY_AUTH, request, testConfig, withServer } from './helpers.ts';

/**
 * The ONVIF service decides which endpoint a camera has and owns patrol state.
 * Its SOAP transport is covered in the package tests; here the fake client keeps
 * the tests about resolution, pause/preset semantics and the HTTP contract.
 */

interface ClientCall {
  operation: string;
  args: unknown[];
}

function fakeClient(calls: ClientCall[]) {
  return {
    host: '127.0.0.1',
    async deviceInfo() {
      return { manufacturer: 'Acme', model: 'IPC-9000' };
    },
    async mediaProfiles() {
      return [{ token: 'profile_0', name: 'main' }];
    },
    async streamUri() {
      return 'rtsp://admin:secret@127.0.0.1:554/stream1';
    },
    async snapshotUri() {
      return 'http://127.0.0.1/snapshot.jpg?token=abc';
    },
    async presets() {
      calls.push({ operation: 'presets', args: [] });
      return [
        { name: 'gate', token: '2' },
        { name: 'drive', token: '3' },
      ];
    },
    async presetNames() {
      return ['gate', 'drive'];
    },
    async gotoPreset(name: string) {
      calls.push({ operation: 'gotoPreset', args: [name] });
    },
    async gotoPresetToken(token: string) {
      calls.push({ operation: 'gotoPresetToken', args: [token] });
    },
    async continuousMove(vector: unknown, durationMs: number) {
      calls.push({ operation: 'continuousMove', args: [vector, durationMs] });
    },
    async absoluteMove(vector: unknown) {
      calls.push({ operation: 'absoluteMove', args: [vector] });
    },
    async stop() {
      calls.push({ operation: 'stop', args: [] });
    },
    async status() {
      return { pan: 0, tilt: 0, zoom: 0 };
    },
  };
}

function ptzCamera(overrides: Partial<CameraConfig> = {}): CameraConfig {
  return {
    id: 'front-door',
    name: 'Front door',
    streams: { main: { type: 'file', path: './data/sample.mp4' } },
    ptz: {
      host: '127.0.0.1',
      presets: [
        { name: 'porch', pan: 0.5, tilt: -0.2 },
        { name: 'gate', token: '2' },
        { name: 'parking' },
      ],
      patrol: { enabled: true, presets: ['porch', 'gate'], dwellSeconds: 5 },
    },
    ...overrides,
  };
}

function service(cameras: CameraConfig[], calls: ClientCall[] = [], overrides: Record<string, unknown> = {}) {
  const config = testConfig({ cameras });
  config.onvif = { discovery: { enabled: false }, defaults: { timeoutMs: 1000 } };
  return new OnvifService({
    config,
    log: () => {},
    clientFactory: () => fakeClient(calls) as never,
    ...overrides,
  });
}

describe('OnvifService endpoint resolution', () => {
  test('uses ptz.host, an ONVIF source, or the RTSP host, and nothing else', async () => {
    const onvif = service([
      ptzCamera({ id: 'explicit' }),
      {
        id: 'onvif',
        name: 'ONVIF camera',
        streams: { main: { type: 'onvif', host: '10.0.0.20', port: 8000, profileToken: 'main' } },
      },
      {
        id: 'rtsp',
        name: 'RTSP camera',
        streams: { main: { type: 'rtsp', url: 'rtsp://admin:pw@10.0.0.30:554/stream' } },
      },
      { id: 'file', name: 'File', streams: { main: { type: 'file', path: './clip.mp4' } } },
    ]);
    await onvif.start();

    const explicit = onvif.status('explicit');
    assert.equal(explicit.supported, true);
    assert.equal(explicit.endpoint, 'http://127.0.0.1:80/onvif/device_service');
    assert.deepEqual(
      explicit.presets.map((preset) => [preset.name, preset.source, preset.token]),
      [
        ['porch', 'config', undefined],
        ['gate', 'config', '2'],
        ['parking', 'config', undefined],
      ],
    );
    assert.deepEqual(explicit.patrol.presets, ['porch', 'gate']);
    assert.equal(explicit.patrol.enabled, true);
    assert.equal(explicit.patrol.running, true, 'patrol starts with the service');
    await onvif.shutdown();
  });

  test('an ONVIF source with a port keeps its port; RTSP implies port 80', () => {
    const onvif = service([
      { id: 'o', name: 'O', streams: { main: { type: 'onvif', host: '10.0.0.20', port: 8000 } } },
      { id: 'r', name: 'R', streams: { main: { type: 'rtsp', url: 'rtsp://10.0.0.30:554/live' } } },
      { id: 'f', name: 'F', streams: { main: { type: 'file', path: './clip.mp4' } } },
    ]);
    assert.equal(onvif.status('o').endpoint, 'http://10.0.0.20:8000/onvif/device_service');
    assert.equal(onvif.status('r').endpoint, 'http://10.0.0.30:80/onvif/device_service');
    const unsupported = onvif.status('f');
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.reachable, false);
    assert.match(unsupported.reason ?? '', /no ONVIF endpoint/);
  });

  test('ptz.enabled = false wins over every other source of an endpoint', () => {
    const camera = ptzCamera({ ptz: { host: '127.0.0.1', enabled: false } });
    const onvif = service([camera]);
    assert.equal(onvif.canControl(camera), false);
    assert.equal(onvif.status('front-door').supported, false);
    assert.deepEqual(onvif.controlledCameraIds(), []);
  });
});

describe('OnvifService control', () => {
  test('visits a preset by its configured token, by position, or by device name', async () => {
    const calls: ClientCall[] = [];
    const onvif = service([ptzCamera()], calls);

    await onvif.gotoPreset('front-door', 'gate');
    assert.deepEqual(calls.at(-1), { operation: 'gotoPresetToken', args: ['2'] });

    await onvif.gotoPreset('front-door', 'porch');
    assert.deepEqual(calls.at(-1), { operation: 'absoluteMove', args: [{ pan: 0.5, tilt: -0.2 }] });

    // No token and no position: the name is resolved against the device itself.
    await onvif.gotoPreset('front-door', 'parking');
    assert.deepEqual(calls.at(-1), { operation: 'gotoPreset', args: ['parking'] });

    await onvif.shutdown();
  });

  test('a manual move pauses the patrol and stop() is forwarded', async () => {
    const calls: ClientCall[] = [];
    const onvif = service([ptzCamera()], calls);
    await onvif.start();

    await onvif.move('front-door', { pan: 1, tilt: 0 }, 500);
    assert.deepEqual(
      calls.find((call) => call.operation === 'continuousMove'),
      { operation: 'continuousMove', args: [{ pan: 1, tilt: 0 }, 500] },
    );
    const status = onvif.status('front-door');
    assert.equal(status.reachable, true);
    assert.notEqual(status.patrol.pausedUntil, undefined);

    await onvif.stop('front-door');
    assert.deepEqual(calls.at(-1), { operation: 'stop', args: [] });
    await onvif.shutdown();
  });

  test('patrol can be switched off and on at runtime without changing the config', async () => {
    const onvif = service([ptzCamera()]);
    await onvif.start();
    assert.equal(onvif.status('front-door').patrol.running, true);

    const off = await onvif.setPatrol('front-door', false);
    assert.equal(off.patrol.enabled, false);
    assert.equal(off.patrol.running, false);

    const on = await onvif.setPatrol('front-door', true);
    assert.equal(on.patrol.enabled, true);
    assert.equal(on.patrol.running, true);
    await onvif.shutdown();
  });

  test('a camera without a patrol cannot be told to tour', async () => {
    const onvif = service([
      { id: 'plain', name: 'Plain', streams: { main: { type: 'onvif', host: '10.0.0.9' } } },
    ]);
    await assert.rejects(() => onvif.setPatrol('plain', true), /no PTZ patrol configured/);
    await onvif.shutdown();
  });

  test('device presets are merged into the status without duplicates', async () => {
    const onvif = service([ptzCamera()]);
    const status = await onvif.refresh('front-door');
    assert.deepEqual(
      status.presets.map((preset) => [preset.name, preset.source]),
      [
        ['porch', 'config'],
        ['gate', 'config'],
        ['parking', 'config'],
        ['drive', 'device'],
      ],
    );
    assert.equal(status.reachable, true);
    assert.equal(status.profileToken, 'profile_0');
    await onvif.shutdown();
  });

  test('describe strips credentials and tokens from advertised URIs', async () => {
    const onvif = service([]);
    const described = await onvif.describe({ host: '127.0.0.1' });
    assert.equal(described.device.model, 'IPC-9000');
    assert.equal(described.streamUri, 'rtsp://***:***@127.0.0.1:554/stream1');
    assert.equal(described.snapshotUri, 'http://127.0.0.1/snapshot.jpg?token=***');
    assert.deepEqual(described.presets, [
      { name: 'gate', token: '2' },
      { name: 'drive', token: '3' },
    ]);
  });
});

describe('ONVIF HTTP API', () => {
  test('reports status, refuses moves for cameras without an endpoint', async () => {
    const offline: CameraConfig = {
      id: 'offline',
      name: 'Offline',
      streams: { main: { type: 'file', path: './clip.mp4' } },
      ptz: { host: '127.0.0.1', port: 1 },
    };
    const config = testConfig({ auth: EMPTY_AUTH, cameras: [ptzCamera(), offline] });
    config.onvif = { discovery: { enabled: false }, defaults: { timeoutMs: 1000 } };
    await withServer(config, async (server) => {
      const status = await request(server, '/api/cameras/front-door/ptz');
      assert.equal(status.status, 200);
      const body = status.json as { supported: boolean; endpoint: string; presets: unknown[] };
      assert.equal(body.supported, true);
      assert.equal(body.endpoint, 'http://127.0.0.1:80/onvif/device_service');
      assert.equal(Array.isArray(body.presets), true);

      const unknown = await request(server, '/api/cameras/nope/ptz');
      assert.equal(unknown.status, 404);

      // Nothing is listening on port 1: the camera is unreachable, not the API.
      const move = await request(server, '/api/cameras/offline/ptz/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pan: 1 }),
      });
      assert.equal(move.status, 502);
      assert.equal((move.json as { error: { code: string } }).error.code, 'ptz-unreachable');
    });
  });

  test('validates scan, describe and patrol payloads', async () => {
    const config = testConfig({ auth: EMPTY_AUTH, cameras: [ptzCamera()] });
    config.onvif = { discovery: { enabled: false } };
    await withServer(config, async (server) => {
      const scan = await request(server, '/api/onvif/scan', { method: 'POST' });
      assert.equal(scan.status, 200);
      const scanned = scan.json as { devices: unknown[]; warnings: string[] };
      assert.deepEqual(scanned.devices, []);
      assert.match(scanned.warnings[0] ?? '', /disabled/);

      const badHost = await request(server, '/api/onvif/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: 'http://evil.example/path' }),
      });
      assert.equal(badHost.status, 400);

      const badPredicate = await request(server, '/api/cameras/front-door/ptz/patrol', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      assert.equal(badPredicate.status, 400);

      const emptyMove = await request(server, '/api/cameras/front-door/ptz/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(emptyMove.status, 400);

      const info = await request(server, '/api/onvif');
      assert.equal(info.status, 200);
      const payload = info.json as { defaults: { hasCredentials: boolean }; discovery: { enabled: boolean } };
      assert.equal(payload.discovery.enabled, false);
      assert.equal(payload.defaults.hasCredentials, false);
    });
  });
});
