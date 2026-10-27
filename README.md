# iCamify

Self-hosted NVR/VMS with an FFmpeg media pipeline, low-latency browser live view,
pixel motion, local AI (CodeProject.AI / DeepStack / LPR), tiered retention with
archive and a scrubbing timeline. An architectural counterpart to Agent DVR / iSpy,
built as one Node.js process plus a zero-plugin HTML5 console.

**Status: Phase 5 complete — the storage loop is closed.** The server boots from
validated configuration, authenticates users, serves the Vue console, streams
cameras over fragmented MP4 (MSE) with an MJPEG fallback, records every configured
camera direct-to-disk, runs a pixel motion engine on the sub-stream, sends motion
frames to a local AI detector (CodeProject.AI, DeepStack, any HTTP endpoint or a
sandboxed plugin), executes the configured rules (record clip, snapshot, notify,
tag the event), and now enforces storage: per-volume age and size quotas, a free
disk floor, archive-then-delete to local/S3/SFTP, detection-history pruning, and a
day-long timeline that scrubs across clips and plays them in the browser.

WebRTC signaling, SDP validation and session accounting are implemented; the
WebRTC *media* engine is the one remaining adapter and is reported honestly rather
than faked. ONVIF/PTZ control (4b) and the resizable layout editor (6) remain.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1a | Repo, config schema + loader, CLI, tests | ✅ done |
| 1b | FFmpeg probe/supervisor, RTSP/RTMP/HTTP/USB/file ingest | ✅ done |
| 2 | HTTP API + auth, control WS, MSE/MJPEG live view, WebRTC signaling, Vue grid console | ✅ done |
| 3 | Direct-to-disk recording, pre-buffer ring, pixel motion + zone matrix, recording index + clip playback | ✅ done |
| 4 | AI gateway (CodeProject.AI/DeepStack/generic/plugin), label+confidence gating, rules engine, webhook notifications, alert clips | ✅ done |
| 4b | ONVIF WS-Discovery + PTZ control/patrols, script/PTZ rule actions, email/MQTT/Telegram delivery | not started |
| 5 | Retention enforcement (age/size/disk floor), archive to local/S3/SFTP, detection pruning, timeline player | ✅ done |
| 6 | WebRTC media engine (`werift` adapter), resizable layout editor, HLS | not started |

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

# every check that CI runs (typecheck + console typecheck + 376 tests)
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
packages/ai/      AI gateway: providers, mapping, bounded concurrency, circuit breaker, rule matching
packages/onvif/   WS-Discovery + PTZ contracts
packages/storage/ SQLite index, retention engine (age/size/disk floor), local+S3+SFTP archive targets
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
- **The detector is a replaceable adapter, and it is not on the critical path.**
  Motion confirmation gates every AI call; a per-camera interval and an in-flight
  guard stop a slow detector from building a backlog; per-provider concurrency is
  bounded; three consecutive failures open a circuit for 30 s so a dead service
  costs nothing instead of one timeout per event. Recording never depends on the
  detector answering.
- **Boxes survive cropping.** The detector gets only the motion region when
  `cropToMotion` is on; its pixel boxes are normalized against the submitted image
  (SOF parsed, no JPEG decoder) and remapped into full-frame coordinates, so the
  overlay and the timeline draw them in the right place.
- **Alerts escalate clips.** A rule firing during a motion episode turns the open
  window into an alert clip and extends it to `then.record.seconds`, so the clip
  someone looks for later is the one marked `alert`.
- **Deletion is unlink first, tombstone second.** A row without a file is
  recoverable (playback reports 410 and the file can be re-scanned); a file without
  a row is invisible footage. Retention also refuses to delete a clip it was
  supposed to archive when the upload failed, because a network blip must never
  cost footage.
- **One sweep order, cheapest first.** Archive (copy what is old enough) → age →
  size ceiling → free-disk floor. Each step can make the next unnecessary, and the
  size loop stops the moment the volume is under quota instead of deleting a batch.
- **The timeline remuxes, it does not transcode.** Selecting a moment asks FFmpeg
  for `-ss <offset>` + `-c copy` into fragmented MP4: no decode, no quality loss, a
  few percent of a core, and a browser can play what Matroska cannot.
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

npm run check              # backend typecheck + console typecheck + 376 tests
npm test                   # 376 tests: config, media/recorder, motion, storage index/retention/archive, streams, AI, rules, server
npm run web:build          # build the console into apps/web/dist
npm run web:dev            # Vite dev server proxying /api and /ws to :8060
npm run config:validate    # validate ./config/icamify.json
npm run config:print       # resolved config, secrets masked
npm run config:schema      # print the JSON Schema
```

## Current limitations

- **SFTP archiving needs the OpenSSH client and key authentication.** It is driven
  through `sftp -b` (no runtime dependency, no SFTP stack to audit), so a provider
  configured with a password is refused at boot with that explanation instead of
  silently never uploading.
- **Playback remuxes one window at a time.** Matroska becomes fragmented MP4 with
  stream copy, which cannot seek inside the window in the browser; clicking the
  timeline asks for a new window instead. Codecs MP4 cannot carry (for example
  some H.265 browser combinations) will fail to play — the file itself is intact
  and downloadable.
- **The purge does not reconcile the index against the disk yet.** Tombstones keep
  history, and the recorder re-adopts hot segments after a restart, but a full
  boot-time rescan (`reconcile.ts`) is not written; deleting files behind iCamify's
  back leaves rows that report 410 until they age out.
- **Only webhook delivery is implemented.** Email, MQTT and Telegram channels are
  validated and reported by `/api/rules` as `implemented: false`; a rule that
  notifies them logs the alert and skips delivery instead of pretending.
- **Two rule actions are recognised but not executed.** `then.ptz` needs the ONVIF
  device layer and `then.script` needs an explicit trust model; both are reported
  as `not implemented` in the rule outcome and warned once at startup.
- **One detection task per camera.** A provider that declares several
  capabilities gets the first of `object → face → lpr → scene` (overridable per
  camera via the AI panel or `/api/cameras/:id/ai`), so a single provider cannot
  run object and LPR analysis on the same frame.
- **Snapshot annotation is not burned in.** `then.snapshot.annotate` is accepted;
  the saved JPEG is clean and the boxes travel with the event instead, which is
  what the console overlays.
- **Scheduled recording evaluates windows in UTC.** `system.timezone` is advisory
  and per-schedule timezones are accepted but not converted, so a non-UTC install
  shifts its schedule.
- **WebRTC media is not wired.** Signaling, validation and session caps work; an
  engine (intended: `werift` H.264 bridge) must be registered. Until then
  `/api/system` reports WebRTC unavailable with a reason and the console uses MSE.
- **Live audio is not carried.** The live plan maps video only.
- **Resizable tile spans** are not in the console yet; grid size, order and focus
  persist locally. Configured layout tiles seed the initial order.
- **`system.api.basePath` and `corsOrigins`** are not honoured yet (routes are
  `/api`, console is same-origin); startup warns if a custom base path is set.
- **Verification used a file source** (looping test pattern), a stub detector that
  validates the multipart JPEG and answers with boxes, and a local webhook
  receiver — not physical RTSP/ONVIF hardware or a real inference server; those
  paths are covered by argv, provider-contract and unit tests.
- **Plugins must be trusted twice.** A plugin directory is only loaded when its
  manifest `id` is listed in `plugins.trustedPlugins`; untrusted directories are
  reported at startup and ignored.
