#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CORE_VERSION,
  ConfigError,
  defaultConfigPath,
  getConfigSchema,
  getConfigSchemaPath,
  loadConfig,
  redactConfig,
  type ConfigIssue,
} from '@icamify/core';
import type { PipelinePurpose } from '@icamify/media';
import { runDoctor, runIngest, runProbe, type CommonCommandOptions } from './commands/diagnostics.ts';
import { runServe } from './commands/serve.ts';
import { runUserHash } from './commands/user.ts';

const PROGRAM = 'icamify';

const HELP = `${PROGRAM} ${CORE_VERSION} — self-hosted NVR/VMS

Usage:
  ${PROGRAM} serve          [--config <path>] [--host <addr>] [--port <n>] [--static-dir <path>]
  ${PROGRAM} doctor         [--config <path>] [--json]
  ${PROGRAM} probe          --camera <id> [--stream main|sub] [--json]
  ${PROGRAM} ingest         --camera <id> --purpose record|live|detect [--dry-run] [--seconds <n>]
  ${PROGRAM} config validate [--config <path>] [--json] [--quiet]
  ${PROGRAM} config print    [--config <path>] [--show-secrets]
  ${PROGRAM} config schema   [--output <path>]
  ${PROGRAM} user hash
  ${PROGRAM} --help | --version

Commands:
  serve             Run the NVR: HTTP API, WebSocket hub, live streaming and the console.
                    This is the normal way to start iCamify.
  doctor            Check Node, config, FFmpeg, encoders and storage before starting.
  probe             Run ffprobe against one camera stream and print what it found.
  ingest            Run one camera pipeline in the foreground. With --dry-run it
                    prints the exact FFmpeg command without touching the camera.
  config validate   Parse, merge, validate and integrity-check the configuration.
                    Exits 1 when there is an error; warnings do not fail.
  config print      Print the fully resolved configuration with secrets redacted.
  config schema     Print (or write) the JSON Schema used for validation.
  user hash         Read a password from stdin and print an argon2id hash for
                    auth.users[].passwordHash. Passwords are never taken from argv.

Options:
  -c, --config <path>   Configuration file (default: $ICAMIFY_CONFIG or
                        ./config/icamify.json).
      --camera <id>     Camera id from cameras[].
      --purpose <kind>  record | live | detect.
      --stream <kind>   main | sub (default: main).
      --dry-run         Print the pipeline command instead of running it.
      --seconds <n>     Stop the pipeline after n seconds (default: until Ctrl-C).
      --ffmpeg <path>   FFmpeg binary (default: $ICAMIFY_FFMPEG_PATH or PATH).
      --ffprobe <path>  ffprobe binary (default: $ICAMIFY_FFPROBE_PATH or PATH).
      --host <addr>     Bind address for "serve" (default: system.server.host).
      --port <n>        Port for "serve" (default: system.server.port).
      --static-dir <p>  Console build directory served by "serve".
      --json            Machine-readable output for doctor, probe and validate.
      --quiet           Suppress per-stream progress and FFmpeg stderr lines.
      --show-secrets    Include secret values in "config print" output. Avoid in
                        shared terminals; secrets are redacted by default.
  -o, --output <path>   Write schema to a file instead of stdout.
  -h, --help            Show this help.
  -v, --version         Show the version.

Getting started:
  cp config/icamify.example.json config/icamify.json
  ${PROGRAM} config validate
  ${PROGRAM} doctor
  ${PROGRAM} ingest --camera front-door --purpose record --dry-run
`;

interface ParsedArgs {
  command: string[];
  config?: string;
  json: boolean;
  quiet: boolean;
  showSecrets: boolean;
  output?: string;
  camera?: string;
  purpose?: string;
  stream?: string;
  seconds?: string;
  dryRun: boolean;
  ffmpeg?: string;
  ffprobe?: string;
  host?: string;
  port?: string;
  staticDir?: string;
  help: boolean;
  version: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      'show-secrets': { type: 'boolean', default: false },
      output: { type: 'string', short: 'o' },
      camera: { type: 'string' },
      purpose: { type: 'string' },
      stream: { type: 'string' },
      seconds: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ffmpeg: { type: 'string' },
      ffprobe: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'static-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  return {
    command: positionals,
    config: values.config,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    showSecrets: values['show-secrets'] ?? false,
    output: values.output,
    camera: values.camera,
    purpose: values.purpose,
    stream: values.stream,
    seconds: values.seconds,
    dryRun: values['dry-run'] ?? false,
    ffmpeg: values.ffmpeg,
    ffprobe: values.ffprobe,
    host: values.host,
    port: values.port,
    staticDir: values['static-dir'],
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function commonOptions(args: ParsedArgs): CommonCommandOptions {
  return {
    configPath: args.config,
    ffmpegPath: args.ffmpeg,
    ffprobePath: args.ffprobe,
    json: args.json,
    quiet: args.quiet,
  };
}

function usageError(message: string): number {
  process.stderr.write(`${PROGRAM}: ${message}\n\n${HELP}`);
  return 2;
}

function formatIssue(issue: ConfigIssue): string {
  const label = issue.severity === 'error' ? 'error' : 'warn ';
  return `  ${label}  ${issue.path}  ${issue.message}  [${issue.code}]`;
}

function printIssues(issues: ConfigIssue[]): void {
  for (const issue of issues) {
    process.stderr.write(`${formatIssue(issue)}\n`);
  }
}

function printWarnings(warnings: ConfigIssue[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}:\n`);
  printIssues(warnings);
}

function relativeSource(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') ? path : rel;
}

function resolveConfigPath(args: ParsedArgs): string {
  return args.config ?? defaultConfigPath(process.env);
}

function commandValidate(args: ParsedArgs): number {
  const path = resolveConfigPath(args);

  try {
    const loaded = loadConfig({ path, schemaPath: undefined });
    const { config, warnings } = loaded;

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            valid: true,
            source: loaded.sourcePath,
            warnings,
            summary: {
              cameras: config.cameras.length,
              profiles: Object.keys(config.streaming.profiles ?? {}).length,
              volumes: (config.storage.volumes ?? []).length,
              rules: (config.rules ?? []).length,
              layouts: (config.layouts ?? []).length,
            },
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (!args.quiet) {
      const enabledCameras = config.cameras.filter((camera) => camera.enabled !== false).length;
      process.stdout.write(`${PROGRAM} config — ${relativeSource(loaded.sourcePath)}\n`);
      process.stdout.write(
        `  ${enabledCameras}/${config.cameras.length} cameras enabled · ` +
          `${Object.keys(config.streaming.profiles ?? {}).length} profiles · ` +
          `${(config.storage.volumes ?? []).length} volumes · ` +
          `${(config.rules ?? []).length} rules · ` +
          `${(config.layouts ?? []).length} layouts\n`,
      );
      if (loaded.envOverrides.length > 0) {
        process.stdout.write(`  env overrides: ${loaded.envOverrides.join(', ')}\n`);
      }
      process.stdout.write(
        warnings.length === 0
          ? '  configuration is valid\n'
          : `  configuration is valid with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`,
      );
    }

    printWarnings(warnings);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              valid: false,
              source: path,
              kind: error.kind,
              message: error.message,
              errors: error.issues.filter((issue) => issue.severity === 'error'),
              warnings: error.issues.filter((issue) => issue.severity === 'warning'),
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stderr.write(`${PROGRAM} config: ${error.message}\n`);
        printIssues(error.issues);
        if (error.kind === 'missing-file') {
          process.stderr.write(
            '\nHint: cp config/icamify.example.json config/icamify.json (then edit it), ' +
              `or pass --config <path>. Looked for: ${resolve(path)}\n`,
          );
        }
      }
      return 1;
    }
    throw error;
  }
}

function commandPrint(args: ParsedArgs): number {
  const path = resolveConfigPath(args);
  try {
    const loaded = loadConfig({ path });
    const output = args.showSecrets ? loaded.config : redactConfig(loaded.config);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (loaded.warnings.length > 0) {
      printWarnings(loaded.warnings);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${PROGRAM} config: ${error.message}\n`);
      printIssues(error.issues);
      return 1;
    }
    throw error;
  }
}

function commandSchema(args: ParsedArgs): number {
  const schema = getConfigSchema();
  const text = `${JSON.stringify(schema, null, 2)}\n`;

  if (args.output) {
    const target = resolve(process.cwd(), args.output);
    writeFileSync(target, text, 'utf8');
    process.stderr.write(`wrote ${relativeSource(target)}\n`);
    return 0;
  }

  process.stdout.write(text);
  return 0;
}

function parsePurpose(value: string | undefined): PipelinePurpose | undefined {
  return value === 'record' || value === 'live' || value === 'detect' ? value : undefined;
}

async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  if (args.version) {
    process.stdout.write(`${PROGRAM} ${CORE_VERSION} (schema at ${getConfigSchemaPath()})\n`);
    return 0;
  }
  if (args.help || args.command.length === 0) {
    process.stdout.write(HELP);
    return args.command.length === 0 && !args.help ? 2 : 0;
  }

  const [group, action, ...rest] = args.command;

  if (group === 'serve') {
    if (action !== undefined) return usageError(`serve takes no subcommand (got "${action}")`);
    let port: number | undefined;
    if (args.port !== undefined) {
      const parsed = Number(args.port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return usageError('--port must be an integer between 1 and 65535');
      port = parsed;
    }
    return runServe({
      ...commonOptions(args),
      ...(args.host === undefined ? {} : { host: args.host }),
      ...(port === undefined ? {} : { port }),
      ...(args.staticDir === undefined ? {} : { staticDir: args.staticDir }),
    });
  }

  if (group === 'user') {
    if (action !== 'hash') return usageError(`unknown user command "${action ?? ''}". Available: user hash.`);
    if (rest.length > 0) return usageError(`unexpected arguments: ${rest.join(' ')}`);
    return runUserHash();
  }

  if (group === 'doctor') {
    if (action !== undefined) return usageError(`doctor takes no subcommand (got "${action}")`);
    return runDoctor(commonOptions(args));
  }

  if (group === 'probe') {
    if (action !== undefined) return usageError(`unexpected argument "${action}" for probe`);
    if (args.camera === undefined) return usageError('probe needs --camera <id>');
    if (args.stream !== undefined && args.stream !== 'main' && args.stream !== 'sub') {
      return usageError('--stream must be "main" or "sub"');
    }
    return runProbe({ ...commonOptions(args), cameraId: args.camera, stream: args.stream ?? 'main' });
  }

  if (group === 'ingest') {
    if (action !== undefined) return usageError(`unexpected argument "${action}" for ingest`);
    if (args.camera === undefined) return usageError('ingest needs --camera <id>');
    const purpose = parsePurpose(args.purpose);
    if (purpose === undefined) return usageError('ingest needs --purpose record|live|detect');

    let seconds: number | undefined;
    if (args.seconds !== undefined) {
      const parsed = Number(args.seconds);
      if (!Number.isFinite(parsed) || parsed < 0) return usageError('--seconds must be a non-negative number');
      seconds = parsed;
    }
    return runIngest({ ...commonOptions(args), cameraId: args.camera, purpose, dryRun: args.dryRun, seconds });
  }

  if (group === 'config') {
    if (rest.length > 0) return usageError(`unexpected arguments: ${rest.join(' ')}`);
    switch (action) {
      case 'validate':
        return commandValidate(args);
      case 'print':
        return commandPrint(args);
      case 'schema':
        return commandSchema(args);
      default:
        return usageError(`unknown config command "${action ?? ''}"`);
    }
  }

  return usageError(
    `unknown command "${args.command.join(' ')}". Available: serve, doctor, probe, ingest, config, user.`,
  );
}

process.exitCode = await main(process.argv.slice(2));
