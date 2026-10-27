import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerCodecFor, describeUnsupportedOffer, parseMediaSections, selectH264 } from '../src/sdp.ts';

/** A Chrome-style offer: VP8/H264 with two H.264 profiles and mode 1 first. */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlZw',
  'a=fingerprint:sha-256 4B:2C:5B:0D:6A:2B:0F:4D:0A:5F:0B:3D:0C:4B:5A:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:0A:1B:2C:3D:4E:5F',
  'a=setup:actpass',
  'a=mid:0',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtcp-fb:102 nack pli',
  'a=rtpmap:103 H264/90000',
  'a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
  '',
].join('\r\n');

describe('parseMediaSections', () => {
  it('reads the video section, direction and codecs', () => {
    const sections = parseMediaSections(CHROME_OFFER);
    assert.equal(sections.length, 1);
    const video = sections[0];
    assert.ok(video !== undefined);
    assert.equal(video.kind, 'video');
    assert.equal(video.mid, '0');
    assert.equal(video.direction, 'recvonly');
    assert.equal(video.setup, 'actpass');
    assert.equal(video.iceUfrag, '4ZcD');
    assert.deepEqual(
      video.codecs.map((codec) => `${codec.payloadType}:${codec.encoding}`),
      ['96:VP8', '97:RTX', '102:H264', '103:H264'],
    );
    const h264 = video.codecs.find((codec) => codec.payloadType === 102);
    assert.equal(h264?.fmtp['profile-level-id'], '42e01f');
    assert.equal(h264?.fmtp['level-asymmetry-allowed'], '1');
  });

  it('handles CRLF and LF equally', () => {
    const lf = CHROME_OFFER.replace(/\r\n/g, '\n');
    assert.deepEqual(parseMediaSections(lf), parseMediaSections(CHROME_OFFER));
  });
});

describe('selectH264', () => {
  it('prefers packetization mode 1 and constrained baseline', () => {
    const video = parseMediaSections(CHROME_OFFER)[0];
    assert.ok(video !== undefined);
    const selection = selectH264(video);
    assert.equal(selection?.codec.payloadType, 102);
    assert.equal(selection?.fuA, true);
    assert.equal(selection?.profileLevelId, '42e01f');
  });

  it('returns undefined when only VP8 is offered', () => {
    const offer = CHROME_OFFER.replace(/a=rtpmap:(102|103) H264.*\r\n/g, '').replace(
      /a=fmtp:(102|103).*\r\n/g,
      '',
    );
    const video = parseMediaSections(offer)[0];
    assert.ok(video !== undefined);
    assert.equal(selectH264(video), undefined);
    assert.match(describeUnsupportedOffer(parseMediaSections(offer)), /H\.264/);
    assert.match(describeUnsupportedOffer(parseMediaSections(offer)), /VP8/);
  });

  it('answers with the browser payload type and its own fmtp values', () => {
    const video = parseMediaSections(CHROME_OFFER)[0];
    assert.ok(video !== undefined);
    const selection = selectH264(video);
    assert.ok(selection !== undefined);
    const codec = answerCodecFor(selection);
    assert.equal(codec.payloadType, 102);
    assert.equal(codec.mimeType, 'video/H264');
    assert.equal(codec.clockRate, 90_000);
    // Echoed verbatim, in the offer's own order: browsers compare these values.
    assert.equal(codec.parameters, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
    assert.deepEqual(codec.fmtp, {
      'level-asymmetry-allowed': '1',
      'packetization-mode': '1',
      'profile-level-id': '42e01f',
    });
  });
});
