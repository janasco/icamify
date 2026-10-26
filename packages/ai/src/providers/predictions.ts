import type { AiCapability } from '@icamify/core';
import type { Detection } from '../index.ts';
import { clamp, readCornerBox, readPath, sanitizeLabel, toConfidence } from '../mapping.ts';
import type { PixelSize } from '../mapping.ts';

/**
 * Shared mapping for the `predictions[]` response shape.
 *
 * CodeProject.AI and DeepStack were built on the same idea and answer almost
 * identically: a `predictions` array of corner boxes with a label and a
 * confidence. One mapper keeps their quirks in one place.
 */

export const CORNER_PATHS = { xMin: 'x_min', yMin: 'y_min', xMax: 'x_max', yMax: 'y_max' } as const;

export interface PredictionMappingOptions {
  providerId: string;
  task: AiCapability;
  image: PixelSize;
  /** Used when a prediction carries no label (face detection reports a user id). */
  fallbackLabel: string;
  minConfidence?: number;
}

export function detectionsFromPredictions(payload: unknown, options: PredictionMappingOptions): Detection[] {
  const predictions = readPath(payload, 'predictions');
  if (!Array.isArray(predictions)) return [];

  const detections: Detection[] = [];
  for (const prediction of predictions) {
    if (prediction === null || typeof prediction !== 'object') continue;
    const label =
      sanitizeLabel(readPath(prediction, 'label')) ??
      sanitizeLabel(readPath(prediction, 'name')) ??
      sanitizeLabel(readPath(prediction, 'plate')) ??
      sanitizeLabel(readPath(prediction, 'text')) ??
      options.fallbackLabel;
    const confidence = toConfidence(readPath(prediction, 'confidence') ?? readPath(prediction, 'score')) ?? 0;
    if (options.minConfidence !== undefined && confidence < options.minConfidence) continue;

    const box = readCornerBox(prediction, CORNER_PATHS, options.image);
    const userId = sanitizeLabel(readPath(prediction, 'userid'));
    detections.push({
      label,
      confidence,
      ...(box === undefined ? {} : { box: { x: box.x, y: box.y, width: box.width, height: box.height, normalized: false as const } }),
      ...(userId === undefined ? {} : { extra: { userId } }),
    });
  }
  return detections;
}

/**
 * Scene classification returns one label for the whole frame, no boxes.
 * Confidence is clamped because a few builds answer with percentages.
 */
export function detectionFromScene(payload: unknown, options: { minConfidence?: number } = {}): Detection[] {
  const label = sanitizeLabel(readPath(payload, 'label')) ?? sanitizeLabel(readPath(payload, 'prediction'));
  if (label === undefined) return [];
  const confidence = clamp(toConfidence(readPath(payload, 'confidence') ?? readPath(payload, 'score')) ?? 0.5, 0, 1);
  if (options.minConfidence !== undefined && confidence < options.minConfidence) return [];
  return [{ label, confidence }];
}

/** True when the service says the call failed even though HTTP said 200. */
export function payloadFailed(payload: unknown): string | undefined {
  const success = readPath(payload, 'success');
  if (success === false) {
    return sanitizeLabel(readPath(payload, 'message')) ?? sanitizeLabel(readPath(payload, 'error')) ?? 'the provider reported success=false';
  }
  return undefined;
}
