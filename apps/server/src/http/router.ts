import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Role } from '@icamify/core';
import type { Principal } from './auth.ts';

/**
 * Method + path router.
 *
 * Deliberately tiny and dependency-free: iCamify's API is a fixed route table,
 * so a pattern matcher with `:param` segments is enough, and it keeps the
 * request path auditable (no middleware stack, no hidden body parsers).
 */

export type AuthRequirement = 'public' | 'optional' | 'required';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  principal: Principal | undefined;
  clientIp: string;
}

export type RouteHandler = (context: RouteContext) => Promise<void> | void;

export interface RouteOptions {
  auth?: AuthRequirement;
  /** Minimum role once authenticated. */
  role?: Role;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
  options: RouteOptions;
  method: string;
  pattern: string;
}

interface CompiledRoute {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
  options: RouteOptions;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: RouteHandler, options: RouteOptions = {}): this {
    const upper = method.toUpperCase();
    if (!(METHODS as readonly string[]).includes(upper)) {
      throw new Error(`Unsupported HTTP method "${method}" for route ${pattern}.`);
    }
    if (upper === 'GET' || upper === 'HEAD') {
      for (const existing of this.routes) {
        if (existing.method === upper && existing.pattern === pattern) {
          throw new Error(`Duplicate route ${upper} ${pattern}.`);
        }
      }
    }
    this.routes.push({
      method: upper,
      pattern,
      segments: splitPath(pattern),
      handler,
      options,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add('POST', pattern, handler, options);
  }

  put(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add('PUT', pattern, handler, options);
  }

  delete(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method: string, pathname: string): RouteMatch | undefined {
    const segments = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params === undefined) continue;
      return { handler: route.handler, params, options: route.options, method: route.method, pattern: route.pattern };
    }
    return undefined;
  }

  /** For the `Allow` header on a 405. */
  allowedMethods(pathname: string): string[] {
    const segments = splitPath(pathname);
    const methods = new Set<string>();
    for (const route of this.routes) {
      if (matchSegments(route.segments, segments) !== undefined) methods.add(route.method);
    }
    if (methods.has('GET')) methods.add('HEAD');
    return [...methods].sort();
  }

  routes_(): ReadonlyArray<{ method: string; pattern: string }> {
    return this.routes.map((route) => ({ method: route.method, pattern: route.pattern }));
  }
}

export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const value = actual[index] as string;
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
      continue;
    }
    if (expected !== value) return undefined;
  }
  return params;
}
