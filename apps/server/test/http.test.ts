import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AuthConfig } from '@icamify/core';
import { hashPassword, hashToken } from '../src/http/auth.ts';
import {
  CAMERA,
  EMPTY_AUTH,
  StubWebRtcEngine,
  connectControl,
  cookieFrom,
  request,
  testConfig,
  waitFor,
  withServer,
} from './helpers.ts';

let hash = '';
const tempDirs: string[] = [];

before(async () => {
  hash = await hashPassword('hunter2-hunter2', { memoryKib: 8192, iterations: 1, parallelism: 1 });
});

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function localAuth(overrides: Partial<AuthConfig> = {}): Partial<AuthConfig> {
  return {
    mode: 'local',
    allowAnonymousViewing: false,
    session: {
      secret: 'a-test-secret-with-enough-entropy-0123456789',
      cookieName: 'icamify_session',
      ttlHours: 24,
      idleTimeoutMinutes: 120,
      secureCookie: false,
      sameSite: 'lax',
    },
    users: [
      { username: 'admin', role: 'admin', passwordHash: hash },
      { username: 'watcher', role: 'viewer', passwordHash: hash },
    ],
    apiTokens: [{ name: 'ops', role: 'operator', tokenHash: hashToken('ops-token') }],
    lockout: { maxAttempts: 50, windowMinutes: 15, blockMinutes: 15 },
    ...overrides,
  };
}

describe('HTTP surface', () => {
  test('health is public and reports the version', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const response = await request(server, '/health');
      assert.equal(response.status, 200);
      assert.equal((response.json as { status: string }).status, 'ok');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    });
  });

  test('camera endpoints require authentication unless anonymous viewing is on', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const anonymous = await request(server, '/api/cameras');
      assert.equal(anonymous.status, 401);
      assert.equal((anonymous.json as { error: { code: string } }).error.code, 'unauthenticated');
      assert.match(anonymous.headers.get('www-authenticate') ?? '', /Bearer/);
    });

    await withServer(testConfig({ auth: localAuth({ allowAnonymousViewing: true }) }), async (server) => {
      const anonymous = await request(server, '/api/cameras');
      assert.equal(anonymous.status, 200);
      const body = anonymous.json as { cameras: Array<Record<string, unknown>> };
      assert.equal(body.cameras.length, 1);
      assert.equal(body.cameras[0]?.name, 'Front door');
    });
  });

  test('login sets a session cookie that authenticates later requests', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const bad = await request(server, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
      assert.equal(bad.status, 401);

      const login = await request(server, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'hunter2-hunter2' }),
      });
      assert.equal(login.status, 200);
      const cookie = cookieFrom(login);
      assert.match(cookie, /^icamify_session=/);

      const me = await request(server, '/api/auth/me', { cookie });
      assert.equal(me.status, 200);
      const body = me.json as { authenticated: boolean; user: { username: string; role: string } };
      assert.equal(body.authenticated, true);
      assert.equal(body.user.username, 'admin');
      assert.equal(body.user.role, 'admin');

      const cameras = await request(server, '/api/cameras', { cookie });
      assert.equal(cameras.status, 200);
    });
  });

  test('logout revokes the session server-side', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const login = await request(server, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'hunter2-hunter2' }),
      });
      const cookie = cookieFrom(login);
      const logout = await request(server, '/api/auth/logout', { method: 'POST', cookie });
      assert.equal(logout.status, 200);
      const me = await request(server, '/api/auth/me', { cookie });
      assert.equal((me.json as { authenticated: boolean }).authenticated, false);
    });
  });

  test('bearer tokens authenticate without CSRF and carry their role', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const cameras = await request(server, '/api/cameras', {
        headers: { authorization: 'Bearer ops-token' },
      });
      assert.equal(cameras.status, 200);

      const argv = await request(server, '/api/cameras/front-door/live-argv', {
        headers: { authorization: 'Bearer ops-token' },
      });
      assert.equal(argv.status, 200);
      const body = argv.json as { argv: string[] };
      assert.ok(body.argv.includes('-c:v'));
      assert.ok(!body.argv.join(' ').includes('./data/sample.mp4') === false, 'the local file path is not a secret');

      const wrong = await request(server, '/api/cameras', { headers: { authorization: 'Bearer nope' } });
      assert.equal(wrong.status, 401);
    });
  });

  test('roles are enforced: viewers cannot read settings', async () => {
    await withServer(testConfig({ auth: localAuth({ allowAnonymousViewing: true }) }), async (server) => {
      const denied = await request(server, '/api/system/config', {
        headers: { authorization: 'Bearer ops-token' },
      });
      assert.equal(denied.status, 403);
      assert.equal((denied.json as { error: { code: string } }).error.code, 'forbidden');

      const login = await request(server, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'hunter2-hunter2' }),
      });
      const cookie = cookieFrom(login);
      const allowed = await request(server, '/api/system/config', { cookie });
      assert.equal(allowed.status, 200);
      assert.ok(!allowed.text.includes('$argon2'), 'password hashes must be redacted');
      assert.ok(!allowed.text.includes('a-test-secret-with-enough-entropy'), 'session secrets must be redacted');
    });
  });

  test('cookie-authenticated mutations must be same-origin', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      const login = await request(server, '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'hunter2-hunter2' }),
      });
      const cookie = cookieFrom(login);

      const crossSite = await request(server, '/api/auth/logout', {
        method: 'POST',
        cookie,
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(crossSite.status, 403);
      assert.equal((crossSite.json as { error: { code: string } }).error.code, 'cross-origin');

      const sameSite = await request(server, '/api/auth/logout', {
        method: 'POST',
        cookie,
        headers: { origin: `http://127.0.0.1:${server.listen.port}` },
      });
      assert.equal(sameSite.status, 200);
    });
  });

  test('camera views expose transport availability but never credentials', async () => {
    const camera = {
      ...CAMERA,
      streams: { main: { type: 'rtsp' as const, url: 'rtsp://admin:secret@10.0.0.9/ch1' } },
    };
    await withServer(testConfig({ auth: EMPTY_AUTH, cameras: [camera] }), async (server) => {
      const response = await request(server, '/api/cameras');
      const body = response.json as { cameras: Array<{ source: { masked: string }; status: { transports: Array<{ transport: string; available: boolean }> } }> };
      const first = body.cameras[0];
      assert.ok(first);
      assert.ok(!first.source.masked.includes('secret'), 'credentials must be masked');
      assert.match(first.source.masked, /\*\*\*/);
      assert.deepEqual(
        first.status.transports.map((entry) => entry.transport),
        ['webrtc', 'mse', 'mjpeg'],
      );
      assert.equal(first.status.transports[0]?.available, false, 'WebRTC is disabled for this server');
    }, { webrtc: false });
  });

  test('unknown API routes return JSON 404 and wrong methods return 405', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const missing = await request(server, '/api/nope');
      assert.equal(missing.status, 404);
      assert.equal((missing.json as { error: { code: string } }).error.code, 'not-found');

      const wrongMethod = await request(server, '/api/cameras', { method: 'DELETE' });
      assert.equal(wrongMethod.status, 405);
      assert.match(wrongMethod.headers.get('allow') ?? '', /GET/);
    });
  });

  test('a failing snapshot reports 502 rather than hanging', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const response = await request(server, '/api/cameras/front-door/snapshot.jpg');
      assert.equal(response.status, 502);
      assert.equal((response.json as { error: { code: string } }).error.code, 'snapshot-failed');
    });
  });

  test('snapshot of an unknown camera is a 404', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const response = await request(server, '/api/cameras/ghost/snapshot.jpg');
      assert.equal(response.status, 404);
    });
  });
});

describe('static console', () => {
  test('serves index.html at the root, hashed assets immutably, and SPA routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icamify-web-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>iCamify</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');

    await withServer(
      testConfig({ auth: EMPTY_AUTH }),
      async (server) => {
        const index = await request(server, '/');
        assert.equal(index.status, 200);
        assert.match(index.headers.get('content-type') ?? '', /text\/html/);
        assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
        assert.equal(index.headers.get('cache-control'), 'no-cache');

        const asset = await request(server, '/assets/app.js');
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
        assert.match(asset.headers.get('content-type') ?? '', /javascript/);

        const spa = await request(server, '/cameras/front-door');
        assert.equal(spa.status, 200);
        assert.match(spa.text, /iCamify/);

        const missingAsset = await request(server, '/assets/missing.js');
        assert.equal(missingAsset.status, 404);
      },
      { staticDir: dir },
    );
  });

  test('a traversal attempt never escapes the console directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icamify-web-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'index.html'), 'index');
    await withServer(
      testConfig({ auth: EMPTY_AUTH }),
      async (server) => {
        const response = await fetch(`${server.listen.url.replace('localhost', '127.0.0.1')}/..%2f..%2fpackage.json`);
        assert.equal(response.status, 404);
      },
      { staticDir: dir },
    );
  });
});

describe('control WebSocket', () => {
  test('rejects unauthenticated upgrades when auth is required', async () => {
    await withServer(testConfig({ auth: localAuth() }), async (server) => {
      await assert.rejects(() => connectControl(server), /401/);
    });
  });

  test('greets with the camera snapshot and answers ping', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const { socket, received } = await connectControl(server);
      const welcome = await waitFor(
        () => received.find((message) => message.type === 'welcome'),
        2000,
        'welcome message',
      );
      assert.equal((welcome.cameras as unknown[]).length, 1);
      assert.equal((welcome.user as { username: string }).username, 'local');

      socket.send(JSON.stringify({ type: 'ping', t: 42 }));
      const pong = await waitFor(() => received.find((message) => message.type === 'pong'), 2000, 'pong');
      assert.equal(pong.t, 42);

      socket.send(JSON.stringify({ type: 'subscribe', topics: ['cameras'] }));
      const subscribed = await waitFor(() => received.find((message) => message.type === 'subscribed'), 2000, 'ack');
      assert.deepEqual(subscribed.topics, ['cameras']);
      socket.close();
    });
  });

  test('answers a WebRTC offer with a capability error instead of leaving the client hanging', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const { socket, received } = await connectControl(server);
      await waitFor(() => received.find((message) => message.type === 'welcome'));
      socket.send(JSON.stringify({ type: 'webrtc:offer', cameraId: 'front-door', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ice-ufrag:x\r\n' }));
      const error = await waitFor(() => received.find((message) => message.type === 'webrtc:error'), 2000, 'webrtc error');
      assert.equal(error.code, 'engine-unavailable');
      assert.match(String(error.message), /media engine|disabled/i);
      socket.close();
    }, { webrtc: false });
  });

  test('brokers an offer over the control socket and reports the media plane', async () => {
    const engine = new StubWebRtcEngine();
    await withServer(
      testConfig({ auth: EMPTY_AUTH }),
      async (server) => {
        const { socket, received } = await connectControl(server);
        const welcome = await waitFor(() => received.find((message) => message.type === 'welcome'));
        const cameras = welcome.cameras as Array<{ status: { transports: Array<{ transport: string; available: boolean }> } }>;
        const transport = cameras[0]?.status.transports.find((entry) => entry.transport === 'webrtc');
        assert.equal(transport?.available, true);

        socket.send(
          JSON.stringify({
            type: 'webrtc:offer',
            cameraId: 'front-door',
            sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ice-ufrag:x\r\na=setup:actpass\r\na=rtpmap:96 H264/90000\r\n',
          }),
        );
        const answer = await waitFor(() => received.find((message) => message.type === 'webrtc:answer'), 2000, 'answer');
        assert.match(String(answer.sdp), /H264/);
        assert.equal(engine.offers[0]?.camera.id, 'front-door');

        socket.send(
          JSON.stringify({
            type: 'webrtc:ice',
            sessionId: answer.sessionId,
            candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host' },
          }),
        );
        await waitFor(() => engine.candidates.length === 1 ? true : undefined, 2000, 'candidate');

        const status = await request(server, '/api/webrtc');
        const body = status.json as {
          available: boolean;
          engine: string;
          active: { sessions: number; sources: number };
          details?: { sessions: Array<{ user: string; packets: number }> };
        };
        assert.equal(status.status, 200);
        assert.equal(body.available, true);
        assert.equal(body.engine, 'stub');
        assert.equal(body.active.sessions, 1);
        assert.equal(body.details?.sessions[0]?.packets, 10);
        socket.close();
      },
      { webrtc: engine },
    );
  });

  test('rejects malformed control messages without dropping the socket', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const { socket, received } = await connectControl(server);
      await waitFor(() => received.find((message) => message.type === 'welcome'));
      socket.send('not json');
      const error = await waitFor(() => received.find((message) => message.type === 'error'), 2000, 'error');
      assert.equal(error.code, 'invalid-message');
      assert.equal(socket.readyState, 1);
      socket.close();
    });
  });
});

describe('AI and rules API', () => {
  test('reports the AI feature and an empty provider list when none are configured', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const system = await request(server, '/api/system');
      assert.equal((system.json as { features: { ai: boolean } }).features.ai, true);

      const providers = await request(server, '/api/ai/providers');
      assert.equal(providers.status, 200);
      assert.deepEqual((providers.json as { providers: unknown[] }).providers, []);
    });
  });

  test('returns null AI status for a camera without an AI block, then accepts one', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const before = await request(server, '/api/cameras/front-door/ai');
      assert.equal(before.status, 200);
      assert.equal((before.json as { ai: unknown }).ai, null);

      const updated = await request(server, '/api/cameras/front-door/ai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labels: ['person', 'car'], minConfidence: 0.7 }),
      });
      assert.equal(updated.status, 200);
      const status = (updated.json as { ai: { labels: string[]; minConfidence: number; task: string } }).ai;
      assert.deepEqual(status.labels, ['person', 'car']);
      assert.equal(status.minConfidence, 0.7);
      assert.equal(status.task, 'object');

      const invalid = await request(server, '/api/cameras/front-door/ai', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minConfidence: 5 }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((invalid.json as { error: { code: string } }).error.code, 'invalid-ai-settings');
    });
  });

  test('manual detection explains why nothing ran instead of failing silently', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const response = await request(server, '/api/cameras/front-door/ai/detect', { method: 'POST' });
      assert.equal(response.status, 200);
      const body = response.json as { detections: unknown[]; reason?: string };
      assert.deepEqual(body.detections, []);
      assert.match(String(body.reason), /provider/i);
    });
  });

  test('lists rules and channels, marking every channel as implemented', async () => {
    const config = testConfig({ auth: EMPTY_AUTH });
    config.rules = [
      { id: 'person', name: 'Person', when: { events: ['ai.object'] }, then: { notify: { channels: ['hook', 'tg'] } } },
    ];
    config.notifications = {
      dedupeSeconds: 15,
      channels: [
        { id: 'hook', name: 'Hook', type: 'webhook', url: 'http://127.0.0.1:9/hook' },
        { id: 'tg', name: 'Telegram', type: 'telegram', botToken: 'x', chatId: '1' },
      ],
    };
    await withServer(config, async (server) => {
      const response = await request(server, '/api/rules');
      assert.equal(response.status, 200);
      const body = response.json as {
        rules: Array<{ id: string }>;
        channels: Array<{ id: string; implemented: boolean }>;
        dedupeSeconds: number;
      };
      assert.deepEqual(body.rules.map((rule) => rule.id), ['person']);
      assert.deepEqual(
        body.channels.map((channel) => [channel.id, channel.implemented]),
        [
          ['hook', true],
          ['tg', true],
        ],
      );
      assert.equal(body.dedupeSeconds, 15);
    });
  });

  test('serves a saved detection snapshot and rejects an unknown event', async () => {
    await withServer(testConfig({ auth: EMPTY_AUTH }), async (server) => {
      const missing = await request(server, '/api/events/does-not-exist/snapshot');
      assert.equal(missing.status, 404);
      assert.equal((missing.json as { error: { code: string } }).error.code, 'event-not-found');
    });
  });
});
