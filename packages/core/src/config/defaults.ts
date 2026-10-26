import { allActiveMask } from './mask.ts';
import type { ResolvedIcamifyConfig, StreamProfile } from './types.ts';

/**
 * Built-in defaults. Every user document is deep-merged on top of this, so the
 * runtime can rely on these sections existing. Arrays are replaced, not merged:
 * an explicit `cameras: []` really means no cameras.
 */

export const DEFAULT_PROFILES: Record<string, StreamProfile> = {
  'record-main': {
    description: 'Direct-to-disk: remux the main stream without re-encoding.',
    purpose: 'record',
    copy: true,
    video: { codec: 'copy' },
    audio: { codec: 'copy' },
    container: 'mkv',
  },
  'live-sub': {
    description: 'Grid tile, browser-safe H.264 in fragmented MP4.',
    purpose: 'live',
    video: {
      codec: 'h264',
      width: 640,
      height: 360,
      fps: 15,
      bitrateKbps: 700,
      maxBitrateKbps: 1200,
      gopSeconds: 1,
      preset: 'veryfast',
      profile: 'main',
      pixelFormat: 'yuv420p',
      hardwareAcceleration: 'auto',
      bframes: 0,
    },
    audio: { codec: 'opus', bitrateKbps: 32, sampleRate: 48000, channels: 1 },
    container: 'fmp4',
    latency: 'low',
  },
  'detect-sub': {
    description: 'Tiny stream for the pixel motion engine.',
    purpose: 'detect',
    video: {
      codec: 'h264',
      width: 320,
      height: 180,
      fps: 5,
      bitrateKbps: 200,
      maxBitrateKbps: 400,
      gopSeconds: 2,
      preset: 'ultrafast',
      pixelFormat: 'yuv420p',
    },
    audio: { codec: 'none' },
    container: 'mpegts',
    latency: 'low',
  },
};

export const DEFAULT_CONFIG: ResolvedIcamifyConfig = {
  version: '1.0',
  system: {
    server: { host: '0.0.0.0', port: 8060, trustProxy: false },
    tls: { enabled: false, minVersion: 'TLSv1.2' },
    logging: { level: 'info', maxFileMb: 64, maxFiles: 5, pretty: false, redactSecrets: true },
    timezone: 'UTC',
    workers: { motion: 2, ai: 2, thumbnail: 1 },
    shutdownGraceSeconds: 15,
    healthCheckSeconds: 10,
    api: {
      basePath: '/api',
      corsOrigins: [],
      rateLimit: { windowMs: 60000, max: 600 },
      websocket: { path: '/ws', heartbeatSeconds: 20, maxClients: 64 },
    },
    web: { serveStatic: true, staticDir: './apps/web/dist' },
  },
  auth: {
    mode: 'local',
    allowAnonymousViewing: false,
    session: {
      cookieName: 'icamify_session',
      ttlHours: 24,
      idleTimeoutMinutes: 120,
      secureCookie: true,
      sameSite: 'lax',
    },
    users: [],
    apiTokens: [],
    lockout: { maxAttempts: 8, windowMinutes: 15, blockMinutes: 15 },
  },
  storage: {
    rootDir: './data',
    recordingsDir: 'recordings',
    snapshotsDir: 'snapshots',
    stateDir: 'state',
    tempDir: 'tmp',
    format: 'mkv',
    filenameTemplate: '{cameraId}/{date}/{time}-{reason}.{ext}',
    segmentMinutes: 15,
    preBufferSeconds: 5,
    preBufferMaxMemoryMb: 512,
    snapshot: { format: 'jpg', quality: 85, maxWidth: 1280 },
    volumes: [],
    purge: {
      enabled: true,
      intervalSeconds: 300,
      strategy: 'oldest-first',
      batchSize: 50,
      dryRun: false,
      protectFlagged: true,
    },
    diskHealthCheckSeconds: 60,
    warnAtPercent: 90,
    archiveProviders: [],
  },
  streaming: {
    profiles: DEFAULT_PROFILES,
    defaults: { record: 'record-main', live: 'live-sub', detect: 'detect-sub' },
    webrtc: {
      enabled: true,
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      portRange: { min: 40000, max: 40099 },
      codecPreference: ['h264', 'vp8', 'vp9'],
      maxBitrateKbps: 4000,
      maxViewersPerCamera: 8,
      fallbackAfterMs: 4000,
    },
    mse: { enabled: true, segmentDurationMs: 1000, windowSegments: 8 },
    hls: { enabled: false, segmentSeconds: 4, playlistSize: 6 },
    mjpeg: { enabled: true, fps: 5, width: 640, quality: 70 },
    fallbackChain: ['webrtc', 'mse', 'mjpeg'],
    maxConcurrentSessions: 32,
    sessionIdleTimeoutSeconds: 60,
    onDemandStart: true,
  },
  motion: {
    enabled: true,
    intervalMs: 200,
    // threshold/percentThreshold are intentionally absent: the motion engine
    // derives them from `sensitivity` unless the operator sets them explicitly.
    sensitivity: 50,
    minBlobPercent: 0.2,
    blurRadius: 2,
    grayscale: true,
    denoise: 1,
    zones: { cols: 16, rows: 16, cells: allActiveMask(16, 16), mode: 'include' },
    cooldownSeconds: 10,
    warmupFrames: 10,
    postMotionSeconds: 10,
  },
  cameras: [],
  groups: [],
  layouts: [],
  schedules: [],
  rules: [],
  notifications: { dedupeSeconds: 30, channels: [] },
  ai: {
    enabled: true,
    storeDetectionsDays: 30,
    maxDetectionsPerFrame: 50,
    providers: [],
  },
  onvif: {
    discovery: {
      enabled: true,
      intervalSeconds: 300,
      multicastAddress: '239.255.255.250',
      multicastPort: 3702,
      subnets: [],
      timeoutMs: 3000,
    },
    defaults: { timeoutMs: 5000 },
    ptz: { continuousMoveMs: 400, defaultSpeed: 0.5 },
  },
  plugins: {
    enabled: true,
    directories: ['./data/plugins'],
    trustedPlugins: [],
    timeoutMs: 15000,
    workerMemoryMb: 256,
  },
};

/** Config keys that may be overridden directly from the process environment. */
export const ENV_OVERRIDES: ReadonlyArray<{
  env: string;
  path: string;
  parse?: (raw: string) => string | number | boolean;
}> = [
  { env: 'ICAMIFY_HOST', path: 'system.server.host' },
  { env: 'ICAMIFY_PORT', path: 'system.server.port', parse: (raw) => Number(raw) },
  { env: 'ICAMIFY_PUBLIC_URL', path: 'system.server.publicUrl' },
  { env: 'ICAMIFY_LOG_LEVEL', path: 'system.logging.level' },
  { env: 'ICAMIFY_TIMEZONE', path: 'system.timezone' },
  { env: 'ICAMIFY_DATA_DIR', path: 'storage.rootDir' },
];
