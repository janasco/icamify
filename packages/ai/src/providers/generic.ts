import type { GenericHttpProvider } from '@icamify/core';
import { AiError } from '../errors.ts';
import { postImage, postJson, type FetchLike } from '../http.ts';
import { jpegSize } from '../image.ts';
import type { AiProviderClient, Detection, DetectionRequest } from '../index.ts';
import { readBox, readPath, sanitizeLabel, toConfidence } from '../mapping.ts';

/**
 * Bring-your-own detector.
 *
 * A camera vendor's inference box, a cloud vision API or a bespoke script can all
 * be adapted without writing a plugin: the request body is templated and the
 * response is addressed with dot/bracket paths.
 */

export interface GenericProviderOptions {
  fetch?: FetchLike;
}

const DEFAULT_TEMPLATE = '{"image":"{{image}}","minConfidence":{{minConfidence}}}';

export function createGenericProvider(
  config: GenericHttpProvider,
  options: GenericProviderOptions = {},
): AiProviderClient {
  const timeoutMs = config.timeoutMs ?? 8000;
  const method = config.method ?? 'POST';

  function substitute(template: string, request: DetectionRequest): string {
    return template
      .replaceAll('{{image}}', request.image.toString('base64'))
      .replaceAll('{{minConfidence}}', String(request.minConfidence ?? 0.4))
      .replaceAll('{{task}}', request.task)
      .replaceAll('{{cameraId}}', request.camera.id)
      .replaceAll('{{cameraName}}', request.camera.name);
  }

  return {
    id: config.id,
    capabilities: config.capabilities ?? ['object'],
    async detect(request: DetectionRequest): Promise<Detection[]> {
      const size = jpegSize(request.image);
      if (size === undefined) {
        throw new AiError('invalid-response', config.id, 'The frame is not a readable JPEG; cannot map detection boxes.');
      }

      const http = {
        providerId: config.id,
        url: config.url,
        timeoutMs,
        headers: config.headers ?? {},
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      };

      let payload: unknown;
      if ((config.contentType ?? 'json') === 'multipart') {
        payload = await postImage({ ...http, image: request.image, mimeType: request.mimeType }, method);
      } else {
        const template = config.requestTemplate ?? DEFAULT_TEMPLATE;
        let body: unknown;
        try {
          body = JSON.parse(substitute(template, request)) as unknown;
        } catch {
          throw new AiError(
            'invalid-response',
            config.id,
            'Request template is not valid JSON after placeholder substitution.',
          );
        }
        payload = await postJson(http, body, method);
      }

      const rows = readPath(payload, config.response.detectionsPath);
      if (!Array.isArray(rows)) {
        throw new AiError(
          'invalid-response',
          config.id,
          `Response path "${config.response.detectionsPath}" is not an array.`,
        );
      }

      const detections: Detection[] = [];
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const label = sanitizeLabel(readPath(row, config.response.labelPath));
        const confidence = toConfidence(readPath(row, config.response.confidencePath));
        if (label === undefined || confidence === undefined) continue;
        if (request.minConfidence !== undefined && confidence < request.minConfidence) continue;
        const box = readBox(row, config.response.box, size);
        detections.push({
          label,
          confidence,
          ...(box === undefined
            ? {}
            : { box: { x: box.x, y: box.y, width: box.width, height: box.height, normalized: false as const } }),
        });
      }
      return detections;
    },
    async health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }> {
      const startedAt = Date.now();
      const doFetch = options.fetch ?? fetch;
      try {
        // Generic endpoints often only accept POST, so reachability is enough.
        const response = await doFetch(config.url, { method: 'GET', signal: AbortSignal.timeout(3000) });
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
