# @icamify/ai — AI gateway

**Phase:** 4.

Routes motion-triggered frames to local or remote detectors and normalizes the
answers into `Detection[]`. The rules engine never talks to a vendor API.

## Planned layout

```
src/
  gateway.ts        # queueing, per-provider concurrency, timeouts, circuit breaker
  providers/
    codeproject.ts  # POST /v1/vision/detection (object, scene, face, ALPR modules)
    deepstack.ts    # POST /v1/vision/detection | /v1/vision/face | /v1/vision/alpr
    generic.ts      # template request + JSON path response mapping
    plugin.ts       # worker-thread bridge to a hot-loaded plugin
  mapping.ts        # normalize provider boxes/labels, confidence clamps
  rules.ts          # label + confidence filters that gate events
  cache.ts          # last-detection per camera, used to avoid duplicate alerts
```

## Parity matrix

| Capability | CodeProject.AI | DeepStack | Generic HTTP | Plugin |
| ---------- | -------------- | --------- | ------------ | ------ |
| Object     | Blue Iris/YOLO modules | `mode: object` | yes | yes |
| Face       | FaceProcessing module | `mode: face` | yes | yes |
| LPR        | ALPR module | `mode: lpr` | yes | yes |
| Scene      | Scene module | `mode: scene` | yes | yes |

## Rules of engagement

- Frames are only sent when motion is confirmed (unless a camera explicitly
  disables that), cropped to the motion region when `cropToMotion` is true.
- `intervalMs` per camera is enforced before enqueueing, not after, so a slow
  detector cannot build an unbounded backlog.
- A provider failure degrades to motion-only events with a single warning per
  minute; it never blocks recording.
- Every request is bounded by `timeoutMs`; hung HTTP connections are aborted.
- Plugin providers run in a worker thread with `workerMemoryMb` limit and
  `timeoutMs`; a crashing plugin is disabled, not allowed to take down ingest.
