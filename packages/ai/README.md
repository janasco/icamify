# @icamify/ai — AI gateway

**Phase:** 4 (complete for object/face/LPR/scene detection).

Routes motion-triggered frames to local or remote detectors and normalizes the
answers into `Detection[]`. The rule engine never talks to a vendor API.

## Layout

```
src/
  gateway.ts          # per-provider queue, concurrency, timeouts, circuit breaker
  http.ts             # bounded JSON/multipart transport (abort + response size cap)
  image.ts            # JPEG SOF reader: frame size without decoding
  mapping.ts          # paths, confidence/label normalization, box math, crop remap
  rules.ts            # pure rule predicates + template interpolation
  errors.ts           # AiError with a machine-readable code
  plugin-protocol.ts  # host ↔ worker messages
  plugin-worker.ts    # worker bootstrap: imports the plugin, forwards requests
  providers/
    codeproject.ts    # /v1/vision/detection | /face | /plate | /scene
    deepstack.ts      # /v1/vision/detection | /face | /alpr | /scene
    generic.ts        # templated request + JSON-path response mapping
    plugin.ts         # worker-thread host for hot-loaded providers
    predictions.ts    # shared `predictions[]` mapping for CodeProject/DeepStack
```

## Parity matrix

| Capability | CodeProject.AI | DeepStack | Generic HTTP | Plugin |
| ---------- | -------------- | --------- | ------------ | ------ |
| Object     | Blue Iris/YOLO modules | `mode: object` | yes | yes |
| Face       | FaceProcessing module | `mode: face` | yes | yes |
| LPR        | ALPR module (`endpoint` override) | `mode: lpr` | yes | yes |
| Scene      | Scene module | `mode: scene` | yes | yes |

## Behaviour

- **One task per call.** The service picks the provider's first declared
  capability in `object → face → lpr → scene` order, or the camera's runtime
  override. A provider declaring several capabilities serves one at a time.
- **Capacity is bounded.** `concurrency` requests run at once per provider; up to
  two frames may wait behind them, after which the call fails with `busy` — the
  caller drops the frame instead of queuing an unbounded backlog.
- **Every call has a deadline.** Providers use `timeoutMs` for their own HTTP
  abort; the gateway adds a hard deadline of `timeoutMs + 500` for adapters that
  ignore signals (plugins are terminated on timeout and respawned on demand).
- **Failures are classified.** Transport errors, 429/5xx and timeouts count toward
  the circuit breaker (3 consecutive → open for 30 s). `unsupported` and
  `invalid-response` do not: the service answered, the configuration is wrong.
- **Boxes are honest.** Pixel coordinates are clipped per edge, normalized against
  the submitted image, and remapped through the crop rectangle, so a detector that
  only saw part of the frame still reports full-frame coordinates.
- **Plugins are sandboxed and opt-in.** They run in a worker thread with
  `plugins.workerMemoryMb`, receive only the image and metadata, and must be listed
  in `plugins.trustedPlugins`. Detections are sanitized: unknown labels,
  non-finite confidences and degenerate boxes are dropped.

## Verification

`packages/ai/test/*.test.ts` covers path/confidence/box mapping, crop remapping,
JPEG header parsing, all four provider response shapes against a fake `fetch`,
HTTP failure classification, queue limits, concurrency, breaker open/recover,
timeout enforcement, rule matching (labels, confidence, cameras, events,
schedules, duration, provider), and the plugin bridge with a real worker thread
(happy path, throwing plugin, hung plugin terminated, unresolved plugin id).

End to end (real FFmpeg, stub detector): cropped JPEGs arrive as multipart at the
object endpoint, detections are indexed with normalized boxes and saved snapshots,
the rule fires a clip + webhook with a valid HMAC, and `/api/events/:id/snapshot`
serves the JPEG.
