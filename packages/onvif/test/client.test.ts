import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { OnvifClient, OnvifError } from '../src/index.ts';

/**
 * The client is exercised against a fake ONVIF device over real HTTP: the parts
 * worth testing are the envelope/action contract, digest negotiation and the
 * mapping of SOAP answers, none of which a stubbed `fetch` would prove.
 */

const servers: Array<ReturnType<typeof createServer>> = [];
after(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface DeviceOptions {
  requireDigest?: boolean;
  password?: string;
  delayMs?: number;
  profiles?: number;
}

interface Captured {
  action: string;
  body: string;
  authorization?: string;
  path: string;
}

function fault(reason: string): string {
  return (
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault>' +
    `<s:Reason><s:Text>${reason}</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`
  );
}

function envelope(body: string): string {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
}

function verifyDigest(header: string | undefined, method: string, uri: string, password: string): boolean {
  if (header === undefined || !header.startsWith('Digest ')) return false;
  const params = new Map<string, string>();
  for (const match of header.matchAll(/([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params.set(match[1] as string, (match[2] ?? match[3] ?? '') as string);
  }
  const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex');
  const ha1 = md5(`${params.get('username')}:${params.get('realm')}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const expected = params.has('qop')
    ? md5(`${ha1}:${params.get('nonce')}:${params.get('nc')}:${params.get('cnonce')}:auth:${ha2}`)
    : md5(`${ha1}:${params.get('nonce')}:${ha2}`);
  return expected === params.get('response');
}

async function fakeDevice(options: DeviceOptions = {}) {
  const captured: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const action = /action="([^"]+)"/.exec(String(request.headers['content-type'] ?? ''))?.[1] ?? '';
      const operation = action.split('/').pop() ?? '';
      const path = request.url ?? '/';
      captured.push({
        action,
        body,
        path,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      });

      const send = (status: number, payload: string, headers: Record<string, string> = {}): void => {
        const write = (): void => {
          response.writeHead(status, { 'content-type': 'application/soap+xml; charset=utf-8', ...headers });
          response.end(payload);
        };
        if (options.delayMs === undefined) write();
        else setTimeout(write, options.delayMs).unref();
      };

      if (options.requireDigest === true) {
        if (!verifyDigest(request.headers.authorization, 'POST', path, options.password ?? 'secret')) {
          send(401, '<denied/>', { 'www-authenticate': 'Digest realm="cam", nonce="nonce-1", qop="auth"' });
          return;
        }
      }

      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const profileCount = options.profiles ?? 2;
      const profiles = Array.from({ length: profileCount }, (_, index) => {
        const token = `profile_${index}`;
        const width = index === 0 ? 1920 : 640;
        return (
          `<trt:Profiles token="${token}"><trt:Name>${index === 0 ? 'main' : 'sub'}</trt:Name>` +
          `<trt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding>` +
          `<tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${index === 0 ? 1080 : 360}</tt:Height></tt:Resolution>` +
          `<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit><tt:BitrateLimit>4096</tt:BitrateLimit></tt:RateControl>` +
          `</trt:VideoEncoderConfiguration></trt:Profiles>`
        );
      }).join('');

      switch (operation) {
        case 'GetCapabilities':
          send(
            200,
            envelope(
              `<tds:GetCapabilitiesResponse><tds:Capabilities>` +
                `<tt:Media><tt:XAddr>${origin}/onvif/media_service</tt:XAddr></tt:Media>` +
                `<tt:PTZ><tt:XAddr>${origin}/onvif/ptz_service</tt:XAddr></tt:PTZ>` +
                `</tds:Capabilities></tds:GetCapabilitiesResponse>`,
            ),
          );
          return;
        case 'GetDeviceInformation':
          send(
            200,
            envelope(
              '<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer>' +
                '<tds:Model>IPC-9000</tds:Model><tds:FirmwareVersion>1.2.3</tds:FirmwareVersion>' +
                '<tds:SerialNumber>SN-42</tds:SerialNumber></tds:GetDeviceInformationResponse>',
            ),
          );
          return;
        case 'GetProfiles':
          send(200, envelope(`<trt:GetProfilesResponse>${profiles}</trt:GetProfilesResponse>`));
          return;
        case 'GetStreamUri':
          if (!body.includes('profile_0')) {
            send(200, fault('No profile with that token'));
            return;
          }
          send(
            200,
            envelope('<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.0.0.9:554/stream1</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>'),
          );
          return;
        case 'GetSnapshotUri':
          send(
            200,
            envelope('<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://10.0.0.9/snapshot.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>'),
          );
          return;
        case 'GetPresets':
          send(
            200,
            envelope(
              '<tptz:GetPresetsResponse><tptz:Preset token="1"><tt:Name>porch</tt:Name></tptz:Preset>' +
                '<tptz:Preset token="2"><tt:Name>gate</tt:Name></tptz:Preset></tptz:GetPresetsResponse>',
            ),
          );
          return;
        case 'GotoPreset':
          if (!body.includes('<tptz:PresetToken>2</tptz:PresetToken>')) {
            send(200, fault('No preset with that token'));
            return;
          }
          send(200, envelope('<tptz:GotoPresetResponse/>'));
          return;
        case 'ContinuousMove':
        case 'AbsoluteMove':
        case 'Stop':
          send(200, envelope(`<tptz:${operation}Response/>`));
          return;
        default:
          send(400, fault(`Unknown operation ${operation}`));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    captured,
    close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('OnvifClient device operations', () => {
  it('reads device information, profiles and URIs through capabilities', async () => {
    const device = await fakeDevice();
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 3000 });

    const info = await client.deviceInfo();
    assert.deepEqual(info, { manufacturer: 'Acme', model: 'IPC-9000', firmwareVersion: '1.2.3', serialNumber: 'SN-42' });

    const profiles = await client.mediaProfiles();
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0]?.token, 'profile_0');
    assert.equal(profiles[0]?.name, 'main');
    assert.equal(profiles[0]?.width, 1920);
    assert.equal(profiles[0]?.height, 1080);
    assert.equal(profiles[0]?.encoding, 'H264');
    assert.equal(profiles[0]?.fps, 25);
    assert.equal(profiles[0]?.bitrateKbps, 4096);

    assert.equal(await client.streamUri(), 'rtsp://10.0.0.9:554/stream1');
    assert.equal(await client.snapshotUri('profile_0'), 'http://10.0.0.9/snapshot.jpg');

    // Capabilities are resolved once, not per call.
    assert.equal(device.captured.filter((entry) => entry.action.endsWith('/GetCapabilities')).length, 1);
    assert.equal(
      device.captured.find((entry) => entry.action.endsWith('/GetProfiles'))?.path,
      '/onvif/media_service',
    );
    await device.close();
  });

  it('moves the camera and visits presets by name', async () => {
    const device = await fakeDevice();
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 3000 });

    const presets = await client.presets();
    assert.deepEqual(presets, [
      { name: 'porch', token: '1' },
      { name: 'gate', token: '2' },
    ]);
    assert.deepEqual(await client.presetNames(), ['porch', 'gate']);

    await client.gotoPreset('gate');
    const goto = device.captured.find((entry) => entry.action.endsWith('/GotoPreset'));
    assert.match(goto?.body ?? '', /<tptz:PresetToken>2<\/tptz:PresetToken>/);

    await client.continuousMove({ pan: 1, tilt: -0.5, zoom: 0.25 }, 3000);
    const move = device.captured.find((entry) => entry.action.endsWith('/ContinuousMove'));
    assert.match(move?.body ?? '', /<tt:PanTilt x="1" y="-0.5"\/>/);
    assert.match(move?.body ?? '', /<tptz:Timeout>PT3S<\/tptz:Timeout>/);

    await client.absoluteMove({ pan: 0.5, tilt: 0, zoom: 1 });
    assert.match(
      device.captured.find((entry) => entry.action.endsWith('/AbsoluteMove'))?.body ?? '',
      /<tt:Zoom x="1"\/>/,
    );

    await client.stop();
    assert.match(device.captured.find((entry) => entry.action.endsWith('/Stop'))?.body ?? '', /<tptz:PanTilt>true<\/tptz:PanTilt>/);
    await device.close();
  });

  it('rejects an unknown preset with the available names', async () => {
    const device = await fakeDevice();
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 3000 });
    await assert.rejects(
      () => client.gotoPreset('driveway'),
      (error: unknown) => {
        assert.equal(error instanceof OnvifError, true);
        assert.equal((error as OnvifError).code, 'invalid-target');
        assert.match((error as OnvifError).detail ?? '', /porch, gate/);
        return true;
      },
    );
    await device.close();
  });

  it('maps a SOAP fault to a classified error', async () => {
    const device = await fakeDevice();
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 3000 });
    await assert.rejects(
      () => client.streamUri('missing_profile'),
      (error: unknown) => {
        assert.equal(error instanceof OnvifError, true);
        assert.equal((error as OnvifError).code, 'soap-fault');
        assert.match((error as Error).message, /No profile with that token/);
        return true;
      },
    );
    await device.close();
  });

  it('reports an unreachable camera instead of hanging', async () => {
    const client = new OnvifClient({ host: '127.0.0.1', port: 1, timeoutMs: 1000 });
    await assert.rejects(
      () => client.deviceInfo(),
      (error: unknown) => {
        assert.equal(error instanceof OnvifError, true);
        assert.equal((error as OnvifError).code, 'unreachable');
        return true;
      },
    );
  });

  it('times out a camera that accepts the connection but never answers', async () => {
    const device = await fakeDevice({ delayMs: 2000 });
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 500 });
    await assert.rejects(
      () => client.deviceInfo(),
      (error: unknown) => {
        assert.equal(error instanceof OnvifError, true);
        assert.equal((error as OnvifError).code, 'timeout');
        return true;
      },
    );
    await device.close();
  });
});

describe('OnvifClient authentication', () => {
  it('answers an HTTP digest challenge and retries', async () => {
    const device = await fakeDevice({ requireDigest: true, password: 'secret' });
    const client = new OnvifClient({
      host: '127.0.0.1',
      port: device.port,
      timeoutMs: 3000,
      credentials: { username: 'admin', password: 'secret' },
    });
    const info = await client.deviceInfo();
    assert.equal(info.model, 'IPC-9000');

    const denied = device.captured.filter((entry) => entry.authorization === undefined);
    assert.equal(denied.length, 1, 'exactly one unauthenticated attempt');
    const accepted = device.captured.find((entry) => entry.authorization?.startsWith('Digest '));
    assert.notEqual(accepted, undefined);
    assert.equal(verifyDigest(accepted?.authorization, 'POST', accepted?.path ?? '/', 'secret'), true);

    // The WS-Security token travels in the body as well.
    assert.match(accepted?.body ?? '', /<wsse:Username>admin<\/wsse:Username>/);
    assert.equal((accepted?.body ?? '').includes('>secret<'), false);
    await device.close();
  });

  it('reports bad credentials as unauthorized', async () => {
    const device = await fakeDevice({ requireDigest: true, password: 'secret' });
    const client = new OnvifClient({
      host: '127.0.0.1',
      port: device.port,
      timeoutMs: 3000,
      credentials: { username: 'admin', password: 'wrong' },
    });
    await assert.rejects(
      () => client.deviceInfo(),
      (error: unknown) => {
        assert.equal((error as OnvifError).code, 'unauthorized');
        return true;
      },
    );
    await device.close();
  });

  it('says unauthorized when the camera requires a login and none is configured', async () => {
    const device = await fakeDevice({ requireDigest: true });
    const client = new OnvifClient({ host: '127.0.0.1', port: device.port, timeoutMs: 3000 });
    await assert.rejects(
      () => client.deviceInfo(),
      (error: unknown) => {
        assert.equal((error as OnvifError).code, 'unauthorized');
        assert.match((error as Error).message, /rejected the credentials/);
        return true;
      },
    );
    await device.close();
  });
});
