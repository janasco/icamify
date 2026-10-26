import type { AiCapability, AiProviderConfig, CameraConfig } from '@icamify/core';

/**
 * AI gateway contracts (Phase 4).
 *
 * One narrow interface fronts every detector, whether it is a local
 * CodeProject.AI instance, DeepStack, a bespoke HTTP service or an out-of-process
 * plugin. The rule engine only ever sees `Detection[]`.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when coordinates are 0..1 instead of source pixels. */
  normalized?: boolean;
}

export interface Detection {
  label: string;
  confidence: number;
  box?: Box;
  /** Provider-specific payload: plate text, face embedding, model revision... */
  extra?: Record<string, unknown>;
}

export interface DetectionRequest {
  camera: Pick<CameraConfig, 'id' | 'name'>;
  /** JPEG (or PNG) of the frame, optionally cropped to the motion region. */
  image: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  task: AiCapability;
  /** Labels the camera cares about; providers may use it as a hint only. */
  labels?: string[];
  minConfidence?: number;
  signal?: AbortSignal;
}

export interface AiProviderClient {
  readonly id: string;
  readonly capabilities: ReadonlyArray<AiCapability>;
  detect(request: DetectionRequest): Promise<Detection[]>;
  health(): Promise<{ ok: boolean; latencyMs?: number; detail?: string }>;
  close(): Promise<void>;
}

/**
 * Contract implemented by hot-loaded plugins (loaded in a worker thread, never
 * in the server process). See plugins/example-ai-provider.
 */
export interface AiProviderPluginModule {
  createProvider(config: Record<string, unknown>, context: PluginContext): AiProviderClient;
}

export interface PluginContext {
  pluginId: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
  signal: AbortSignal;
}

export interface AiGateway {
  detect(providerId: string, request: DetectionRequest): Promise<Detection[]>;
  health(): Promise<Array<{ providerId: string; ok: boolean; latencyMs?: number; detail?: string }>>;
  close(): Promise<void>;
}

export interface AiGatewayOptions {
  providers: AiProviderConfig[];
  /** Bounded concurrency per provider, from provider.concurrency. */
  concurrency: number;
  onDetection?(cameraId: string, detections: Detection[], request: DetectionRequest): void;
  onError?(providerId: string, error: Error): void;
}
