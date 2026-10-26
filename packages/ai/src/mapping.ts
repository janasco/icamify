/**
 * Value mapping and geometry.
 *
 * Detector payloads disagree about everything: coordinates in pixels or in 0..1,
 * corners (`x_min`/`x_max`) or origin+size, confidence 0..1 or 0..100, labels in
 * a field called `label`, `class` or `tag`. Everything is normalized here so the
 * rest of iCamify only ever sees `Detection[]` in image pixels.
 */

export interface PixelSize {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized: true;
}

/**
 * Reads a dotted/bracketed path out of an unknown JSON value.
 *
 * Supports `predictions`, `a.b[0].label`, `a.0.label` and numeric indices, which
 * covers every provider mapping configured through `generic-http`. A missing or
 * non-traversable segment returns `undefined` instead of throwing: one malformed
 * prediction must not discard the rest of the response.
 */
export function readPath(value: unknown, path: string): unknown {
  if (path.length === 0) return value;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);

  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Accepts 0..1, 0..100 percentages and stringified numbers.
 *
 * Some services report `"87"` or `87` for an 87% match; a value above 1 is
 * treated as a percentage only when it exceeds 1 and stays within 100.
 */
export function toConfidence(value: unknown): number | undefined {
  let numeric: number;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim().length > 0) numeric = Number(value);
  else return undefined;
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric > 1 && numeric <= 100) numeric = numeric / 100;
  return clamp(numeric, 0, 1);
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

export function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

export interface BoxSpec {
  x: string;
  y: string;
  width: string;
  height: string;
  /** True when the provider already reports 0..1 coordinates. */
  normalized?: boolean;
}

export interface MappedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Always pixel coordinates of the submitted image. */
  normalized: false;
}

/**
 * Reads a box described by origin+size paths.
 *
 * Values are asserted to be pixels unless `normalized` is set, in which case they
 * are scaled by the submitted image size. Coordinates are clamped to the frame:
 * detectors routinely return boxes that stick out by a pixel, and an overlay box
 * outside the canvas looks like a UI bug.
 */
export function readBox(
  source: unknown,
  spec: BoxSpec,
  image: PixelSize,
): MappedBox | undefined {
  const x = toNumber(readPath(source, spec.x));
  const y = toNumber(readPath(source, spec.y));
  const width = toNumber(readPath(source, spec.width));
  const height = toNumber(readPath(source, spec.height));
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;

  const scaleX = spec.normalized === true ? image.width : 1;
  const scaleY = spec.normalized === true ? image.height : 1;

  // Clip each edge independently: a box that starts outside the frame keeps the
  // part that is actually visible instead of sliding inward.
  const rawLeft = x * scaleX;
  const rawTop = y * scaleY;
  const left = clamp(rawLeft, 0, image.width);
  const top = clamp(rawTop, 0, image.height);
  const right = clamp(rawLeft + Math.max(0, width * scaleX), 0, image.width);
  const bottom = clamp(rawTop + Math.max(0, height * scaleY), 0, image.height);
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top, normalized: false };
}

/**
 * Reads a corner-based box (`x_min`/`x_max`, `y_min`/`y_max`), which is what
 * CodeProject.AI and DeepStack both return.
 */
export function readCornerBox(
  source: unknown,
  paths: { xMin: string; yMin: string; xMax: string; yMax: string },
  image: PixelSize,
): MappedBox | undefined {
  const xMin = toNumber(readPath(source, paths.xMin));
  const yMin = toNumber(readPath(source, paths.yMin));
  const xMax = toNumber(readPath(source, paths.xMax));
  const yMax = toNumber(readPath(source, paths.yMax));
  if (xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined) return undefined;
  return readBox(
    { x: xMin, y: yMin, width: Math.max(0, xMax - xMin), height: Math.max(0, yMax - yMin) },
    { x: 'x', y: 'y', width: 'width', height: 'height' },
    image,
  );
}

/**
 * Maps a box reported for a cropped image back into the full frame.
 *
 * Without this, `cropToMotion` detectors would draw their boxes in the wrong
 * place: the detector only knows the crop it was given.
 */
export function remapBox(box: { x: number; y: number; width: number; height: number }, crop: CropRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: crop.x + box.x * crop.width,
    y: crop.y + box.y * crop.height,
    width: box.width * crop.width,
    height: box.height * crop.height,
  };
}

/** Normalizes a pixel box into 0..1 for the API and the overlay. */
export function normalizeBox(
  box: { x: number; y: number; width: number; height: number },
  size: PixelSize,
): { x: number; y: number; width: number; height: number } {
  if (size.width <= 0 || size.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: round3(clamp(box.x / size.width, 0, 1)),
    y: round3(clamp(box.y / size.height, 0, 1)),
    width: round3(clamp(box.width / size.width, 0, 1)),
    height: round3(clamp(box.height / size.height, 0, 1)),
  };
}

/**
 * Union of detection boxes, padded and clamped, used as the AI crop.
 * Returns `undefined` when there is nothing usable to crop to.
 */
export function unionBox(
  boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  padding = 0.08,
): CropRect | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    if (box.width <= 0 || box.height <= 0) continue;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined;

  const padX = (right - left) * padding;
  const padY = (bottom - top) * padding;
  const x = clamp(left - padX, 0, 1);
  const y = clamp(top - padY, 0, 1);
  const width = clamp(right + padX, 0, 1) - x;
  const height = clamp(bottom + padY, 0, 1) - y;
  if (width <= 0.001 || height <= 0.001) return undefined;
  return {
    x: round4(x),
    y: round4(y),
    width: round4(width),
    height: round4(height),
    normalized: true,
  };
}

/** Case-insensitive label match used by camera label filters and rules. */
export function labelMatches(label: string, wanted: ReadonlyArray<string> | undefined): boolean {
  if (wanted === undefined || wanted.length === 0) return true;
  const normalized = label.toLowerCase();
  return wanted.some((candidate) => {
    const needle = candidate.trim().toLowerCase();
    if (needle.length === 0) return false;
    // Substring matching lets "person" catch "Person/Adult" style labels without
    // forcing operators to enumerate every model revision's wording.
    return normalized === needle || normalized.includes(needle);
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
