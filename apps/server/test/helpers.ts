import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG, type AuthConfig, type CameraConfig, type ResolvedIcamifyConfig, type StreamingConfig } from '@icamify/core';
import type { FfmpegToolchain } from '@icamify/media';
import type { LiveRegistry } from '@icamify/stream';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../src/index.ts';

/** Shared fixtures for the server tests. */

export const CAMERA: CameraConfig = {
  id: 'front-door',
  name: 'Front door',
  enabled: true,
  streams: { main: { type: 'file', path: './data/sample.mp4' } },
  profiles: { record: 'record-main', live: 'live-sub', detect: 'detect-sub' },
};

export const STUB_TOOLCHAIN: FfmpegToolchain = {
  ffmpeg: { path: 'ffmpeg', version: { major: 7, minor: 0, patch: 2, raw: '7.0.2' } },
  ffprobe: { path: 'ffprobe', version: { major: 7, minor: 0, patch: 2, raw: '7.0.2' } },
  capabilities: {
    encoders: ['libx264', 'libx265', 'aac', 'mjpeg'],
    filters: ['scale', 'fps'],
    demuxers: ['rtsp', 'rtmp', 'mjpeg'],
    muxers: ['matroska', 'mp4', 'mjpeg'],
    protocols: ['file', 'pipe'],
    hwaccels: [],
  },
  warnings: [],
  hasEncoder: () => true,
  hasFilter: () => true,
  hasProtocol: () => true,
  hasDemuxer: () => true,
};

export interface TestConfigOptions {
  auth?: Partial<AuthConfig>;
  cameras?: CameraConfig[];
  streaming?: Partial<StreamingConfig>;
}

export function testConfig(options: TestConfigOptions = {}): ResolvedIcamifyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { ...config.auth, ...options.auth };
  config.cameras = options.cameras ?? [CAMERA];
  config.streaming = { ...config.streaming, ...options.streaming };
  config.system.api = { ...config.system.api, rateLimit: { windowMs: 1000, max: 10_000 } };
  config.system.web = { ...config.system.web, serveStatic: false };
  return config;
}

export const EMPTY_AUTH: Partial<AuthConfig> = {
  mode: 'none',
  allowAnonymousViewing: true,
  users: [],
  apiTokens: [],
};

export async function withServer(
  config: ResolvedIcamifyConfig,
  run: (server: RunningServer) => Promise<void>,
  options: { staticDir?: string | false } = {},
): Promise<void> {
  const server = await startServer({
    config,
    toolchain: STUB_TOOLCHAIN,
    host: '127.0.0.1',
    port: 0,
    staticDir: options.staticDir ?? false,
    log: () => {},
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

export interface HttpResponseText {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export function originOf(server: RunningServer): string {
  return server.listen.url.replace('localhost', '127.0.0.1');
}

export async function request(
  server: RunningServer,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<HttpResponseText> {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  const response = await fetch(`${originOf(server)}${path}`, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export function cookieFrom(response: HttpResponseText): string {
  const setCookie = response.headers.getSetCookie();
  const first = setCookie[0];
  if (first === undefined) throw new Error('response did not set a cookie');
  return first.split(';')[0] ?? '';
}

export interface ControlConnection {
  socket: WebSocket;
  /** JSON messages in arrival order; collected from before the socket opens. */
  received: Array<Record<string, unknown>>;
}

/** Opens a control socket and resolves once it is open. */
export function connectControl(server: RunningServer, cookie?: string): Promise<ControlConnection> {
  const url = `${originOf(server).replace('http', 'ws')}/ws`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } });
    const received: Array<Record<string, unknown>> = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once('open', () => resolve({ socket, received }));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`unexpected response ${response.statusCode}`));
    });
  });
}

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function listenPort(registry: LiveRegistry): number {
  const stats = registry.stats();
  return stats.length;
}

export function ephemeralOrigin(server: import('node:http').Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
