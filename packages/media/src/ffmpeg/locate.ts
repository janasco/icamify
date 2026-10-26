import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { MediaError } from '../errors.ts';

/**
 * Toolchain discovery.
 *
 * iCamify shells out to FFmpeg, so the first thing a deployment needs to know is
 * that the binaries exist, are new enough and expose the encoders/filters the
 * configured profiles ask for. Doing this once at boot turns "stream silently
 * never starts" into one actionable error, and lets the API report capability
 * gaps before a user clicks a camera.
 */

export interface ToolRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the binary could not be executed at all (ENOENT/EACCES). */
  spawnFailed: boolean;
}

export type ToolRunner = (bin: string, args: string[], timeoutMs: number) => Promise<ToolRunResult>;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Version text exactly as FFmpeg printed it, e.g. `6.1.1-3ubuntu5`. */
  raw: string;
}

export interface FfmpegCapabilities {
  encoders: string[];
  filters: string[];
  /** Container readers. RTSP/RTMP input support lives here, not in protocols. */
  demuxers: string[];
  muxers: string[];
  protocols: string[];
  hwaccels: string[];
}

export interface ToolInfo {
  path: string;
  version: ParsedVersion;
}

export interface FfmpegToolchain {
  ffmpeg: ToolInfo;
  ffprobe: ToolInfo;
  capabilities: FfmpegCapabilities;
  /** Non-fatal findings worth surfacing in `icamify doctor`. */
  warnings: string[];
  hasEncoder(name: string): boolean;
  hasFilter(name: string): boolean;
  hasProtocol(name: string): boolean;
  hasDemuxer(name: string): boolean;
}

export interface LocateOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ToolRunner;
  timeoutMs?: number;
  /** Skip `-encoders`/`-filters`/... discovery (faster startup, no cap checks). */
  skipCapabilities?: boolean;
}

/** FFmpeg 5 is the floor: `-fps_mode` and the current `-progress` format. */
export const MIN_FFMPEG_MAJOR = 5;

/** Runner that executes with the inherited environment. */
export const defaultToolRunner: ToolRunner = (bin, args, timeoutMs) =>
  createToolRunner(process.env)(bin, args, timeoutMs);

/** Runner bound to an explicit environment (used for PATH overrides in tests). */
export function createToolRunner(env: NodeJS.ProcessEnv): ToolRunner {
  return (bin, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
        (error, stdout, stderr) => {
          const errno = error as NodeJS.ErrnoException | null;
          const spawnFailed = errno?.code === 'ENOENT' || errno?.code === 'EACCES';
          const exitCode = typeof errno?.code === 'number' ? errno.code : error ? 1 : 0;
          resolve({
            code: spawnFailed ? 127 : exitCode,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            spawnFailed,
          });
        },
      );
    });
}

export function parseFfmpegVersion(text: string): ParsedVersion | undefined {
  const match = /version\s+n?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text);
  if (!match) return undefined;
  return {
    major: Number(match[1] ?? '0'),
    minor: Number(match[2] ?? '0'),
    patch: Number(match[3] ?? '0'),
    raw: match[0].replace(/^version\s+/i, ''),
  };
}

export function versionText(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function versionAtLeast(version: ParsedVersion, major: number, minor = 0): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

const INSTALL_HINT = [
  'Install FFmpeg and make sure it is on PATH:',
  '  Debian/Ubuntu   sudo apt install ffmpeg',
  '  macOS           brew install ffmpeg',
  '  Windows         winget install Gyan.FFmpeg   (or https://www.gyan.dev/ffmpeg/builds/)',
  'Alternatively point iCamify at a build: --ffmpeg <path> or ICAMIFY_FFMPEG_PATH=<path>.',
].join('\n');

/**
 * Locates FFmpeg and ffprobe, verifies their versions and enumerates
 * capabilities. Every probe is a plain argv spawn — no shell, so paths with
 * spaces or shell metacharacters are safe.
 */
export async function locateFfmpeg(options: LocateOptions = {}): Promise<FfmpegToolchain> {
  const env = options.env ?? process.env;
  const run = options.runner ?? createToolRunner(env);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const ffmpegPath = options.ffmpegPath ?? env.ICAMIFY_FFMPEG_PATH ?? env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? env.ICAMIFY_FFPROBE_PATH ?? env.FFPROBE_PATH ?? 'ffprobe';

  const [ffmpeg, ffprobe] = await Promise.all([
    describeTool(ffmpegPath, run, timeoutMs),
    describeTool(ffprobePath, run, timeoutMs),
  ]);

  const warnings: string[] = [];
  if (!versionAtLeast(ffmpeg.version, MIN_FFMPEG_MAJOR)) {
    throw new MediaError(
      'toolchain-unsupported',
      `FFmpeg ${versionText(ffmpeg.version)} is too old; iCamify needs ${MIN_FFMPEG_MAJOR}.0 or newer.`,
      `Found at ${ffmpeg.path}. Upgrade FFmpeg, or point ICAMIFY_FFMPEG_PATH at a newer build.`,
    );
  }
  if (ffprobe.version.major !== ffmpeg.version.major) {
    warnings.push(
      `ffmpeg ${versionText(ffmpeg.version)} and ffprobe ${versionText(ffprobe.version)} differ in major version; probe results may not match the encoder build.`,
    );
  }

  let capabilities: FfmpegCapabilities = {
    encoders: [],
    filters: [],
    demuxers: [],
    muxers: [],
    protocols: [],
    hwaccels: [],
  };
  if (!options.skipCapabilities) {
    capabilities = await discoverCapabilities(ffmpeg.path, run, timeoutMs);
    if (capabilities.encoders.length === 0) {
      warnings.push(
        'Could not enumerate FFmpeg encoders (`-encoders` output was empty); profile capability checks are disabled.',
      );
    }
  }

  return {
    ffmpeg,
    ffprobe,
    capabilities,
    warnings,
    hasEncoder: (name) => capabilities.encoders.length === 0 || capabilities.encoders.includes(name),
    hasFilter: (name) => capabilities.filters.length === 0 || capabilities.filters.includes(name),
    hasProtocol: (name) => capabilities.protocols.length === 0 || capabilities.protocols.includes(name),
    hasDemuxer: (name) => capabilities.demuxers.length === 0 || capabilities.demuxers.includes(name),
  };
}

async function describeTool(bin: string, run: ToolRunner, timeoutMs: number): Promise<ToolInfo> {
  // An explicit path is checked eagerly so the error names the file the operator
  // configured rather than a bare "ffmpeg not found".
  if (bin.includes('/') || bin.includes('\\')) {
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      throw new MediaError(
        'toolchain-missing',
        `FFmpeg binary is not executable: ${bin}`,
        `Check the path and its permissions.\n${INSTALL_HINT}`,
      );
    }
  }

  const result = await run(bin, ['-hide_banner', '-version'], timeoutMs);
  if (result.spawnFailed) {
    throw new MediaError(
      'toolchain-missing',
      `Could not execute "${bin}" — FFmpeg does not appear to be installed.`,
      INSTALL_HINT,
    );
  }
  if (result.code !== 0) {
    throw new MediaError(
      'toolchain-missing',
      `"${bin} -version" exited with code ${result.code}.`,
      (result.stderr || result.stdout).split('\n').slice(0, 8).join('\n') || INSTALL_HINT,
    );
  }

  const version = parseFfmpegVersion(result.stdout) ?? parseFfmpegVersion(result.stderr);
  if (!version) {
    throw new MediaError(
      'toolchain-unsupported',
      `Could not parse a version out of "${bin} -version" output.`,
      result.stdout.split('\n').slice(0, 3).join('\n'),
    );
  }
  return { path: bin, version };
}

async function discoverCapabilities(
  bin: string,
  run: ToolRunner,
  timeoutMs: number,
): Promise<FfmpegCapabilities> {
  const [encoders, filters, demuxers, muxers, protocols, hwaccels] = await Promise.all([
    run(bin, ['-hide_banner', '-encoders'], timeoutMs),
    run(bin, ['-hide_banner', '-filters'], timeoutMs),
    run(bin, ['-hide_banner', '-demuxers'], timeoutMs),
    run(bin, ['-hide_banner', '-muxers'], timeoutMs),
    run(bin, ['-hide_banner', '-protocols'], timeoutMs),
    run(bin, ['-hide_banner', '-hwaccels'], timeoutMs),
  ]);

  return {
    encoders: parseTable(encoders.stdout, /^\s*[VASD.]{6}\s+(\S+)/),
    filters: parseTable(filters.stdout, /^\s*[TSC.]{3}\s+(\S+)/),
    // Tables print one leading space, then the flag columns: encoders 6 chars,
    // demuxers/muxers 3 (" D  " / " D. "), so the patterns are format-specific.
    demuxers: parseTable(demuxers.stdout, /^ D[ .][ .d]\s+(\S+)/),
    muxers: parseTable(muxers.stdout, /^ [D ]E[ .]\s+(\S+)/),
    protocols: parseProtocols(protocols.stdout),
    hwaccels: hwaccels.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9_]+$/.test(line)),
  };
}

function parseTable(text: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const name = pattern.exec(line)?.[1];
    // Legend lines (" T.. = Timeline support") also match the flag pattern, so
    // only keep entries that look like an actual capability name.
    if (name !== undefined && /^[a-zA-Z0-9_]+$/.test(name)) found.add(name);
  }
  return [...found].sort();
}

function parseProtocols(text: string): string[] {
  const found = new Set<string>();
  let inSection = false;
  for (const line of text.split('\n')) {
    if (/^\s*(Input|Output):/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const match = /^\s{2,}([a-z0-9_]+)\s*$/.exec(line);
    if (match?.[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/** Human-readable toolchain summary used by `icamify doctor`. */
export function describeToolchain(toolchain: FfmpegToolchain): string[] {
  const lines = [
    `ffmpeg   ${versionText(toolchain.ffmpeg.version)}  ${toolchain.ffmpeg.path}`,
    `ffprobe  ${versionText(toolchain.ffprobe.version)}  ${toolchain.ffprobe.path}`,
  ];
  const caps = toolchain.capabilities;
  if (caps.encoders.length > 0) {
    const wanted = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_videotoolbox', 'aac'];
    const present = wanted.filter((name) => caps.encoders.includes(name));
    lines.push(`encoders ${caps.encoders.length} total · relevant: ${present.join(', ') || 'none found'}`);
  }
  if (caps.demuxers.length > 0) {
    const inputs = ['rtsp', 'rtmp', 'flv', 'mjpeg', 'hls'].filter((name) => caps.demuxers.includes(name));
    lines.push(`demuxers ${caps.demuxers.length} total · relevant: ${inputs.join(', ') || 'none found'}`);
  }
  if (caps.hwaccels.length > 0) {
    lines.push(`hwaccels ${caps.hwaccels.join(', ')}`);
  }
  return lines;
}
