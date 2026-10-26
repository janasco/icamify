# @icamify/motion — pixel motion engine

**Phase:** 3.

Pure TypeScript over `Uint8Array` frames, so it runs identically on x86, ARM
(NAS/ Raspberry Pi) and in tests without native dependencies.

## Planned layout

```
src/
  engine.ts         # background model + frame differencing state machine
  background.ts     # running-average background with warmup and scene-cut reset
  blobs.ts          # connected components, min-blob filtering, box merging
  filters.ts        # blur, denoise, luminance threshold, hue gate
  zones.ts          # zone matrix application and per-cell scoring
  debounce.ts       # cooldown, lost-signal and post-roll timers
  index.ts          # public contracts
```

## Algorithm

1. Convert the detect frame to luma, downscale to the configured grid-friendly
   size, apply a separable box blur (`blurRadius`) and denoise pass.
2. Maintain a slowly adapting background (exponential average, frozen while
   motion is active) and diff the current frame against it.
3. Threshold at `threshold` (0..255); optional hue gate drops pixels outside the
   configured colour ranges (foliage, sky).
4. Map changed pixels onto `zones.cols x zones.rows`, ignore masked cells, and
   compute `changedPercent` over active cells only.
5. Label connected components; drop components below `minBlobPercent` to kill
   sensor noise, then merge neighbours into event boxes.
6. Raise motion when `changedPercent >= percentThreshold` or sensitivity-derived
   threshold, then hold the event open until `postMotionSeconds` of quiet and
   `cooldownSeconds` has elapsed.

`sensitivity` is a convenience dial, linearly interpolated by
`resolveMotionThresholds()` in `@icamify/core`: 1 → strict (threshold 60,
percent 5), 50 → threshold 34 / percent 2.62, 100 → permissive (threshold 8,
percent 0.2). Explicit `threshold` / `percentThreshold` always win.

## Invariants

- Never mutate incoming frames; the same buffer feeds AI snapshots.
- A camera reconnect calls `reset()` so the first frames after a gap do not
  produce a full-frame false positive.
- Zone math uses the camera's native aspect ratio: cells are not square on
  ultrawide sensors, and the UI must draw the same grid the engine uses.
