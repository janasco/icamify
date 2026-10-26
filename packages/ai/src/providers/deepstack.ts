import type { AiCapability, DeepStackProvider } from '@icamify/core';
import { AiError } from '../errors.ts';
import { postImage, type FetchLike } from '../http.ts';
import { jpegSize } from '../image.ts';
import type { AiProviderClient, Detection, DetectionRequest } from '../index.ts';
import { detectionsFromPredictions, detectionFromScene, payloadFailed } from './predictions.ts';

/**
 * DeepStack provider.
 *
 * DeepStack is protocol-compatible with CodeProject.AI's object endpoint but has
 * its own paths and an `X-API-KEY` header. `mode` selects the module a
 * single-purpose container was started with, which is why it is used as the
 * default capability when the config does not list any.
 */

const TASK_PATHS: Record<AiCapability, string> = {
  object: '/v1/vision/detection',
  face: '/v1/vision/face',
  scene: '/v1/vision/scene',
  lpr: '/v1/vision/alpr',
};

const FALLBACK_LABELS: Record<AiCapability, string> = {
  object: 'object',
  face: 'face',
  lpr: 'plate',
  scene: 'scene',
};

export interface DeepStackProviderOptions {
  fetch?: FetchLike;
}

export function createDeepStackProvider(
  config: DeepStackProvider,
  options: DeepStackProviderOptions = {},
): AiProviderClient {
  const capabilities: AiCapability[] = config.capabilities ?? [config.mode ?? 'object'];
  const timeoutMs = config.timeoutMs ?? 8000;
  const headers: Record<string, string> = config.apiKey === undefined ? {} : { 'X-API-KEY': config.apiKey };
  const base = config.url.replace(/\/$/, '');
  const threshold = config.minConfidence ?? 0.4;

  return {
    id: config.id,
    capabilities,
    async detect(request: DetectionRequest): Promise<Detection[]> {
      if (!capabilities.includes(request.task)) {
        throw new AiError(
          'unsupported',
          config.id,
          `Provider "${config.id}" does not declare the "${request.task}" capability.`,
        );
      }
      const size = jpegSize(request.image);
      if (size === undefined) {
        throw new AiError('invalid-response', config.id, 'The frame is not a readable JPEG; cannot map detection boxes.');
      }

      const payload = await postImage(
        {
          providerId: config.id,
          url: `${base}${TASK_PATHS[request.task]}`,
          timeoutMs,
          headers,
          image: request.image,
          mimeType: request.mimeType,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
      );

      const failure = payloadFailed(payload);
      if (failure !== undefined) throw new AiError('failed', config.id, `DeepStack: ${failure}`);

      // The camera's threshold wins; the provider default only narrows what the
      // model reports.
      const minConfidence = Math.max(request.minConfidence ?? 0, request.minConfidence === undefined ? threshold : 0);
      if (request.task === 'scene') {
        return detectionFromScene(payload, { minConfidence });
      }
      return detectionsFromPredictions(payload, {
        providerId: config.id,
        task: request.task,
        image: size,
        fallbackLabel: FALLBACK_LABELS[request.task],
        minConfidence,
      });
    },
    async health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
      const startedAt = Date.now();
      const doFetch = options.fetch ?? fetch;
      try {
        // DeepStack has no health route; any HTTP answer proves it is listening.
        const response = await doFetch(`${base}/`, { method: 'GET', signal: AbortSignal.timeout(3000) });
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          ...(response.ok ? {} : { detail: `reachable (HTTP ${response.status})` }),
        };
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async close(): Promise<void> {
      // Stateless HTTP client: nothing to release.
    },
  };
}
