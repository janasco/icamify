import type { AiCapability } from '@icamify/core';
import type { Detection } from './index.ts';

/**
 * Host ↔ plugin worker messages.
 *
 * The image crosses the thread boundary as a transferable `Uint8Array` (no
 * structured-clone copy), and every request carries an id so a timed-out call can
 * be abandoned without confusing it with the next one.
 */

export interface PluginWorkerData {
  pluginId: string;
  entry: string;
  config: Record<string, unknown>;
}

export type HostToPlugin =
  | {
      type: 'detect';
      id: number;
      image: Uint8Array;
      mimeType: 'image/jpeg' | 'image/png';
      task: AiCapability;
      camera: { id: string; name: string };
      labels?: string[];
      minConfidence?: number;
    }
  | { type: 'close' };

export type PluginToHost =
  | { type: 'ready'; capabilities?: string[] }
  | { type: 'result'; id: number; detections: Detection[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'fatal'; message: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; fields?: Record<string, unknown> };
