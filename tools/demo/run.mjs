#!/usr/bin/env node
/**
 * Boots a complete iCamify demo from a clean checkout.
 *
 * What it does, in order:
 *   1. finds (or generates) three looping H.264 clips, so every camera has a real
 *      RTSP-shaped pipeline feeding motion detection, recording and WebRTC;
 *   2. starts the DeepStack-shaped detector and the fake ONVIF camera;
 *   3. copies `config.demo.json` into `.demo/config.json` (a throwaway data root);
 *   4. starts `icamify serve` and waits for `/api/health` before printing advice.
 *
 * Nothing here is imported by the product: it is a harness, and `.demo/` is
 * gitignored, so a demo run never leaves state in the repository.
 *
 * `node tools/demo/run.mjs [--port 3000] [--ffmpeg /path/to/ffmpeg] [--no-media]`
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const demoDir = join(repoRoot, '.demo');
const mediaDir = join(demoDir, 'media');
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 3000);
const ffmpeg = resolveFfmpeg(args.ffmpeg);

if (ffmpeg === undefined) {
  fail('no FFmpeg found: pass --ffmpeg <path>, set ICAMIFY_FFMPEG_PATH, or put ffmpeg on PATH');
}
// A static build ships ffprobe next to ffmpeg; use it when it is not on PATH.
const ffprobePath = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffprobe = existsSync(ffprobePath) ? ffprobePath : undefined;
mkdirSync(mediaDir, { recursive: true });
mkdirSync(join(demoDir, 'data'), { recursive: true });

const configPath = join(demoDir, 'config.json');
const config = JSON.parse(readFileSync(join(here, 'config.demo.json'), 'utf8'));
config.system.server.port = port;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const children = [];
let shuttingDown = false;

if (args['no-media'] !== true) ensureMedia();

start('ai', process.execPath, [join(here, 'fake-ai.mjs'), '--port', '8765']);
start('onvif', process.execPath, [join(here, 'fake-onvif.mjs'), '--port', '8990']);

const server = start(
  'server',
  process.execPath,
  [
    join(repoRoot, 'apps/server/src/cli.ts'),
    'serve',
    '--config',
    configPath,
    '--ffmpeg',
    ffmpeg,
    ...(ffprobe === undefined ? [] : ['--ffprobe', ffprobe]),
    '--port',
    String(port),
  ],
  { inherit: true },
);

void waitForHealth().then(() => {
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(
    [
      '',
      'iCamify demo is up',
      `  console      ${url}`,
      `  live view    WebRTC (fallback MSE → MJPEG per tile)`,
      '  cameras      front-door, parking, porch-ptz (fake ONVIF device on :8990)',
      '  ai           DeepStack-shaped stub on :8765 (person + car, alternating)',
      `  data         ${join(demoDir, 'data')} (retention: 2 GB / 24 h)`,
      '',
      '  try:         npm run demo:rtc -- --camera front-door',
      '               open the Onvif panel and scan (finds "Porch PTZ")',
      '  stop:        Ctrl-C',
      '',
    ].join('\n'),
  );
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => {
  if (shuttingDown) return;
  shutdown(code ?? 0);
});

function ensureMedia() {
  const clips = [
    { name: 'front-door', source: 'testsrc2=size=640x360:rate=15', seconds: 8 },
    { name: 'parking', source: 'smptebars=size=640x360:rate=15', seconds: 8 },
    { name: 'porch', source: 'rgbtestsrc=size=640x360:rate=15', seconds: 8 },
  ];
  for (const clip of clips) {
    const path = join(mediaDir, `${clip.name}.mp4`);
    if (existsSync(path)) continue;
    process.stdout.write(`[demo] generating ${clip.name}.mp4 (${clip.seconds}s H.264)\n`);
    const result = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        clip.source,
        '-t',
        String(clip.seconds),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '15',
        '-keyint_min',
        '15',
        '-sc_threshold',
        '0',
        '-an',
        path,
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) fail(`ffmpeg failed to generate ${clip.name}.mp4`);
  }
}

function start(label, command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: options.inherit === true ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  children.push({ label, child });
  if (options.inherit !== true) {
    child.stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
    child.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
  }
  child.on('exit', (code) => {
    if (!shuttingDown) process.stdout.write(`[demo] ${label} exited (${code})\n`);
  });
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json();
        process.stdout.write(
          `[demo] health ok — ${body.cameras?.enabled ?? '?'} camera(s) enabled, ` +
            `${body.ffmpeg?.version ?? 'ffmpeg?'}\n`,
        );
        return;
      }
    } catch {
      // The listener is not up yet.
    }
    if (Date.now() > deadline) {
      process.stdout.write('[demo] the server did not become healthy; see the log above\n');
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children.reverse()) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => process.exit(code), 400);
}

function resolveFfmpeg(explicit) {
  if (explicit !== undefined) return resolve(explicit);
  if (process.env.ICAMIFY_FFMPEG_PATH !== undefined) return resolve(process.env.ICAMIFY_FFMPEG_PATH);
  const toolsDir = join(repoRoot, '.tools');
  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir)) {
      if (!entry.startsWith('ffmpeg')) continue;
      const candidate = join(toolsDir, entry, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (existsSync(candidate)) return candidate;
    }
  }
  const which = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return which.status === 0 ? 'ffmpeg' : undefined;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      result[flag.slice(2)] = true;
      continue;
    }
    result[flag.slice(2)] = next;
    index += 1;
  }
  return result;
}

function fail(message) {
  process.stderr.write(`[demo] ${message}\n`);
  process.exit(1);
}
