import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import type { CameraConfig } from '@icamify/core';
import {
  LiveRegistry,
  type LiveSource,
  type LiveSourceHandlers,
} from '@icamify/stream';
import { WebSocket } from 'ws';
import { AuthService, hashPassword } from '../src/http/auth.ts';
import { HttpError, sendError } from '../src/http/responses.ts';
import { createLiveStreamHandler } from '../src/live/ws-stream.ts';
import { createMjpegHandler } from '../src/live/mjpeg.ts';
import { EMPTY_AUTH, testConfig, waitFor } from './helpers.ts';

/**
 * Media socket tests.
 *
 * These assert the wire contract the browser depends on: a JSON init message, the
 * init segment as its own binary frame, then one frame per fragment. Getting that
 * ordering wrong produces a black tile with no error, which is exactly the kind
 * of bug that must be caught by tests rather than by a camera operator.
 */

const CAMERA: CameraConfig = {
  id: 'front-door',
  name: 'Front door',
  streams: { main: { type: 'file', path: './data/sample.mp4' } },
};

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function initSegment(width = 640, height = 360): Buffer {
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  };
  const prefix = Buffer.alloc(78);
  prefix.writeUInt16BE(1, 6);
  prefix.writeUInt16BE(width, 24);
  prefix.writeUInt16BE(height, 26);
  const entry = box('avc1', Buffer.concat([prefix, box('avcC', Buffer.from([1, 0x42, 0xc0, 0x1f, 0xff]))]));
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), u32(1), entry]));
  const stbl = box('stbl', stsd);
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(4), u32(0), u32(0), u32(12800), u32(0)]));
  const hdlr = box('hdlr', Buffer.concat([Buffer.alloc(4), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)]));
  const moov = box('moov', box('trak', Buffer.concat([box('tkhd', Buffer.alloc(84)), box('mdia', Buffer.concat([mdhd, hdlr, box('minf', stbl)]))])));
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), moov]);
}

function fragment(sequence: number): Buffer {
  return Buffer.concat([
    box('moof', box('mfhd', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, sequence])]))),
    box('mdat', Buffer.alloc(16, sequence)),
  ]);
}

function jpeg(label: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label, 'latin1'), Buffer.from([0xff, 0xd9])]);
}

class FakeSource implements LiveSource {
  readonly argv = ['ffmpeg', '-i', 'fake'];
  handlers: LiveSourceHandlers | undefined;
  stops = 0;

  start(handlers: LiveSourceHandlers): void {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  push(chunk: Buffer): void {
    this.handlers?.onData(chunk);
  }
}

function setup(): { registry: LiveRegistry; source: FakeSource; config: ReturnType<typeof testConfig> } {
  const config = testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA] });
  const source = new FakeSource();
  const registry = new LiveRegistry({
    config,
    camera: (id) => (id === CAMERA.id ? CAMERA : undefined),
    createSource: () => source,
  });
  return { registry, source, config };
}

async function listen(server: import('node:http').Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('MSE socket', () => {
  test('sends stream metadata, the init segment, then one frame per fragment', async () => {
    const { registry, source } = setup();
    const auth = new AuthService({ auth: { mode: 'none' } });
    const handler = createLiveStreamHandler({ auth, registry });
    const server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    server.on('upgrade', handler.handleUpgrade);
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cameras/front-door/live.ws`);

    const events: Array<{ type: 'json'; value: Record<string, unknown> } | { type: 'binary'; value: Buffer }> = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) events.push({ type: 'binary', value: Buffer.from(data as Buffer) });
      else events.push({ type: 'json', value: JSON.parse(data.toString()) as Record<string, unknown> });
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const init = initSegment();
    const first = fragment(1);
    source.push(Buffer.concat([init, first]));

    const meta = await waitFor(() => events.find((event) => event.type === 'json' && event.value.type === 'stream:init'), 2000, 'stream:init');
    assert.equal(meta.type === 'json' ? meta.value.codec : '', 'avc1.42c01f');
    assert.equal(meta.type === 'json' ? meta.value.mimeType : '', 'video/mp4; codecs="avc1.42c01f"');
    assert.equal(meta.type === 'json' ? meta.value.segmentMode : '', 'fmp4');
    assert.equal(meta.type === 'json' ? meta.value.width : 0, 640);

    const binaries = await waitFor(
      () => (events.filter((event) => event.type === 'binary').length >= 2 ? events.filter((event) => event.type === 'binary') : undefined),
      2000,
      'init and fragment frames',
    );
    assert.deepEqual(binaries[0]?.value, init, 'the init segment must arrive as its own frame');
    assert.deepEqual(binaries[1]?.value, first);
    assert.equal(registry.viewerCount('front-door'), 1);

    socket.close();
    await waitFor(() => (registry.viewerCount('front-door') === 0 ? true : undefined), 2000, 'viewer detach');
    await handler.close();
    await registry.shutdown();
    server.close();
  });

  test('rejects an unauthenticated media socket when auth is required', async () => {
    const passwordHash = await hashPassword('another-password', { memoryKib: 8192, iterations: 1, parallelism: 1 });
    const config = testConfig({
      auth: { mode: 'local', allowAnonymousViewing: false, users: [{ username: 'admin', role: 'admin', passwordHash }] },
      cameras: [CAMERA],
    });
    const registry = new LiveRegistry({ config, camera: () => CAMERA, createSource: () => new FakeSource() });
    const auth = new AuthService({ auth: config.auth });
    const handler = createLiveStreamHandler({ auth, registry });
    const server = createServer((_req, res) => res.writeHead(404).end());
    server.on('upgrade', handler.handleUpgrade);
    const port = await listen(server);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cameras/front-door/live.ws`);
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once('open', () => {
        socket.close();
        reject(new Error('the unauthenticated socket was accepted'));
      });
      socket.once('error', () => {
        // Some failures surface here instead; unexpected-response is preferred.
      });
    });
    assert.equal(status, 401);
    await handler.close();
    await registry.shutdown();
    server.close();
  });
});

describe('MJPEG endpoint', () => {
  test('streams multipart JPEG frames and detaches on disconnect', async () => {
    const { registry, source } = setup();
    const auth = new AuthService({ auth: { mode: 'none' } });
    const handler = createMjpegHandler({ registry, auth });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        handler({
          req,
          res,
          url,
          params: { id: 'front-door' },
          query: url.searchParams,
          principal: undefined,
          clientIp: '127.0.0.1',
        });
      } catch (error) {
        if (error instanceof HttpError) sendError(res, error.status, error.code, error.message);
        else throw error;
      }
    });
    const port = await listen(server);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/cameras/front-door/live.mjpeg`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /multipart\/x-mixed-replace; boundary=/);

    const reader = response.body?.getReader();
    assert.ok(reader);
    source.push(Buffer.concat([jpeg('first-frame'), jpeg('second-frame')]));
    const chunk = await reader.read();
    const text = Buffer.from(chunk.value ?? Buffer.alloc(0)).toString('latin1');
    assert.match(text, /--icamifyframe/);
    assert.match(text, /Content-Type: image\/jpeg/);
    assert.ok(text.includes('\xff\xd8\xff'), 'the multipart body must contain a JPEG');

    controller.abort();
    await waitFor(() => (registry.viewerCount('front-door') === 0 ? true : undefined), 2000, 'viewer detach');
    await registry.shutdown();
    server.close();
  });

  test('refuses a disabled transport with an actionable message', async () => {
    const config = testConfig({ auth: EMPTY_AUTH, cameras: [CAMERA], streaming: { mjpeg: { enabled: false } } });
    const registry = new LiveRegistry({ config, camera: () => CAMERA, createSource: () => new FakeSource() });
    const auth = new AuthService({ auth: config.auth });
    const handler = createMjpegHandler({ registry, auth });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        handler({ req, res, url, params: { id: 'front-door' }, query: url.searchParams, principal: undefined, clientIp: '127.0.0.1' });
      } catch (error) {
        if (error instanceof HttpError) sendError(res, error.status, error.code, error.message);
      }
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/cameras/front-door/live.mjpeg`);
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'transport-disabled');
    assert.match(body.error.message, /streaming\.mjpeg\.enabled/);
    server.close();
  });
});

after(() => {
  // Nothing global to clean up; sessions are unref'd.
});
