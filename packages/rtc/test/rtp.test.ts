import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectH264Payload, parseRtpHeader, RtpContinuity } from '../src/rtp.ts';

/** Builds a minimal RTP packet: 12-byte header, no CSRCs, no extensions. */
function rtpPacket(options: {
  sequence: number;
  timestamp: number;
  ssrc?: number;
  payloadType?: number;
  marker?: boolean;
  payload?: number[];
}): Buffer {
  const payload = Buffer.from(options.payload ?? [0x41, 0x9a, 0x00, 0x01]);
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = ((options.marker === true ? 0x80 : 0x00) | (options.payloadType ?? 96)) & 0xff;
  packet.writeUInt16BE(options.sequence & 0xffff, 2);
  packet.writeUInt32BE(options.timestamp >>> 0, 4);
  packet.writeUInt32BE(options.ssrc ?? 0x11223344, 8);
  payload.copy(packet, 12);
  return packet;
}

describe('parseRtpHeader', () => {
  it('reads the fixed header fields', () => {
    const header = parseRtpHeader(rtpPacket({ sequence: 7, timestamp: 1234, marker: true, payloadType: 102 }));
    assert.ok(header !== undefined);
    assert.equal(header.version, 2);
    assert.equal(header.sequenceNumber, 7);
    assert.equal(header.timestamp, 1234);
    assert.equal(header.ssrc, 0x11223344);
    assert.equal(header.marker, true);
    assert.equal(header.payloadType, 102);
    assert.equal(header.payloadOffset, 12);
    assert.equal(header.payloadLength, 4);
  });

  it('skips CSRCs and header extensions', () => {
    const base = rtpPacket({ sequence: 1, timestamp: 1 });
    const packet = Buffer.alloc(12 + 4 + 8 + 4);
    base.copy(packet, 0);
    packet[0] = 0x80 | 0x10 | 0x01; // one CSRC, extension present
    // CSRC occupies 12..16, extension header 16..20 with two 32-bit words.
    packet.writeUInt16BE(0xbede, 16);
    packet.writeUInt16BE(2, 18);
    packet.writeUInt32BE(0, 24);
    const header = parseRtpHeader(packet);
    assert.ok(header !== undefined);
    assert.equal(header.extension, true);
    assert.equal(header.payloadOffset, 20 + 8);
    assert.equal(header.payloadLength, 0);
  });

  it('rejects non-RTP and truncated packets', () => {
    assert.equal(parseRtpHeader(Buffer.from([1, 2, 3])), undefined);
    const wrongVersion = rtpPacket({ sequence: 1, timestamp: 1 });
    wrongVersion[0] = 0x40;
    assert.equal(parseRtpHeader(wrongVersion), undefined);
    assert.equal(parseRtpHeader(Buffer.alloc(12)), undefined);
  });
});

describe('RtpContinuity', () => {
  it('keeps a clean stream in order and rewrites the header', () => {
    const continuity = new RtpContinuity({ ssrc: 0xdeadbeef, payloadType: 102, initialSequence: 100 });
    const first = continuity.rewrite(rtpPacket({ sequence: 50, timestamp: 50_000, marker: true, payloadType: 96 }));
    const second = continuity.rewrite(rtpPacket({ sequence: 51, timestamp: 53_000, payloadType: 96 }));
    assert.ok(first !== undefined && second !== undefined);

    const firstHeader = parseRtpHeader(first);
    const secondHeader = parseRtpHeader(second);
    assert.equal(firstHeader?.sequenceNumber, 100);
    assert.equal(secondHeader?.sequenceNumber, 101);
    assert.equal(firstHeader?.payloadType, 102);
    assert.equal(firstHeader?.ssrc, 0xdeadbeef);
    assert.equal(firstHeader?.marker, true);
    // The timestamp delta is preserved, not the absolute value.
    assert.equal((secondHeader?.timestamp ?? 0) - (firstHeader?.timestamp ?? 0), 3000);
    assert.equal(continuity.stats().discontinuities, 0);
  });

  it('survives a pipeline restart without going backwards', () => {
    const continuity = new RtpContinuity({ ssrc: 1, payloadType: 102, discontinuityStep: 3000 });
    const before = continuity.rewrite(rtpPacket({ sequence: 900, timestamp: 900_000 }));
    const restarted = continuity.rewrite(rtpPacket({ sequence: 0, timestamp: 0 }));
    assert.ok(before !== undefined && restarted !== undefined);
    const beforeHeader = parseRtpHeader(before);
    const restartedHeader = parseRtpHeader(restarted);
    assert.equal(restartedHeader?.sequenceNumber, ((beforeHeader?.sequenceNumber ?? 0) + 1) & 0xffff);
    assert.equal((restartedHeader?.timestamp ?? 0) - (beforeHeader?.timestamp ?? 0), 3000);
    assert.equal(continuity.stats().discontinuities, 1);

    // And the stream continues normally after the restart.
    const next = continuity.rewrite(rtpPacket({ sequence: 1, timestamp: 3000 }));
    assert.ok(next !== undefined);
    const nextHeader = parseRtpHeader(next);
    assert.equal(nextHeader?.sequenceNumber, ((restartedHeader?.sequenceNumber ?? 0) + 1) & 0xffff);
    assert.equal((nextHeader?.timestamp ?? 0) - (restartedHeader?.timestamp ?? 0), 3000);
  });

  it('drops duplicates and empty payloads', () => {
    const continuity = new RtpContinuity({ ssrc: 1, payloadType: 102 });
    assert.ok(continuity.rewrite(rtpPacket({ sequence: 5, timestamp: 1000 })) !== undefined);
    assert.equal(continuity.rewrite(rtpPacket({ sequence: 5, timestamp: 1000 })), undefined);
    assert.equal(continuity.rewrite(rtpPacket({ sequence: 6, timestamp: 2000, payload: [] })), undefined);
    assert.equal(continuity.stats().dropped, 2);
    assert.equal(continuity.stats().packets, 1);
  });

  it('drops a late packet instead of moving the output clock backwards', () => {
    const continuity = new RtpContinuity({ ssrc: 1, payloadType: 102 });
    continuity.rewrite(rtpPacket({ sequence: 10, timestamp: 10_000 }));
    const gap = continuity.rewrite(rtpPacket({ sequence: 12, timestamp: 12_000 }));
    const late = continuity.rewrite(rtpPacket({ sequence: 11, timestamp: 11_000 }));
    assert.ok(gap !== undefined);
    assert.equal(late, undefined);
    assert.equal(continuity.stats().discontinuities, 0);
    assert.equal(continuity.stats().dropped, 1);

    // The stream carries on from the highest packet seen.
    const next = continuity.rewrite(rtpPacket({ sequence: 13, timestamp: 13_000 }));
    assert.ok(next !== undefined);
    assert.ok((parseRtpHeader(next)?.timestamp ?? 0) > (parseRtpHeader(gap)?.timestamp ?? 0));
  });
});

describe('inspectH264Payload', () => {
  it('identifies a single IDR NAL', () => {
    const info = inspectH264Payload(Buffer.from([0x65, 0x88]));
    assert.deepEqual(info, { nalType: 5, packetization: 'single', keyframe: true, parameterSet: false });
  });

  it('identifies SPS and PPS inside a STAP-A', () => {
    const payload = Buffer.from([
      24,
      0x00, 0x03, 0x67, 0x42, 0x00, // SPS
      0x00, 0x02, 0x68, 0xce, // PPS
    ]);
    const info = inspectH264Payload(payload);
    assert.equal(info?.packetization, 'stap-a');
    assert.equal(info?.parameterSet, true);
    assert.equal(info?.keyframe, false);
  });

  it('resolves the real NAL type of a FU-A fragment', () => {
    const info = inspectH264Payload(Buffer.from([0x7c, 0x05, 0x00]));
    assert.equal(info?.nalType, 5);
    assert.equal(info?.packetization, 'fu-a');
    assert.equal(info?.keyframe, true);
  });

  it('rejects an empty payload', () => {
    assert.equal(inspectH264Payload(Buffer.alloc(0)), undefined);
  });
});
