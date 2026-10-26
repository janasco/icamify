import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import type { AuthConfig, Role } from '@icamify/core';

/**
 * Authentication and authorisation.
 *
 * Two credential types, both stored only as hashes in the configuration:
 * - local users with argon2id password hashes, exchanged for a signed session
 *   cookie (HttpOnly, SameSite, optional Secure);
 * - API tokens whose SHA-256 is in `auth.apiTokens`, sent as
 *   `Authorization: Bearer <token>`.
 *
 * Sessions are held server-side so logout actually revokes them, and so the
 * idle timeout can be enforced without rewriting the cookie on every request.
 * A restart invalidates sessions — acceptable for a single-node appliance, and
 * documented.
 */

export type PrincipalKind = 'user' | 'token' | 'anonymous' | 'open';

export interface Principal {
  kind: PrincipalKind;
  username: string;
  role: Role;
  displayName?: string;
}

export type Role_ = Role;

export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export type PasswordVerifier = (hash: string, password: string) => Promise<boolean>;

/** Verifies an argon2id PHC string. Anything else is refused, never coerced. */
export const argon2PasswordVerifier: PasswordVerifier = async (hash, password) => {
  if (!hash.startsWith('$argon2')) return false;
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
};

/** Produces an argon2id PHC hash for `icamify user hash`. */
export async function hashPassword(password: string, options: { memoryKib?: number; iterations?: number; parallelism?: number } = {}): Promise<string> {
  if (password.length === 0) throw new Error('password must not be empty');
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: options.parallelism ?? 4,
    iterations: options.iterations ?? 3,
    memorySize: options.memoryKib ?? 65536,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AuthServiceOptions {
  auth: AuthConfig;
  now?: () => number;
  /** Session signing key; defaults to auth.session.secret. */
  secret?: string;
  verifyPassword?: PasswordVerifier;
  /** Reports configuration problems (generated secret, no users, ...). */
  onWarning?: (message: string) => void;
}

export interface SessionCookieOptions {
  cookieName: string;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  maxAgeSeconds: number;
}

export type LoginResult =
  | { ok: true; principal: Principal; cookie: string }
  | { ok: false; code: 'invalid-credentials' | 'locked-out' | 'disabled' | 'auth-disabled' | 'misconfigured'; message: string; retryAfterSeconds?: number };

export interface SessionRecord {
  sid: string;
  sub: string;
  role: Role;
  displayName?: string;
  issuedAt: number;
  lastSeen: number;
  expiresAt: number;
}

interface LockoutState {
  attempts: number;
  firstAttemptAt: number;
  blockedUntil: number;
}

const DEFAULTS = {
  lockoutMaxAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutBlockMinutes: 15,
  ttlHours: 24,
  idleTimeoutMinutes: 120,
};

export class AuthService {
  readonly enabled: boolean;
  readonly cookie: SessionCookieOptions;
  private readonly auth: AuthConfig;
  private readonly now: () => number;
  private readonly verifyPassword: PasswordVerifier;
  private readonly secret: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly lockouts = new Map<string, LockoutState>();
  private readonly ttlMs: number;
  private readonly idleMs: number;

  constructor(options: AuthServiceOptions) {
    this.auth = options.auth;
    this.now = options.now ?? Date.now;
    this.verifyPassword = options.verifyPassword ?? argon2PasswordVerifier;
    this.enabled = options.auth.mode !== 'none';

    const session = options.auth.session ?? {};
    const secret = options.secret ?? session.secret;
    if (secret !== undefined && secret.length >= 16) {
      this.secret = secret;
    } else {
      // A generated key is safe for this process but invalidates sessions at
      // restart; say so once, loudly, instead of silently shipping a default.
      this.secret = randomBytes(32).toString('hex');
      options.onWarning?.(
        'auth.session.secret is missing or too short; using an ephemeral key. Sessions will not survive a restart — set auth.session.secret to ${ICAMIFY_SESSION_SECRET}.',
      );
    }

    this.ttlMs = (session.ttlHours ?? DEFAULTS.ttlHours) * 3_600_000;
    this.idleMs = (session.idleTimeoutMinutes ?? DEFAULTS.idleTimeoutMinutes) * 60_000;
    this.cookie = {
      cookieName: session.cookieName ?? 'icamify_session',
      secure: session.secureCookie !== false,
      sameSite: session.sameSite ?? 'lax',
      maxAgeSeconds: Math.round(this.ttlMs / 1000),
    };

    if (this.enabled && (this.auth.users ?? []).filter((user) => user.enabled !== false).length === 0) {
      options.onWarning?.(
        'Authentication is enabled (auth.mode = "local") but no enabled users are configured; nobody can sign in. Add an auth.users entry or set auth.mode = "none".',
      );
    }
  }

  get userCount(): number {
    return (this.auth.users ?? []).filter((user) => user.enabled !== false).length;
  }

  get anonymousViewing(): boolean {
    return !this.enabled || this.auth.allowAnonymousViewing === true;
  }

  /** The identity used when auth is switched off entirely. */
  openPrincipal(): Principal {
    return { kind: 'open', username: 'local', role: 'admin', displayName: 'Local operator' };
  }

  get open(): boolean {
    return !this.enabled;
  }

  async login(username: string, password: string, clientKey = 'unknown'): Promise<LoginResult> {
    if (!this.enabled) {
      return { ok: false, code: 'auth-disabled', message: 'Authentication is disabled (auth.mode = "none").' };
    }
    const lockKey = `${clientKey}:${username.toLowerCase()}`;
    const blocked = this.lockoutRemaining(lockKey);
    if (blocked > 0) {
      return {
        ok: false,
        code: 'locked-out',
        message: `Too many failed sign-in attempts. Try again in ${Math.ceil(blocked / 60_000)} minute(s).`,
        retryAfterSeconds: Math.ceil(blocked / 1000),
      };
    }

    const user = (this.auth.users ?? []).find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
    const passwordOk = user === undefined ? false : await this.verifyPassword(user.passwordHash, password);
    if (user === undefined || !passwordOk) {
      this.recordFailure(lockKey);
      return { ok: false, code: 'invalid-credentials', message: 'Incorrect username or password.' };
    }
    if (user.enabled === false) {
      return { ok: false, code: 'disabled', message: 'This account is disabled.' };
    }

    this.lockouts.delete(lockKey);
    const principal: Principal = {
      kind: 'user',
      username: user.username,
      role: user.role,
      ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    };
    return { ok: true, principal, cookie: this.issueSession(principal) };
  }

  /** Issues a signed session cookie and records the session for revocation. */
  issueSession(principal: Principal): string {
    const now = this.now();
    const sid = randomBytes(18).toString('base64url');
    this.sessions.set(sid, {
      sid,
      sub: principal.username,
      role: principal.role,
      ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }),
      issuedAt: now,
      lastSeen: now,
      expiresAt: now + this.ttlMs,
    });
    this.pruneSessions();
    return this.serializeCookie(this.signToken({ sid, sub: principal.username, role: principal.role, iat: now }));
  }

  /** Authenticates a request from its Cookie and/or Authorization header. */
  authenticate(headers: { cookie?: string | undefined; authorization?: string | undefined }): Principal | undefined {
    if (!this.enabled) return this.openPrincipal();

    const bearer = readBearer(headers.authorization);
    if (bearer !== undefined) {
      const principal = this.authenticateToken(bearer);
      if (principal !== undefined) return principal;
    }

    const token = readCookie(headers.cookie, this.cookie.cookieName);
    if (token === undefined) return undefined;
    return this.authenticateSessionToken(token);
  }

  /** Revokes the session referenced by the request's cookie. */
  logout(headers: { cookie?: string | undefined }): void {
    const token = readCookie(headers.cookie, this.cookie.cookieName);
    if (token === undefined) return;
    const payload = this.verifyToken(token);
    if (payload !== undefined) this.sessions.delete(payload.sid);
  }

  clearCookie(): string {
    const parts = [`${this.cookie.cookieName}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', `SameSite=${capitalize(this.cookie.sameSite)}`];
    if (this.cookie.secure) parts.push('Secure');
    return parts.join('; ');
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private authenticateToken(token: string): Principal | undefined {
    const candidate = hashToken(token);
    const candidateBuffer = Buffer.from(candidate, 'hex');
    for (const entry of this.auth.apiTokens ?? []) {
      if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= this.now()) continue;
      const expected = Buffer.from(entry.tokenHash.toLowerCase(), 'hex');
      if (expected.length !== candidateBuffer.length) continue;
      if (timingSafeEqual(expected, candidateBuffer)) {
        return { kind: 'token', username: entry.name, role: entry.role };
      }
    }
    return undefined;
  }

  private authenticateSessionToken(token: string): Principal | undefined {
    const payload = this.verifyToken(token);
    if (payload === undefined) return undefined;
    const session = this.sessions.get(payload.sid);
    if (session === undefined) return undefined;
    const now = this.now();
    if (now > session.expiresAt || now - session.lastSeen > this.idleMs) {
      this.sessions.delete(session.sid);
      return undefined;
    }
    session.lastSeen = now;
    return {
      kind: 'user',
      username: session.sub,
      role: session.role,
      ...(session.displayName === undefined ? {} : { displayName: session.displayName }),
    };
  }

  private signToken(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `v1.${body}.${this.mac(body)}`;
  }

  private verifyToken(token: string): { sid: string; sub: string; role: Role; iat: number } | undefined {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
    const [, body, signature] = parts;
    if (body === undefined || signature === undefined) return undefined;
    const expected = this.mac(body);
    const actual = Buffer.from(signature, 'base64url');
    const wanted = Buffer.from(expected, 'base64url');
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string' || typeof payload.iat !== 'number') return undefined;
      if (payload.role !== 'admin' && payload.role !== 'operator' && payload.role !== 'viewer') return undefined;
      return { sid: payload.sid, sub: payload.sub, role: payload.role, iat: payload.iat };
    } catch {
      return undefined;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body, 'utf8').digest('base64url');
  }

  private serializeCookie(token: string): string {
    const parts = [
      `${this.cookie.cookieName}=${token}`,
      'Path=/',
      `Max-Age=${this.cookie.maxAgeSeconds}`,
      'HttpOnly',
      `SameSite=${capitalize(this.cookie.sameSite)}`,
    ];
    if (this.cookie.secure) parts.push('Secure');
    return parts.join('; ');
  }

  private recordFailure(key: string): void {
    const now = this.now();
    const windowMs = (this.auth.lockout?.windowMinutes ?? DEFAULTS.lockoutWindowMinutes) * 60_000;
    const state = this.lockouts.get(key);
    if (state === undefined || now - state.firstAttemptAt > windowMs) {
      this.lockouts.set(key, { attempts: 1, firstAttemptAt: now, blockedUntil: 0 });
      return;
    }
    state.attempts += 1;
    const max = this.auth.lockout?.maxAttempts ?? DEFAULTS.lockoutMaxAttempts;
    if (state.attempts >= max) {
      state.blockedUntil = now + (this.auth.lockout?.blockMinutes ?? DEFAULTS.lockoutBlockMinutes) * 60_000;
      state.attempts = 0;
      state.firstAttemptAt = now;
    }
  }

  private lockoutRemaining(key: string): number {
    const state = this.lockouts.get(key);
    if (state === undefined || state.blockedUntil === 0) return 0;
    const remaining = state.blockedUntil - this.now();
    if (remaining <= 0) {
      this.lockouts.delete(key);
      return 0;
    }
    return remaining;
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [sid, session] of this.sessions) {
      if (now > session.expiresAt || now - session.lastSeen > this.idleMs) this.sessions.delete(sid);
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function readBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
