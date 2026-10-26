# Example AI provider plugin

Reference implementation of the hot-swap contract used by `ai.providers[]` with
`"type": "plugin"`.

```
plugins/example-ai-provider/
  manifest.json      # id, apiVersion, kind, entry, capabilities, config schema
  src/index.ts       # exports createProvider(config, context)
```

## Enabling it

1. Install the plugin directory under `data/plugins/yolo-custom/` (the directory
   `plugins.directories` are scanned, `./plugins` is included by default).
2. Trust it: `plugins.trustedPlugins: ["yolo-custom-plugin"]`.
3. Reference it from a camera or as the default:

```json
{
  "ai": {
    "providers": [
      {
        "id": "yolo-custom",
        "name": "Custom YOLO",
        "type": "plugin",
        "pluginId": "yolo-custom-plugin",
        "config": { "endpoint": "http://127.0.0.1:9001/detect", "minConfidence": 0.4 },
        "capabilities": ["object"]
      }
    ]
  }
}
```

## Contract

- The host spawns a dedicated `worker_threads` worker with
  `plugins.workerMemoryMb`, imports `entry`, and calls `createProvider(config,
  context)`.
- `detect()` receives a JPEG/PNG buffer plus task/labels/threshold hints; it must
  return `Detection[]` with labels and optional boxes (source pixels).
- Every call is bounded by `ai.providers[].timeoutMs` and an AbortSignal.
- A plugin that throws or times out is disabled with backoff; ingest and recording
  continue unaffected.

## Trust model

Plugins are **not** sandboxed against the host's filesystem or network — a worker
thread is an isolation boundary for crashes and memory, not a security boundary.
Only install plugins you would run as your own user. Loading requires an explicit
entry in `plugins.trustedPlugins`; empty means nothing loads.
