import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, ENV_OVERRIDES } from './defaults.ts';
import { interpolateEnv, type EnvReference } from './env.ts';
import { JsoncParseError, parseJsonc } from './jsonc.ts';
import { deepMerge, isPlainObject, setPath } from './merge.ts';
import { checkSemantics, validateSchema } from './validate.ts';
import type { ConfigIssue, IcamifyConfig, ResolvedIcamifyConfig } from './types.ts';

export type ConfigErrorKind = 'missing-file' | 'parse' | 'env' | 'schema' | 'semantics' | 'version';

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly issues: ConfigIssue[];

  constructor(
    message: string,
    kind: ConfigErrorKind,
    issues: ConfigIssue[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConfigError';
    this.kind = kind;
    this.issues = issues;
  }

  get errors(): ConfigIssue[] {
    return this.issues.filter((issue) => issue.severity === 'error');
  }
}

export interface LoadConfigOptions {
  /** Path to icamify.json. Defaults to $ICAMIFY_CONFIG or ./config/icamify.json. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Programmatic overrides applied last (used by tests and the UI draft preview). */
  overrides?: unknown;
  schemaPath?: string;
  /** Skip profile/volume/schedule integrity checks. */
  skipSemantics?: boolean;
}

export interface LoadedConfig {
  config: ResolvedIcamifyConfig;
  sourcePath: string;
  warnings: ConfigIssue[];
  envReferences: EnvReference[];
  /** Environment variables applied as direct overrides (ICAMIFY_PORT, ...). */
  envOverrides: string[];
}

export const SUPPORTED_CONFIG_VERSION = '1.0';

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ICAMIFY_CONFIG ?? './config/icamify.json';
}

function envIssues(
  missing: Array<{ name: string; path: string }>,
  malformed: Array<{ path: string; value: string }>,
): ConfigIssue[] {
  return [
    ...missing.map<ConfigIssue>((entry) => ({
      severity: 'error',
      path: entry.path || '(root)',
      code: 'missing-env',
      message: `environment variable "${entry.name}" is not set and has no fallback (${entry.path || '(root)'})`,
    })),
    ...malformed.map<ConfigIssue>((entry) => ({
      severity: 'error',
      path: entry.path || '(root)',
      code: 'malformed-env',
      message: `unresolved or malformed \${...} reference in "${entry.value}"`,
    })),
  ];
}

function applyEnvOverrides(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { applied: string[]; issues: ConfigIssue[] } {
  const applied: string[] = [];
  const issues: ConfigIssue[] = [];

  for (const override of ENV_OVERRIDES) {
    const raw = env[override.env];
    if (raw === undefined || raw === '') continue;

    const parsed = override.parse ? override.parse(raw) : raw;
    if (typeof parsed === 'number' && (!Number.isFinite(parsed) || parsed <= 0)) {
      issues.push({
        severity: 'error',
        path: override.path,
        code: 'bad-env-override',
        message: `environment variable ${override.env}="${raw}" is not a valid value`,
      });
      continue;
    }
    setPath(config, override.path, parsed);
    applied.push(override.env);
  }

  return { applied, issues };
}

/**
 * Load, resolve and validate a configuration file.
 * Throws ConfigError with structured issues; warnings are returned.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const sourcePath = resolve(process.cwd(), options.path ?? defaultConfigPath(env));

  if (!existsSync(sourcePath)) {
    throw new ConfigError(
      `configuration file not found: ${sourcePath}`,
      'missing-file',
      [],
    );
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(sourcePath, 'utf8'), sourcePath);
  } catch (error) {
    if (error instanceof JsoncParseError) {
      throw new ConfigError(error.message, 'parse', [
        { severity: 'error', path: '(file)', code: 'parse', message: error.message },
      ], { cause: error });
    }
    throw new ConfigError(
      `could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      'parse',
      [],
      { cause: error },
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `${sourcePath}: top-level value must be a JSON object`,
      'parse',
      [{ severity: 'error', path: '(root)', code: 'parse', message: 'top-level value must be an object' }],
    );
  }

  const version = parsed.version;
  if (typeof version === 'string' && version !== SUPPORTED_CONFIG_VERSION) {
    throw new ConfigError(
      `${sourcePath}: unsupported config version "${version}" (expected "${SUPPORTED_CONFIG_VERSION}")`,
      'version',
      [
        {
          severity: 'error',
          path: 'version',
          code: 'unsupported-version',
          message: `unsupported config version "${version}" (expected "${SUPPORTED_CONFIG_VERSION}")`,
        },
      ],
    );
  }

  const interpolation = interpolateEnv(parsed, env);
  const interpolationIssues = envIssues(interpolation.missing, interpolation.malformed);
  if (interpolationIssues.length > 0) {
    const names = [...new Set(interpolation.missing.map((entry) => entry.name))];
    throw new ConfigError(
      names.length > 0
        ? `missing environment variables: ${names.join(', ')}`
        : 'could not resolve environment references',
      'env',
      interpolationIssues,
    );
  }

  let merged: Record<string, unknown> = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    interpolation.value as Record<string, unknown>,
  );

  const { applied, issues: overrideIssues } = applyEnvOverrides(merged, env);
  if (overrideIssues.length > 0) {
    throw new ConfigError('invalid environment overrides', 'env', overrideIssues);
  }
  if (options.overrides !== undefined) {
    merged = deepMerge(merged, options.overrides);
  }

  // Detach untouched branches from the shared DEFAULT_CONFIG object so callers
  // cannot mutate the defaults through a loaded configuration.
  let isolated: Record<string, unknown>;
  try {
    isolated = structuredClone(merged);
  } catch (error) {
    throw new ConfigError(
      `${sourcePath}: configuration is not plain JSON data`,
      'parse',
      [{ severity: 'error', path: '(root)', code: 'not-json', message: 'value cannot be cloned' }],
      { cause: error },
    );
  }

  const schemaIssues = validateSchema(isolated, options.schemaPath);
  if (schemaIssues.length > 0) {
    throw new ConfigError(
      `${sourcePath}: failed schema validation (${schemaIssues.length} error${schemaIssues.length === 1 ? '' : 's'})`,
      'schema',
      schemaIssues,
    );
  }

  const config = isolated as unknown as ResolvedIcamifyConfig;
  const semanticIssues = options.skipSemantics ? [] : checkSemantics(config);
  const errors = semanticIssues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new ConfigError(
      `${sourcePath}: failed integrity checks (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      'semantics',
      semanticIssues,
    );
  }

  return {
    config,
    sourcePath,
    warnings: semanticIssues.filter((issue) => issue.severity === 'warning'),
    envReferences: interpolation.references,
    envOverrides: applied,
  };
}

export function parseConfigText(text: string, env: NodeJS.ProcessEnv = process.env): unknown {
  const parsed = parseJsonc(text, '<inline>');
  return interpolateEnv(parsed, env).value;
}

export type { IcamifyConfig };
