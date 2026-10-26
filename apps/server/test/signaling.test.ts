import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CameraConfig } from '@icamify/core';
import { EMPTY_AUTH, testConfig } from './helpers.ts';
import {
  SignalingService,
  validateOfferSdp,
  type IceCandidateInit,
  type NegotiateInput,
  type WebRtcMediaEngine,
} from '../src/webrtc/signaling.ts';

const CAMERA: CameraConfig = {
  id: 'front-door',
  name: 'Front door',
  streams: { main: { type: 'file', path: './data/sample.mp4' } },
};

const VALID_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlZw',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendrecv',
  '',
].join('\r\n');

class FakeEngine implements WebRtcMediaEngine {
  readonly name = 'fake';
  available = true;
  reason: string | undefined;
  offers: NegotiateInput[] = [];
  candidates: Array<{ sessionId: string; candidate: IceCandidateInit }> = [];
  closed: string[] = [];

  async negotiate(input: NegotiateInput): Promise<{ answerSdp: string; sessionId?: string }> {
    this.offers.push(input);
    return { answerSdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', sessionId: 'engine-session' };
  }

  addIceCandidate(sessionId: string, candidate: IceCandidateInit): void {
    this.candidates.push({ sessionId, candidate });
  }

  closeSession(sessionId: string): void {
    this.closed.push(sessionId);
  }
}

describe('validateOfferSdp', () => {
  test('accepts a normal browser offer', () => {
    assert.equal(validateOfferSdp(VALID_OFFER), undefined);
  });

  test('explains each rejection', () => {
    assert.match(validateOfferSdp(42) ?? '', /SDP string/);
    assert.match(validateOfferSdp('') ?? '', /empty/);
    assert.match(validateOfferSdp('hello') ?? '', /v=0/);
    assert.match(validateOfferSdp('v=0\r\na=ice-ufrag:x\r\n') ?? '', /video/);
    assert.match(validateOfferSdp('v=0\r\nm=video 9 x\r\n') ?? '', /ICE credentials/);
    assert.match(validateOfferSdp(`${VALID_OFFER}${'a'.repeat(200_000)}`) ?? '', /exceeds/);
  });
});

describe('SignalingService', () => {
  test('reports WebRTC as unavailable with an actionable reason when no engine exists', async () => {
    const service = new SignalingService({ config: testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] }) });
    assert.equal(service.available, false);
    assert.match(service.reason ?? '', /No WebRTC media engine/);
    const result = await service.offer({ cameraId: 'front-door', sdp: VALID_OFFER, principal: { kind: 'user', username: 'a', role: 'admin' } });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : '', 'engine-unavailable');
    const capabilities = service.capabilities();
    assert.equal(capabilities.available, false);
    assert.ok(capabilities.iceServers.length > 0);
    assert.equal(capabilities.fallbackAfterMs, 4000);
  });

  test('brokers an offer through the engine and tracks the session', async () => {
    const engine = new FakeEngine();
    const service = new SignalingService({
      config: testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] }),
      engine,
    });
    assert.equal(service.available, true);
    const result = await service.offer({
      cameraId: 'front-door',
      sdp: VALID_OFFER,
      principal: { kind: 'user', username: 'op', role: 'operator' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.type, 'answer');
    assert.match(result.sdp, /^v=0/);
    assert.equal(engine.offers[0]?.camera.id, 'front-door');
    assert.equal(engine.offers[0]?.user.username, 'op');
    assert.ok((engine.offers[0]?.iceServers.length ?? 0) > 0);

    const candidate = service.addCandidate(result.sessionId, { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' });
    assert.equal(candidate.ok, true);
    assert.equal(engine.candidates[0]?.sessionId, 'engine-session');

    assert.equal(service.addCandidate('rtc_missing', { candidate: 'x' }).ok, false);

    service.close(result.sessionId);
    assert.deepEqual(engine.closed, ['engine-session']);
    assert.equal(service.sessions_().length, 0);
  });

  test('enforces the per-camera WebRTC viewer cap', async () => {
    const engine = new FakeEngine();
    const config = testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] });
    config.streaming.webrtc = { ...config.streaming.webrtc, maxViewersPerCamera: 1 };
    const service = new SignalingService({ config, engine });
    const principal = { kind: 'user' as const, username: 'op', role: 'operator' as const };
    assert.equal((await service.offer({ cameraId: 'front-door', sdp: VALID_OFFER, principal })).ok, true);
    const second = await service.offer({ cameraId: 'front-door', sdp: VALID_OFFER, principal });
    assert.equal(second.ok === false ? second.code : '', 'viewer-limit');
  });

  test('rejects unknown cameras, disabled cameras and anonymous offers', async () => {
    const engine = new FakeEngine();
    const config = testConfig({
      auth: EMPTY_AUTH,
      cameras: [CAMERA, { ...CAMERA, id: 'off', name: 'Off', enabled: false }],
    });
    const service = new SignalingService({ config, engine });
    const principal = { kind: 'user' as const, username: 'op', role: 'operator' as const };

    assert.equal((await service.offer({ cameraId: 'ghost', sdp: VALID_OFFER, principal })).ok, false);
    const disabled = await service.offer({ cameraId: 'off', sdp: VALID_OFFER, principal });
    assert.equal(disabled.ok === false ? disabled.code : '', 'camera-disabled');
    const anonymous = await service.offer({ cameraId: 'front-door', sdp: VALID_OFFER });
    assert.equal(anonymous.ok === false ? anonymous.code : '', 'forbidden');
  });

  test('surfaces an engine negotiation failure instead of throwing', async () => {
    const engine: WebRtcMediaEngine = {
      name: 'broken',
      available: true,
      negotiate: async () => {
        throw new Error('ICE gathering timed out');
      },
    };
    const service = new SignalingService({ config: testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] }), engine });
    const result = await service.offer({
      cameraId: 'front-door',
      sdp: VALID_OFFER,
      principal: { kind: 'user', username: 'op', role: 'operator' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : '', 'negotiation-failed');
    assert.match(result.ok === false ? result.message : '', /ICE gathering timed out/);
  });

  test('expires abandoned sessions', async () => {
    let now = 1_000_000;
    const engine = new FakeEngine();
    const service = new SignalingService({ config: testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] }), engine, now: () => now });
    const result = await service.offer({
      cameraId: 'front-door',
      sdp: VALID_OFFER,
      principal: { kind: 'user', username: 'op', role: 'operator' },
    });
    assert.equal(result.ok, true);
    now += 121_000;
    assert.equal(service.sessions_().length, 0);
    assert.deepEqual(engine.closed, ['engine-session']);
  });
});
