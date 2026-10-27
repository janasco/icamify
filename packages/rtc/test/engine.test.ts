import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RTCPeerConnection, RTCRtpCodecParameters, type RtpPacket } from 'werift';
import type { CameraConfig } from '@icamify/core';
import { createWebRtcEngine, type RtpSource, type RtpSourceHandlers } from '../src/engine.ts';

/**
 * These tests connect a real werift peer to the engine over loopback. That is the
 * whole point: SDP bookkeeping and RTP bookkeeping can be unit-tested, but "does a
 * browser-shaped peer actually receive video" cannot be faked without re-testing
 * the fake.
 */

const camera: CameraConfig = {
  id: 'cam1',
  name: 'Camera 1',
  streams: { main: { type: 'file', path: './data/sample.mp4' } },
};

const codec = new RTCRtpCodecParameters({
  mimeType: 'video/H264',
  clockRate: 90_000,
  payloadType: 102,
  parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
});

/** Emits synthetic H.264 RTP packets, one every 10 ms, starting with an IDR. */
class FakeRtpSource implements RtpSource {
  readonly argv = ['ffmpeg', '-f', 'rtp', 'rtp://127.0.0.1:0'];
  started = 0;
  stopped = 0;
  private timer: NodeJS.Timeout | undefined;
  private sequence = 100;
  private timestamp = 0;

  start(handlers: RtpSourceHandlers): void {
    this.started += 1;
    this.timer = setInterval(() => {
      handlers.onPacket(this.packet());
    }, 10);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private packet(): Buffer {
    const payload = Buffer.from([0x65, 0x88, 0x84, 0x00]); // IDR slice
    const buffer = Buffer.alloc(12 + payload.length);
    buffer[0] = 0x80;
    buffer[1] = 96;
    buffer.writeUInt16BE(this.sequence & 0xffff, 2);
    buffer.writeUInt32BE(this.timestamp >>> 0, 4);
    buffer.writeUInt32BE(0x01020304, 8);
    payload.copy(buffer, 12);
    this.sequence += 1;
    this.timestamp += (90_000 / 25) | 0;
    return buffer;
  }
}

async function negotiateWithClient(
  engine: Awaited<ReturnType<typeof createWebRtcEngine>>,
): Promise<{ client: RTCPeerConnection; packets: RtpPacket[] }> {
  const client = new RTCPeerConnection({ codecs: { video: [codec] } });
  const received: RtpPacket[] = [];
  const trackArrived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the client never received a video track')), 15_000);
    client.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => {
        received.push(packet);
        if (received.length === 1) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  });

  client.addTransceiver('video', { direction: 'recvonly' });
  const offer = await client.createOffer();
  await client.setLocalDescription(offer);

  const result = await engine.negotiate({
    camera,
    offerSdp: offer.sdp,
    iceServers: [],
    user: { username: 'operator', role: 'admin' },
  });
  assert.match(result.answerSdp, /a=rtpmap:102 H264\/90000/);

  await client.setRemoteDescription({ type: 'answer', sdp: result.answerSdp });
  await trackArrived;
  return { client, packets: received };
}

describe('createWebRtcEngine', () => {
  it('reports itself unavailable, with a reason, when werift is not installed', async () => {
    const engine = await createWebRtcEngine({
      createSource: () => new FakeRtpSource(),
      loadWerift: async () => undefined,
    });
    assert.equal(engine.available, false);
    assert.match(engine.reason ?? '', /werift/);
    assert.deepEqual(engine.stats(), { sessions: [], sources: [] });
    await assert.rejects(
      engine.negotiate({ camera, offerSdp: 'v=0\r\n', iceServers: [], user: { username: 'x', role: 'admin' } }),
    );
  });

  it('carries RTP to a real peer connection and shares one source per camera', async () => {
    const source = new FakeRtpSource();
    let created = 0;
    const engine = await createWebRtcEngine({
      createSource: () => {
        created += 1;
        return source;
      },
      iceServers: [],
      sourceIdleMs: 1000,
      gatherTimeoutMs: 2000,
    });
    assert.equal(engine.available, true);

    const first = await negotiateWithClient(engine);
    const second = await negotiateWithClient(engine);
    await waitFor(() => first.packets.length >= 5 && second.packets.length >= 5);

    // One FFmpeg pipeline, two viewers: the central performance rule.
    assert.equal(created, 1);
    assert.equal(source.started, 1);

    const stats = engine.stats();
    assert.equal(stats.sessions.length, 2);
    assert.deepEqual(
      stats.sessions.map((session) => session.cameraId),
      ['cam1', 'cam1'],
    );
    for (const session of stats.sessions) {
      assert.ok(session.packets > 0, 'the engine should count forwarded packets');
      assert.equal(session.keyframeSeen, true, 'IDR detection should mark the keyframe');
      assert.equal(session.user, 'operator');
    }
    assert.equal(stats.sources.length, 1);
    assert.equal(stats.sources[0]?.viewers, 2);
    assert.ok((stats.sources[0]?.packets ?? 0) > 0);
    assert.deepEqual(stats.sources[0]?.argv, source.argv);

    // The rewritten stream must be one the client can decode: the payload type is
    // the negotiated one and the sequence numbers never jump backwards.
    const sequences = first.packets.map((packet) => packet.header.sequenceNumber);
    for (let index = 1; index < sequences.length; index += 1) {
      const delta = ((sequences[index] as number) - (sequences[index - 1] as number) + 0x10000) & 0xffff;
      assert.ok(delta > 0 && delta < 0x8000, `sequence numbers must increase (index ${index})`);
    }
    assert.equal(first.packets[0]?.header.payloadType, 102);

    await first.client.close();
    await second.client.close();
    await engine.shutdown();
    assert.equal(engine.stats().sessions.length, 0);
    assert.equal(source.stopped, 1);
  });

  it('rejects an offer without H.264 before starting a pipeline', async () => {
    const source = new FakeRtpSource();
    let created = 0;
    const engine = await createWebRtcEngine({
      createSource: () => {
        created += 1;
        return source;
      },
      iceServers: [],
    });
    const vp8Offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=ice-ufrag:abcd',
      'a=setup:actpass',
      'a=recvonly',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');
    await assert.rejects(
      engine.negotiate({ camera, offerSdp: vp8Offer, iceServers: [], user: { username: 'x', role: 'admin' } }),
      /H\.264/,
    );
    assert.equal(created, 0);
    await engine.shutdown();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for RTP packets');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
