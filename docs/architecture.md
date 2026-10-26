# iCamify architecture

iCamify is a self-hosted NVR/VMS in the Agent DVR / iSpy tradition: many cameras
in, one browser console out, with motion, AI, PTZ, retention and a timeline. It
is built as a single backend process supervising FFmpeg, plus a zero-plugin HTML5
frontend.

This document is the map: repository layout, module boundaries, data flows and
the phase plan. The configuration contract is specified separately in
[configuration.md](./configuration.md).

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
                         │        Browser (Vue 3 SPA, Phase 2)      │
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
│   ├── server/                      ✅ package · 📐 internals
│   │   ├── package.json             ✅ bin: icamify
│   │   ├── README.md                ✅ composition root + planned layout
│   │   ├── src/
│   │   │   ├── cli.ts               ✅ config validate | print | schema
│   │   │   └── index.ts             📐 server bootstrap (Phase 2)
│   │   ├── test/cli.test.ts         ✅ 6 end-to-end CLI tests
│   │   └── (planned) src/http/, ws/, webrtc/, events/, supervisor/
│   │
│   └── web/                         🧭 Vue 3 + Vite SPA
│       └── README.md                ✅ planned views, stores, player ladder
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
│   │   └── test/                    ✅ 54 tests (argv, toolchain, plans, supervisor)
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
| `@icamify/server` | HTTP + WS + WebRTC | all of the above | browser console |

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
player tile ── POST /api/streams/:camera/ticket ──> short-lived, session-bound ticket
            ── WS /ws (ticket) ──> webrtc/offer ──> answer + ICE
            ── if no connected PC after fallbackAfterMs ──> MSE (fMP4) ──> MJPEG
```

- One encoder per camera+profile, fanned out to N viewers; the encoder stops when
  the last viewer leaves.
- The signaling socket is authenticated; media flows peer-to-peer or through the
  configured TURN server. Ports come from `streaming.webrtc.portRange`.
- Tiles pause when off-screen; the UI re-negotiates on visibility change.

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
| HTTP | Session cookie (HttpOnly, SameSite) or `Authorization: Bearer` API token; argon2id password hashes; login lockout; rate limiting. |
| Mutations | Same-origin check + CSRF token; role check (`admin`, `operator`, `viewer`). |
| Streams | Per-session, per-camera, short-lived tickets; no camera credentials ever reach the browser. |
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
| **2 — Live console** | HTTP API + auth, WebSocket hub, WebRTC signaling and session lifecycle, MSE/MJPEG fallback, Vue grid with drag/resize layouts, event feed | planned |
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
- **2** — two browsers watch the same camera through WebRTC with <200ms latency;
  blocking UDP falls back to MSE visibly; layouts persist across reloads.
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
