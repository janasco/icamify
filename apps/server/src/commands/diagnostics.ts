import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import { ConfigError, loadConfig } from '@icamify/core';
import {
  IngestSupervisor,
  MediaEngine,
  MediaError,
  buildPipelinePlan,
  describeToolchain,
  locateFfmpeg,
  redactArgv,
  type FfmpegToolchain,
  type IngestEvent,
  type PipelinePlan,
  type PipelinePurpose,
} from '@icamify/media';

/**
 * Commands that answer "why is this camera not working?" before the HTTP server
 * exists. They share the configuration loader and the media layer with the future
 * backend, so a diagnosis here matches what the server will do at runtime.
 */

export interface CommonCommandOptions {
  configPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  json: boolean;
  quiet: boolean;
}

export interface ProbeCommandOptions extends CommonCommandOptions {
  cameraId: string;
  stream: 'main' | 'sub';
  timeoutMs?: number;
}

export interface IngestCommandOptions extends CommonCommandOptions {
  cameraId: string;
  purpose: PipelinePurpose;
  dryRun: boolean;
  seconds?: number;
}

type CheckStatus = 'ok' | 'warn' | 'error';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const MIN_NODE_MAJOR = 24;

function relativeSource(path: string): string {
  const resolved = resolve(process.cwd(), path);
  return isAbsolute(path) && !resolved.startsWith(process.cwd()) ? resolved : path;
}

function findCamera(config: ResolvedIcamifyConfig, cameraId: string): CameraConfig | undefined {
  return config.cameras.find((candidate) => candidate.id === cameraId);
}

function cameraList(config: ResolvedIcamifyConfig): string {
  return config.cameras.map((candidate) => candidate.id).join(', ') || 'none';
}

function loadConfigured(options: CommonCommandOptions): ReturnType<typeof loadConfig> {
  try {
    return loadConfig({ path: options.configPath });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`icamify: ${error.message}\n`);
      for (const issue of error.issues) {
        process.stderr.write(`  ${issue.severity}  ${issue.path}  ${issue.message}\n`);
      }
      if (error.kind === 'missing-file') {
        process.stderr.write('\nHint: cp config/icamify.example.json config/icamify.json\n');
      }
      process.exitCode = 1;
      throw new CommandAbort();
    }
    throw error;
  }
}

class CommandAbort extends Error {}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export async function runDoctor(options: CommonCommandOptions): Promise<number> {
  const checks: Check[] = [];

  checks.push(
    process.versions.node.split('.')[0] !== undefined &&
      Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'node',
          status: 'error',
          detail: `v${process.versions.node} is too old`,
          hint: `iCamify runs TypeScript directly and needs Node ${MIN_NODE_MAJOR}+.`,
        },
  );

  let config: ResolvedIcamifyConfig | undefined;
  try {
    const loaded = loadConfig({ path: options.configPath });
    config = loaded.config;
    const warningCount = loaded.warnings.length;
    checks.push({
      name: 'config',
      status: warningCount === 0 ? 'ok' : 'warn',
      detail:
        `${relativeSource(loaded.sourcePath)} · ${loaded.config.cameras.length} cameras` +
        (warningCount > 0 ? ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''),
      ...(warningCount > 0 ? { hint: 'Run `icamify config validate` for details.' } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      checks.push({
        name: 'config',
        status: 'error',
        detail: error.message,
        hint: error.kind === 'missing-file' ? 'cp config/icamify.example.json config/icamify.json' : undefined,
      });
    } else {
      throw error;
    }
  }

  let toolchain: FfmpegToolchain | undefined;
  try {
    toolchain = await locateFfmpeg({ ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });
    checks.push({ name: 'ffmpeg', status: 'ok', detail: describeToolchain(toolchain).join(' · ') });
    for (const warning of toolchain.warnings) {
      checks.push({ name: 'ffmpeg', status: 'warn', detail: warning });
    }
  } catch (error) {
    if (error instanceof MediaError) {
      checks.push({ name: 'ffmpeg', status: 'error', detail: error.message, hint: error.detail });
    } else {
      throw error;
    }
  }

  if (config !== undefined && toolchain !== undefined) {
    checks.push(...checkPipelines(config, toolchain));
    checks.push(...checkStorage(config));
  }

  if (options.json) {
    const ok = checks.every((check) => check.status !== 'error');
    process.stdout.write(
      `${JSON.stringify({ ok, toolchain: toolchain === undefined ? null : summarizeToolchain(toolchain), checks }, null, 2)}\n`,
    );
    return ok ? 0 : 1;
  }

  process.stdout.write(`icamify doctor — ${relativeSource(options.configPath ?? 'config/icamify.json')}\n\n`);
  for (const check of checks) {
    const marker = check.status === 'ok' ? 'ok  ' : check.status;
    process.stdout.write(`  ${marker.padEnd(5)} ${check.name.padEnd(10)} ${check.detail}\n`);
  }
  const hints = checks.filter((check) => check.hint !== undefined);
  if (hints.length > 0) {
    process.stdout.write('\n');
    for (const check of hints) {
      process.stdout.write(`  ${check.name}: ${check.hint ?? ''}\n`);
    }
  }

  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  process.stdout.write(
    `\n${errors === 0 ? 'ready' : `${errors} error${errors === 1 ? '' : 's'}`}` +
      (warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : '') +
      '\n',
  );
  return errors === 0 ? 0 : 1;
}

function summarizeToolchain(toolchain: FfmpegToolchain): Record<string, unknown> {
  return {
    ffmpeg: { path: toolchain.ffmpeg.path, version: toolchain.ffmpeg.version.raw },
    ffprobe: { path: toolchain.ffprobe.path, version: toolchain.ffprobe.version.raw },
    encoders: toolchain.capabilities.encoders.length,
    filters: toolchain.capabilities.filters.length,
    hwaccels: toolchain.capabilities.hwaccels,
  };
}

/**
 * Builds every configured pipeline without starting it and checks that the
 * encoders it needs exist. This catches "profile asks for nvenc on a CPU-only
 * box" at boot instead of at 3am when the camera restarts.
 */
function checkPipelines(config: ResolvedIcamifyConfig, toolchain: FfmpegToolchain): Check[] {
  const checks: Check[] = [];
  const purposes: PipelinePurpose[] = ['record', 'live', 'detect'];

  for (const camera of config.cameras) {
    if (camera.enabled === false) continue;
    for (const purpose of purposes) {
      if (purpose === 'record' && (camera.recording?.mode ?? 'off') === 'off') continue;
      if (purpose === 'detect' && camera.motion?.enabled === false) continue;

      const label = `${camera.id}/${purpose}`;
      try {
        const plan = buildPipelinePlan(config, camera, purpose, {
          hasEncoder: toolchain.hasEncoder,
          ffmpegMajor: toolchain.ffmpeg.version.major,
        });
        // Raw-frame and MJPEG pipelines carry no -c:v; only real encoders are checked.
        const encoderIndex = plan.args.indexOf('-c:v');
        const encoder = encoderIndex === -1 ? undefined : plan.args[encoderIndex + 1];
        if (encoder !== undefined && encoder !== 'copy' && !toolchain.hasEncoder(encoder)) {
          checks.push({
            name: 'pipeline',
            status: 'error',
            detail: `${label}: encoder "${encoder}" is not available in this FFmpeg build`,
            hint: 'Change the profile codec/hardwareAcceleration, or install a build with that encoder.',
          });
          continue;
        }
        const missingTransport = missingTransportFor(plan.sourceType, toolchain);
        if (missingTransport !== undefined) {
          checks.push({
            name: 'pipeline',
            status: 'error',
            detail: `${label}: FFmpeg has no ${missingTransport}`,
            hint: 'Install a full FFmpeg build (the distro "ffmpeg" package includes RTSP/RTMP/HTTP input).',
          });
          continue;
        }
        const warning = plan.warnings[0];
        checks.push({
          name: 'pipeline',
          status: warning === undefined ? 'ok' : 'warn',
          detail: `${label}: ${plan.profileName}${encoder === 'copy' ? ' (copy)' : ''}${warning === undefined ? '' : ` · ${warning}`}`,
        });
      } catch (error) {
        if (error instanceof MediaError && error.code === 'unsupported-source') {
          // ONVIF cameras have no URI until the device is queried at runtime, so
          // this is expected before Phase 4 rather than a broken configuration.
          checks.push({ name: 'pipeline', status: 'warn', detail: `${label}: ${error.message}` });
        } else if (error instanceof MediaError) {
          checks.push({ name: 'pipeline', status: 'error', detail: `${label}: ${error.message}`, hint: error.detail });
        } else if (error instanceof ConfigError) {
          checks.push({ name: 'pipeline', status: 'error', detail: `${label}: ${error.message}` });
        } else {
          throw error;
        }
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ name: 'pipeline', status: 'warn', detail: 'no enabled cameras to check' });
  }
  return checks;
}

/**
 * RTSP and RTMP are *demuxers* in FFmpeg; only HTTP is a protocol. Checking the
 * wrong table produces false "missing input support" alarms on stock builds.
 */
function missingTransportFor(sourceType: string, toolchain: FfmpegToolchain): string | undefined {
  switch (sourceType) {
    case 'rtsp':
    case 'onvif':
      return toolchain.hasDemuxer('rtsp') ? undefined : 'rtsp demuxer';
    case 'rtmp':
      return toolchain.hasProtocol('rtmp') && toolchain.hasDemuxer('flv') ? undefined : 'rtmp/flv support';
    case 'http':
      return toolchain.hasProtocol('http') ? undefined : 'http protocol';
    default:
      return undefined;
  }
}

function checkStorage(config: ResolvedIcamifyConfig): Check[] {
  const checks: Check[] = [];
  // Relative storage paths hang off rootDir, matching the schema defaults.
  const root = config.storage.rootDir ?? './data';
  const resolveDir = (dir: string): string => (isAbsolute(dir) ? dir : join(root, dir));

  const dirs = new Map<string, string>([[root, 'rootDir']]);
  if (config.storage.recordingsDir !== undefined) dirs.set(resolveDir(config.storage.recordingsDir), 'recordingsDir');
  if (config.storage.snapshotsDir !== undefined) dirs.set(resolveDir(config.storage.snapshotsDir), 'snapshotsDir');
  for (const volume of config.storage.volumes ?? []) dirs.set(resolveDir(volume.path), `volume ${volume.id}`);

  for (const [dir, label] of dirs) {
    const target = resolve(process.cwd(), dir);
    try {
      accessSync(target, constants.W_OK);
      checks.push({ name: 'storage', status: 'ok', detail: `${label} ${dir} (writable)` });
    } catch {
      checks.push({
        name: 'storage',
        status: 'warn',
        detail: `${label} ${dir} is not writable yet`,
        hint: 'The directory is created on first use; make sure the parent exists and the user can write to it.',
      });
    }
  }

  const volumes = config.storage.volumes ?? [];
  if (volumes.length === 0 && checks.length > 0) {
    checks.push({ name: 'storage', status: 'warn', detail: 'no volumes configured; retention cannot enforce quotas' });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export async function runProbe(options: ProbeCommandOptions): Promise<number> {
  let config: ResolvedIcamifyConfig;
  try {
    config = loadConfigured(options).config;
  } catch (error) {
    if (error instanceof CommandAbort) return 1;
    throw error;
  }

  const camera = findCamera(config, options.cameraId);
  if (camera === undefined) {
    process.stderr.write(`icamify probe: unknown camera "${options.cameraId}". Configured: ${cameraList(config)}\n`);
    return 1;
  }

  const source = options.stream === 'sub' ? (camera.streams.sub ?? camera.streams.main) : camera.streams.main;

  try {
    const toolchain = await locateFfmpeg({
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      skipCapabilities: true,
    });
    const probe = await new MediaEngine({
      ffmpegPath: toolchain.ffmpeg.path,
      ffprobePath: toolchain.ffprobe.path,
    }).probe(source, options.timeoutMs);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ camera: camera.id, stream: options.stream, ...probe, raw: undefined }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${camera.name} (${camera.id}) · ${options.stream} · ${source.type}\n`);
    process.stdout.write(`  video      ${probe.videoCodec} ${probe.width}x${probe.height} @ ${probe.fps}fps\n`);
    if (probe.bitrateKbps !== undefined) {
      process.stdout.write(`  bitrate    ${probe.bitrateKbps} kbps (~${formatBytes(((probe.bitrateKbps * 1000) / 8) * 3600)}/hour)\n`);
    }
    process.stdout.write(`  container  ${probe.container}\n`);
    if (probe.audioCodec !== undefined) process.stdout.write(`  audio      ${probe.audioCodec}\n`);
    if (probe.pixelFormat !== undefined) process.stdout.write(`  pixel fmt  ${probe.pixelFormat}\n`);
    process.stdout.write(`  live       ${probe.live ? 'yes' : 'no'}\n`);
    return 0;
  } catch (error) {
    if (error instanceof MediaError) {
      process.stderr.write(`icamify probe: ${error.message}\n`);
      if (error.detail !== undefined) process.stderr.write(`${error.detail}\n`);
      return 1;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

export async function runIngest(options: IngestCommandOptions): Promise<number> {
  let config: ResolvedIcamifyConfig;
  try {
    config = loadConfigured(options).config;
  } catch (error) {
    if (error instanceof CommandAbort) return 1;
    throw error;
  }

  const camera = findCamera(config, options.cameraId);
  if (camera === undefined) {
    process.stderr.write(`icamify ingest: unknown camera "${options.cameraId}". Configured: ${cameraList(config)}\n`);
    return 1;
  }

  let toolchain: FfmpegToolchain;
  let plan: PipelinePlan;
  try {
    toolchain = await locateFfmpeg({ ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });
    plan = new MediaEngine({
      ffmpegPath: toolchain.ffmpeg.path,
      ffprobePath: toolchain.ffprobe.path,
      hasEncoder: toolchain.hasEncoder,
      ffmpegMajor: toolchain.ffmpeg.version.major,
    }).plan(config, camera, options.purpose);
  } catch (error) {
    if (error instanceof MediaError) {
      process.stderr.write(`icamify ingest: ${error.message}\n`);
      if (error.detail !== undefined) process.stderr.write(`${error.detail}\n`);
      return 1;
    }
    throw error;
  }

  if (options.dryRun) {
    process.stdout.write(
      `${camera.id} · ${options.purpose} · profile ${plan.profileName} · ${plan.sourceType}\n` +
        `${toolchain.ffmpeg.path} ${redactArgv(plan.args).join(' ')}\n`,
    );
    for (const warning of plan.warnings) process.stderr.write(`warn  ${warning}\n`);
    return 0;
  }

  if (options.purpose === 'record') {
    // FFmpeg's segment muxer does not create missing directories; the storage
    // manager owns their lifecycle from Phase 3, so the CLI does the minimum.
    const template = plan.args.at(-1) ?? '';
    if (template.length > 0) mkdirSync(dirname(template), { recursive: true });
  }

  const supervisor = new IngestSupervisor({
    cameraId: camera.id,
    purpose: options.purpose,
    bin: toolchain.ffmpeg.path,
    build: () => ({ args: plan.args, warnings: plan.warnings }),
    health: camera.health,
    // A foreground diagnostic run should return promptly. Loopback/file sources
    // ignore SIGTERM until EOF, so escalation to SIGKILL is expected there.
    killGraceMs: 2_000,
    onStdout: () => {
      // stdout carries media/raw frames; this diagnostic command discards them.
    },
    onEvent: (event) => reportIngestEvent(event, options.quiet),
  });

  const seconds = options.seconds ?? 0;
  process.stderr.write(
    `ingest ${camera.id} · ${options.purpose} · ${plan.profileName}${seconds > 0 ? ` · ${seconds}s` : ''} (Ctrl-C to stop)\n`,
  );
  supervisor.start();

  await new Promise<void>((resolvePromise) => {
    const timer = seconds > 0 ? setTimeout(resolvePromise, seconds * 1000) : undefined;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  await supervisor.stop();
  const failed = supervisor.lastExit !== undefined && !supervisor.lastExit.requested && supervisor.lastExit.code !== 0;
  process.stderr.write(failed ? `ingest exited with code ${supervisor.lastExit?.code ?? 'unknown'}\n` : 'ingest stopped\n');
  return failed ? 1 : 0;
}

function reportIngestEvent(event: IngestEvent, quiet: boolean): void {
  switch (event.type) {
    case 'running':
      process.stderr.write(`  running (pid ${event.pid ?? '?'})\n`);
      break;
    case 'stderr':
      if (!quiet) process.stderr.write(`  ffmpeg: ${event.line}\n`);
      break;
    case 'restart-scheduled':
      process.stderr.write(`  ${event.reason}; retrying in ${event.delayMs}ms\n`);
      break;
    case 'degraded':
      process.stderr.write(`  camera degraded after ${event.failures} failed attempts\n`);
      break;
    case 'recovered':
      process.stderr.write('  camera recovered\n');
      break;
    case 'progress':
      if (!quiet && event.frame.speed !== undefined) process.stderr.write(`  ${event.frame.speed}x realtime\n`);
      break;
    default:
      break;
  }
}
