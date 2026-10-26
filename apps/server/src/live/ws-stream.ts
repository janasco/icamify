import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { LiveRegistry, LiveSession, ViewerStreamInfo } from '@icamify/stream';
import type { AuthService } from '../http/auth.ts';

/**
 * MSE endpoint: `GET (Upgrade) /api/cameras/:id/live.ws`.
 *
 * Framing is intentionally simple and explicit:
 *   1. a JSON `stream:init` message carrying camera, codec, MIME type and size,
 *   2. one binary message with the init segment (`ftyp`+`moov`),
 *   3. binary messages, each a complete `moof`+`mdat` fragment.
 *
 * The browser can therefore append blindly, and it knows the codec string before
 * it creates its `MediaSource`. On a pipeline restart a fresh `stream:init`
 * arrives, which the client uses to rebuild the source buffer (the codec can
 * change when a camera reboots into a different profile).
 */

export interface LiveStreamOptions {
  auth: AuthService;
  registry: LiveRegistry;
  pathPrefix?: string;
  log?: (line: string) => void;
}

const PREFIX = '/api/cameras/';
const SUFFIX = '/live.ws';

export interface LiveStreamHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

export function createLiveStreamHandler(options: LiveStreamOptions): LiveStreamHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, clientTracking: false });
  const clients = new Set<WebSocket>();
  const prefix = options.pathPrefix ?? PREFIX;
  let sequence = 0;

  return {
    handleUpgrade(req, socket, head): boolean {
      const url = parseUrl(req);
      if (url === undefined || !url.pathname.startsWith(prefix) || !url.pathname.endsWith(SUFFIX)) return false;

      const cameraId = decodeURIComponent(url.pathname.slice(prefix.length, url.pathname.length - SUFFIX.length));
      if (cameraId.length === 0) {
        reject(socket, 404, 'Camera not found');
        return true;
      }

      const principal = options.auth.authenticate({ cookie: req.headers.cookie, authorization: req.headers.authorization });
      if (principal === undefined && !options.auth.anonymousViewing) {
        reject(socket, 401, 'Unauthorized');
        return true;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        sequence += 1;
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
        const viewerId = `live${sequence}`;
        const viewer = new WsViewer(ws, viewerId);
        const result = options.registry.view(cameraId, 'mse', viewer);
        if (!result.ok) {
          viewer.error(result.message, result.code);
          viewer.closePeer(1008, result.code);
          return;
        }
        const session: LiveSession = result.session;
        ws.on('close', () => {
          options.registry.removeViewer(cameraId, 'mse', viewerId);
        });
        ws.on('error', () => {
          options.registry.removeViewer(cameraId, 'mse', viewerId);
        });
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const text = typeof data === 'string' ? data : data.toString('utf8');
          if (text.length > 1024) return;
          try {
            const message = JSON.parse(text) as { type?: unknown };
            if (message.type === 'ping') viewer.json({ type: 'pong' });
          } catch {
            // A malformed control frame must not tear down the media socket.
          }
        });
        options.log?.(`live viewer ${viewerId} attached to ${cameraId} (${session.viewerCount} total)`);
      });
      return true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) {
          try {
            client.terminate();
          } catch {
            // Already gone.
          }
        }
        clients.clear();
        wss.close(() => resolve());
      }),
  };
}

class WsViewer {
  readonly id: string;
  private readonly socket: WebSocket;

  constructor(socket: WebSocket, id: string) {
    this.socket = socket;
    this.id = id;
  }

  sendInit(info: ViewerStreamInfo, initSegment: Buffer): void {
    this.json({
      type: 'stream:init',
      cameraId: info.cameraId,
      transport: info.transport,
      mimeType: info.mimeType,
      codec: info.codec,
      width: info.width,
      height: info.height,
      segmentMode: info.segmentMode,
    });
    if (initSegment.length > 0) this.binary(initSegment);
  }

  sendSegment(data: Buffer): void {
    this.binary(data);
  }

  sendError(message: string, code?: string): void {
    this.json({ type: 'stream:error', code: code ?? 'stream-error', message });
  }

  close(reason: string): void {
    this.closePeer(1000, reason);
  }

  bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  error(message: string, code: string): void {
    this.sendError(message, code);
  }

  closePeer(code: number, reason: string): void {
    try {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(code, reason.slice(0, 120));
      }
    } catch {
      // Already closed.
    }
  }

  json(message: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The session will notice through bufferedBytes()/close().
    }
  }

  private binary(data: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(data, { binary: true });
    } catch {
      // See json().
    }
  }
}

function parseUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) return;
  const reason = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}
