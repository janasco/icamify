import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { interpolateTemplate } from '@icamify/ai';

/**
 * The `then.script` rule action.
 *
 * Security model, in order of importance:
 *
 * 1. Off unless `scripts.enabled` is true, so a default deployment has no way to
 *    execute anything.
 * 2. A script path must resolve (after symlinks) inside one of `scripts.directories`.
 * 3. `spawn` with `shell: false` — there is no shell, so a camera name containing
 *    `; rm -rf /` is just characters in an argv entry.
 * 4. Event fields arrive as `ICAMIFY_*` environment variables, not spliced into
 *    the command line; `{placeholder}` substitution in `args` is plain string
 *    replacement into one argv element.
 * 5. Every run is bounded by a timeout and killed as a process group, so a script
 *    that forks cannot outlive it.
 */

export interface ScriptContext {
  ruleId: string;
  ruleName: string;
  cameraId: string;
  cameraName: string;
  kind: string;
  label?: string;
  confidence?: number;
  at: number;
  severity: string;
  title: string;
  message: string;
  snapshot?: string;
  eventId?: string;
}

export interface ScriptAction {
  path: string;
  args?: string[];
  timeoutSeconds?: number;
}

export interface ScriptRunnerOptions {
  directories: string[];
  /** Must be true; the composition root only builds a runner when configured. */
  enabled?: boolean;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  maxConcurrent?: number;
  environment?: Record<string, string>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ScriptResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Human-readable command, for the rule outcome. */
  command: string;
  detail: string;
}

export class ScriptError extends Error {
  readonly stage: string;

  constructor(message: string, stage: string) {
    super(message);
    this.name = 'ScriptError';
    this.stage = stage;
  }
}

const MAX_DETAIL_CHARS = 200;

export class ScriptRunner {
  private readonly options: ScriptRunnerOptions;
  private running = 0;

  constructor(options: ScriptRunnerOptions) {
    this.options = options;
  }

  get activeRuns(): number {
    return this.running;
  }

  async run(action: ScriptAction, context: ScriptContext): Promise<ScriptResult> {
    if (this.options.enabled !== true) {
      throw new ScriptError('script actions are disabled (set scripts.enabled to true to allow them)', 'disabled');
    }
    const maxConcurrent = Math.max(1, this.options.maxConcurrent ?? 2);
    if (this.running >= maxConcurrent) {
      throw new ScriptError(`script concurrency limit reached (${maxConcurrent} already running)`, 'busy');
    }

    const file = this.resolve(action.path);
    const values = templateValues(context);
    const args = (action.args ?? []).map((arg) => interpolateTemplate(arg, values));
    const timeoutMs = Math.max(100, (action.timeoutSeconds ?? this.options.timeoutSeconds ?? 10) * 1000);
    const maxOutputBytes = Math.max(0, this.options.maxOutputBytes ?? 4096);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.options.environment ?? {}),
      ...scriptEnvironment(context),
    };

    this.running += 1;
    try {
      return await spawnScript({ file, args, env, timeoutMs, maxOutputBytes, now: () => this.now() });
    } finally {
      this.running -= 1;
    }
  }

  /**
   * Finds the script on disk and proves it stays inside an allowed directory.
   * Symlinks are resolved first, so a link inside `directories` that points at
   * `/etc/passwd` is rejected rather than followed.
   */
  private resolve(requested: string): string {
    if (requested.trim().length === 0) throw new ScriptError('the script path is empty', 'path');
    if (requested.includes('\0')) throw new ScriptError('the script path contains a NUL byte', 'path');

    const roots = (this.options.directories.length > 0 ? this.options.directories : ['.']).map(realDirectory);
    const candidates = isAbsolute(requested) ? [requested] : roots.map((root) => resolve(root, requested));

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
      if (!inside) {
        throw new ScriptError(
          `script "${requested}" resolves outside the configured script directories (${roots.join(', ')})`,
          'outside-directories',
        );
      }
      if (!statSync(real).isFile()) throw new ScriptError(`script "${requested}" is not a regular file`, 'path');
      try {
        accessSync(real, constants.X_OK);
      } catch {
        throw new ScriptError(`script "${requested}" is not executable (chmod +x it)`, 'permission');
      }
      return real;
    }

    throw new ScriptError(`script "${requested}" was not found in ${roots.join(', ')}`, 'not-found');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function realDirectory(directory: string): string {
  const absolute = resolve(directory);
  try {
    return realpathSync(absolute);
  } catch {
    // A directory that does not exist yet still bounds a candidate path.
    return absolute;
  }
}

function templateValues(context: ScriptContext): Record<string, string | number | undefined> {
  return {
    ruleId: context.ruleId,
    ruleName: context.ruleName,
    cameraId: context.cameraId,
    cameraName: context.cameraName,
    kind: context.kind,
    label: context.label,
    confidence: context.confidence === undefined ? undefined : context.confidence.toFixed(2),
    time: new Date(context.at).toISOString(),
    severity: context.severity,
    title: context.title,
    message: context.message,
    snapshot: context.snapshot,
    eventId: context.eventId,
  };
}

function scriptEnvironment(context: ScriptContext): Record<string, string> {
  const env: Record<string, string> = {
    ICAMIFY_RULE_ID: context.ruleId,
    ICAMIFY_RULE_NAME: context.ruleName,
    ICAMIFY_CAMERA_ID: context.cameraId,
    ICAMIFY_CAMERA_NAME: context.cameraName,
    ICAMIFY_EVENT_KIND: context.kind,
    ICAMIFY_EVENT_TIME: new Date(context.at).toISOString(),
    ICAMIFY_SEVERITY: context.severity,
    ICAMIFY_TITLE: context.title,
    ICAMIFY_MESSAGE: context.message,
  };
  if (context.label !== undefined) env.ICAMIFY_LABEL = context.label;
  if (context.confidence !== undefined) env.ICAMIFY_CONFIDENCE = context.confidence.toFixed(3);
  if (context.snapshot !== undefined) env.ICAMIFY_SNAPSHOT = context.snapshot;
  if (context.eventId !== undefined) env.ICAMIFY_EVENT_ID = context.eventId;
  return env;
}

function spawnScript(options: {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  now: () => number;
}): Promise<ScriptResult> {
  const startedAt = options.now();
  const command = displayCommand(options.file, options.args);

  return new Promise<ScriptResult>((resolvePromise, reject) => {
    const child = spawn(options.file, options.args, {
      cwd: dirname(options.file),
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: a timeout can then kill the script and its children.
      detached: true,
    });

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= options.maxOutputBytes) return current;
      return current + chunk.subarray(0, Math.max(0, options.maxOutputBytes - current.length)).toString('utf8');
    };

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      // A script that ignores SIGTERM still must not outlive its rule.
      forceKill = setTimeout(() => kill('SIGKILL'), 1500);
      forceKill.unref();
    }, options.timeoutMs);
    timer.unref();
    let forceKill: NodeJS.Timeout;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      const durationMs = Math.max(0, options.now() - startedAt);
      const firstError = stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      const ok = !timedOut && code === 0;

      let detail: string;
      if (timedOut) detail = `${command} timed out after ${options.timeoutMs}ms`;
      else if (ok) detail = `${command} exited 0 in ${durationMs}ms`;
      else detail = `${command} exited ${code ?? signal ?? 'unknown'}${firstError === undefined ? '' : `: ${firstError}`}`;

      resolvePromise({
        ok,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs,
        command,
        detail: trim(detail),
      });
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      reject(new ScriptError(`could not start ${command}: ${error.message}`, 'spawn'));
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

function displayCommand(file: string, args: string[]): string {
  const text = [basename(file), ...args].join(' ');
  return trim(text);
}

function trim(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_DETAIL_CHARS ? collapsed : `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
