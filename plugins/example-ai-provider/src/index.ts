import type {
  AiProviderClient,
  AiProviderPluginModule,
  Detection,
  DetectionRequest,
  PluginContext,
} from '@icamify/ai';

/**
 * Reference AI provider plugin.
 *
 * The host loads this module inside a worker thread, calls `createProvider()`
 * with the `config` block from `ai.providers[]` (type: "plugin") and then only
 * uses the returned AiProviderClient. Plugins must not import server internals
 * or touch the filesystem; everything arrives through the request.
 */

interface PluginConfig {
  endpoint: string;
  apiKey?: string;
  minConfidence?: number;
}

interface ServiceResult {
  label?: string;
  score?: number;
  box?: { x1: number; y1: number; x2: number; y2: number };
  [key: string]: unknown;
}

function assertConfig(config: Record<string, unknown>): PluginConfig {
  if (typeof config.endpoint !== 'string' || config.endpoint.length === 0) {
    throw new Error('yolo-custom-plugin: config.endpoint is required');
  }
  return {
    endpoint: config.endpoint,
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : undefined,
    minConfidence: typeof config.minConfidence === 'number' ? config.minConfidence : 0.35,
  };
}

function mapDetection(result: ServiceResult): Detection | null {
  if (!result.label) return null;
  const confidence = typeof result.score === 'number' ? result.score : 0;
  const box = result.box;
  return {
    label: result.label,
    confidence,
    ...(box
      ? {
          box: {
            x: box.x1,
            y: box.y1,
            width: box.x2 - box.x1,
            height: box.y2 - box.y1,
          },
        }
      : {}),
    extra: result,
  };
}

export const createProvider: AiProviderPluginModule['createProvider'] = (
  rawConfig: Record<string, unknown>,
  context: PluginContext,
): AiProviderClient => {
  const config = assertConfig(rawConfig);

  return {
    id: context.pluginId,
    capabilities: ['object'],

    async detect(request: DetectionRequest): Promise<Detection[]> {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        },
        body: JSON.stringify({
          image: request.image.toString('base64'),
          min_confidence: request.minConfidence ?? config.minConfidence,
          labels: request.labels ?? [],
        }),
        signal: request.signal ?? context.signal,
      });

      if (!response.ok) {
        throw new Error(`${context.pluginId}: inference failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { results?: ServiceResult[] };
      const detections = (payload.results ?? [])
        .map(mapDetection)
        .filter((detection): detection is Detection => detection !== null);

      const threshold = request.minConfidence ?? config.minConfidence ?? 0;
      return detections.filter((detection) => detection.confidence >= threshold);
    },

    async health() {
      const started = Date.now();
      try {
        const response = await fetch(config.endpoint, { method: 'GET', signal: context.signal });
        return { ok: response.ok, latencyMs: Date.now() - started };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async close() {
      // No persistent connections to release in this example.
    },
  };
};
