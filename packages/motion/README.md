# @icamify/motion — pixel motion engine

**Phase:** 3 — implemented.

Pure TypeScript over `Uint8Array` frames: no native dependencies, no decoder, no
container. The detect pipeline hands it raw luma at 320×180 and it returns a
boolean plus boxes, so it runs identically on x86, ARM (NAS / Raspberry Pi) and in
tests.

```ts
import { createMotionEngine, RawFrameReader, fullFrameZones } from '@icamify/motion';

const engine = createMotionEngine({ cameraId: 'front-door', settings, zones: fullFrameZones(320, 180) });
const reader = new RawFrameReader({ cameraId: 'front-door', width: 320, height: 180 });

ffmpegStdout.on('data', (chunk) => {
  for (const frame of reader.push(chunk)) {
    const detection = engine.analyze(frame); // null during warmup
    if (detection?.motion) console.log(detection.changedPercent, detection.boxes);
  }
});
```

## Files

```
src/
  engine.ts     # background model, differencing, colour gate, denoise, blobs, hangover
  grid.ts       # zone matrix compilation (include/exclude → active bitmap, cell geometry)
  frame.ts      # rawvideo splitter (gray/rgb24) with cross-chunk framing and backlog drop
  index.ts      # public contracts + factory
```

## Algorithm

Per frame, on `width × height` luma:

1. **Blur** — optional separable 3×3 box blur (`blurRadius` 1–2) to suppress sensor
   grain.
2. **Difference** — `|frame − background|` against a per-pixel running average.
   The mean is seeded from the first frame after a start/reset, then averaged over
   `warmupFrames`; `analyze()` returns `null` until warmup ends.
3. **Threshold** — pixels at or above `threshold` (0–255) count as changed.
   Unchanged pixels adapt at `2%` per frame; changed pixels adapt far more slowly
   (`0.4%`), so a person crossing is never absorbed but a parked car or a moved bin
   becomes background within about a minute and stops triggering.
4. **Colour gate** — optional `colorFilter` (saturation floor and hue ranges) drops
   changed pixels that are not the configured colour. It needs `rgb24` frames; with
   gray frames the gate is skipped (`analysis.pixelFormat` reports which is in use).
5. **Denoise** — optional erosion: a changed pixel needs 1–3 changed 4-neighbours to
   survive, which removes isolated hot pixels.
6. **Zone matrix** — changed pixels are counted per cell. A cell flips when at least
   `threshold` percent of *its own* pixels changed (cells on the edge of the frame
   are smaller, and that is accounted for). `mode: include` monitors the selected
   cells, `mode: exclude` ignores them. `changedPercent` is over active cells only.
7. **Blobs** — flipped cells are merged with 4-connectivity; components below
   `minBlobPercent` of the frame are dropped, and at most 8 boxes (largest first)
   are returned in analysis-frame pixels plus a union `region`.
8. **Decision** — motion requires both `changedPercent ≥ percentThreshold` **and**
   at least one surviving blob, so a scatter of changed pixels cannot open a
   recording. Motion stays true for `postMotionSeconds` after the last detection.

`sensitivity` is the convenience dial, interpolated by `resolveMotionThresholds()`
in `@icamify/core`: 1 → strict (threshold 60, 2.62%…5%), 50 → 34 / 2.62%, 100 →
permissive (8 / 0.2%). Explicit `threshold` / `percentThreshold` always win.

## Zone matrix semantics

`MotionSettings.zones` stores one row of `0`/`1` per line, joined by `/`:

```jsonc
"zones": {
  "cols": 16, "rows": 16,
  "cells": "1111111111111111/1111111111111111/…",
  "mode": "include"   // monitor the painted cells
  // "exclude" ignores the painted cells (footpath, tree line, road)
}
```

Compilation to an `active` bitmap happens once per geometry change, not per frame;
`compileZones()` also precomputes per-pixel cell lookups and per-cell pixel areas.
An all-inactive mask is reported by `hasActiveCells()` so the caller can fall back
or refuse to start instead of silently never detecting anything.

## Invariants

- A camera restart or a resolution change must call `resize()` (or `reset()` for
  the model only): reusing a model across geometries produces a full-frame false
  positive.
- `MotionDetection.cells` is a reused buffer — the UI overlay reads it synchronously
  or copies it.
- Boxes are in analysis-frame pixel space. The API divides by width/height to
  produce the normalised boxes the console draws.
- No clocks inside: timestamps come from the caller, which is what makes the state
  machine testable without sleeping.

## Tests

`test/engine.test.ts` covers warmup, static scenes, moving blocks and boxes,
include/exclude zones, colour filtering, denoise, blob filtering, the post-motion
hangover, reset/resize and background adaptation. `test/frame.test.ts` covers
split boundaries, rgb24→luma and backlog dropping; `test/grid.test.ts` covers
mask compilation and cell geometry.
