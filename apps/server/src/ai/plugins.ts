import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AiCapability } from '@icamify/core';

/**
 * Plugin discovery.
 *
 * A plugin is a directory with a `manifest.json` (`id`, `kind`, `entry`) under one
 * of `plugins.directories`. Only plugins listed in `plugins.trustedPlugins` are
 * loaded: installing a directory is not the same as trusting its code, and the
 * manifest itself is data from disk, not an instruction.
 */

export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  apiVersion?: number;
  kind?: string;
  entry?: string;
  runtime?: string;
  capabilities?: AiCapability[];
  description?: string;
}

export interface PluginInfo extends PluginManifest {
  directory: string;
  entryPath?: string;
  trusted: boolean;
  error?: string;
}

export interface PluginResolverOptions {
  directories: ReadonlyArray<string>;
  trustedPlugins: ReadonlyArray<string>;
  enabled?: boolean;
  cwd?: string;
  log?: (line: string) => void;
}

export interface PluginResolver {
  resolveEntry(pluginId: string): string | undefined;
  list(): PluginInfo[];
}

export function createPluginResolver(options: PluginResolverOptions): PluginResolver {
  const cwd = options.cwd ?? process.cwd();
  const plugins = scan(options, cwd);
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

  for (const plugin of plugins) {
    if (plugin.error !== undefined) {
      options.log?.(`plugin ${plugin.id}: ${plugin.error}`);
    } else if (!plugin.trusted && options.enabled !== false) {
      options.log?.(`plugin ${plugin.id} is installed but not in plugins.trustedPlugins; it will not be loaded`);
    }
  }

  return {
    list: () => plugins.map((plugin) => ({ ...plugin })),
    resolveEntry: (pluginId) => {
      if (options.enabled === false) return undefined;
      const plugin = byId.get(pluginId);
      if (plugin === undefined || plugin.entryPath === undefined) return undefined;
      if (!plugin.trusted) return undefined;
      return existsSync(plugin.entryPath) ? plugin.entryPath : undefined;
    },
  };
}

function scan(options: PluginResolverOptions, cwd: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  const seen = new Set<string>();

  for (const directory of options.directories) {
    const root = isAbsolute(directory) ? directory : resolve(cwd, directory);
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      // A missing plugin directory is normal on a fresh install.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDirectory = join(root, entry.name);
      const manifestPath = join(pluginDirectory, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      let manifest: PluginManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
      } catch (error) {
        options.log?.(`plugin at ${pluginDirectory}: manifest.json is not valid JSON (${message(error)})`);
        continue;
      }
      if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
        options.log?.(`plugin at ${pluginDirectory}: manifest has no id`);
        continue;
      }
      if (seen.has(manifest.id)) {
        options.log?.(`plugin ${manifest.id}: duplicate id at ${pluginDirectory}; keeping the first`);
        continue;
      }
      seen.add(manifest.id);

      const trusted = options.trustedPlugins.includes(manifest.id);
      const entryPath =
        typeof manifest.entry === 'string' && manifest.entry.length > 0
          ? resolve(pluginDirectory, manifest.entry)
          : undefined;

      plugins.push({
        ...manifest,
        directory: pluginDirectory,
        trusted,
        ...(entryPath === undefined ? { error: 'manifest has no entry module' } : { entryPath }),
      });
    }
  }

  return plugins;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
