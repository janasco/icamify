import { ConfigError } from '@icamify/core';
import { MediaError } from '@icamify/media';
import { startServer } from '../serve.ts';
import type { CommonCommandOptions } from './diagnostics.ts';

/**
 * `icamify serve` — the long-running process.
 *
 * Signals shut down in the documented order: stop accepting connections, stop
 * encoders, close sockets, exit. A second Ctrl-C is left to the default handler
 * so nothing can trap an operator who needs the process gone immediately.
 */

export interface ServeCommandOptions extends CommonCommandOptions {
  host?: string;
  port?: number;
  staticDir?: string;
}

export async function runServe(options: ServeCommandOptions): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  try {
    const running = await startServer({
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
      ...(options.ffprobePath === undefined ? {} : { ffprobePath: options.ffprobePath }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
      log: out,
    });

    const transport = running.registry
      .availability()
      .map((entry) => `${entry.transport}${entry.available ? '' : '(off)'}`)
      .join(' → ');

    out(`  config   ${running.config.cameras.length} camera(s), ${Object.keys(running.config.streaming.profiles ?? {}).length} profile(s)`);
    out(`  live     ${transport}`);
    out(`  auth     ${running.auth.open ? 'disabled (single-user mode)' : `${running.auth.userCount} user(s)`}`);
    out(`  health   ${running.listen.url}/health`);
    out('  press Ctrl-C to stop');

    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        out('shutting down…');
        resolve();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });

    await running.close();
    out('stopped');
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`icamify serve: ${error.message}\n`);
      for (const issue of error.issues) {
        process.stderr.write(`  ${issue.severity}  ${issue.path}  ${issue.message}  [${issue.code}]\n`);
      }
      return 1;
    }
    if (error instanceof MediaError) {
      process.stderr.write(`icamify serve: ${error.message}\n`);
      if (error.detail !== undefined) process.stderr.write(`${error.detail}\n`);
      return 1;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`icamify serve: ${message}\n`);
    return 1;
  }
}
