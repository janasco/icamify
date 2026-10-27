import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { ResolvedIcamifyConfig } from '@icamify/core';
import { redactConfig } from '@icamify/core';
import type { LiveRegistry } from '@icamify/stream';
import { createRemuxStream, type FfmpegToolchain } from '@icamify/media';
import type { AiOverride, AiService } from '../ai/service.ts';
import { resolveSnapshotPath } from '../ai/snapshots.ts';
import type { Gateway } from '@icamify/ai';
import type { RuleEngine } from '../rules/engine.ts';
import type { RecordingEventKind, RecordingSegment, SegmentReason } from '@icamify/storage';
import type { AuthService, Principal } from '../http/auth.ts';
import { HttpError, readJsonBody, sendBuffer, sendJson } from '../http/responses.ts';
import type { RouteContext, Router } from '../http/router.ts';
import { createMjpegHandler } from '../live/mjpeg.ts';
import { OnvifError } from '@icamify/onvif';
import type { MotionService } from '../motion/service.ts';
import type { OnvifService } from '../onvif/service.ts';
import type { RecordingManager } from '../recording/manager.ts';
import type { CameraRuntime, CameraView } from '../runtime.ts';
import type { StorageService } from '../storage/service.ts';
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
  ai?: AiService;
  rules?: RuleEngine;
  gateway?: Gateway;
  storage?: StorageService;
  onvif?: OnvifService;
  snapshotsDir?: string;
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

  const requireStorage = (): StorageService => {
    if (deps.storage === undefined) {
      throw new HttpError(503, 'storage-unavailable', 'Storage management is not enabled on this server.');
    }
    return deps.storage;
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
          ai: deps.ai !== undefined,
          rules: deps.rules !== undefined,
          retention: deps.storage !== undefined,
          timeline: deps.recording !== undefined,
          archive: (deps.config.storage.archiveProviders ?? []).some((provider) => provider.enabled !== false),
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

  // -- AI --------------------------------------------------------------------

  router.get(
    '/api/cameras/:id/ai',
    (context) => {
      requireView(context);
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      sendJson(context.res, 200, { cameraId: camera.id, ai: deps.ai?.viewForCamera(camera) ?? null });
    },
    { auth: 'optional' },
  );

  router.put(
    '/api/cameras/:id/ai',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      if (deps.ai === undefined) {
        throw new HttpError(503, 'ai-unavailable', 'AI detection is not enabled on this server.');
      }
      const body = await readJsonBody(context.req, { maxBytes: 64 * 1024 });
      const patch: AiOverride = {
        ...(body.task === undefined ? {} : { task: body.task as AiOverride['task'] }),
        ...(body.labels === undefined ? {} : { labels: body.labels as string[] }),
        ...(body.minConfidence === undefined ? {} : { minConfidence: Number(body.minConfidence) }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled === true }),
      };
      try {
        const status = await deps.ai.configure(camera.id, patch);
        deps.log?.(`ai settings updated for ${camera.id} by ${context.principal?.username ?? 'anonymous'}`);
        sendJson(context.res, 200, { ai: status });
      } catch (error) {
        throw new HttpError(400, 'invalid-ai-settings', error instanceof Error ? error.message : String(error));
      }
    },
    { auth: 'required', role: 'operator' },
  );

  // Manual analysis is how an operator proves a detector works before trusting it
  // with motion-triggered alerts.
  router.post(
    '/api/cameras/:id/ai/detect',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      if (deps.ai === undefined) {
        throw new HttpError(503, 'ai-unavailable', 'AI detection is not enabled on this server.');
      }
      const body = await readJsonBody(context.req, { maxBytes: 16 * 1024 });
      const boxes = Array.isArray(body.boxes)
        ? (body.boxes as Array<{ x: number; y: number; width: number; height: number }>).map((box) => ({
            x: Number(box.x),
            y: Number(box.y),
            width: Number(box.width),
            height: Number(box.height),
            normalized: true as const,
          }))
        : undefined;
      try {
        const summary = await deps.ai.analyze(camera.id, { manual: true, ...(boxes === undefined ? {} : { boxes }) });
        if (summary === undefined) {
          const status = deps.ai.viewForCamera(camera);
          sendJson(context.res, 200, {
            detections: [],
            reason: status?.lastError ?? 'no detection was produced',
            ai: status ?? null,
          });
          return;
        }
        sendJson(context.res, 200, { ...summary, ai: deps.ai.viewForCamera(camera) ?? null });
      } catch (error) {
        throw new HttpError(502, 'ai-analysis-failed', error instanceof Error ? error.message : String(error));
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.get(
    '/api/ai/providers',
    async (context) => {
      requireView(context);
      const providers = deps.gateway?.status() ?? [];
      const health =
        context.query.get('health') === '1' && context.principal !== undefined
          ? await deps.gateway?.health()
          : undefined;
      sendJson(context.res, 200, {
        providers,
        ...(health === undefined ? {} : { health }),
        cameras: deps.runtime.cameras().map((camera) => ({
          id: camera.id,
          name: camera.name,
          enabled: camera.ai.enabled,
          ...(camera.ai.providerId === undefined ? {} : { providerId: camera.ai.providerId }),
          task: camera.ai.task,
          lastLabels: camera.ai.lastLabels ?? [],
          ...(camera.ai.lastError === undefined ? {} : { lastError: camera.ai.lastError }),
        })),
      });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/rules',
    (context) => {
      requireView(context);
      sendJson(context.res, 200, {
        rules: deps.config.rules ?? [],
        channels: (deps.config.notifications.channels ?? []).map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          enabled: channel.enabled !== false,
          implemented: channel.type === 'webhook',
        })),
        dedupeSeconds: deps.config.notifications.dedupeSeconds ?? 30,
      });
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/events/:id/snapshot',
    async (context) => {
      requireView(context);
      const recording = requireRecording();
      const event = recording.index.getEvent(context.params.id ?? '');
      if (event === undefined) throw new HttpError(404, 'event-not-found', 'Event not found.');
      if (event.snapshot === undefined || deps.snapshotsDir === undefined) {
        throw new HttpError(404, 'snapshot-not-found', 'This event has no saved snapshot.');
      }
      const path = resolveSnapshotPath(deps.snapshotsDir, event.snapshot);
      if (path === undefined) throw new HttpError(400, 'invalid-snapshot-path', 'The stored snapshot path is invalid.');
      const jpeg = await readFile(path).catch(() => undefined);
      if (jpeg === undefined) throw new HttpError(404, 'snapshot-missing', 'The snapshot file is no longer on disk.');
      sendBuffer(context.res, 200, jpeg, 'image/jpeg', { 'Cache-Control': 'private, max-age=300' });
    },
    { auth: 'optional' },
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

  // -- timeline & playback ---------------------------------------------------

  // One request per visible day, so the timeline does not have to stitch clips
  // together and page through events to draw a single screen.
  router.get(
    '/api/timeline',
    (context) => {
      requireView(context);
      const recording = requireRecording();
      const cameraId = context.query.get('cameraId') ?? undefined;
      const from = parseTime(context.query.get('from')) ?? startOfDay(Date.now());
      const to = parseTime(context.query.get('to')) ?? from + DAY_MS;
      if (!(to > from)) {
        throw new HttpError(400, 'invalid-range', '`to` must be greater than `from`.');
      }
      if (to - from > 31 * DAY_MS) {
        throw new HttpError(400, 'range-too-large', 'The timeline covers at most 31 days per request.');
      }
      const base = {
        ...(cameraId === undefined ? {} : { cameraId }),
        from,
        to,
      };
      const segments = recording.index.listSegments({ ...base, order: 'asc', limit: TIMELINE_LIMIT });
      const events = recording.index.listEvents({ ...base, order: 'asc', limit: TIMELINE_LIMIT });
      sendJson(context.res, 200, {
        ...base,
        segments,
        events,
        counts: { segments: recording.index.countSegments(base), events: events.length },
        truncated: segments.length >= TIMELINE_LIMIT || events.length >= TIMELINE_LIMIT,
      });
    },
    { auth: 'optional' },
  );

  // Recording files are Matroska, which a browser cannot play. This remuxes a
  // window to fragmented MP4 without re-encoding, so the timeline can seek.
  router.get(
    '/api/recordings/:id/play.mp4',
    async (context) => {
      requireView(context);
      const recording = requireRecording();
      const segment = recording.segment(context.params.id ?? '');
      if (segment === undefined) throw new HttpError(404, 'recording-not-found', 'Recording not found.');
      const info = await stat(segment.path).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        throw new HttpError(
          410,
          'recording-missing',
          'The recording file is no longer on disk (retention may have removed it).',
        );
      }
      if (deps.toolchain === undefined) {
        throw new HttpError(503, 'ffmpeg-unavailable', 'FFmpeg is not available on this server.');
      }
      const startSeconds = clampNumber(context.query.get('start'), 0, 86_400, 0);
      const durationSeconds = clampNumber(context.query.get('duration'), 0, 7_200, 0);
      const remux = createRemuxStream(deps.toolchain.ffmpeg.path, segment.path, {
        ...(startSeconds > 0 ? { startSeconds } : {}),
        ...(durationSeconds > 0 ? { durationSeconds } : {}),
      });
      let closed = false;
      context.res.on('close', () => {
        closed = true;
        remux.child.kill('SIGKILL');
      });
      context.res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, max-age=300',
        'Accept-Ranges': 'none',
      });
      remux.done.catch((error: unknown) => {
        if (!closed) deps.log?.(`playback ${segment.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
      remux.child.stdout?.pipe(context.res);
      await remux.done.catch(() => undefined);
    },
    { auth: 'optional' },
  );

  router.post(
    '/api/recordings/:id/protect',
    async (context) => {
      const recording = requireRecording();
      const storage = requireStorage();
      const segment = recording.segment(context.params.id ?? '');
      if (segment === undefined) throw new HttpError(404, 'recording-not-found', 'Recording not found.');
      const body = await readJsonBody(context.req, { maxBytes: 8 * 1024 });
      const next = typeof body.protected === 'boolean' ? body.protected : segment.protected !== true;
      await storage.protect(segment.id, next);
      deps.log?.(`recording ${segment.id} ${next ? 'protected' : 'unprotected'} by ${context.principal?.username ?? 'anonymous'}`);
      sendJson(context.res, 200, { segment: recording.segment(segment.id), protected: next });
    },
    { auth: 'required', role: 'operator' },
  );

  // Deleting a clip is recorded as a tombstone, not a row deletion: the timeline
  // stops drawing it while the file's history stays auditable.
  router.delete(
    '/api/recordings/:id',
    async (context) => {
      const recording = requireRecording();
      const storage = requireStorage();
      const segment = recording.segment(context.params.id ?? '');
      if (segment === undefined) throw new HttpError(404, 'recording-not-found', 'Recording not found.');
      if (segment.protected === true) {
        throw new HttpError(409, 'recording-protected', 'This clip is protected; unprotect it before deleting.');
      }
      try {
        await storage.deleteSegment(segment);
      } catch (error) {
        throw new HttpError(500, 'delete-failed', error instanceof Error ? error.message : String(error));
      }
      deps.log?.(`recording ${segment.id} deleted by ${context.principal?.username ?? 'anonymous'}`);
      sendJson(context.res, 200, { deleted: true, segmentId: segment.id });
    },
    { auth: 'required', role: 'operator' },
  );

  // -- storage ---------------------------------------------------------------

  router.get(
    '/api/storage',
    async (context) => {
      requireView(context);
      const storage = requireStorage();
      sendJson(context.res, 200, await storage.overview());
    },
    { auth: 'optional' },
  );

  router.post(
    '/api/storage/sweep',
    async (context) => {
      const storage = requireStorage();
      const body = await readJsonBody(context.req, { maxBytes: 8 * 1024 });
      const volumeId = typeof body.volumeId === 'string' && body.volumeId.length > 0 ? body.volumeId : undefined;
      if (volumeId !== undefined && !storage.volumes.some((volume) => volume.id === volumeId)) {
        throw new HttpError(404, 'volume-not-found', `No storage volume "${volumeId}".`);
      }
      const results = await storage.sweep({
        ...(volumeId === undefined ? {} : { volumeId }),
        dryRun: body.dryRun === true,
      });
      deps.log?.(`storage sweep by ${context.principal?.username ?? 'anonymous'}${body.dryRun === true ? ' (dry run)' : ''}`);
      sendJson(context.res, 200, { volumes: results, overview: await storage.overview() });
    },
    { auth: 'required', role: 'operator' },
  );

  // -- ONVIF / PTZ -----------------------------------------------------------

  const requireOnvif = (): OnvifService => {
    if (deps.onvif === undefined) {
      throw new HttpError(503, 'onvif-unavailable', 'ONVIF control is not enabled on this server.');
    }
    return deps.onvif;
  };

  router.get(
    '/api/onvif',
    (context) => {
      requireView(context);
      const onvif = requireOnvif();
      sendJson(context.res, 200, {
        discovery: {
          enabled: onvif.discoveryEnabled,
          ...(deps.config.onvif.discovery?.multicastAddress === undefined
            ? {}
            : { multicastAddress: deps.config.onvif.discovery.multicastAddress }),
          ...(deps.config.onvif.discovery?.timeoutMs === undefined
            ? {}
            : { timeoutMs: deps.config.onvif.discovery.timeoutMs }),
        },
        defaults: {
          timeoutMs: deps.config.onvif.defaults?.timeoutMs ?? 8000,
          // Presence, never the value: credentials must not reach the browser.
          hasCredentials: deps.config.onvif.defaults?.username !== undefined,
        },
        controlledCameras: onvif.controlledCameraIds(),
      });
    },
    { auth: 'optional' },
  );

  router.post(
    '/api/onvif/scan',
    async (context) => {
      const body = await readJsonBody(context.req, { maxBytes: 4 * 1024 }).catch(() => ({}) as Record<string, unknown>);
      const timeoutMs = typeof body.timeoutMs === 'number' ? Math.min(15_000, Math.max(500, body.timeoutMs)) : undefined;
      try {
        const result = await requireOnvif().scan(timeoutMs === undefined ? {} : { timeoutMs });
        deps.log?.(`onvif discovery by ${context.principal?.username ?? 'anonymous'}: ${result.devices.length} device(s)`);
        sendJson(context.res, 200, result);
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  // Used by "inspect" on a discovered device, and by an operator validating a
  // camera before adding it. Credentials in the body are used once, never stored.
  router.post(
    '/api/onvif/describe',
    async (context) => {
      const body = await readJsonBody(context.req, { maxBytes: 4 * 1024 });
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      if (!/^[A-Za-z0-9._-]+$/.test(host)) {
        throw new HttpError(400, 'invalid-host', 'host must be a hostname or IPv4 address.');
      }
      const port = body.port === undefined ? 80 : Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new HttpError(400, 'invalid-port', 'port must be an integer between 1 and 65535.');
      }
      const credentials =
        typeof body.username === 'string' && body.username.length > 0 && typeof body.password === 'string'
          ? { username: body.username, password: body.password }
          : undefined;
      try {
        const result = await requireOnvif().describe({ host, port, ...(credentials === undefined ? {} : { credentials }) });
        sendJson(context.res, 200, result);
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.get(
    '/api/cameras/:id/ptz',
    (context) => {
      requireView(context);
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      sendJson(context.res, 200, requireOnvif().status(camera.id));
    },
    { auth: 'optional' },
  );

  // Loads the device's own presets; the configured list is available offline.
  router.post(
    '/api/cameras/:id/ptz/refresh',
    async (context) => {
      try {
        const status = await requireOnvif().refresh(deps.runtime.requireCamera(context.params.id ?? '').id);
        sendJson(context.res, 200, status);
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.post(
    '/api/cameras/:id/ptz/move',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      const body = await readJsonBody(context.req, { maxBytes: 4 * 1024 });
      const vector = {
        ...(body.pan === undefined ? {} : { pan: clampUnit(body.pan) }),
        ...(body.tilt === undefined ? {} : { tilt: clampUnit(body.tilt) }),
        ...(body.zoom === undefined ? {} : { zoom: clampUnit(body.zoom) }),
      };
      if (Object.keys(vector).length === 0) {
        throw new HttpError(400, 'empty-move', 'Provide at least one of pan, tilt or zoom.');
      }
      const durationMs = Math.min(10_000, Math.max(100, Number(body.durationMs ?? 500)));
      try {
        await requireOnvif().move(camera.id, vector, durationMs);
        deps.log?.(`PTZ move ${camera.id} by ${context.principal?.username ?? 'anonymous'}: ${JSON.stringify(vector)} ${durationMs}ms`);
        sendJson(context.res, 200, { moved: true, cameraId: camera.id, ...vector, durationMs });
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.post(
    '/api/cameras/:id/ptz/stop',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      try {
        await requireOnvif().stop(camera.id);
        sendJson(context.res, 200, { stopped: true, cameraId: camera.id });
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.post(
    '/api/cameras/:id/ptz/preset',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      const body = await readJsonBody(context.req, { maxBytes: 4 * 1024 });
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0) throw new HttpError(400, 'invalid-preset', 'name is required.');
      try {
        await requireOnvif().gotoPreset(camera.id, name);
        deps.log?.(`PTZ preset "${name}" on ${camera.id} by ${context.principal?.username ?? 'anonymous'}`);
        sendJson(context.res, 200, { cameraId: camera.id, preset: name, moved: true });
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
  );

  router.post(
    '/api/cameras/:id/ptz/patrol',
    async (context) => {
      const camera = deps.runtime.requireCamera(context.params.id ?? '');
      const body = await readJsonBody(context.req, { maxBytes: 4 * 1024 });
      if (typeof body.enabled !== 'boolean') {
        throw new HttpError(400, 'invalid-patrol', 'enabled must be true or false.');
      }
      try {
        const status = await requireOnvif().setPatrol(camera.id, body.enabled);
        deps.log?.(`PTZ patrol ${body.enabled ? 'started' : 'stopped'} on ${camera.id} by ${context.principal?.username ?? 'anonymous'}`);
        sendJson(context.res, 200, status);
      } catch (error) {
        throw onvifHttpError(error);
      }
    },
    { auth: 'required', role: 'operator' },
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

function clampNumber(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Local midnight: the timeline is a day view in the operator's timezone. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY_MS = 86_400_000;
/** Segments and events per timeline request; a day of heavy motion can exceed it. */
const TIMELINE_LIMIT = 500;

/** Camera-side failures are gateway errors, except bad input and a missing preset. */
function onvifHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof OnvifError) {
    switch (error.code) {
      case 'invalid-target':
        return new HttpError(404, 'ptz-invalid-target', error.message);
      case 'unsupported':
        return new HttpError(409, 'ptz-unsupported', error.message);
      case 'timeout':
        return new HttpError(504, 'ptz-timeout', error.message);
      case 'unauthorized':
        // 401 would look like an iCamify session problem; the session is fine.
        return new HttpError(502, 'ptz-unauthorized', error.message);
      default:
        return new HttpError(502, `ptz-${error.code}`, error.message);
    }
  }
  return new HttpError(502, 'ptz-failed', error instanceof Error ? error.message : String(error));
}

function clampUnit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(-1, parsed));
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
