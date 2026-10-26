import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { AuthService, Principal } from '../http/auth.ts';
import type { CameraView } from '../runtime.ts';
import type { SignalingService } from '../webrtc/signaling.ts';
import { parseClientMessage, type ServerMessage } from './protocol.ts';

/**
 * Authenticated control WebSocket.
 *
 * Clients connect once, receive the camera snapshot, and then get push updates
 * when a camera's live state changes. WebRTC signaling rides the same socket,
 * which keeps one authorization decision per browser tab instead of one per
 * transport.
 *
 * Slow consumers are dropped rather than buffered: status updates are cheap to
 * regenerate on reconnect, so there is no reason to accumulate megabytes for a
 * tab that stopped reading.
 */

export interface HubSnapshot {
  cameras: CameraView[];
}

export interface WsHubOptions {
  auth: AuthService;
  path?: string;
  heartbeatSeconds?: number;
  maxClients?: number;
  startedAt?: number;
  version: string;
  snapshot: () => HubSnapshot;
  signaling?: SignalingService;
  log?: (line: string) => void;
  now?: () => number;
}

interface ClientState {
  socket: WebSocket;
  id: string;
  principal: Principal | undefined;
  topics: Set<string>;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  remote: string;
}

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MESSAGE_BURST = 30;
const MESSAGE_REFILL_PER_SECOND = 20;

export class WsHub {
  private readonly options: WsHubOptions;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ClientState>();
  private readonly path: string;
  private readonly startedAt: number;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;

  constructor(options: WsHubOptions) {
    this.options = options;
    this.path = options.path ?? '/ws';
    this.startedAt = options.startedAt ?? Date.now();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, clientTracking: false });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attaches to the HTTP server's `upgrade` event. Returns true when handled. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseUrl(req);
    if (url === undefined || url.pathname !== this.path) return false;

    const principal = this.options.auth.authenticate({
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    if (principal === undefined && !this.options.auth.anonymousViewing) {
      reject(socket, 401, 'Unauthorized');
      return true;
    }
    const maxClients = this.options.maxClients ?? 64;
    if (this.clients.size >= maxClients) {
      reject(socket, 503, 'Too many WebSocket clients');
      return true;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, principal, req));
    return true;
  }

  /** Broadcasts the full camera list to every client subscribed to cameras. */
  broadcastCameras(cameras: CameraView[]): void {
    this.broadcast({ type: 'cameras', cameras });
  }

  broadcastCamera(camera: CameraView): void {
    this.broadcast({ type: 'camera:status', camera });
  }

  broadcast(message: ServerMessage, topic?: string): void {
    for (const client of this.clients.values()) {
      if (topic !== undefined && !client.topics.has(topic)) continue;
      this.send(client, message);
    }
  }

  /** Closes every client and stops the heartbeat. Safe to call twice. */
  async close(): Promise<void> {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        // Socket already closing.
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private attach(socket: WebSocket, principal: Principal | undefined, req: IncomingMessage): void {
    const id = `ws${this.nextId++}`;
    const client: ClientState = {
      socket,
      id,
      principal,
      topics: new Set(['cameras']),
      alive: true,
      tokens: MESSAGE_BURST,
      lastRefill: this.now(),
      remote: req.socket.remoteAddress ?? 'unknown',
    };
    this.clients.set(id, client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(id);
    });
    socket.on('error', () => {
      this.clients.delete(id);
    });
    socket.on('message', (data: RawData, isBinary: boolean) => void this.onMessage(client, data, isBinary));

    this.startHeartbeat();
    this.send(client, this.welcome(client));
  }

  private welcome(client: ClientState): ServerMessage {
    return {
      type: 'welcome',
      user:
        client.principal === undefined
          ? null
          : { username: client.principal.username, role: client.principal.role, kind: client.principal.kind },
      server: {
        version: this.options.version,
        uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000),
        startedAt: new Date(this.startedAt).toISOString(),
      },
      cameras: this.options.snapshot().cameras,
      topics: [...client.topics],
    };
  }

  private async onMessage(client: ClientState, data: RawData, isBinary: boolean): Promise<void> {
    if (!this.takeToken(client)) {
      this.send(client, { type: 'error', code: 'rate-limited', message: 'Too many messages; slow down.' });
      return;
    }
    if (isBinary) {
      this.send(client, { type: 'error', code: 'invalid-message', message: 'Binary frames are not accepted on this channel.' });
      return;
    }
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const message = parseClientMessage(text);
    if (message.type === 'invalid') {
      this.send(client, { type: 'error', code: 'invalid-message', message: message.message });
      return;
    }

    switch (message.type) {
      case 'subscribe': {
        for (const topic of message.topics) {
          if (topic === 'cameras') client.topics.add(topic);
        }
        this.send(client, { type: 'subscribed', topics: [...client.topics] });
        if (client.topics.has('cameras')) {
          this.send(client, { type: 'cameras', cameras: this.options.snapshot().cameras });
        }
        return;
      }
      case 'unsubscribe': {
        for (const topic of message.topics) client.topics.delete(topic);
        this.send(client, { type: 'subscribed', topics: [...client.topics] });
        return;
      }
      case 'ping':
        this.send(client, { type: 'pong', ...(message.t === undefined ? {} : { t: message.t }) });
        return;
      case 'webrtc:offer': {
        const signaling = this.options.signaling;
        if (signaling === undefined) {
          this.send(client, { type: 'webrtc:error', code: 'engine-unavailable', message: 'WebRTC is not configured.' });
          return;
        }
        const result = await signaling.offer({ cameraId: message.cameraId, sdp: message.sdp, principal: client.principal });
        if (result.ok) {
          this.send(client, { type: 'webrtc:answer', sessionId: result.sessionId, cameraId: result.cameraId, sdp: result.sdp });
        } else {
          this.send(client, { type: 'webrtc:error', code: result.code, message: result.message });
        }
        return;
      }
      case 'webrtc:ice': {
        const result = this.options.signaling?.addCandidate(message.sessionId, message.candidate);
        if (result !== undefined && !result.ok) {
          this.send(client, { type: 'webrtc:error', code: 'unknown-session', message: result.message ?? 'Unknown session.' });
        }
        return;
      }
      case 'webrtc:close':
        this.options.signaling?.close(message.sessionId);
        return;
    }
  }

  private takeToken(client: ClientState): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - client.lastRefill) / 1000;
    client.lastRefill = now;
    client.tokens = Math.min(MESSAGE_BURST, client.tokens + elapsed * MESSAGE_REFILL_PER_SECOND);
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  private send(client: ClientState, message: ServerMessage): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // A tab that cannot read status updates is of no use to anyone; drop it
      // instead of letting its queue grow.
      client.socket.terminate();
      this.clients.delete(client.id);
      return;
    }
    try {
      client.socket.send(JSON.stringify(message));
    } catch (error) {
      this.options.log?.(`websocket send failed for ${client.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    const seconds = Math.max(5, this.options.heartbeatSeconds ?? 30);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.socket.terminate();
          this.clients.delete(client.id);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client.id);
        }
      }
    }, seconds * 1000);
    this.heartbeat.unref?.();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
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
  const reason = status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'Forbidden';
  if (!socket.writable) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}
