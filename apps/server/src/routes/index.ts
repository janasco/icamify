import type { ResolvedIcamifyConfig } from '@icamify/core';
import { redactConfig } from '@icamify/core';
import type { LiveRegistry } from '@icamify/stream';
import type { FfmpegToolchain } from '@icamify/media';
import type { AuthService, Principal } from '../http/auth.ts';
import { HttpError, readJsonBody, sendBuffer, sendJson } from '../http/responses.ts';
import type { RouteContext, Router } from '../http/router.ts';
import { createMjpegHandler } from '../live/mjpeg.ts';
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
  log?: (line: string) => void;
}

export function registerRoutes(router: Router, deps: ApiDeps): void {
  const requireView = (context: RouteContext): Principal | undefined => {
    if (context.principal !== undefined) return context.principal;
    if (deps.auth.anonymousViewing) return undefined;
    throw new HttpError(401, 'unauthenticated', 'Sign in to view cameras.');
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
        features: { recording: false, motion: false, ai: false, retention: false, timeline: false },
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
