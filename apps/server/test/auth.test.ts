import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { AuthConfig } from '@icamify/core';
import { AuthService, hashPassword, hashToken, readCookie } from '../src/http/auth.ts';

/**
 * Auth is the only thing standing between a camera network and the internet, so
 * these tests cover the failure paths (wrong password, tampered cookie, revoked
 * session, lockout) rather than only the happy path.
 */

let passwordHash = '';

before(async () => {
  // Cheap argon2 parameters keep the suite fast; verification uses the parameters
  // embedded in the PHC string, so this still exercises the real verifier.
  passwordHash = await hashPassword('correct horse battery staple', { memoryKib: 8192, iterations: 1, parallelism: 1 });
});

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    mode: 'local',
    allowAnonymousViewing: false,
    session: {
      secret: 'test-secret-that-is-long-enough-0123456789',
      cookieName: 'icamify_session',
      ttlHours: 24,
      idleTimeoutMinutes: 120,
      secureCookie: true,
      sameSite: 'lax',
    },
    users: [{ username: 'admin', role: 'admin', passwordHash }],
    apiTokens: [{ name: 'automation', role: 'operator', tokenHash: hashToken('token-value') }],
    lockout: { maxAttempts: 3, windowMinutes: 15, blockMinutes: 15 },
    ...overrides,
  };
}

describe('password hashing', () => {
  test('produces an argon2id PHC string that verifies the password', async () => {
    assert.match(passwordHash, /^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
    const service = new AuthService({ auth: config() });
    const result = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    assert.equal(result.ok, true);
  });

  test('rejects the wrong password and unknown users identically', async () => {
    const service = new AuthService({ auth: config() });
    const wrong = await service.login('admin', 'nope', '127.0.0.1');
    const unknown = await service.login('ghost', 'nope', '127.0.0.1');
    assert.equal(wrong.ok, false);
    assert.equal(unknown.ok, false);
    assert.equal(wrong.ok === false ? wrong.code : '', 'invalid-credentials');
    assert.equal(wrong.ok === false ? wrong.message : '', unknown.ok === false ? unknown.message : '');
  });

  test('refuses a non-argon2 hash instead of accepting anything', async () => {
    const service = new AuthService({
      auth: config({ users: [{ username: 'admin', role: 'admin', passwordHash: 'plaintext' }] }),
    });
    const result = await service.login('admin', 'plaintext', '127.0.0.1');
    assert.equal(result.ok, false);
  });
});

describe('sessions', () => {
  test('issues a cookie that authenticates and is revoked by logout', async () => {
    const service = new AuthService({ auth: config() });
    const login = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    assert.equal(login.ok, true);
    if (!login.ok) return;

    const token = readCookie(login.cookie, 'icamify_session');
    assert.ok(token);
    const principal = service.authenticate({ cookie: `icamify_session=${token}` });
    assert.equal(principal?.username, 'admin');
    assert.equal(principal?.role, 'admin');

    service.logout({ cookie: `icamify_session=${token}` });
    assert.equal(service.authenticate({ cookie: `icamify_session=${token}` }), undefined);
  });

  test('rejects a tampered payload with a valid-looking shape', async () => {
    const service = new AuthService({ auth: config() });
    const login = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    if (!login.ok) throw new Error('login failed');
    const token = readCookie(login.cookie, 'icamify_session') ?? '';
    const [version, body, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.role = 'admin';
    payload.sub = 'intruder';
    const forged = `${version}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    assert.equal(service.authenticate({ cookie: `icamify_session=${forged}` }), undefined);
  });

  test('honours the cookie name and the Secure/SameSite flags', async () => {
    const service = new AuthService({ auth: config({ session: { ...config().session, cookieName: 'nvr', secureCookie: false, sameSite: 'strict' } }) });
    const login = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    if (!login.ok) throw new Error('login failed');
    assert.match(login.cookie, /^nvr=/);
    assert.match(login.cookie, /SameSite=Strict/);
    assert.doesNotMatch(login.cookie, /Secure/);
    assert.match(login.cookie, /HttpOnly/);
  });

  test('expires sessions after the TTL', async () => {
    let now = 1_000_000;
    const service = new AuthService({ auth: config(), now: () => now });
    const login = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    if (!login.ok) throw new Error('login failed');
    const token = readCookie(login.cookie, 'icamify_session') ?? '';
    now += 25 * 3_600_000;
    assert.equal(service.authenticate({ cookie: `icamify_session=${token}` }), undefined);
  });

  test('expires sessions after the idle timeout', async () => {
    let now = 1_000_000;
    const service = new AuthService({ auth: config(), now: () => now });
    const login = await service.login('admin', 'correct horse battery staple', '127.0.0.1');
    if (!login.ok) throw new Error('login failed');
    const token = readCookie(login.cookie, 'icamify_session') ?? '';
    now += 121 * 60_000;
    assert.equal(service.authenticate({ cookie: `icamify_session=${token}` }), undefined);
  });
});

describe('api tokens and lockout', () => {
  test('accepts a bearer token and reports its role', () => {
    const service = new AuthService({ auth: config() });
    const principal = service.authenticate({ authorization: 'Bearer token-value' });
    assert.equal(principal?.kind, 'token');
    assert.equal(principal?.role, 'operator');
  });

  test('ignores expired tokens', () => {
    const service = new AuthService({
      auth: config({
        apiTokens: [{ name: 'old', role: 'admin', tokenHash: hashToken('old-token'), expiresAt: '2000-01-01' }],
      }),
    });
    assert.equal(service.authenticate({ authorization: 'Bearer old-token' }), undefined);
  });

  test('locks an identity out after repeated failures, then releases it', async () => {
    let now = 1_000_000;
    const service = new AuthService({ auth: config(), now: () => now });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await service.login('admin', 'wrong', '10.0.0.5');
      assert.equal(result.ok, false);
    }
    const locked = await service.login('admin', 'correct horse battery staple', '10.0.0.5');
    assert.equal(locked.ok === false ? locked.code : '', 'locked-out');
    // A different client is unaffected: the lockout is per client+identity.
    const other = await service.login('admin', 'correct horse battery staple', '10.0.0.6');
    assert.equal(other.ok, true);
    now += 16 * 60_000;
    const released = await service.login('admin', 'correct horse battery staple', '10.0.0.5');
    assert.equal(released.ok, true);
  });

  test('mode "none" opens the appliance without credentials', () => {
    const service = new AuthService({ auth: config({ mode: 'none' }) });
    const principal = service.authenticate({});
    assert.equal(principal?.role, 'admin');
    assert.equal(principal?.kind, 'open');
  });

  test('warns instead of silently generating a key when the secret is missing', () => {
    const warnings: string[] = [];
    new AuthService({ auth: config({ session: { secret: undefined } }), onWarning: (message) => warnings.push(message) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /ephemeral key/);
  });
});
