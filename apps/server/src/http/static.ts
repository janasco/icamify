import { readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * Static file serving for the built console.
 *
 * The SPA is served from the same origin as the API, which is what keeps the
 * session cookie, WebSocket and MSE endpoints free of CORS entirely. Path
 * traversal is blocked by resolving inside the root and re-checking the prefix;
 * a missing file falls back to `index.html` only for extension-less GETs.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticHandlerOptions {
  root: string;
  /** Serve index.html for unknown extension-less paths (client-side routes). */
  spa?: boolean;
  /** Sent on HTML responses; empty string disables the header. */
  contentSecurityPolicy?: string;
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

export function createStaticHandler(options: StaticHandlerOptions): StaticHandler {
  const root = resolve(options.root);
  const indexFile = join(root, 'index.html');
  const spa = options.spa !== false;

  return async (req, res, url): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const head = req.method === 'HEAD';

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (pathname.includes('\0')) return false;

    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    let target = resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      // `..` escaped the root.
      return false;
    }

    let info = await statOrUndefined(target);
    if (info?.isDirectory() === true) {
      target = join(target, 'index.html');
      info = await statOrUndefined(target);
    }

    if (info === undefined || !info.isFile()) {
      const looksLikeAsset = extname(relative).length > 0;
      if (!spa || looksLikeAsset) return false;
      target = indexFile;
      info = await statOrUndefined(target);
      if (info === undefined) return false;
    }

    const extension = extname(target).toLowerCase();
    const size = Number(info.size);
    const header: Record<string, string | number> = {
      'Content-Type': MIME[extension] ?? 'application/octet-stream',
      'Content-Length': size,
      'Last-Modified': info.mtime.toUTCString(),
      ETag: `W/"${size}-${Math.round(info.mtimeMs)}"`,
      'Cache-Control':
        target === indexFile
          ? 'no-cache'
          : url.pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600',
    };
    if (extension === '.html' && options.contentSecurityPolicy !== undefined) {
      header['Content-Security-Policy'] = options.contentSecurityPolicy;
    }

    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').map((value) => value.trim()).includes(String(header.ETag))) {
      res.writeHead(304, { ETag: header.ETag, 'Cache-Control': header['Cache-Control'] as string });
      res.end();
      return true;
    }

    if (head) {
      res.writeHead(200, header);
      res.end();
      return true;
    }

    try {
      const body = await readFile(target);
      res.writeHead(200, header);
      res.end(body);
      return true;
    } catch {
      return false;
    }
  };
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    // The non-bigint overload is the default call shape here.
    return (await stat(path, { bigint: false })) as Stats;
  } catch {
    return undefined;
  }
}
