# iCamify

Self-hosted NVR/VMS with an FFmpeg media pipeline, WebRTC live view, pixel
motion, local AI (CodeProject.AI / DeepStack / LPR), ONVIF PTZ and tiered
retention. An architectural counterpart to Agent DVR / iSpy, built as one Node.js
process and a zero-plugin HTML5 console.

**Status: Phase 1a complete — configuration foundation.** The schema, loader,
defaults, environment/secret handling, integrity checks, zone-matrix codec, CLI
and tests are implemented and green. FFmpeg ingestion and the web console are the
next phases (see [docs/architecture.md](./docs/architecture.md#9-phase-plan)).

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1a | Repo, config schema + loader, CLI, tests | ✅ done |
| 1b | FFmpeg probe/supervisor, RTSP/RTMP/HTTP/USB/file ingest | next |
| 2 | HTTP/WS/WebRTC signaling, Vue grid console | planned |
| 3 | Direct-to-disk recording, pre-buffer, motion + zones | planned |
| 4 | AI gateway, rules engine, notifications, ONVIF PTZ | planned |
| 5 | Retention manager, archive, timeline playback | planned |

## Requirements

- **Node.js ≥ 24** (the code is TypeScript executed natively via type stripping —
  no build step in development)
- **FFmpeg / ffprobe** on `PATH` (used from Phase 1b onward)
- Optional: CodeProject.AI or DeepStack instance for object/face/LPR detection

## Quick start

```bash
npm install

# create your config from the fully documented example
cp config/icamify.example.json config/icamify.json

# validate: schema + environment references + referential integrity
npx icamify config validate

# print the resolved config with secrets masked
npx icamify config print

# every check that CI runs
npm run check
```

`npx icamify` resolves the workspace `bin` directly; `npm run icamify -- <args>`
works too. The example config is intentionally complete — 6 cameras (ONVIF PTZ,
dual-stream RTSP, USB, RTMP push, MJPEG, file), two volumes with S3 archiving,
schedules, four rules, four notification channels, four AI providers and two
dashboard layouts. Validation prints warnings for the deliberate placeholders
(password hashes, empty camera passwords, disabled channels).

## What the configuration covers

- **Camera matrix** — RTSP/RTMP/HTTP-MJPEG/ONVIF/USB/file sources with credentials
  from the environment, dual main/sub streams and per-camera profiles.
- **Streaming** — named `copy` (0% CPU direct-to-disk), live and detect profiles;
  WebRTC/MSE/HLS/MJPEG fallback ladder; ICE servers, ports and viewer limits.
- **Recording** — continuous, motion, alert and scheduled modes; pre-roll cache;
  segment duration, size caps, post-roll, audio policy.
- **Motion** — sensitivity dial, pixel threshold, blur/denoise/colour filters and
  a paintable inclusion/exclusion zone matrix validated against its dimensions.
- **AI** — provider registry (CodeProject.AI, DeepStack, generic HTTP with
  response mapping, hot-loaded plugins), per-camera labels and confidence gates.
- **PTZ / ONVIF** — WS-Discovery scanner settings, presets and scheduled patrols.
- **Storage** — multiple volumes with per-camera assignment, size/age quotas,
  disk floor, purge strategy, dry-run and S3/SFTP/local archive targets.
- **Automation** — schedules with exceptions, priority-ordered rules with
  conditions on cameras/events/labels/schedules, actions for record, snapshot,
  notify, PTZ, scripts and event tagging; webhook/email/MQTT/Telegram channels.
- **Console** — saved grid layouts in cell coordinates, camera groups, ordering.

Full reference: [docs/configuration.md](./docs/configuration.md).
Schema: [`config/icamify.schema.json`](./config/icamify.schema.json) (add
`"$schema": "./icamify.schema.json"` for editor autocomplete).

## Repository map

```
apps/server/     icamify CLI + backend composition root
apps/web/        Vue 3 console (Phase 2)
packages/core/   config schema engine, types, defaults, validation, masks
packages/media/  FFmpeg ingest/remux/transcode/recording contracts
packages/motion/ pixel motion engine contracts
packages/ai/     AI gateway + provider contracts
packages/onvif/  WS-Discovery + PTZ contracts
packages/storage/retention, quota and archive contracts
plugins/         hot-loadable AI providers (reference implementation included)
config/          canonical JSON Schema + annotated example
docs/            architecture and configuration reference
data/            runtime state: recordings, snapshots, SQLite, logs (gitignored)
```

See [docs/architecture.md](./docs/architecture.md) for the annotated tree, data
flows, security model and per-phase exit criteria.

## Design highlights

- **Recording is a remux.** The `record-main` profile is `-c copy`; CPU cost is
  effectively zero regardless of resolution. Transcoding exists only for the live
  ladder and derived sub-streams.
- **The sub-stream does the thinking.** Motion and AI run on a 320×180 stream, so
  detection cost does not scale with sensor resolution.
- **Config fails fast.** Unknown keys, dangling profile/volume/schedule/channel
  references, mismatched zone masks and out-of-bounds layout tiles are startup
  errors with a JSON path. Operational hazards are warnings.
- **Secrets stay out of the file.** `${VAR}` / `${VAR:-fallback}` interpolation,
  `ICAMIFY_*` deployment overrides, and key-based redaction in every output.
- **One process, no broker.** FFmpeg children are supervised, events flow through
  an in-process bus, and SQLite is the index.

## Commands

```bash
npm run typecheck          # tsc --noEmit across all workspaces
npm test                   # 34 tests: config engine + CLI end-to-end
npm run check              # typecheck + tests
npm run config:validate    # validate ./config/icamify.json
npm run config:print       # resolved config, secrets masked
npm run config:schema      # print the JSON Schema
```
