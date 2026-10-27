import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NAMESPACES,
  absoluteMoveRequest,
  continuousMoveRequest,
  escapeXml,
  findAll,
  isoDuration,
  parseXml,
  passwordDigest,
  soapEnvelope,
  soapFaultReason,
  textOf,
  wsSecurityHeader,
} from '../src/index.ts';

describe('XML reader', () => {
  it('reads nested elements regardless of namespace prefix', () => {
    const document = parseXml(
      '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="x"><SOAP-ENV:Body>' +
        '<trt:GetProfilesResponse><trt:Profiles token="p1"><trt:Name>main&amp;sub</trt:Name>' +
        '<trt:Resolution><trt:Width>1920</trt:Width></trt:Resolution></trt:Profiles>' +
        '</trt:GetProfilesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>',
    );
    const profiles = findAll(document, 'Profiles');
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.attributes.token, 'p1');
    assert.equal(textOf(profiles[0], 'Name'), 'main&sub');
    assert.equal(textOf(profiles[0], 'Width'), '1920');
  });

  it('handles self-closing tags, CDATA, comments and entities', () => {
    const document = parseXml(
      '<r><empty/><!-- note --><v><![CDATA[a < b]]></v><n>&#65;&#x42;</n><t>  spaced\n out </t></r>',
    );
    assert.equal(findAll(document, 'empty').length, 1);
    assert.equal(textOf(document, 'v'), 'a < b');
    assert.equal(textOf(document, 'n'), 'AB');
    assert.equal(textOf(document, 't'), 'spaced out');
  });

  it('decodes attributes and escapes text', () => {
    const document = parseXml('<r><e token="1" name="Front &quot;Door&quot;"/></r>');
    const element = findAll(document, 'e')[0];
    assert.equal(element?.attributes.name, 'Front "Door"');
    assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });

  it('survives malformed input without throwing', () => {
    assert.doesNotThrow(() => parseXml('<a><b></a><<<>'));
    assert.equal(findAll(parseXml('not xml at all'), 'a').length, 0);
  });
});

describe('SOAP envelopes', () => {
  it('wraps a body in a SOAP 1.2 envelope with the ONVIF namespaces', () => {
    const envelope = soapEnvelope('<tds:GetDeviceInformation/>');
    assert.match(envelope, /^<\?xml version="1.0"/);
    assert.match(envelope, new RegExp(`xmlns:s="${NAMESPACES.soap}"`));
    assert.match(envelope, new RegExp(`xmlns:tds="${NAMESPACES.device}"`));
    assert.match(envelope, /<s:Body><tds:GetDeviceInformation\/><\/s:Body>/);
    assert.equal(envelope.includes('<s:Header>'), false);
  });

  it('computes the WS-Security digest from nonce, created and password', () => {
    const digest = passwordDigest('bm9uY2U=', '2026-01-01T00:00:00.000Z', 'secret');
    assert.equal(digest, passwordDigest('bm9uY2U=', '2026-01-01T00:00:00.000Z', 'secret'));
    assert.notEqual(digest, passwordDigest('bm9uY2U=', '2026-01-01T00:00:01.000Z', 'secret'));
    const header = wsSecurityHeader({
      username: 'admin',
      password: 'secret',
      nonce: 'bm9uY2U=',
      created: '2026-01-01T00:00:00.000Z',
    });
    assert.match(header, /<wsse:Username>admin<\/wsse:Username>/);
    assert.match(header, new RegExp(`>${digest.replace(/[+/=]/g, (character) => `\\${character}`)}<`));
    assert.match(header, /PasswordDigest/);
    // The plain password must never appear in the token.
    assert.equal(header.includes('>secret<'), false);
  });

  it('builds PTZ requests with clamped vectors', () => {
    const move = continuousMoveRequest('p1', { pan: 2, tilt: -2, zoom: 0.5 }, 4500);
    assert.match(move, /<tptz:ProfileToken>p1<\/tptz:ProfileToken>/);
    assert.match(move, /<tt:PanTilt x="1" y="-1"\/>/);
    assert.match(move, /<tt:Zoom x="0.5"\/>/);
    assert.match(move, /<tptz:Timeout>PT5S<\/tptz:Timeout>/);
    assert.equal(isoDuration(1), 'PT1S');
    assert.equal(isoDuration(120_000), 'PT120S');

    const absolute = absoluteMoveRequest('p1', { pan: 0.25, tilt: -0.5, zoom: 0 });
    assert.match(absolute, /<tt:PanTilt x="0.25" y="-0.5"\/>/);
  });

  it('extracts a SOAP fault reason', () => {
    const xml =
      '<s:Envelope xmlns:s="x"><s:Body><s:Fault><s:Reason><s:Text xml:lang="en">No such profile</s:Text>' +
      '</s:Reason></s:Fault></s:Body></s:Envelope>';
    assert.equal(soapFaultReason(xml), 'No such profile');
    assert.equal(soapFaultReason('<ok/>'), undefined);
  });
});
