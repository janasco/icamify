import { Worker } from 'node:worker_threads';
import type { AiCapability, PluginProvider } from '@icamify/core';
import { AiError } from '../errors.ts';
import type { AiProviderClient, Detection, DetectionRequest } from '../index.ts';
import { clamp } from '../mapping.ts';
import type { HostToPlugin, PluginToHost, PluginWorkerData } from '../plugin-protocol.ts';

/**
 * Hot-loaded plugin provider.
 *
 * The plugin runs in its own worker thread with a memory ceiling. A plugin that
 * hangs is killed on the next timeout and respawned on demand; a plugin that
 * crashes takes nothing else down with it.
 */

export interface PluginProviderOptions {
  /** Resolves a `pluginId` to the absolute path of its entry module. */
  resolveEntry(pluginId: string): string | undefined;
  /** Overrides the worker bootstrap script (tests). */
  workerScript?: string | URL;
  workerMemoryMb?: number;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (detections: Detection[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function createPluginProvider(config: PluginProvider, options: PluginProviderOptions): AiProviderClient {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const entry = options.resolveEntry(config.pluginId);
  const workerScript = options.workerScript ?? new URL('../plugin-worker.ts', import.meta.url);
  const capabilities = (config.capabilities ?? ['object']) as AiCapability[];

  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  let fatal: string | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function failAll(error: Error): void {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      pending.delete(id);
      call.reject(error);
    }
  }

  function terminate(reason: string): void {
    const current = worker;
    worker = undefined;
    ready = undefined;
    failAll(new AiError('unavailable', config.id, reason));
    if (current !== undefined) void current.terminate().catch(() => undefined);
  }

  function onMessage(message: PluginToHost): void {
    switch (message.type) {
      case 'ready':
        return;
      case 'log':
        options.log?.(`plugin ${config.pluginId} [${message.level}] ${message.message}`);
        return;
      case 'fatal':
        fatal = message.message;
        terminate(message.message);
        return;
      case 'result': {
        const call = pending.get(message.id);
        if (call === undefined) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        call.resolve(sanitizeDetections(message.detections, config.id));
        return;
      }
      case 'error': {
        const call = pending.get(message.id);
        if (call === undefined) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        call.reject(new AiError('failed', config.id, message.message));
        return;
      }
    }
  }

  function spawn(): Promise<void> {
    if (ready !== undefined) return ready;
    if (entry === undefined) {
      return Promise.reject(
        new AiError('unsupported', config.id, `Plugin "${config.pluginId}" could not be resolved from the plugin directories.`),
      );
    }
    if (fatal !== undefined) {
      return Promise.reject(new AiError('unavailable', config.id, fatal));
    }

    ready = new Promise<void>((resolve, reject) => {
      const workerData: PluginWorkerData = {
        pluginId: config.pluginId,
        entry,
        config: config.config ?? {},
      };
      let created: Worker;
      try {
        created = new Worker(workerScript, {
          workerData,
          ...(options.workerMemoryMb === undefined
            ? {}
            : { resourceLimits: { maxOldGenerationSizeMb: options.workerMemoryMb } }),
        });
      } catch (error) {
        ready = undefined;
        reject(new AiError('unavailable', config.id, `Could not start the plugin worker: ${message(error)}`));
        return;
      }

      worker = created;
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error);
      };

      created.on('message', (incoming: PluginToHost) => {
        if (incoming.type === 'ready') settle();
        else if (incoming.type === 'fatal') settle(new AiError('unavailable', config.id, incoming.message));
        onMessage(incoming);
      });
      created.on('error', (error) => {
        settle(new AiError('unavailable', config.id, `plugin ${config.pluginId} crashed: ${error.message}`));
        terminate(`plugin ${config.pluginId} crashed: ${error.message}`);
      });
      created.on('exit', (code) => {
        settle(new AiError('unavailable', config.id, `plugin ${config.pluginId} exited during startup (code ${code}).`));
        // A clean exit after `close()` has no pending calls; anything else is a crash.
        terminate(`plugin ${config.pluginId} exited (code ${code}).`);
      });
    });
    return ready;
  }

  return {
    id: config.id,
    capabilities,
    async detect(request: DetectionRequest): Promise<Detection[]> {
      if (!capabilities.includes(request.task)) {
        throw new AiError('unsupported', config.id, `Provider "${config.id}" does not declare the "${request.task}" capability.`);
      }
      await spawn();
      const current = worker;
      if (current === undefined) throw new AiError('unavailable', config.id, 'plugin worker is not running');

      const id = nextId++;
      const payload: HostToPlugin = {
        type: 'detect',
        id,
        image: new Uint8Array(request.image),
        mimeType: request.mimeType,
        task: request.task,
        camera: { id: request.camera.id, name: request.camera.name },
        ...(request.labels === undefined ? {} : { labels: request.labels }),
        ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
      };

      return await new Promise<Detection[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // A plugin that misses its deadline is terminated: a wedged worker
          // cannot be interrupted from the outside.
          terminate(`plugin ${config.pluginId} timed out after ${timeoutMs} ms.`);
          reject(new AiError('timeout', config.id, `Plugin "${config.pluginId}" timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          current.postMessage(payload, [payload.image.buffer as ArrayBuffer]);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new AiError('failed', config.id, `Could not send the frame to the plugin: ${message(error)}`));
        }
      });
    },
    async health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
      if (entry === undefined) return { ok: false, detail: `plugin "${config.pluginId}" is not installed` };
      if (fatal !== undefined) return { ok: false, detail: fatal };
      const startedAt = Date.now();
      try {
        await spawn();
        return { ok: true, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - startedAt, detail: message(error) };
      }
    },
    async close(): Promise<void> {
      worker?.postMessage({ type: 'close' } satisfies HostToPlugin);
      terminate('plugin host closed');
    },
  };
}

function sanitizeDetections(detections: unknown, providerId: string): Detection[] {
  if (!Array.isArray(detections)) {
    throw new AiError('invalid-response', providerId, 'plugin did not return an array of detections');
  }
  const result: Detection[] = [];
  for (const entry of detections) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as Partial<Detection>;
    if (typeof candidate.label !== 'string' || candidate.label.trim().length === 0) continue;
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence)) continue;
    const box = candidate.box;
    const usableBox =
      box !== undefined &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0 &&
      box.height > 0;
    result.push({
      label: candidate.label.trim().slice(0, 64),
      confidence: clamp(candidate.confidence, 0, 1),
      ...(usableBox
        ? {
            box: {
              x: Math.max(0, box.x),
              y: Math.max(0, box.y),
              width: box.width,
              height: box.height,
              normalized: box.normalized === true,
            },
          }
        : {}),
    });
  }
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
