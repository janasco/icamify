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

const PROGRAM = 'icamify';

const HELP = `${PROGRAM} ${CORE_VERSION} — self-hosted NVR/VMS

Usage:
  ${PROGRAM} config validate [--config <path>] [--json] [--quiet]
  ${PROGRAM} config print    [--config <path>] [--show-secrets]
  ${PROGRAM} config schema   [--output <path>]
  ${PROGRAM} --help | --version

Commands:
  config validate   Parse, merge, validate and integrity-check the configuration.
                    Exits 1 when there is an error; warnings do not fail.
  config print      Print the fully resolved configuration with secrets redacted.
  config schema     Print (or write) the JSON Schema used for validation.

Options:
  -c, --config <path>   Configuration file (default: $ICAMIFY_CONFIG or
                        ./config/icamify.json).
      --json            Machine-readable output for validate.
      --quiet           Only print problems, not the summary.
      --show-secrets    Include secret values in "config print" output. Avoid in
                        shared terminals; secrets are redacted by default.
  -o, --output <path>   Write schema to a file instead of stdout.
  -h, --help            Show this help.
  -v, --version         Show the version.

Getting started:
  cp config/icamify.example.json config/icamify.json
  ${PROGRAM} config validate
`;

interface ParsedArgs {
  command: string[];
  config?: string;
  json: boolean;
  quiet: boolean;
  showSecrets: boolean;
  output?: string;
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
    help: values.help ?? false,
    version: values.version ?? false,
  };
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

function main(argv: string[]): number {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${PROGRAM}: ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
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
  if (rest.length > 0) {
    process.stderr.write(`${PROGRAM}: unexpected arguments: ${rest.join(' ')}\n`);
    return 2;
  }

  if (group === 'config') {
    switch (action) {
      case 'validate':
        return commandValidate(args);
      case 'print':
        return commandPrint(args);
      case 'schema':
        return commandSchema(args);
      default:
        process.stderr.write(`${PROGRAM}: unknown config command "${action ?? ''}"\n\n${HELP}`);
        return 2;
    }
  }

  process.stderr.write(
    `${PROGRAM}: unknown command "${args.command.join(' ')}". ` +
      'The server entrypoint is implemented in Phase 2; configuration commands are available now.\n\n',
  );
  process.stderr.write(HELP);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
