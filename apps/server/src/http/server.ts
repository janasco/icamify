import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { ResolvedIcamifyConfig } from '@icamify/core';
import { roleAtLeast, type AuthService, type Principal } from './auth.ts';
import { HttpError, methodNotAllowed, sendError } from './responses.ts';
import type { RouteContext, Router } from './router.ts';
import { createStaticHandler, type StaticHandler } from './static.ts';

/**
 * HTTP listener.
 *
 * One place where cross-cutting concerns live — client IP resolution, security
 * headers, rate limiting, authentication, CSRF for cookie-authenticated
 * mutations and structured logging — so no individual route can forget them.
 */

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  clientIp: string;
  user?: string;
}

export interface AppServerOptions {
  config: ResolvedIcamifyConfig;
  auth: AuthService;
  router: Router;
  staticDir?: string;
  log?: (line: string) => void;
  onRequest?: (entry: RequestLogEntry) => void;
  /** Returns true when the upgrade was handled. */
  upgradeHandlers?: Array<(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean>;
}

export interface ListenResult {
  host: string;
  port: number;
  url: string;
  tls: boolean;
}

export interface AppServer {
  server: Server;
  listen(port?: number, host?: string): Promise<ListenResult>;
  close(): Promise<void>;
  listening(): ListenResult | undefined;
}

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'";

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly max: number;

  constructor(windowMs: number, max: number) {
    this.windowMs = Math.max(100, windowMs);
    this.max = Math.max(1, max);
  }

  take(key: string, now: number): boolean {
    const hits = (this.windows.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    if (hits.length >= this.max) {
      this.windows.set(key, hits);
      return false;
    }
    hits.push(now);
    this.windows.set(key, hits);
    if (this.windows.size > 4096) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, hits] of this.windows) {
      if (hits.every((timestamp) => now - timestamp >= this.windowMs)) this.windows.delete(key);
    }
  }
}

export function createAppServer(options: AppServerOptions): AppServer {
  const { config, auth, router } = options;
  const log = options.log ?? (() => {});
  const system = config.system ?? {};
  const limits = system.api?.rateLimit;
  const limiter = limits === undefined ? undefined : new RateLimiter(limits.windowMs ?? 60_000, limits.max ?? 600);
  const trustProxy = system.server?.trustProxy === true;

  const staticHandler: StaticHandler | undefined =
    options.staticDir === undefined
      ? undefined
      : createStaticHandler({ root: options.staticDir, spa: true, contentSecurityPolicy: CSP });

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const clientIp = resolveClientIp(req, trustProxy);
    let status = 500;
    let user: string | undefined;

    const setSecurityHeaders = (): void => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      if (system.tls?.enabled === true) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
    };

    try {
      setSecurityHeaders();

      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      } catch {
        status = 400;
        sendError(res, 400, 'invalid-url', 'The request URL could not be parsed.');
        return;
      }

      if (limiter !== undefined && !limiter.take(clientIp, started)) {
        status = 429;
        sendError(res, 429, 'rate-limited', 'Too many requests. Slow down.', undefined, { 'Retry-After': '5' });
        return;
      }

      const method = (req.method ?? 'GET').toUpperCase();
      const match = router.match(method, url.pathname);
      if (match === undefined) {
        const allowed = router.allowedMethods(url.pathname);
        if (allowed.length > 0) {
          status = 405;
          methodNotAllowed(res, allowed);
          return;
        }
        if (method === 'GET' || method === 'HEAD') {
          if (staticHandler !== undefined && (await staticHandler(req, res, url))) {
            status = res.statusCode;
            return;
          }
        }
        status = 404;
        if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
          sendError(res, 404, 'not-found', `No route for ${method} ${url.pathname}.`);
        } else {
          sendError(res, 404, 'not-found', 'Not found. The web console has not been built yet (run npm run web:build).');
        }
        return;
      }

      const requirement = match.options.auth ?? 'required';
      const principal: Principal | undefined =
        requirement === 'public' ? undefined : auth.authenticate({ cookie: req.headers.cookie, authorization: req.headers.authorization });

      if (principal !== undefined) user = principal.username;

      if (requirement === 'required' && principal === undefined) {
        status = 401;
        sendError(res, 401, 'unauthenticated', 'Sign in to continue.', undefined, {
          'WWW-Authenticate': 'Bearer realm="icamify"',
        });
        return;
      }

      const requiredRole = match.options.role;
      if (principal !== undefined && requiredRole !== undefined) {
        if (!roleAtLeast(principal.role, requiredRole)) {
          status = 403;
          sendError(res, 403, 'forbidden', `This action requires the "${requiredRole}" role.`);
          return;
        }
      }

      if (MUTATING.has(method) && principal?.kind === 'user' && !isSameOrigin(req, config)) {
        status = 403;
        sendError(res, 403, 'cross-origin', 'Cookie-authenticated requests must come from the same origin.');
        return;
      }

      const context: RouteContext = {
        req,
        res,
        url,
        params: match.params,
        query: url.searchParams,
        principal,
        clientIp,
      };
      await match.handler(context);
      status = res.statusCode;
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        if (!res.headersSent) {
          sendError(
            res,
            error.status,
            error.code,
            error.message,
            error.details,
            error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="icamify"' } : {},
          );
        }
      } else if (!res.headersSent) {
        status = 500;
        sendError(res, 500, 'internal-error', 'An unexpected error occurred.');
        log(`request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      } else {
        res.destroy();
      }
    } finally {
      const entry: RequestLogEntry = {
        method: req.method ?? 'GET',
        path: new URL(req.url ?? '/', 'http://local').pathname,
        status,
        durationMs: Date.now() - started,
        clientIp,
        ...(user === undefined ? {} : { user }),
      };
      options.onRequest?.(entry);
      if (status >= 500) {
        log(`${entry.method} ${entry.path} -> ${status} in ${entry.durationMs}ms`);
      }
    }
  };

  let server: Server;
  if (system.tls?.enabled === true) {
    const certFile = system.tls.certFile;
    const keyFile = system.tls.keyFile;
    if (certFile === undefined || keyFile === undefined) {
      throw new Error('system.tls.enabled is true but certFile/keyFile are not both set.');
    }
    server = createHttpsServer(
      {
        cert: readFileSync(certFile),
        key: readFileSync(keyFile),
        minVersion: system.tls.minVersion ?? 'TLSv1.2',
      },
      (req, res) => void requestHandler(req, res),
    );
  } else {
    server = createHttpServer((req, res) => void requestHandler(req, res));
  }

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const upgradeHandlers = options.upgradeHandlers ?? [];
  if (upgradeHandlers.length > 0) {
    // One listener for all upgrade routes. Registering one listener per handler
    // would let a later listener 404 a socket an earlier one already upgraded.
    server.on('upgrade', (req, socket, head) => {
      for (const handler of upgradeHandlers) {
        try {
          if (handler(req, socket, head)) return;
        } catch (error) {
          log(`upgrade handler failed: ${error instanceof Error ? error.message : String(error)}`);
          if (socket.writable) socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
          return;
        }
      }
      // No handler claimed the socket; a half-open upgraded socket would hang
      // the client forever, so reject it explicitly.
      if (socket.writable) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    });
  }

  let listening: ListenResult | undefined;

  return {
    server,
    listening: () => listening,
    listen: (port, host) =>
      new Promise<ListenResult>((resolvePromise, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address() as AddressInfo | null;
          const boundPort = address?.port ?? 0;
          const boundHost = host ?? system.server?.host ?? '0.0.0.0';
          const displayHost = boundHost === '0.0.0.0' || boundHost === '::' ? 'localhost' : boundHost;
          const scheme = system.tls?.enabled === true ? 'https' : 'http';
          listening = { host: boundHost, port: boundPort, url: `${scheme}://${displayHost}:${boundPort}`, tls: scheme === 'https' };
          resolvePromise(listening);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port ?? system.server?.port ?? 8060, host ?? system.server?.host ?? '0.0.0.0');
      }),
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
        // Sockets that are mid-response still count; give them a bounded window
        // instead of hanging shutdown forever.
        setTimeout(() => server.closeAllConnections?.(), 2000).unref?.();
      }),
  };
}

/** Honour X-Forwarded-For only when the operator opted into a trusted proxy. */
export function resolveClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Origin check for state-changing cookie requests. A browser always sends
 * `Origin` for cross-site POSTs, so a mismatch is a CSRF attempt; a missing
 * Origin means a non-browser client (curl, scripts), which is allowed.
 */
export function isSameOrigin(req: IncomingMessage, config: ResolvedIcamifyConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.host;
  if (host !== undefined && originHost === host) return true;
  const publicUrl = config.system?.server?.publicUrl;
  if (publicUrl !== undefined) {
    try {
      if (new URL(publicUrl).host === originHost) return true;
    } catch {
      // Invalid publicUrl is reported by config validation; treat as mismatch.
    }
  }
  return false;
}
