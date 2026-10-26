import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { ResolvedIcamifyConfig } from '@icamify/core';
import { redactConfig } from '@icamify/core';
import type { LiveRegistry } from '@icamify/stream';
import type { FfmpegToolchain } from '@icamify/media';
import type { RecordingEventKind, RecordingSegment, SegmentReason } from '@icamify/storage';
import type { AuthService, Principal } from '../http/auth.ts';
import { HttpError, readJsonBody, sendBuffer, sendJson } from '../http/responses.ts';
import type { RouteContext, Router } from '../http/router.ts';
import { createMjpegHandler } from '../live/mjpeg.ts';
import type { MotionService } from '../motion/service.ts';
import type { RecordingManager } from '../recording/manager.ts';
import type { CameraRuntime, CameraView } from '../runtime.ts';
import type { SignalingService } from '../webrtc/signaling.ts';

/**
 * API surface.
 *
 * Route table, roles and the anonymous-viewing rule all live here so the
 * authorization model is readable in one file. Media and signaling details are
 * delegated to the runtime and services.
 */

export interface ApiDeps {
  config: ResolvedIcamifyConfig;
  auth: AuthService;
  runtime: CameraRuntime;
  registry: LiveRegistry;
  signaling: SignalingService;
  version: string;
  startedAt: number;
  toolchain?: FfmpegToolchain;
  staticDir?: string;
  publicUrl?: string;
  recording?: RecordingManager;
  motion?: MotionService;
  log?: (line: string) => void;
}

export function registerRoutes(router: Router, deps: ApiDeps): void {
  const requireView = (context: RouteContext): Principal | undefined => {
    if (context.principal !== undefined) return context.principal;
    if (deps.auth.anonymousViewing) return undefined;
    throw new HttpError(401, 'unauthenticated', 'Sign in to view cameras.');
  };

  const requireRecording = (): RecordingManager => {
    if (deps.recording === undefined) {
      throw new HttpError(503, 'recording-unavailable', 'Recording is not enabled on this server.');
    }
    return deps.recording;
  };

  // -- liveness / readiness --------------------------------------------------

  router.get(
    '/health',
    (_context) => {
      sendJson(_context.res, 200, { status: 'ok', version: deps.version });
    },
    { auth: 'public' },
  );

  router.get(
    '/api/health',
    (context) => {
      const cameras = deps.runtime.cameras();
      sendJson(context.res, 200, {
        status: 'ok',
        version: deps.version,
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        cameras: {
          total: cameras.length,
          enabled: cameras.filter((camera) => camera.enabled).length,
          live: cameras.filter((camera) => camera.status.state === 'live').length,
        },
        liveSessions: deps.registry.stats().length,
        viewers: cameras.reduce((total, camera) => total + camera.status.viewers, 0),
        ffmpeg: deps.toolchain === undefined ? null : { version: versionString(deps.toolchain) },
      });
    },
    { auth: 'optional' },
  );

  // -- authentication --------------------------------------------------------

  router.post(
    '/api/auth/login',
    async (context) => {
      const body = await readJsonBody(context.req);
      const username = body.username;
      const password = body.password;
      if (typeof username !== 'string' || typeof password !== 'string' || username.length === 0 || password.length === 0) {
        throw new HttpError(400, 'invalid-credentials', 'username and password are required.');
      }
      const result = await deps.auth.login(username, password, context.clientIp);
      if (!result.ok) {
        const status = result.code === 'locked-out' ? 429 : result.code === 'auth-disabled' ? 400 : 401;
        const headers: Record<string, string> =
          result.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(result.retryAfterSeconds) };
        throw new HttpError(status, result.code, result.message);
      }
      sendJson(
        context.res,
        200,
        {
          user: {
            username: result.principal.username,
            role: result.principal.role,
            ...(result.principal.displayName === undefined ? {} : { displayName: result.principal.displayName }),
          },
        },
        { 'Set-Cookie': result.cookie },
      );
    },
    { auth: 'public' },
  );

  router.post(
    '/api/auth/logout',
    (context) => {
      deps.auth.logout({ cookie: context.req.headers.cookie });
      context.res.setHeader('Set-Cookie', deps.auth.clearCookie());
      sendJson(context.res, 200, { ok: true });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/auth/me',
    (context) => {
      sendJson(context.res, 200, {
        authenticated: context.principal !== undefined,
        user:
          context.principal === undefined
            ? null
            : {
                username: context.principal.username,
                role: context.principal.role,
                kind: context.principal.kind,
                ...(context.principal.displayName === undefined ? {} : { displayName: context.principal.displayName }),
              },
        auth: {
          mode: deps.auth.open ? 'none' : 'local',
          signInRequired: !deps.auth.open,
          allowAnonymousViewing: deps.auth.anonymousViewing,
          userCount: deps.auth.userCount,
        },
      });
    },
    { auth: 'optional' },
  );

  // -- system ----------------------------------------------------------------

  router.get(
    '/api/system',
    (context) => {
      requireView(context);
      sendJson(context.res, 200, {
        version: deps.version,
        uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
        startedAt: new Date(deps.startedAt).toISOString(),
        timezone: deps.config.system.timezone ?? 'UTC',
        ffmpeg: deps.toolchain === undefined ? null : describeToolchainForApi(deps.toolchain),
        auth: {
          mode: deps.auth.open ? 'none' : 'local',
          allowAnonymousViewing: deps.auth.anonymousViewing,
          userCount: deps.auth.userCount,
        },
        transports: {
          ladder: deps.registry.limits.fallbackChain,
          availability: deps.registry.availability(),
          webrtc: deps.signaling.capabilities(),
        },
        web: { staticServed: deps.staticDir !== undefined },
        features: {
          recording: deps.recording !== undefined,
          motion: deps.motion !== undefined,
          ai: false,
          retention: false,
          // The timeline UI ships with the storage phase; the API it needs is live.
          timeline: deps.recording !== undefined,
        },
      });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/system/config',
    (context) => {
      sendJson(context.res, 200, redactConfig(deps.config));
    },
    { auth: 'required', role: 'admin' },
  );

  router.get(
    '/api/webrtc',
    (context) => {
      requireView(context);
      sendJson(context.res, 200, deps.signaling.capabilities());
    },
    { auth: 'optional' },
  );

  // -- cameras ---------------------------------------------------------------

  router.get(
    '/api/cameras',
    (context) => {
      requireView(context);
      sendJson(context.res, 200, { cameras: deps.runtime.cameras() });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/cameras/:id',
    (context) => {
      requireView(context);
      const camera = deps.runtime.camera(context.params.id ?? '');
      if (camera === undefined) throw new HttpError(404, 'camera-not-found', 'Camera not found.');
      sendJson(context.res, 200, { camera: deps.runtime.view(camera) });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/cameras/:id/snapshot.jpg',
    async (context) => {
      requireView(context);
      const width = clampWidth(context.query.get('w'));
      const result = await deps.runtime.snapshot(context.params.id ?? '', width);
      sendBuffer(context.res, 200, result.jpeg, 'image/jpeg', { 'Cache-Control': 'no-store' });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/cameras/:id/live-argv',
    (context) => {
      const argv = deps.runtime.liveArgv(context.params.id ?? '', context.query.get('transport') === 'mjpeg' ? 'mjpeg' : 'mse');
      sendJson(context.res, 200, { argv });
    },
    { auth: 'required', role: 'operator' },
  );

  router.get('/api/cameras/:id/live.mjpeg', createMjpegHandler({ registry: deps.registry, auth: deps.auth }), {
    auth: 'optional',
  });

  // -- motion ----------------------------------------------------------------

  router.get(
    '/api/cameras/:id/motion',
    (context) => {
      requireView(context);
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      const status = deps.motion?.viewForCamera(camera);
      sendJson(context.res, 200, { cameraId: camera.id, motion: status ?? null });
    },
    { auth: 'optional' },
  );

  router.put(
    '/api/cameras/:id/motion',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      if (deps.motion === undefined) {
        throw new HttpError(503, 'motion-unavailable', 'Motion detection is not enabled on this server.');
      }
      const body = await readJsonBody(context.req, { maxBytes: 128 * 1024 });
      try {
        const status = await deps.motion.configure(camera.id, {
          ...(body.sensitivity === undefined ? {} : { sensitivity: Number(body.sensitivity) }),
          ...(body.zones === undefined ? {} : { zones: body.zones as Parameters<MotionService['configure']>[1]['zones'] }),
        });
        deps.log?.(`motion settings updated for ${camera.id} by ${context.principal?.username ?? 'anonymous'}`);
        sendJson(context.res, 200, { motion: status });
      } catch (error) {
        throw new HttpError(400, 'invalid-motion-settings', error instanceof Error ? error.message : String(error));
      }
    },
    { auth: 'required', role: 'operator' },
  );

  // -- recordings ------------------------------------------------------------

  router.get(
    '/api/recordings',
    (context) => {
      requireView(context);
      const recording = requireRecording();
      const cameraId = context.query.get('cameraId') ?? undefined;
      const from = parseTime(context.query.get('from'));
      const to = parseTime(context.query.get('to'));
      const reason = parseReason(context.query.get('reason'));
      const hasMotion = parseBoolean(context.query.get('hasMotion'));
      const query = {
        ...(cameraId === undefined ? {} : { cameraId }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(reason === undefined ? {} : { reason }),
        ...(hasMotion === undefined ? {} : { hasMotion }),
        limit: parseInteger(context.query.get('limit'), 100),
        offset: parseInteger(context.query.get('offset'), 0),
        order: context.query.get('order') === 'asc' ? ('asc' as const) : ('desc' as const),
      };
      sendJson(context.res, 200, {
        segments: recording.index.listSegments(query),
        total: recording.index.countSegments(query),
        stats: recording.index.stats(cameraId === undefined ? {} : { cameraId }),
        request: { ...query },
      });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/recordings/:id',
    (context) => {
      requireView(context);
      const recording = requireRecording();
      const segment = recording.segment(context.params.id ?? '');
      if (segment === undefined) throw new HttpError(404, 'recording-not-found', 'Recording not found.');
      const events = segment.eventIds.map((id) => recording.index.getEvent(id)).filter((event) => event !== undefined);
      sendJson(context.res, 200, { segment, events });
    },
    { auth: 'optional' },
  );

  // Byte ranges are what a <video> element needs to seek inside a 15-minute file.
  router.get(
    '/api/recordings/:id/file',
    async (context) => {
      requireView(context);
      const recording = requireRecording();
      const segment = recording.segment(context.params.id ?? '');
      if (segment === undefined) throw new HttpError(404, 'recording-not-found', 'Recording not found.');
      await sendSegmentFile(context, segment);
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/events',
    (context) => {
      requireView(context);
      const recording = requireRecording();
      const cameraId = context.query.get('cameraId') ?? undefined;
      const kind = context.query.get('kind') ?? undefined;
      const from = parseTime(context.query.get('from'));
      const to = parseTime(context.query.get('to'));
      sendJson(context.res, 200, {
        events: recording.index.listEvents({
          ...(cameraId === undefined ? {} : { cameraId }),
          ...(kind === undefined ? {} : { kind: kind as RecordingEventKind }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          limit: parseInteger(context.query.get('limit'), 100),
          order: context.query.get('order') === 'asc' ? ('asc' as const) : ('desc' as const),
        }),
      });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/cameras/:id/recording',
    (context) => {
      requireView(context);
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      const recording = requireRecording();
      sendJson(context.res, 200, {
        status: recording.status(camera.id) ?? null,
        stats: recording.index.stats({ cameraId: camera.id }),
        recent: recording.index.listSegments({ cameraId: camera.id, limit: 10 }),
      });
    },
    { auth: 'optional' },
  );

  // -- layouts ---------------------------------------------------------------

  router.get(
    '/api/layouts',
    (context) => {
      requireView(context);
      const layouts = deps.config.layouts ?? [];
      const cameras: CameraView[] = deps.runtime.cameras();
      sendJson(context.res, 200, {
        layouts,
        defaultLayoutId: layouts.find((layout) => layout.isDefault)?.id ?? layouts[0]?.id,
        cameras: cameras.map((camera) => ({ id: camera.id, name: camera.name, order: camera.ui.order ?? 1000 })),
      });
    },
    { auth: 'optional' },
  );
}

async function sendSegmentFile(context: RouteContext, segment: RecordingSegment): Promise<void> {
  const info = await stat(segment.path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new HttpError(410, 'recording-missing', 'The recording file is no longer on disk (retention may have removed it).');
  }
  const contentType = videoContentType(segment.path);
  const range = parseRange(context.req.headers.range, info.size);
  if (range === 'invalid') {
    context.res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' });
    context.res.end();
    return;
  }
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };
  if (range === undefined) {
    context.res.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
    await pipeline(createReadStream(segment.path), context.res);
    return;
  }
  context.res.writeHead(206, {
    ...headers,
    'Content-Length': String(range.end - range.start + 1),
    'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
  });
  await pipeline(createReadStream(segment.path, { start: range.start, end: range.end }), context.res);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (header === undefined || size === 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(size - 1, Number(rawEnd));
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end };
}

function videoContentType(path: string): string {
  if (path.endsWith('.mkv')) return 'video/x-matroska';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

function parseTime(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function parseBoolean(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function parseReason(raw: string | null): SegmentReason | undefined {
  switch (raw) {
    case 'continuous':
    case 'motion':
    case 'alert':
    case 'scheduled':
    case 'manual':
      return raw;
    default:
      return undefined;
  }
}

function clampWidth(raw: string | null): number {
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return 960;
  return Math.max(80, Math.min(3840, Math.round(value)));
}

function versionString(toolchain: FfmpegToolchain): string {
  const { major, minor, patch } = toolchain.ffmpeg.version;
  return `${major}.${minor}.${patch}`;
}

function describeToolchainForApi(toolchain: FfmpegToolchain): { version: string; encoders: string[]; demuxers: string[] } {
  const encoders = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_videotoolbox'].filter(
    (name) => toolchain.hasEncoder(name),
  );
  return {
    version: versionString(toolchain),
    encoders,
    demuxers: ['rtsp', 'rtmp', 'flv', 'mjpeg', 'hls'].filter((name) => toolchain.hasDemuxer(name)),
  };
}
