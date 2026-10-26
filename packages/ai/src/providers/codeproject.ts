import type { AiCapability, CodeProjectProvider } from '@icamify/core';
import { AiError } from '../errors.ts';
import { jpegSize } from '../image.ts';
import { getJson, postImage, type FetchLike } from '../http.ts';
import type { AiProviderClient, Detection, DetectionRequest } from '../index.ts';
import { detectionsFromPredictions, detectionFromScene, payloadFailed } from './predictions.ts';

/**
 * CodeProject.AI provider.
 *
 * CodeProject.AI (the maintained successor of DeepStack's module ecosystem)
 * exposes one HTTP endpoint per module. Object detection is the default; face,
 * plate and scene modules each have their own path. `endpoint` overrides the path
 * for whichever task is being called, which is how installations with a renamed
 * ALPR module (`/v1/image/alpr`) are supported.
 */

const TASK_PATHS: Record<AiCapability, string> = {
  object: '/v1/vision/detection',
  face: '/v1/vision/face',
  lpr: '/v1/vision/plate',
  scene: '/v1/vision/scene',
};

const FALLBACK_LABELS: Record<AiCapability, string> = {
  object: 'object',
  face: 'face',
  lpr: 'plate',
  scene: 'scene',
};

export interface CodeProjectProviderOptions {
  fetch?: FetchLike;
}

export function createCodeProjectProvider(
  config: CodeProjectProvider,
  options: CodeProjectProviderOptions = {},
): AiProviderClient {
  const capabilities: AiCapability[] = config.capabilities ?? ['object'];
  const timeoutMs = config.timeoutMs ?? 8000;
  const headers: Record<string, string> = config.apiKey === undefined ? {} : { 'x-api-key': config.apiKey };
  const base = config.url.replace(/\/$/, '');

  function urlFor(task: AiCapability): string {
    return `${base}${config.endpoint ?? TASK_PATHS[task]}`;
  }

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
          url: urlFor(request.task),
          timeoutMs,
          headers,
          image: request.image,
          mimeType: request.mimeType,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );

      const failure = payloadFailed(payload);
      if (failure !== undefined) throw new AiError('failed', config.id, `CodeProject.AI: ${failure}`);

      const detections =
        request.task === 'scene'
          ? detectionFromScene(payload, request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence })
          : detectionsFromPredictions(payload, {
              providerId: config.id,
              task: request.task,
              image: size,
              fallbackLabel: FALLBACK_LABELS[request.task],
              ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
            });
      return detections;
    },
    async health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
      const startedAt = Date.now();
      try {
        // The object module is present in every CodeProject.AI install; its
        // response doubles as a reachability probe.
        await getJson({
          providerId: config.id,
          url: urlFor('object'),
          timeoutMs: Math.min(timeoutMs, 3000),
          headers,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        return { ok: true, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    async close(): Promise<void> {
      // Stateless HTTP client: nothing to release.
    },
  };
}
