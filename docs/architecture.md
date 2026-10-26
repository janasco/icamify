# iCamify architecture

iCamify is a self-hosted NVR/VMS in the Agent DVR / iSpy tradition: many cameras
in, one browser console out, with motion, AI, PTZ, retention and a timeline. It
is built as a single backend process supervising FFmpeg, plus a zero-plugin HTML5
frontend.

This document is the map: repository layout, module boundaries, data flows and
the phase plan. The configuration contract is specified in
[configuration.md](./configuration.md); the HTTP API and streaming protocols in
[api.md](./api.md).

---

## 1. Design goals

| Goal | Consequence |
| ---- | ----------- |
| **Direct-to-disk recording** | Recording profiles use FFmpeg `-c copy`; the recorder never decodes video. CPU cost of recording a 4K camera is roughly a file copy. |
| **Dual-stream by default** | Each camera can define `streams.main` (record) and `streams.sub` (live grid + motion). The heavy stream is only touched for recording and full-screen playback. |
| **Browser-native viewing** | WebRTC first, fMP4/MSE second, MJPEG last. No HLS latency, no plugins, no transcode farms. |
| **Local-first AI** | CodeProject.AI, DeepStack and any HTTP endpoint behind one gateway; rules decide what is an alert. Cloud is optional, never required. |
| **Boring operations** | One process, one config file, one data directory. No message broker, no container orchestration, no external database. |
| **Explainable configuration** | JSON Schema + integrity checks: a bad profile reference fails at startup with a path, not at 03:00 with a missing recording. |

Non-goals for v1: multi-tenant hosting, cloud relay, mobile native apps,
distributed recording clusters, and analytics beyond object/face/LPR/scene.

---

## 2. Runtime topology

```
                         ┌──────────────────────────────────────────┐
                         │          Browser (Vue 3 SPA)             │
                         │  live grid · playback · settings · zones │
                         └───────┬───────────────────┬──────────────┘
                       REST/WS   │                   │ WebRTC / MSE / MJPEG
                                 ▼                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  @icamify/server — single Node.js process                                 │
│                                                                           │
│  config ──> supervisor ──> media ──> ffmpeg (child processes, one per job) │
│                 │              │                                          │
│                 │              ├── record: -c copy → segments + prebuffer  │
│                 │              ├── live:   one encoder, many viewers      │
│                 │              └── detect: tiny frames                    │
│                 │                                                         │
│                 ├──> motion ──> events ──> rules ──> record/snapshot/notify│
│                 ├──> ai gateway ──> CodeProject / DeepStack / HTTP / plugin│
│                 ├──> onvif (WS-Discovery, PTZ)                            │
│                 └──> storage (SQLite index, retention, archive)           │
└───────────────────────────────────────────────────────────────────────────┘
```

The process owns no video codecs itself. Its jobs are: supervise children,
enforce backpressure, index what hit disk, and decide when an event is worth
recording or telling someone about.

### Why Node.js 24 + TypeScript

The hot path is FFmpeg, not the runtime. Node gives one language across backend
and UI, first-class WebSocket/WebRTC plumbing, and native type stripping in Node
24 (no build step in development). CPU-sensitive pixel work runs on small frames
in bounded worker pools; if profiling ever shows the supervisor itself is the
bottleneck, `@icamify/media` is the only package that would move to a sidecar.

---

## 3. Repository map

Status: ✅ implemented · 📐 contract defined, implementation planned · 🧭 planned

```
icamify/
├── package.json                     ✅ npm workspaces, scripts, engine pin (Node >=24)
├── tsconfig.json                    ✅ strict, NodeNext, native TS execution
├── .env.example                     ✅ every secret the example config references
├── .gitignore                       ✅ data/, .env, build output
├── README.md                        ✅ overview + quick start
│
├── config/
│   ├── icamify.schema.json          ✅ canonical JSON Schema (2020-12, ~1.3k lines)
│   └── icamify.example.json         ✅ full reference config (6 cameras, all modules)
│
├── docs/
│   ├── architecture.md              ✅ this document
│   └── configuration.md             ✅ configuration reference & recipes
│
├── apps/
│   ├── server/                      ✅ HTTP/WS/WebRTC-signaling composition root
│   │   ├── package.json             ✅ bin: icamify
│   │   ├── README.md                ✅ routes, files, operational rules
│   │   ├── src/
│   │   │   ├── cli.ts               ✅ serve | doctor | probe | ingest | config | user
│   │   │   ├── serve.ts             ✅ boot order, static console, status push, shutdown
│   │   │   ├── runtime.ts           ✅ camera read model + snapshots + redaction
│   │   │   ├── http/                ✅ listener, router, auth, responses, static
│   │   │   ├── ws/                  ✅ authenticated control hub + typed protocol
│   │   │   ├── live/                ✅ MSE socket + multipart MJPEG endpoint
│   │   │   ├── webrtc/signaling.ts  ✅ SDP validation, sessions, ICE, engine seam
│   │   │   ├── media/live-source.ts ✅ LiveSource → media supervisor bridge
│   │   │   └── routes/index.ts      ✅ route table, roles, anonymous-viewing rule
│   │   └── test/                    ✅ 52 tests (auth, HTTP, streams, signaling)
│   │
│   └── web/                         ✅ Vue 3 + Vite console
│       ├── README.md                ✅ layout, player ladder, conventions
│       └── src/                     ✅ App, Dashboard, CameraTile, LoginView, live.ts
│
├── packages/
│   ├── core/                        ✅ configuration engine
│   │   ├── package.json             ✅ dependency: ajv
│   │   ├── README.md                ✅ pipeline + module table
│   │   ├── src/config/
│   │   │   ├── types.ts             ✅ TypeScript mirror of the schema
│   │   │   ├── defaults.ts          ✅ built-in profiles/defaults/env overrides
│   │   │   ├── jsonc.ts             ✅ JSONC parser with offset-preserving errors
│   │   │   ├── env.ts               ✅ ${VAR} / ${VAR:-fallback} interpolation
│   │   │   ├── merge.ts             ✅ deep merge + path helpers
│   │   │   ├── mask.ts              ✅ zone matrix codec (1010/0101 ⇄ bool[][])
│   │   │   ├── redact.ts            ✅ secret masking
│   │   │   ├── load.ts              ✅ load pipeline + ConfigError taxonomy
│   │   │   ├── validate.ts          ✅ Ajv validation + referential integrity
│   │   │   └── index.ts             ✅ public surface
│   │   ├── src/index.ts             ✅
│   │   └── test/config.test.ts      ✅ 28 tests (load, schema, env, semantics, masks, redaction)
│   │
│   ├── media/                       ✅ FFmpeg pipeline (1b done, recording in Phase 3)
│   │   ├── README.md                ✅ layout, invariants, shutdown policy
│   │   ├── src/errors.ts            ✅ MediaError taxonomy
│   │   ├── src/types.ts             ✅ MediaPipeline, StreamProbe, probe/snapshot options
│   │   ├── src/plan.ts              ✅ config → argv plan, profile/stream/volume selection
│   │   ├── src/snapshot.ts          ✅ one-shot JPEG grab with magic-byte check
│   │   ├── src/ffmpeg/
│   │   │   ├── locate.ts            ✅ binary/version discovery + capability table
│   │   │   ├── args.ts              ✅ pure builders: record/live/detect/snapshot/probe
│   │   │   └── process.ts           ✅ child supervisor, progress parser, stop ladder
│   │   ├── src/ingest/
│   │   │   ├── source.ts            ✅ StreamSource → demuxer args, credential injection
│   │   │   ├── probe.ts             ✅ ffprobe JSON → StreamProbe
│   │   │   └── supervisor.ts        ✅ per-camera state machine, backoff, health events
│   │   └── test/                    ✅ 61 tests (argv, toolchain, plans, supervisor, processes)
│   │
│   ├── stream/                      ✅ live fan-out (fMP4/MJPEG sessions)
│   │   ├── README.md                ✅ invariants + measured behaviour
│   │   ├── src/fmp4.ts              ✅ box reader, init/fragment split, codec strings
│   │   ├── src/jpeg.ts              ✅ MJPEG frame splitter
│   │   ├── src/live/session.ts      ✅ per-camera fan-out, replay window, backpressure
│   │   ├── src/live/registry.ts     ✅ global caps, transport availability
│   │   └── test/                    ✅ 30 tests (no FFmpeg needed)
│   │
│   ├── motion/                      📐 pixel motion engine (Phase 3)
│   │   ├── README.md                ✅ algorithm, planned files, invariants
│   │   └── src/index.ts             📐 MotionEngine, MotionDetection, Frame, Box
│   │
│   ├── ai/                          📐 AI gateway (Phase 4)
│   │   ├── README.md                ✅ provider parity matrix, rules of engagement
│   │   └── src/index.ts             📐 AiGateway, AiProviderClient, Detection, plugin contract
│   │
│   ├── onvif/                       📐 discovery + PTZ (Phase 4)
│   │   ├── README.md                ✅ scope + security behaviour
│   │   └── src/index.ts             📐 OnvifScanner, OnvifDeviceClient, PtzClient
│   │
│   └── storage/                     📐 retention + archive (Phase 5)
│       ├── README.md                ✅ retention order, safety rules, planned files
│       └── src/index.ts             📐 RetentionManager, RecordingSegment, VolumeStats
│
├── plugins/
│   └── example-ai-provider/          ✅ reference hot-loadable AI provider
│       ├── manifest.json             ✅ id, apiVersion, kind, entry, config schema
│       ├── src/index.ts              ✅ createProvider(config, context)
│       └── README.md                 ✅ contract + trust model
│
├── data/                            🧭 runtime only, gitignored
│   ├── recordings/                   # segments, one directory per camera/date
│   ├── snapshots/                    # motion and alert JPEGs
│   ├── state/                        # SQLite index, sessions, plugin state
│   ├── tmp/                          # .part files during writes
│   ├── logs/
│   └── plugins/                      # installed plugins (trustedPlugins gates loading)
│
└── scripts/                         🧭 dev/ops helpers (seed demo clips, ffmpeg doctor)
```

---

## 4. Module contracts

The contracts in `packages/*/src/index.ts` are deliberately small. They are the
seams between phases, so each can be implemented and tested in isolation.

| Package | Public contract | Consumes | Produces |
| ------- | --------------- | -------- | -------- |
| `@icamify/core` | `loadConfig`, `IcamifyConfig`, `ZoneGrid`, `redactConfig` | `icamify.json`, env | typed, validated config |
| `@icamify/media` | `MediaPipeline`, `PreBuffer`, `StreamProbe` | `StreamSource`, `StreamProfile` | FFmpeg processes, segments, live frames |
| `@icamify/motion` | `MotionEngine.analyze(Frame)` | detect frames, `MotionSettings`, `ZoneGrid` | `MotionDetection` (boxes, percent, cells) |
| `@icamify/ai` | `AiGateway.detect(providerId, request)` | JPEG crops, provider config | `Detection[]` |
| `@icamify/onvif` | `OnvifScanner`, `PtzClient` | network, credentials | devices, presets, move commands |
| `@icamify/storage` | `RetentionManager`, `RecordingSegment` | finalized files, quotas | index, deletions, archive uploads |
| `@icamify/stream` | `LiveSession`, `LiveRegistry`, `LiveSource` | FFmpeg stdout, config limits | fMP4 init/fragments, MJPEG frames, viewer stats |
| `@icamify/server` | HTTP + WS + WebRTC signaling | all of the above | browser console |

### Dependency rule

`core` depends on nothing in the repo. Every other package depends on `core`
only. `server` depends on all packages. No package reaches into another's
internals; types are exported from each package root.

---

## 5. Data flows

### 5.1 Camera bring-up and dual stream

```
config.cameras[i] ──> supervisor
  probe(streams.main) ──► StreamProbe (codec, resolution, fps)
  resolve volume by cameraIds / defaultVolume
  start record job (profile.copy = true, -c copy) ──► segments
  if streams.sub ──► start detect job at motion.intervalMs
  else ──► derive sub with FFmpeg (decode + scale, only when needed)
  schedule live encoder lazily on first viewer (streaming.onDemandStart)
  health probe every camera.health.probeIntervalSeconds; backoff on failure
```

Dual-stream matters: a 4K main stream decoded at 5fps just for motion would burn
a core per camera. The sub-stream is 320x180 in the example, so motion detection
sees ~58k pixels instead of 8M.

### 5.2 Live view and the transport ladder

```
player tile ── WS /ws (session cookie or bearer) ──> webrtc:offer ──> answer + ICE
            ── GET /api/system reports webrtc.available:false today ──┐
                                                                     ▼
            ── WS /api/cameras/:id/live.ws ──> stream:init, init segment, moof/mdat
            ── on fatal close ──> GET /api/cameras/:id/live.mjpeg (multipart JPEG)
```

- One encoder per camera+transport, fanned out to N viewers; it is stopped after
  the last viewer leaves plus `streaming.sessionIdleTimeoutSeconds`.
- The control socket is authenticated with the same session cookie or API token as
  the REST API. Signaling validates SDP, enforces
  `streaming.webrtc.maxViewersPerCamera`, forwards ICE and expires abandoned
  sessions after two minutes.
- The media plane is a `WebRtcMediaEngine` seam. **No engine is registered yet**,
  so `webrtc:offer` returns `engine-unavailable` with a reason and the console
  starts at MSE instead of waiting out `fallbackAfterMs`.
- MSE framing is explicit (JSON init, binary init, binary fragments) so the
  browser knows the codec before creating its `SourceBuffer`; a pipeline restart
  re-sends `stream:init` and clients rebuild the source buffer.

### 5.3 Motion → pre-buffer → recording → AI → rules

```
detect frame ──> MotionEngine
   motion=true ──► open MotionEvent, timestamp
                   ├─ drain PreBuffer(last preBufferSeconds) → segment head
                   ├─ start/continue record job             → segment tail
                   ├─ crop region → AiGateway.detect()      → Detection[]
                   └─ publish event on the bus
                                   │
                          rules engine (priority order)
                                   ├─ record.seconds  → extend clip
                                   ├─ snapshot        → annotated JPEG
                                   ├─ notify          → channel adapters
                                   ├─ ptz             → goto preset
                                   └─ script          → sandboxed exec
```

Rules are evaluated only for events they subscribe to (`when.events` +
`when.cameraIds` + schedule + AI label/confidence). Cooldowns are per rule and
per camera, so a busy driveway cannot spam a webhook.

### 5.4 Retention

```
every purge.intervalSeconds:
  free space < minFreeDiskGb        → delete oldest unprotected (disk floor)
  segment age > maxAgeHours         → archive if configured, then delete
  volume size > maxSizeGb           → delete per strategy until under quota
  log every deletion with path/size/reason, emit storage.purge event
```

Segments currently being written are younger than 60s and are skipped. Paths are
resolved and checked to be inside a configured volume before deletion.

---

## 6. Configuration as a contract

- **One file, fully specified.** `config/icamify.schema.json` validates the
  document; `config/icamify.example.json` exercises every section.
- **Fail fast.** Unknown keys are rejected (`additionalProperties: false`).
  Missing profile/volume/schedule/channel references are startup errors with a
  JSON path, not silent misbehaviour.
- **Warn, don't block.** Operational hazards (unbounded volume, disabled channel
  targeted by a rule, placeholder password hash, weak session secret) are
  warnings, visible in `icamify config validate` and the health endpoint.
- **Secrets never in the file.** `${VAR}` / `${VAR:-fallback}` is resolved at load;
  logs and `config print` redact by key. `ICAMIFY_*` variables override the few
  deployment-specific settings (port, host, public URL, data dir, log level,
  timezone).
- **Forward compatible.** `version` gates migrations. Unsupported versions fail
  loudly rather than being half-read.
- **Editable.** JSONC comments and trailing commas are accepted, so operators can
  annotate their camera matrix without a build step.

See [configuration.md](./configuration.md) for the full reference.

---

## 7. Security model

| Boundary | Control |
| -------- | ------- |
| HTTP | Session cookie (HttpOnly, SameSite, Secure) or `Authorization: Bearer` API token; argon2id password hashes verified with `hash-wasm`; server-side session revocation; per-identity login lockout; per-IP rate limiting. |
| Mutations | Same-origin `Origin` check for cookie-authenticated writes; role check (`admin`, `operator`, `viewer`). |
| Streams | Media sockets authenticate with the session cookie or bearer token; camera credentials never reach the browser and FFmpeg argv is redacted. |
| Media | RTSP/ONVIF credentials from env; never logged, redacted in API responses. |
| Plugins | Explicit `trustedPlugins` allowlist, worker thread isolation, memory/time limits. Not a sandbox against a malicious plugin — install only code you trust. |
| Filesystem | Retention resolves and confines paths to configured volumes; no user-supplied paths in deletion code. |
| TLS | Terminate natively (`system.tls`) or behind a reverse proxy with `trustProxy` enabled only when you control it. |

---

## 8. Performance budget

Targets for the reference config (4x 1080p H.264 + 1x 4K + 1 MJPEG, 8-core mini PC):

| Path | Target | Mechanism |
| ---- | ------ | --------- |
| Recording CPU | ~0% per camera | `-c copy` remux, no decode |
| Motion per camera | < 3% of one core | 320x180 detect stream, 5fps, luma-only diff |
| Live view latency | < 200ms glass-to-glass | WebRTC, 1s GOP, no B-frames, low-latency muxer |
| Startup | < 3s to API ready | config validation is O(cameras), no media probe on boot |
| Event → notification | < 1s after motion | in-process bus, bounded AI queue |
| Memory | < 750MB for 16 cameras | sub-stream frames + GOP pre-buffer budget (`preBufferMaxMemoryMb`) |

---

## 9. Phase plan

| Phase | Scope | Status |
| ----- | ----- | ------ |
| **1a — Foundation** | Repo layout, workspace tooling, config schema + example, typed config loader, env/secret handling, referential checks, zone mask codec, CLI, tests, docs | ✅ complete |
| **1b — Media bring-up** | `ffmpeg`/`ffprobe` detection and capability probe, argv builders, process supervisor, RTSP/RTMP/HTTP/USB/file ingest, FFprobe → `StreamProbe`, camera health/backoff, `icamify doctor` | ✅ complete |
| **2 — Live console** | HTTP API + auth, control WebSocket, WebRTC signaling and session lifecycle, MSE/MJPEG live view, Vue grid console | ✅ complete (media plane for WebRTC pending) |
| **2b — WebRTC media** | Register a WebRTC media engine (H.264 RTP ↔ ICE/DTLS), resizable tile spans in the grid editor, HLS segmenter | planned |
| **3 — Recording & motion** | Segmenter + `.part` atomic rename, pre-buffer replay, motion engine + zone editor, timeline index, recording modes (continuous/motion/alert/scheduled) | planned |
| **4 — AI, PTZ, alerts** | AI gateway + CodeProject/DeepStack/HTTP/plugin providers, rules engine, notification channels (webhook/email/MQTT/Telegram), ONVIF discovery and PTZ presets/patrol | planned |
| **5 — Retention & playback** | Retention manager (age/size/disk floor), archive adapters (local/S3/SFTP), timeline player with motion/AI markers, storage dashboards | planned |

### Exit criteria per phase

- **1a** — `npm run check` green; example config validates; broken configs fail
  with actionable paths; all module boundaries exported.
- **1b** — a camera produces `ffprobe`-verified metadata and a playable MKV
  segment; killing the source restarts the job with exponential backoff.
  *(Verified against a file source with FFmpeg 7.0.2: probe, copy recording,
  live transcode and detection all ran under the supervisor. Verification
  against a physical RTSP/ONVIF camera is still pending hardware.)*
- **2** — two browsers watch the same camera and share one encoder; a fatal
  transport error falls back to MJPEG visibly; drag order and grid size persist
  across reloads; the API refuses unauthenticated access and cross-origin cookie
  mutations. *(Verified with FFmpeg 7.0.2 and a file source: MSE delivered a
  `avc1.4d4016` init segment plus fragments to two simultaneous sockets, MJPEG and
  snapshot endpoints returned real JPEGs, and the console bundle was served with
  CSP. Browser playback and a physical camera are still pending hardware/proxy
  verification.)*
- **2b** — WebRTC delivers sub-200 ms glass-to-glass between two browsers, and
  blocking UDP visibly falls back to MSE.
- **3** — motion clip includes configured pre-roll; zone exclusions suppress a
  swaying tree; continuous recording survives a forced kill with a playable file.
- **4** — a person-only rule produces exactly one Telegram alert and one clip;
  LPR labels reach the rule engine with confidence; PTZ preset round-trips.
- **5** — quotas are enforced within one interval; deleting a volume directory
  is repaired by reconciliation; archived segments reappear in playback.

---

## 10. Decisions worth remembering

1. **FFmpeg is the only media engine.** No GStreamer, no native decoder
   bindings. The supervisor is replaceable; the argv contract is documented.
2. **MKV is the default recording container.** It tolerates unclean shutdowns;
   MP4 is available for browser-direct playback and remuxed on export.
3. **Motion detection is pixel-based, not ML-based.** It is cheap, predictable
   and works offline. AI runs only on confirmed motion crops, which keeps the
   detector load proportional to actual activity.
4. **JSON Schema is normative.** Types are derived by hand to keep the toolchain
   dependency-free; drift is caught by validating the shipped example in CI.
5. **No ORM.** Phase 5 uses `node:sqlite` with explicit SQL; the timeline query is
   the performance-critical path and needs hand-tuned indexes.
6. **Configuration is not the database.** Cameras, layouts and rules live in
   `icamify.json`; events, detections and segments live in SQLite.
