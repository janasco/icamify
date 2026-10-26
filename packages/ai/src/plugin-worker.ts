import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  AiProviderClient,
  AiProviderPluginModule,
  DetectionRequest,
  PluginContext,
} from './index.ts';
import type { HostToPlugin, PluginToHost, PluginWorkerData } from './plugin-protocol.ts';

/**
 * Plugin worker entry point.
 *
 * Runs one third-party detector out of process. Nothing here touches the media
 * pipeline, the database or the HTTP server: the worker receives an image and
 * answers with detections, which is the entire trust surface of a plugin.
 */

const data = workerData as PluginWorkerData;
const port = parentPort;

function post(message: PluginToHost, transfer?: ArrayBuffer[]): void {
  if (transfer === undefined) port?.postMessage(message);
  else port?.postMessage(message, transfer);
}

const controller = new AbortController();

const log: PluginContext['log'] = (level, message, fields) => {
  post({ type: 'log', level, message, ...(fields === undefined ? {} : { fields }) });
};

let provider: AiProviderClient | undefined;
let creationError: Error | undefined;

try {
  const module = (await import(pathToFileURL(data.entry).href)) as Partial<AiProviderPluginModule> & {
    default?: Partial<AiProviderPluginModule>;
  };
  const create = module.createProvider ?? module.default?.createProvider;
  if (typeof create !== 'function') {
    throw new Error('plugin module must export createProvider(config, context)');
  }
  provider = create(data.config, { pluginId: data.pluginId, log, signal: controller.signal });
  post({ type: 'ready', capabilities: provider.capabilities as string[] });
} catch (error) {
  creationError = error instanceof Error ? error : new Error(String(error));
  post({ type: 'fatal', message: `plugin ${data.pluginId} failed to load: ${creationError.message}` });
}

port?.on('message', (message: HostToPlugin) => {
  if (message.type === 'close') {
    void provider?.close().catch(() => undefined);
    controller.abort();
    port.close();
    return;
  }
  if (message.type !== 'detect') return;

  if (provider === undefined) {
    post({ type: 'error', id: message.id, message: creationError?.message ?? 'plugin is not initialised' });
    return;
  }

  const request: DetectionRequest = {
    camera: message.camera,
    image: Buffer.from(message.image.buffer, message.image.byteOffset, message.image.byteLength),
    mimeType: message.mimeType,
    task: message.task,
    ...(message.labels === undefined ? {} : { labels: message.labels }),
    ...(message.minConfidence === undefined ? {} : { minConfidence: message.minConfidence }),
    signal: controller.signal,
  };

  provider
    .detect(request)
    .then((detections) => {
      // Detections are plain JSON: structured clone is enough, no transfer list.
      post({ type: 'result', id: message.id, detections });
    })
    .catch((error: unknown) => {
      post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    });
});
