# iCamify

Self-hosted NVR/VMS with an FFmpeg media pipeline, low-latency browser live view,
pixel motion, local AI (CodeProject.AI / DeepStack / LPR), ONVIF PTZ and tiered
retention. An architectural counterpart to Agent DVR / iSpy, built as one Node.js
process plus a zero-plugin HTML5 console.

**Status: Phase 3 complete — the NVR records and reacts to motion.** The server
boots from validated configuration, authenticates users, serves the Vue console,
streams cameras over fragmented MP4 (MSE) with an MJPEG fallback, records every
configured camera direct-to-disk, runs a pixel motion engine on the sub-stream
with a paintable zone matrix, and answers clip playback from a SQLite index. The
console shows live motion boxes, per-tile recorder state, a zone editor and a
recordings drawer with inline playback.

WebRTC signaling, SDP validation and session accounting are implemented; the
WebRTC *media* engine is the one remaining adapter and is reported honestly rather
than faked. AI, retention enforcement and the visual timeline are Phases 4–5.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1a | Repo, config schema + loader, CLI, tests | ✅ done |
| 1b | FFmpeg probe/supervisor, RTSP/RTMP/HTTP/USB/file ingest | ✅ done |
| 2 | HTTP API + auth, control WS, MSE/MJPEG live view, WebRTC signaling, Vue grid console | ✅ done |
| 3 | Direct-to-disk recording, pre-buffer ring, pixel motion + zone matrix, recording index + clip playback | ✅ done |
| 3b | WebRTC media engine (`werift` adapter), resizable layout editor, HLS | not started |
| 4 | AI gateway, rules engine, notifications, ONVIF PTZ | planned |
| 5 | Retention enforcement, archive, visual timeline playback | planned |

## Requirements

- **Node.js ≥ 24** (TypeScript executed natively via type stripping — no build
  step for the backend)
- **FFmpeg 5+ / ffprobe** on `PATH` (or `ICAMIFY_FFMPEG_PATH` /
  `ICAMIFY_FFPROBE_PATH`), with the encoders your profiles name — `icamify doctor`
  checks this per camera
- Optional: CodeProject.AI or DeepStack for object/face/LPR detection
- Optional: a WebRTC media engine (Phase 2b) for sub-200 ms viewing; without it the
  console uses MSE

## Quick start

```bash
npm install

# create your config from the fully documented example
cp config/icamify.example.json config/icamify.json

# validate: schema + environment references + referential integrity
npx icamify config validate

# is this machine ready? Node, config, FFmpeg, encoders and storage paths
npx icamify doctor

# create a login (reads the password from stdin, never argv)
printf '%s' 'your-password' | npx icamify user hash
#   paste the printed $argon2id$… into auth.users[].passwordHash

# build the console, then run the NVR
npm run web:build
npx icamify serve            # http://localhost:8060

# what is actually on the wire for one camera, or one pipeline in isolation
npx icamify probe --camera front-door --stream sub
npx icamify ingest --camera front-door --purpose record --dry-run

# every check that CI runs (typecheck + console typecheck + 247 tests)
npm run check
```

The example config is intentionally complete — 6 cameras (ONVIF PTZ, dual-stream
RTSP, USB, RTMP push, MJPEG, file), two volumes with S3 archiving, schedules, four
rules, four notification channels, four AI providers and two dashboard layouts.
Validation prints warnings for the deliberate placeholders (password hashes,
empty camera passwords, disabled channels).

## What the configuration covers

- **Camera matrix** — RTSP/RTMP/HTTP-MJPEG/ONVIF/USB/file sources with credentials
  from the environment, dual main/sub streams and per-camera profiles.
- **Streaming** — named `copy` (0% CPU direct-to-disk), live and detect profiles;
  WebRTC/MSE/HLS/MJPEG fallback ladder; ICE servers, ports, viewer limits,
  on-demand encoders and session idle timeouts.
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
API and streaming protocols: [docs/api.md](./docs/api.md).
Schema: [`config/icamify.schema.json`](./config/icamify.schema.json) (add
`"$schema": "./icamify.schema.json"` for editor autocomplete).

## Repository map

```
apps/server/      icamify CLI, HTTP API, WS hub, signaling, live endpoints
apps/web/         Vue 3 + Vite console (login, camera grid, MSE/MJPEG player)
packages/core/    config schema engine, types, defaults, validation, masks
packages/media/   FFmpeg discovery, argv builders, probe, supervisor, snapshots
packages/stream/  fMP4/MJPEG framing, per-camera live sessions and viewer registry
packages/motion/  pixel motion engine: background model, zone matrix, blobs, raw-frame splitter
packages/ai/      AI gateway + provider contracts
packages/onvif/   WS-Discovery + PTZ contracts
packages/storage/ SQLite recording index (segments + events); retention/archive contracts
plugins/          hot-loadable AI providers (reference implementation included)
config/           canonical JSON Schema + annotated example
docs/             architecture, configuration and API/streaming reference
data/             runtime state: recordings, snapshots, SQLite, logs (gitignored)
```

See [docs/architecture.md](./docs/architecture.md) for the annotated tree, data
flows, security model and per-phase exit criteria.

## Design highlights

- **One encoder per camera, N viewers.** Live sessions are shared and reference
  counted; the pipeline stops after the last viewer leaves
  (`streaming.onDemandStart`, `sessionIdleTimeoutSeconds`). A six-tile wall does
  not spawn six encoders per camera.
- **The browser gets only what it can use.** The server parses the fMP4 init
  segment to derive the exact RFC 6381 codec string (`avc1.4d4016`) before the
  client creates a `SourceBuffer`, and reports `codec-unsupported` — falling back
  to MJPEG — rather than showing a silent black tile.
- **Recording is a remux.** The `record-main` profile is `-c copy`; CPU cost is
  effectively zero regardless of resolution. Transcoding exists only for the live
  ladder and derived sub-streams.
- **Pre-roll without restarting the encoder.** Each recording camera segments
  continuously into a `.hot` directory; closed segments wait in a ring that covers
  `preBufferSeconds`. A trigger *adopts* them with a rename — that is where the
  seconds before the event come from. In continuous mode segments go straight to
  the recordings tree; in motion/alert mode untriggered ones are deleted when the
  ring slides.
- **One trigger window per episode, extended by heartbeat.** Motion start opens the
  window; each further second of motion extends it, so a person standing in frame
  records until `postRollSeconds` after they leave instead of stopping at the first
  post-roll.
- **The sub-stream does the thinking.** Live grid and motion prefer `streams.sub`,
  so a 4K camera is not decoded at full resolution to draw a 640×360 tile. Motion
  runs on 320×180 luma, one cell grid, integer arithmetic — a fraction of a core
  for a 15-camera install.
- **The index is disposable.** Recordings live on disk; SQLite only answers "what
  clips do I have and where are the motion events". A truncated or lost database
  costs a rescan, never footage.
- **Config fails fast.** Unknown keys, dangling profile/volume/schedule/channel
  references, mismatched zone masks and out-of-bounds layout tiles are startup
  errors with a JSON path; operational hazards are warnings.
- **Secrets stay out of the file and the API.** `${VAR}` interpolation,
  `ICAMIFY_*` overrides, key-based redaction, masked camera URLs and redacted
  FFmpeg argv.
- **Boring operations.** One process, one config file, one data directory. FFmpeg
  children are supervised in their own process groups (no orphan encoders), and
  the live path drops slow viewers instead of buffering for them.

## Commands

```bash
npx icamify serve [--host <addr>] [--port <n>] [--static-dir <path>]
npx icamify doctor [--json]                       # environment readiness
npx icamify probe --camera <id> [--stream sub]    # ffprobe one stream
npx icamify ingest --camera <id> --purpose <p>    # run one pipeline (--dry-run/--seconds)
npx icamify config validate|print|schema          # configuration commands
npx icamify user hash                             # argon2id hash from stdin

npm run check              # backend typecheck + console typecheck + 247 tests
npm test                   # 247 tests: config, media/recorder, motion, storage index, streams, server
npm run web:build          # build the console into apps/web/dist
npm run web:dev            # Vite dev server proxying /api and /ws to :8060
npm run config:validate    # validate ./config/icamify.json
npm run config:print       # resolved config, secrets masked
npm run config:schema      # print the JSON Schema
```

## Current limitations

- **Retention is not enforced yet.** Clips accumulate under the recordings tree;
  `storage.volumes[].maxSizeGb` / `maxAgeHours` and `storage.purge` are validated
  configuration, not a running purge loop (Phase 5). Today the disk fills.
- **No visual timeline yet.** Clips are listed newest-first and play inline with
  byte-range seeking; the day-long scrubbing timeline is Phase 5.
- **Motion has no retention of its own.** Motion events are rows in the index and
  carry the *analysis-frame* boxes; AI cropping and label filtering arrive with
  Phase 4.
- **Scheduled recording evaluates windows in UTC.** `system.timezone` is advisory
  and per-schedule timezones are accepted but not converted, so a non-UTC install
  shifts its schedule.
- **Alert mode is wired but has no trigger source yet.** The recorder accepts
  `alert` triggers and indexes them; nothing raises one until the AI/rules engine
  lands (Phase 4).
- **WebRTC media is not wired.** Signaling, validation and session caps work; an
  engine (intended: `werift` H.264 bridge) must be registered. Until then
  `/api/system` reports WebRTC unavailable with a reason and the console uses MSE.
- **Live audio is not carried.** The live plan maps video only.
- **Resizable tile spans** are not in the console yet; grid size, order and focus
  persist locally. Configured layout tiles seed the initial order.
- **`system.api.basePath` and `corsOrigins`** are not honoured yet (routes are
  `/api`, console is same-origin); startup warns if a custom base path is set.
- **Verification used a file source** (looping test pattern) with FFmpeg 7.0.2,
  not physical RTSP/ONVIF hardware; those paths are covered by argv and unit tests.
