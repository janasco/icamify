import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, activeSchedules, loadConfig, type ResolvedIcamifyConfig } from '@icamify/core';
import { Gateway as AiGateway, jpegSize } from '@icamify/ai';
import { MediaEngine, locateFfmpeg, versionText, type FfmpegToolchain } from '@icamify/media';
import { LiveRegistry } from '@icamify/stream';
import { Notifier } from './alerts/notifier.ts';
import { createPluginResolver } from './ai/plugins.ts';
import { AiService, type AiDetectionSummary, type AiServiceEvent, type CaptureFrame } from './ai/service.ts';
import { snapshotRelativePath, writeSnapshot } from './ai/snapshots.ts';
import { AuthService } from './http/auth.ts';
import { Router } from './http/router.ts';
import { createAppServer, type AppServer, type ListenResult, type RequestLogEntry } from './http/server.ts';
import { createLiveStreamHandler } from './live/ws-stream.ts';
import { createLiveSourceFactory } from './media/live-source.ts';
import { MotionService, type MotionServiceEvent } from './motion/service.ts';
import { RecordingManager, type RecordingHubEvent } from './recording/manager.ts';
import { registerRoutes } from './routes/index.ts';
import { RuleEngine, type RuleEngineEvent } from './rules/engine.ts';
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
  ai: AiService;
  rules: RuleEngine;
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
  await mkdir(storagePaths.snapshotsDir, { recursive: true });

  /**
   * One still frame for the AI layer. The sub-stream is used when the camera has
   * one: detection needs a recognizable picture, not a 4K frame, and the crop is
   * expressed in source-relative coordinates either way.
   */
  const captureFrame: CaptureFrame = async (camera, options) => {
    const source = camera.streams.sub ?? camera.streams.main;
    const jpeg = await media.snapshot(source, options.maxWidth, {
      ...(options.crop === undefined ? {} : { crop: options.crop }),
      timeoutMs: 15_000,
    });
    const size = jpegSize(jpeg);
    if (size === undefined) throw new Error('the snapshot was not a readable JPEG');
    return { jpeg, width: size.width, height: size.height };
  };

  const plugins = createPluginResolver({
    directories: config.plugins.directories ?? [],
    trustedPlugins: config.plugins.trustedPlugins ?? [],
    enabled: config.plugins.enabled !== false,
    log,
  });
  const gateway = new AiGateway({
    providers: config.ai.providers ?? [],
    plugin: {
      resolveEntry: (pluginId) => plugins.resolveEntry(pluginId),
      ...(config.plugins.workerMemoryMb === undefined ? {} : { workerMemoryMb: config.plugins.workerMemoryMb }),
      log,
    },
    log,
  });

  let pushRecording: ((event: RecordingHubEvent) => void) | undefined;
  let pushMotion: ((event: MotionServiceEvent) => void) | undefined;
  let pushAi: ((event: AiServiceEvent) => void) | undefined;
  let pushRule: ((event: RuleEngineEvent) => void) | undefined;

  const recording = new RecordingManager({
    config,
    media,
    indexPath: resolve(storagePaths.stateDir, 'recordings.db'),
    log,
    onEvent: (event) => pushRecording?.(event),
  });

  const notifier = new Notifier({
    channels: config.notifications.channels ?? [],
    ...(config.notifications.dedupeSeconds === undefined ? {} : { dedupeSeconds: config.notifications.dedupeSeconds }),
    log,
  });

  const rules = new RuleEngine({
    config,
    recording,
    index: recording.index,
    notifier,
    scheduleActive: (ids, at) => activeSchedules(config.schedules, new Date(at), ids).active,
    snapshot: async (cameraId, labels) => {
      const camera = config.cameras.find((candidate) => candidate.id === cameraId);
      if (camera === undefined) return undefined;
      const frame = await captureFrame(camera, { maxWidth: config.storage.snapshot?.maxWidth ?? 1280 });
      return await writeSnapshot(
        storagePaths.snapshotsDir,
        snapshotRelativePath(cameraId, Date.now(), labels),
        frame.jpeg,
      );
    },
    log,
    onEvent: (event) => pushRule?.(event),
  });

  const aiService = new AiService({
    config,
    gateway,
    capture: captureFrame,
    index: recording.index,
    recording,
    snapshotsDir: storagePaths.snapshotsDir,
    log,
    onEvent: (event) => pushAi?.(event),
    onDetections: (summary) => handleDetections(summary),
  });

  /** Each detected label is a separate rule event: "person" and "dog" differ. */
  function handleDetections(summary: AiDetectionSummary): void {
    const byLabel = new Map<string, { confidence: number }>();
    for (const detection of summary.detections) {
      const current = byLabel.get(detection.label);
      if (current === undefined || detection.confidence > current.confidence) {
        byLabel.set(detection.label, { confidence: detection.confidence });
      }
    }
    for (const [label, { confidence }] of byLabel) {
      void rules.handle({
        cameraId: summary.cameraId,
        cameraName: summary.cameraName,
        kind: `ai.${summary.task}`,
        at: summary.at,
        label,
        confidence,
        providerId: summary.providerId,
        boxes: summary.boxes,
        ...(summary.snapshot === undefined ? {} : { snapshot: summary.snapshot }),
        ...(summary.eventIds[0] === undefined ? {} : { id: summary.eventIds[0] }),
      });
    }
  }

  // Motion is the trigger source for motion-mode recording and AI analysis; the
  // services are wired through callbacks so none of them depends on another.
  const motion = new MotionService({
    config,
    media,
    log,
    onMotionStart: (cameraId, at, detail) => {
      recording.trigger(cameraId, 'motion', at, { peakPercent: detail.peakPercent, boxes: detail.boxes });
      void aiService.analyze(cameraId, { boxes: detail.boxes });
      void rules.handle({
        ...(detail.episodeId === undefined ? {} : { id: detail.episodeId }),
        cameraId,
        kind: 'motion',
        at,
        phase: 'start',
        durationSeconds: 0,
        confidence: detail.peakPercent / 100,
        boxes: detail.boxes,
      });
    },
    onMotionEnd: (cameraId, _at, detail) => {
      void rules.handle({
        id: detail.episodeId,
        cameraId,
        kind: 'motion',
        at: detail.startedAt,
        phase: 'end',
        durationSeconds: detail.durationSeconds,
        boxes: detail.boxes,
      });
    },
    onEvent: (event) => pushMotion?.(event),
  });

  const runtime = new CameraRuntime({
    config,
    media,
    registry,
    log,
    recording,
    motionStatus: (cameraId) => motion.status(cameraId),
    aiStatus: (cameraId) => aiService.status(cameraId),
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
    ai: aiService,
    rules,
    gateway,
    snapshotsDir: storagePaths.snapshotsDir,
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

  pushAi = (event: AiServiceEvent) => {
    if (event.type === 'ai:detection') {
      hub.broadcast(
        {
          type: 'ai',
          cameraId: event.summary.cameraId,
          at: event.summary.at,
          task: event.summary.task,
          providerId: event.summary.providerId,
          latencyMs: event.summary.latencyMs,
          detections: event.summary.detections,
          ...(event.summary.snapshot === undefined ? {} : { snapshot: event.summary.snapshot }),
        },
        'cameras',
      );
      pushStatus?.(event.summary.cameraId);
      return;
    }
    if (event.type === 'ai:error') {
      hub.broadcast(
        { type: 'ai:error', cameraId: event.cameraId, at: event.at, message: event.message },
        'cameras',
      );
      pushStatus?.(event.cameraId);
      return;
    }
    // Status changes are reflected in the camera payload the UI already tracks.
  };

  pushRule = (event: RuleEngineEvent) => {
    hub.broadcast(
      {
        type: 'alert',
        ruleId: event.outcome.ruleId,
        ruleName: event.outcome.ruleName,
        cameraId: event.outcome.cameraId,
        at: event.outcome.at,
        kind: event.trigger.kind,
        ...(event.trigger.label === undefined ? {} : { label: event.trigger.label }),
        ...(event.trigger.confidence === undefined ? {} : { confidence: event.trigger.confidence }),
        actions: event.outcome.actions,
        ...(event.outcome.snapshot === undefined ? {} : { snapshot: event.outcome.snapshot }),
        ...(event.outcome.alertEventId === undefined ? {} : { eventId: event.outcome.alertEventId }),
      },
      'cameras',
    );
    pushStatus?.(event.outcome.cameraId);
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
  // Started even when ai.enabled is false so saved per-camera overrides are loaded
  // and reported; `analyze()` itself is a no-op while AI is disabled.
  await aiService.start();

  // Announce once so an operator sees why a camera stayed dark.
  log(
    `iCamify ${CORE_VERSION} listening on ${listen.url} — ${config.cameras.length} camera(s), ` +
      `ffmpeg ${versionText(toolchain.ffmpeg.version)}, ${staticDir === undefined ? 'API only (console not built)' : `console at ${staticDir}`}`,
  );
  log(
    `recording: ${recording.startedRecorders} camera(s) → ${storagePaths.recordingsDir}; ` +
      `motion: ${motion.workerCount} camera(s) analysing; index at ${recording.index.path}`,
  );
  log(
    `ai: ${aiService.statuses().length} camera(s), ${gateway.providerIds().length} provider(s); ` +
      `rules: ${rules.rules.filter((rule) => rule.enabled !== false).length} enabled; ` +
      `snapshots → ${storagePaths.snapshotsDir}`,
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
          await aiService.stop().catch(() => undefined);
          await gateway.close().catch(() => undefined);
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
    ai: aiService,
    rules,
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
