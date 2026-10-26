import type { AiCapability, AiProviderConfig } from '@icamify/core';
import { AiError } from './errors.ts';
import type { AiGateway, AiProviderClient, Detection, DetectionRequest } from './index.ts';
import { createCodeProjectProvider } from './providers/codeproject.ts';
import { createDeepStackProvider } from './providers/deepstack.ts';
import { createGenericProvider } from './providers/generic.ts';
import { createPluginProvider, type PluginProviderOptions } from './providers/plugin.ts';

/**
 * AI gateway.
 *
 * Sits between the motion engine and every detector. It owns the things a
 * detector must not have to think about:
 * - bounded concurrency per provider, so one slow camera cannot monopolise the
 *   GPU (extra frames are dropped, never queued without limit);
 * - a timeout on every call, because a hung detector must not stall motion;
 * - a circuit breaker, so a dead service is skipped instead of costing a full
 *   timeout on every motion event for hours.
 */

export interface GatewayOptions {
  providers: AiProviderConfig[];
  /** Test seam: replace provider construction entirely. */
  createProvider?: (config: AiProviderConfig) => AiProviderClient;
  plugin?: PluginProviderOptions;
  /** Frames allowed to wait behind the concurrency limit before calls are dropped. */
  maxQueuePerProvider?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  type: AiProviderConfig['type'];
  enabled: boolean;
  capabilities: AiCapability[];
  concurrency: number;
  active: number;
  queued: number;
  requests: number;
  errors: number;
  failures: number;
  circuit: 'closed' | 'open';
  openUntil?: number;
  lastLatencyMs?: number;
  lastError?: string;
}

export interface ProviderHealth {
  providerId: string;
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

interface Slot {
  config: AiProviderConfig;
  client: AiProviderClient;
  concurrency: number;
  timeoutMs: number;
  active: number;
  queue: Array<() => void>;
  requests: number;
  errors: number;
  failures: number;
  openUntil: number;
  lastLatencyMs?: number;
  lastError?: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class Gateway implements AiGateway {
  private readonly slots = new Map<string, Slot>();
  private readonly options: GatewayOptions;
  private closed = false;

  constructor(options: GatewayOptions) {
    this.options = options;
    for (const config of options.providers ?? []) {
      this.slots.set(config.id, {
        config,
        client: this.build(config),
        concurrency: Math.max(1, config.concurrency ?? 1),
        timeoutMs: config.timeoutMs ?? 8000,
        active: 0,
        queue: [],
        requests: 0,
        errors: 0,
        failures: 0,
        openUntil: 0,
      });
    }
  }

  private build(config: AiProviderConfig): AiProviderClient {
    if (this.options.createProvider !== undefined) return this.options.createProvider(config);
    switch (config.type) {
      case 'codeproject-ai':
        return createCodeProjectProvider(config);
      case 'deepstack':
        return createDeepStackProvider(config);
      case 'generic-http':
        return createGenericProvider(config);
      case 'plugin': {
        const plugin = this.options.plugin;
        return createPluginProvider(config, {
          resolveEntry: (pluginId) => plugin?.resolveEntry(pluginId),
          ...(plugin?.workerScript === undefined ? {} : { workerScript: plugin.workerScript }),
          ...(plugin?.workerMemoryMb === undefined ? {} : { workerMemoryMb: plugin.workerMemoryMb }),
          ...(plugin?.log === undefined ? {} : { log: plugin.log }),
        });
      }
    }
  }

  provider(providerId: string): AiProviderClient | undefined {
    return this.slots.get(providerId)?.client;
  }

  providerIds(): string[] {
    return [...this.slots.keys()];
  }

  /** The provider a camera should use: its own choice, else the global default. */
  resolveProviderId(cameraProviderId: string | undefined, defaultProviderId: string | undefined): string | undefined {
    // A camera naming a provider that no longer exists falls back to the global
    // default instead of going dark; the caller still gets the unknown id when
    // nothing resolves, so the error names what the config actually says.
    if (cameraProviderId !== undefined && this.slots.has(cameraProviderId)) return cameraProviderId;
    if (defaultProviderId !== undefined && this.slots.has(defaultProviderId)) return defaultProviderId;
    return cameraProviderId ?? defaultProviderId;
  }

  capabilitiesOf(providerId: string): AiCapability[] {
    return [...(this.slots.get(providerId)?.client.capabilities ?? [])];
  }

  status(): ProviderStatus[] {
    const now = this.now();
    return [...this.slots.values()].map((slot) => ({
      id: slot.config.id,
      name: slot.config.name,
      type: slot.config.type,
      enabled: slot.config.enabled !== false,
      capabilities: [...slot.client.capabilities],
      concurrency: slot.concurrency,
      active: slot.active,
      queued: slot.queue.length,
      requests: slot.requests,
      errors: slot.errors,
      failures: slot.failures,
      circuit: slot.openUntil > now ? 'open' : 'closed',
      ...(slot.openUntil > now ? { openUntil: slot.openUntil } : {}),
      ...(slot.lastLatencyMs === undefined ? {} : { lastLatencyMs: slot.lastLatencyMs }),
      ...(slot.lastError === undefined ? {} : { lastError: slot.lastError }),
    }));
  }

  async detect(providerId: string, request: DetectionRequest): Promise<Detection[]> {
    if (this.closed) throw new AiError('unavailable', providerId, 'The AI gateway is shutting down.');
    const slot = this.slots.get(providerId);
    if (slot === undefined) {
      throw new AiError('unsupported', providerId, `AI provider "${providerId}" is not configured.`);
    }
    if (slot.config.enabled === false) {
      throw new AiError('unavailable', providerId, `AI provider "${providerId}" is disabled.`);
    }
    if (slot.openUntil > this.now()) {
      const seconds = Math.ceil((slot.openUntil - this.now()) / 1000);
      throw new AiError(
        'unavailable',
        providerId,
        `AI provider "${providerId}" is in cooldown after repeated failures (${seconds}s left).`,
      );
    }
    await this.acquire(slot);
    const startedAt = this.now();
    slot.requests += 1;
    try {
      const detections = await withTimeout(
        slot.client.detect(request),
        slot.timeoutMs + 500,
        providerId,
        slot.timeoutMs,
      );
      slot.failures = 0;
      slot.lastLatencyMs = this.now() - startedAt;
      return detections;
    } catch (error) {
      slot.errors += 1;
      const aiError = error instanceof AiError ? error : new AiError('failed', providerId, messageOf(error));
      slot.lastError = aiError.message;
      // A misconfiguration is not a health problem: the service answered, we just
      // cannot use the answer. Retrying will not help, but neither is it down.
      if (aiError.code !== 'unsupported' && aiError.code !== 'invalid-response') {
        slot.failures += 1;
        if (slot.failures >= (this.options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)) {
          slot.openUntil = this.now() + (this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
          slot.failures = 0;
          this.options.log?.(
            `ai provider ${providerId}: opening circuit for ${Math.round((this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS) / 1000)}s after repeated failures (${aiError.message})`,
          );
        }
      }
      throw aiError;
    } finally {
      this.release(slot);
    }
  }

  async health(): Promise<ProviderHealth[]> {
    return await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        const result = await slot.client.health().catch((error: unknown) => ({
          ok: false,
          detail: messageOf(error),
          latencyMs: undefined as number | undefined,
        }));
        return {
          providerId: slot.config.id,
          ok: result.ok,
          ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    const slots = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(slots.map((slot) => slot.client.close().catch(() => undefined)));
  }

  private acquire(slot: Slot): Promise<void> {
    if (slot.active < slot.concurrency) {
      slot.active += 1;
      return Promise.resolve();
    }
    const maxQueue = this.options.maxQueuePerProvider ?? 2;
    if (slot.queue.length >= maxQueue) {
      return Promise.reject(
        new AiError(
          'busy',
          slot.config.id,
          `AI provider "${slot.config.id}" is busy (${slot.active} in flight, ${slot.queue.length} queued); frame dropped.`,
        ),
      );
    }
    return new Promise<void>((resolve) => {
      // The permit is handed over by release(); the caller never sees it.
      slot.queue.push(() => {
        slot.active += 1;
        resolve();
      });
    });
  }

  private release(slot: Slot): void {
    slot.active = Math.max(0, slot.active - 1);
    const next = slot.queue.shift();
    if (next !== undefined) next();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function withTimeout<T>(promise: Promise<T>, deadlineMs: number, providerId: string, reportedMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AiError('timeout', providerId, `AI provider "${providerId}" exceeded its ${reportedMs} ms budget.`));
    }, deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
