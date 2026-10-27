import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProbeMessage,
  discoverDevices,
  parseProbeMatches,
  parseScopes,
  type DiscoveryTransport,
} from '../src/index.ts';

const MATCH = (urn: string, xaddr: string, scopes: string, name: string): string =>
  `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">` +
  `<s:Body><d:ProbeMatches><d:ProbeMatch>` +
  `<d:EndpointReference><w:Address xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing">${urn}</w:Address></d:EndpointReference>` +
  `<d:Types>dn:NetworkVideoTransmitter</d:Types>` +
  `<d:Scopes>${scopes}</d:Scopes>` +
  `<d:XAddrs>${xaddr}</d:XAddrs>` +
  `<d:MetadataVersion>1</d:MetadataVersion>` +
  `</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;

describe('WS-Discovery messages', () => {
  it('probes for network video transmitters', () => {
    const probe = buildProbeMessage('uuid:test');
    assert.match(probe, /<w:MessageID>uuid:test<\/w:MessageID>/);
    assert.match(probe, /<d:Types>dn:NetworkVideoTransmitter<\/d:Types>/);
    assert.match(probe, /urn:schemas-xmlsoap-org:ws:2005:04:discovery/);
  });

  it('parses advertised hosts, names and locations', () => {
    const xml = MATCH(
      'urn:uuid:aaaa',
      'http://192.168.1.50/onvif/device_service http://[fe80::1]/onvif/device_service',
      'onvif://www.onvif.org/name/Front%20Door onvif://www.onvif.org/hardware/IPC-HD ' +
        'onvif://www.onvif.org/location/Entrance onvif://www.onvif.org/type/NetworkVideoTransmitter',
      'Front Door',
    );
    const devices = parseProbeMatches(xml, 1_700_000_000_000);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.urn, 'urn:uuid:aaaa');
    assert.equal(devices[0]?.xaddr, 'http://192.168.1.50/onvif/device_service');
    assert.equal(devices[0]?.host, '192.168.1.50');
    assert.equal(devices[0]?.name, 'Front Door');
    assert.equal(devices[0]?.hardware, 'IPC-HD');
    assert.equal(devices[0]?.location, 'Entrance');
    assert.deepEqual(devices[0]?.scopes.length, 4);
    assert.equal(devices[0]?.discoveredAt, 1_700_000_000_000);
  });

  it('keeps an explicit port and skips matches without an address', () => {
    const withPort = parseProbeMatches(MATCH('urn:uuid:1', 'http://10.0.0.2:8080/onvif/device_service', '', ''));
    assert.equal(withPort[0]?.port, 8080);
    const missing = parseProbeMatches(
      '<s:Envelope xmlns:s="x"><s:Body><d:ProbeMatches xmlns:d="d"><d:ProbeMatch><d:XAddrs>http://a/b</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>',
    );
    assert.deepEqual(missing, []);
  });

  it('classifies scopes case by shape, not vendor', () => {
    assert.deepEqual(parseScopes(['onvif://www.onvif.org/name/A%20B', 'onvif://www.onvif.org/type/PTZ']), {
      name: 'A B',
      types: ['PTZ'],
    });
    assert.deepEqual(parseScopes(['http://example.com/scope']), { types: [] });
  });
});

describe('discoverDevices', () => {
  function fakeTransport(response: string, sent: Array<{ port: number; address: string }>): DiscoveryTransport {
    let message: ((data: Buffer) => void) | undefined;
    return {
      ready: async () => undefined,
      send: (_message, port, address) => {
        sent.push({ port, address });
        // Reply after the probe, the way a camera would.
        setTimeout(() => message?.(Buffer.from(response)), 5);
      },
      close: () => undefined,
      onMessage: (listener) => {
        message = listener;
      },
      onError: () => undefined,
    };
  }

  it('collects, dedupes and sorts devices', async () => {
    const sent: Array<{ port: number; address: string }> = [];
    const response =
      '<s:Envelope xmlns:s="x"><s:Body><d:ProbeMatches xmlns:d="d">' +
      '<d:ProbeMatch><d:EndpointReference><a:Address xmlns:a="a">urn:uuid:b</a:Address></d:EndpointReference>' +
      '<d:XAddrs>http://192.168.1.60/onvif/device_service</d:XAddrs>' +
      '<d:Scopes>onvif://www.onvif.org/name/Zebra</d:Scopes></d:ProbeMatch>' +
      '<d:ProbeMatch><d:EndpointReference><a:Address xmlns:a="a">urn:uuid:a</a:Address></d:EndpointReference>' +
      '<d:XAddrs>http://192.168.1.61/onvif/device_service</d:XAddrs>' +
      '<d:Scopes>onvif://www.onvif.org/name/Aardvark</d:Scopes></d:ProbeMatch>' +
      '</d:ProbeMatches></s:Body></s:Envelope>';

    const devices = await discoverDevices({
      timeoutMs: 300,
      createTransport: () => fakeTransport(response, sent),
      now: () => 1_700_000_000_000,
    });
    assert.deepEqual(
      devices.map((device) => device.name),
      ['Aardvark', 'Zebra'],
      'sorted by name, not by arrival',
    );
    assert.equal(devices.length, 2);
    assert.deepEqual(sent[0], { port: 3702, address: '239.255.255.250' });
    assert.equal(sent.length, 2, 'the probe is retransmitted once');
  });

  it('returns an empty list when nothing answers', async () => {
    const devices = await discoverDevices({
      timeoutMs: 260,
      createTransport: () => ({
        ready: async () => undefined,
        send: () => undefined,
        close: () => undefined,
        onMessage: () => undefined,
        onError: () => undefined,
      }),
    });
    assert.deepEqual(devices, []);
  });

  it('reports socket errors as warnings instead of failing', async () => {
    const warnings: string[] = [];
    const devices = await discoverDevices({
      timeoutMs: 260,
      onWarning: (message) => warnings.push(message),
      createTransport: () => ({
        ready: async () => undefined,
        send: (_message, _port, _address, callback) => callback?.(new Error('network unreachable')),
        close: () => undefined,
        onMessage: () => undefined,
        onError: (listener) => listener(new Error('multicast blocked')),
      }),
    });
    assert.deepEqual(devices, []);
    assert.equal(warnings.some((warning) => warning.includes('multicast blocked')), true);
    assert.equal(warnings.some((warning) => warning.includes('network unreachable')), true);
  });
});
