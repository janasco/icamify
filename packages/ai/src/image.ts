import type { PixelSize } from './mapping.ts';

/**
 * JPEG header inspection.
 *
 * Detectors report boxes in pixels of the image we sent, but we do not decode
 * JPEGs in Node. Reading the SOF marker is enough to know the frame size, so
 * box normalization stays exact without an image codec dependency.
 */

/**
 * Returns the frame size from a JPEG's SOF marker, or `undefined` when the buffer
 * is not a JPEG or is truncated before the marker.
 */
export function jpegSize(buffer: Buffer): PixelSize | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // Fill bytes and entropy-coded data are not markers; resynchronise forward.
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1] ?? 0;
    // Skip fill bytes (0xFF 0xFF).
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1] ?? 0;
    }
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const length = buffer.readUInt16BE(offset);
    if (length < 2) return undefined;

    // SOF0..SOF15 minus DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 >= buffer.length) return undefined;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return undefined;
      return { width, height };
    }

    if (marker === 0xda) {
      // Start of scan: image data begins before the next marker.
      return undefined;
    }
    offset += length;
  }
  return undefined;
}

export function isJpeg(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
