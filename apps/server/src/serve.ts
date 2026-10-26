import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, loadConfig, type ResolvedIcamifyConfig } from '@icamify/core';
import { MediaEngine, locateFfmpeg, versionText, type FfmpegToolchain } from '@icamify/media';
import { LiveRegistry } from '@icamify/stream';
import { AuthService } from './http/auth.ts';
import { Router } from './http/router.ts';
import { createAppServer, type AppServer, type ListenResult, type RequestLogEntry } from './http/server.ts';
import { createLiveStreamHandler } from './live/ws-stream.ts';
import { createLiveSourceFactory } from './media/live-source.ts';
import { MotionService, type MotionServiceEvent } from './motion/service.ts';
import { RecordingManager, type RecordingHubEvent } from './recording/manager.ts';
import { registerRoutes } from './routes/index.ts';
import { CameraRuntime } from './runtime.ts';
import { resolveStoragePaths } from './storage-paths.ts';
import { SignalingService } from './webrtc/signaling.ts';
import { WsHub } from './ws/hub.ts';

/**
 * Composition root.
 *
 * Boot order matters: configuration is validated first, then the FFmpeg
 * toolchain, then the media engine, and only then does the HTTP listener exist.
 * A server that starts without a working FFmpeg would look healthy while every
 * camera fails, so a toolchain problem aborts startup instead.
 */

export interface StartServerOptions {
  configPath?: string;
  /** Pre-loaded configuration (tests, reloads). */
  config?: ResolvedIcamifyConfig;
  ffmpegPath?: string;
  ffprobePath?: string;
  host?: string;
  port?: number;
  /** Override the console build directory; `false` disables static serving. */
  staticDir?: string | false;
  toolchain?: FfmpegToolchain;
  log?: (line: string) => void;
}

export interface RunningServer {
  server: AppServer;
  hub: WsHub;
  registry: LiveRegistry;
  runtime: CameraRuntime;
  auth: AuthService;
  signaling: SignalingService;
  recording: RecordingManager;
  motion: MotionService;
  config: ResolvedIcamifyConfig;
  toolchain: FfmpegToolchain;
  listen: ListenResult;
  broadcastCameras: () => void;
  close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const config =
    options.config ??
    loadConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
    }).config;

  const toolchain =
    options.toolchain ??
    (await locateFfmpeg({
      ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
      ...(options.ffprobePath === undefined ? {} : { ffprobePath: options.ffprobePath }),
    }));

  for (const warning of toolchain.warnings) log(`warn: ${warning}`);

  const media = new MediaEngine({
    ffmpegPath: toolchain.ffmpeg.path,
    ffprobePath: toolchain.ffprobe.path,
    hasEncoder: (name) => toolchain.hasEncoder(name),
    ffmpegMajor: toolchain.ffmpeg.version.major,
    probeTimeoutMs: 20_000,
    snapshotTimeoutMs: 20_000,
  });

  const sources = createLiveSourceFactory({ media, config, log });
  // The registry is built before the WebSocket hub exists (the hub needs the
  // camera read model), so status pushes are routed through this forwarder.
  let pushStatus: ((cameraId: string) => void) | undefined;
  const registry = new LiveRegistry({
    config,
    camera: (cameraId) => (config.cameras ?? []).find((camera) => camera.id === cameraId),
    createSource: sources,
    onEvent: (event) => {
      if (event.type === 'error') log(`camera ${event.cameraId}: ${event.message}`);
      if (event.type === 'source-exited') log(`camera ${event.cameraId}: pipeline exited (${event.reason})`);
      if (event.type === 'viewers' || event.type === 'started' || event.type === 'stopped' || event.type === 'source-exited') {
        pushStatus?.(event.cameraId);
      }
    },
  });

  // Storage must exist before the index opens: SQLite creates a file, not a tree.
  const storagePaths = resolveStoragePaths(config);
  await mkdir(storagePaths.stateDir, { recursive: true });
  await mkdir(storagePaths.recordingsDir, { recursive: true });

  let pushRecording: ((event: RecordingHubEvent) => void) | undefined;
  let pushMotion: ((event: MotionServiceEvent) => void) | undefined;

  const recording = new RecordingManager({
    config,
    media,
    indexPath: resolve(storagePaths.stateDir, 'recordings.db'),
    log,
    onEvent: (event) => pushRecording?.(event),
  });

  // Motion is the trigger source for motion-mode recording; the two are wired
  // through a callback so neither service depends on the other.
  const motion = new MotionService({
    config,
    media,
    log,
    onMotionStart: (cameraId, at, detail) =>
      recording.trigger(cameraId, 'motion', at, { peakPercent: detail.peakPercent, boxes: detail.boxes }),
    onEvent: (event) => pushMotion?.(event),
  });

  const runtime = new CameraRuntime({
    config,
    media,
    registry,
    log,
    recording,
    motionStatus: (cameraId) => motion.status(cameraId),
  });
  const auth = new AuthService({ auth: config.auth, onWarning: (message) => log(`warn: ${message}`) });
  const signaling = new SignalingService({ config, log });

  const router = new Router();
  const basePath = config.system.api?.basePath;
  if (basePath !== undefined && basePath !== '/api') {
    log(`warn: system.api.basePath "${basePath}" is not implemented yet; routes are served under /api.`);
  }

  const staticDir = resolveStaticDir(options.staticDir, config, log);
  registerRoutes(router, {
    config,
    auth,
    runtime,
    registry,
    signaling,
    recording,
    motion,
    version: CORE_VERSION,
    startedAt: runtime.startedAt,
    toolchain,
    ...(staticDir === undefined ? {} : { staticDir }),
    log,
  });

  const startedAt = runtime.startedAt;
  const hub = new WsHub({
    auth,
    path: config.system.api?.websocket?.path ?? '/ws',
    heartbeatSeconds: config.system.api?.websocket?.heartbeatSeconds ?? 30,
    maxClients: config.system.api?.websocket?.maxClients ?? 64,
    startedAt,
    version: CORE_VERSION,
    snapshot: () => ({ cameras: runtime.cameras() }),
    signaling,
    log,
  });

  const liveStream = createLiveStreamHandler({ auth, registry, log });

  const broadcastCameras = (): void => {
    hub.broadcastCameras(runtime.cameras());
  };

  // Push camera state changes to the UI instead of making it poll.
  pushStatus = (cameraId: string) => {
    const camera = config.cameras.find((candidate) => candidate.id === cameraId);
    if (camera !== undefined) hub.broadcastCamera(runtime.view(camera));
  };

  pushRecording = (event: RecordingHubEvent) => {
    switch (event.type) {
      case 'recording:segment':
        hub.broadcast({ type: 'recording:segment', segment: event.segment }, 'cameras');
        pushStatus?.(event.segment.cameraId);
        break;
      case 'recording:event':
        hub.broadcast({ type: 'recording:event', event: event.event, closed: event.closed }, 'cameras');
        break;
      case 'recording:status':
        // Status changes are reflected in the camera payload, which the UI already
        // re-renders; broadcasting both would double every update.
        break;
    }
  };

  pushMotion = (event: MotionServiceEvent) => {
    if (event.type === 'motion:status') return;
    hub.broadcast(
      {
        type: 'motion',
        cameraId: event.cameraId,
        active: event.type !== 'motion:end',
        at: event.at,
        percent: event.percent,
        peakPercent: event.peakPercent,
        boxes: event.boxes,
      },
      'cameras',
    );
    if (event.type !== 'motion') pushStatus?.(event.cameraId);
  };

  const server = createAppServer({
    config,
    auth,
    router,
    ...(staticDir === undefined ? {} : { staticDir }),
    log,
    ...(config.system.logging?.level === 'trace'
      ? {
          onRequest: (entry: RequestLogEntry) => {
            log(`${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms ${entry.clientIp}${entry.user === undefined ? '' : ` user=${entry.user}`}`);
          },
        }
      : {}),
    upgradeHandlers: [hub.handleUpgrade.bind(hub), liveStream.handleUpgrade.bind(liveStream)],
  });

  const listen = await server.listen(options.port, options.host);

  // Cameras start after the listener exists: a slow RTSP handshake must not delay
  // `listen`, and a failing camera must not keep the API from coming up.
  await recording.start();
  await motion.start();

  // Announce once so an operator sees why a camera stayed dark.
  log(
    `iCamify ${CORE_VERSION} listening on ${listen.url} — ${config.cameras.length} camera(s), ` +
      `ffmpeg ${versionText(toolchain.ffmpeg.version)}, ${staticDir === undefined ? 'API only (console not built)' : `console at ${staticDir}`}`,
  );
  log(
    `recording: ${recording.startedRecorders} camera(s) → ${storagePaths.recordingsDir}; ` +
      `motion: ${motion.workerCount} camera(s) analysing; index at ${recording.index.path}`,
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      const graceSeconds = config.system.shutdownGraceSeconds ?? 10;
      await Promise.race([
        (async () => {
          await hub.close().catch(() => undefined);
          await liveStream.close().catch(() => undefined);
          await motion.stop().catch(() => undefined);
          await recording.stop().catch(() => undefined);
          recording.close();
          await registry.shutdown().catch(() => undefined);
          signaling.shutdown();
          await server.close().catch(() => undefined);
        })(),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, graceSeconds * 1000).unref?.()),
      ]);
    })();
    return closing;
  };

  return {
    server,
    hub,
    registry,
    runtime,
    auth,
    signaling,
    recording,
    motion,
    config,
    toolchain,
    listen,
    broadcastCameras,
    close,
  };
}

function resolveStaticDir(
  override: string | false | undefined,
  config: ResolvedIcamifyConfig,
  log: (line: string) => void,
): string | undefined {
  if (override === false) return undefined;
  // Anonymous static hosting is opt-out: an operator who fronted the console with
  // their own reverse proxy may only want the API from this process.
  if (override === undefined && config.system.web?.serveStatic === false) return undefined;
  const configured = config.system.web?.staticDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../..');
  const candidate =
    override ??
    (configured === undefined
      ? resolve(repoRoot, 'apps/web/dist')
      : isAbsolute(configured)
        ? configured
        : resolve(process.cwd(), configured));

  if (!existsSync(resolve(candidate, 'index.html'))) {
    log(`warn: no console build at ${candidate}; serving the API only (run: npm run web:build)`);
    return undefined;
  }
  return candidate;
}
