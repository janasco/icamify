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
│   ├── server/                      ✅ HTTP/WS/WebRTC composition root
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
│   ├── media/                       ✅ FFmpeg pipeline + direct-to-disk recorder
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
│   │   ├── src/record/
│   │   │   ├── paths.ts             ✅ hot dir / dated tree / local-time file names
│   │   │   ├── watcher.ts           ✅ segment-completion detection (newer file or stale mtime)
│   │   │   ├── prebuffer.ts         ✅ segment ring: adopt or expire
│   │   │   └── recorder.ts          ✅ modes, trigger windows, adopt/drop, status
│   │   └── test/                    ✅ 96 tests (argv, toolchain, plans, supervisor, processes, watcher, recorder)
│   │
│   ├── stream/                      ✅ live fan-out (fMP4/MJPEG sessions)
│   │   ├── README.md                ✅ invariants + measured behaviour
│   │   ├── src/fmp4.ts              ✅ box reader, init/fragment split, codec strings
│   │   ├── src/jpeg.ts              ✅ MJPEG frame splitter
│   │   ├── src/live/session.ts      ✅ per-camera fan-out, replay window, backpressure
│   │   ├── src/live/registry.ts     ✅ global caps, transport availability
│   │   └── test/                    ✅ 30 tests (no FFmpeg needed)
│   │
│   ├── motion/                      ✅ pixel motion engine
│   │   ├── README.md                ✅ algorithm, zone semantics, invariants
│   │   ├── src/engine.ts            ✅ background model, blobs, hangover
│   │   ├── src/grid.ts              ✅ zone matrix compilation
│   │   ├── src/frame.ts             ✅ rawvideo splitter (gray/rgb24)
│   │   ├── src/index.ts             ✅ contracts + factory
│   │   └── test/                    ✅ 18 tests (engine, frames, zones)
│   │
│   ├── ai/                          ✅ AI gateway
│   │   ├── README.md                ✅ provider parity matrix, behaviour, limits
│   │   ├── src/gateway.ts           ✅ bounded queue, concurrency, deadline, circuit breaker
│   │   ├── src/providers/           ✅ CodeProject.AI, DeepStack, generic HTTP, plugin worker
│   │   ├── src/mapping.ts           ✅ paths, confidence, box math, crop remap
│   │   ├── src/rules.ts             ✅ rule predicates + templates (pure)
│   │   ├── src/plugin-worker.ts     ✅ worker bootstrap for hot-loaded providers
│   │   ├── src/index.ts             ✅ contracts + exports
│   │   └── test/                    ✅ 50 tests (mapping, providers, gateway, rules, plugin)
│   │
│   ├── onvif/                       ✅ discovery + PTZ (Phase 4b)
│   │   ├── README.md                ✅ scope + security behaviour
│   │   ├── src/xml.ts               ✅ minimal XML parser + escaping
│   │   ├── src/soap.ts              ✅ SOAP 1.2 envelopes, WS-Security, PTZ requests
│   │   ├── src/discovery.ts         ✅ WS-Discovery probe/parse over UDP multicast
│   │   ├── src/client.ts            ✅ device/media/PTZ client, digest + basic auth
│   │   ├── src/errors.ts            ✅ classified error codes
│   │   ├── src/index.ts             ✅ contracts + exports
│   │   └── test/                    ✅ 24 tests (XML/SOAP, discovery, client, digest)
│   │
│   └── storage/                     ✅ recording index, retention, archive
│       ├── README.md                ✅ schema, API, retention order, archive rules
│       ├── src/db.ts                ✅ node:sqlite connection, WAL, additive migrations
│       ├── src/recordings.ts        ✅ segments, events, links, stats, tombstones, archive state
│       ├── src/retention.ts         ✅ archive → age → size → disk floor, batching, dry run
│       ├── src/archive/local.ts     ✅ copy into a directory, size verified
│       ├── src/archive/s3.ts        ✅ SigV4 PutObject, streamed UNSIGNED-PAYLOAD
│       ├── src/archive/sftp.ts      ✅ OpenSSH `sftp -b`, key authentication
│       ├── src/index.ts             ✅ contracts + exports
│       └── test/                    ✅ 55 tests (index, retention, archive, SigV4 vector)
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
| `@icamify/media` | `MediaPipeline`, `CameraRecorder`, `SegmentWindow`, `StreamProbe` | `StreamSource`, `StreamProfile` | FFmpeg processes, adopted segments, live frames |
| `@icamify/motion` | `MotionEngine.analyze(Frame)`, `RawFrameReader`, `compileZones` | detect frames, `MotionSettings`, `ZoneGrid` | `MotionDetection` (boxes, percent, cells) |
| `@icamify/ai` | `Gateway.detect(providerId, request)`, `matchingRules`, `unionBox` | JPEG crops, provider config | `Detection[]`, rule matches |
| `@icamify/onvif` | `OnvifScanner`, `PtzClient` | network, credentials | devices, presets, move commands |
| `@icamify/storage` | `RecordingIndex`, `RetentionEngine`, `ArchiveTarget` | finalized files, quotas | clip/detection/rule rows, tombstones, archive copies |
| `@icamify/stream` | `LiveSession`, `LiveRegistry`, `LiveSource` | FFmpeg stdout, config limits | fMP4 init/fragments, MJPEG frames, viewer stats |
| `@icamify/rtc` | `createWebRtcEngine`, `RtpContinuity`, `selectH264` | an `RtpSource` per camera, SDP offers | SRTP video per peer, packet/restart counters |
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

### 5.3 Motion → pre-buffer → recording (implemented)

```
CameraRecorder (mode != off), always running, -c copy:
  ffmpeg ──> <recordings>/<camera>/.hot/%Y%m%d-%H%M%S.mkv   (2–10 s in motion mode)
                │
                ▼  SegmentWatcher (poll: newer file, or stale mtime)
          closed segment
                ├─ continuous/scheduled+active ─► adopt: rename into <camera>/<date>/<time>-<reason>.mkv
                ├─ trigger window open ────────► adopt, linked to the open event id
                └─ otherwise ─────────────────► SegmentWindow (ring); expire+delete when it slides

MotionService, one detect pipeline per camera:
  raw luma 320×180 ──► PixelMotionEngine ──► episode start ──► RecordingManager.trigger('motion')
                                          └─ every second while active ──► trigger again (extends window)
```

Why a segment ring rather than a memory pre-buffer: the encoder must never restart
for a trigger (that would lose exactly the seconds before it and pay connect
latency each time), and a 5-second 4K remux is hundreds of megabytes, so holding it
in RAM is not an option. Whole segments in a hot directory cost disk, and adopting
one is a `rename` inside the same volume.

Consequences handled in code:

- A trigger window opens at `now − preBufferSeconds` and closes at
  `lastTrigger + postRollSeconds`. Buffered segments overlapping the window are
  adopted immediately, which is how pre-roll reaches the clip.
- While motion continues, the motion service calls back once per second; the
  recorder extends the window without creating a second event.
- On shutdown the watcher flushes the in-flight file (FFmpeg exit closes it),
  then buffered segments that never triggered are deleted rather than leaked.
- On start, anything left in `.hot` is deleted: it was never indexed, so it could
  never be played back.

Episode/event bookkeeping: `RecordingManager` writes the `events` row when a window
opens (peak percent and boxes attached), links every adopted segment, and closes the
row on release. When a rule fires during an open motion episode the recorder
escalates the episode to `alert` and extends the window to `then.record.seconds`,
so the clip that a person will look for is the one marked `alert`.

### 5.3b Motion → AI → rules

```
motion:start ─┬─→ recording.trigger('motion')        (pre-roll + heartbeat window)
              ├─→ AiService.analyze()                (interval + in-flight guards)
              │     capture frame (sub-stream, cropped) → Gateway.detect()
              │     filter labels/confidence → normalize+remap boxes
              │     save snapshot → index ai.<task> event per label
              │     → WS 'ai' → rules.handle({kind:'ai.object', label, confidence})
              └─→ rules.handle({id, kind:'motion', phase:'start'})
motion:end   ───→ rules.handle({id, kind:'motion', phase:'end', durationSeconds})

rule match → index 'rule' event → recording.trigger('alert', holdSeconds)
           → snapshot  → notifier.deliver(webhook, HMAC)  → WS 'alert'
```

Guarantees: the detector is never on the recording path; `intervalMs` and one
in-flight analysis per camera bound the load; three provider failures open the
circuit for 30 s; a rule fires at most once per episode (`rule|camera|episode`)
and respects `when.cooldownSeconds`.

### 5.4 Retention

`StorageService` translates the configuration (GB → bytes, hours → ms), owns the
timer and prunes detection history; `RetentionEngine` does the per-volume work and
knows nothing about JSON.

```
every purge.intervalSeconds (and on POST /api/storage/sweep):
  for each volume, lowest priority first:
    1. archive   age > archive.afterHours   → target.upload(key) → markArchived
                                              → keepLocalDays === 0 ? delete
    2. age       age > maxAgeHours          → (archive unless already done) → delete
    3. size      used > maxSizeGb           → delete per strategy, batch by batch,
                                              stop the moment the volume is under quota
    4. disk      free < minFreeDiskGb       → delete until projectedFree ≥ floor
  then: prune events older than ai.storeDetectionsDays, and snapshots older than
        that cutoff which no surviving event references
```

Guarantees:

- **Archive failure keeps the file.** The upload is attempted before the unlink; a
  failed or unverified archive records an error and leaves the footage in place.
- **Unlink, then tombstone.** A row without a file is recoverable (410, rescan); a
  file without a row is invisible. `ENOENT` still tombstones so a manual cleanup
  cannot wedge the sweep.
- **One sweep at a time.** `sweep()` serializes; the interval timer, an API call
  and a test can all ask without racing the same files.
- **Dry run is faithful.** It computes the same deletion and archive set and writes
  neither the filesystem nor the index.
- **Starred clips survive.** `protectFlagged` removes protected rows from the
  candidate list before any policy runs.
- **Quotas fail visibly.** A missing mount reports `error` and zero capacity in the
  storage panel instead of drawing a 0 % bar.

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
| **2 — Live console** | HTTP API + auth, control WebSocket, WebRTC signaling and session lifecycle, MSE/MJPEG live view, Vue grid console | ✅ complete |
| **2b — WebRTC media** | WebRTC media engine (H.264 RTP ↔ ICE/DTLS via `werift`), browser player with visible fallback, demo harness | ✅ complete (resizable tile spans and the HLS segmenter are still pending) |
| **3 — Recording & motion** | Segmenter + hot-directory adoption, pre-buffer ring, motion engine + zone editor, recording index and clip playback, recording modes (continuous/motion/alert/scheduled) | ✅ complete (visual timeline lands in Phase 5) |
| **4 — AI & alerts** | AI gateway + CodeProject/DeepStack/HTTP/plugin providers, crop-to-motion, label/confidence gating, rules engine, alert clips, webhook delivery (HMAC), console detection overlay and event log | ✅ complete |
| **4b — ONVIF, PTZ, other channels** | ONVIF WS-Discovery, Profile S PTZ moves/presets/patrols, PTZ rule action, PTZ pad and discovery dialog in the console, SMTP/MQTT/Telegram delivery, opt-in script action | ✅ complete |
| **5 — Retention & playback** | Retention manager (age/size/disk floor), archive adapters (local/S3/SFTP), detection-history pruning, timeline player with motion/AI/rule markers, on-demand MP4 remux, storage panel | ✅ complete (SFTP needs OpenSSH + a key) |

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
  blocking UDP visibly falls back to MSE. *(Verified headlessly against a real
  server: a `werift` peer received 548 RTP packets with keyframes and SPS/PPS in
  5 s, the session was traceable through `/api/webrtc`, and the FFmpeg pipeline
  was a pure H.264 copy. Glass-to-glass latency in two real browsers and the UDP
  blocking case still need a browser/hardware check.)*
- **3** — motion clip includes configured pre-roll; zone exclusions suppress a
  swaying tree; continuous recording survives a forced kill with a playable file.
  *(Verified with FFmpeg 7.0.2 and a looping file source: motion opened an event,
  pre-buffered segments were adopted with the event id, clips streamed back with a
  `206` byte range and a real Matroska header, the zone API persisted a half-frame
  mask, and 16/16 end-to-end checks passed. Zone suppression is covered by unit
  tests with synthetic frames; a physical camera and a swaying-tree scene are still
  pending hardware.)*
- **4** — a person-only rule produces exactly one Telegram alert and one clip;
  LPR labels reach the rule engine with confidence; PTZ preset round-trips.
  *(The PTZ half is verified: the ONVIF client round-trips discovery, device info,
  profiles, presets, moves and stop against a fake ONVIF device over HTTP with a
  digested 401, and the service resolves endpoints, merges device presets and
  pauses patrols on manual moves. Telegram, SMTP and MQTT delivery are verified
  against in-process fake servers, and a physical PTZ camera is still pending
  hardware.)*
- **5** — quotas are enforced within one interval; a failed archive never deletes
  the local file; archived segments are recorded with their provider; the timeline
  plays any clip without transcoding. *(Verified with FFmpeg 7.0.2: two real
  Matroska clips, an age purge that archived one and deleted it, a byte-identical
  archive copy, detection pruning that removed the old event and its snapshot but
  kept the recent one, and `play.mp4` remuxed to a 2-second fragmented MP4 that
  ffprobe reports as h264/mp4 — 41/41 checks. Boot-time disk reconciliation and a
  real S3/SFTP server are still pending.)*

---

## 10. Decisions worth remembering

1. **FFmpeg is the only media engine.** No GStreamer, no native decoder
   bindings. The supervisor is replaceable; the argv contract is documented.
2. **Pre-buffer is a directory ring, not a memory buffer.** Segments are whole files
   in the same volume as their final home, so a trigger is a rename and the
   encoder never restarts. Memory pre-buffering was rejected: `preBufferMaxMemoryMb`
   cannot hold even one 4K segment, and restarting FFmpeg per event loses the
   footage the feature exists to keep.
3. **MKV is the default recording container.** It tolerates unclean shutdowns;
   MP4 is available for browser-direct playback and remuxed on export.
4. **Motion detection is pixel-based, not ML-based.** It is cheap, predictable
   and works offline. AI runs only on confirmed motion crops, which keeps the
   detector load proportional to actual activity.
5. **JSON Schema is normative.** Types are derived by hand to keep the toolchain
   dependency-free; drift is caught by validating the shipped example in CI.
6. **No ORM.** The index uses `node:sqlite` with explicit SQL and hand-tuned
   indexes; the timeline query is the performance-critical path.
7. **Configuration is not the database.** Cameras, layouts and rules live in
   `icamify.json`; events, detections and segments live in SQLite. Runtime tuning
   that an operator expects to keep (motion zones, sensitivity) is stored beside the
   state directory, never written back into the config file.
8. **The filesystem owns recordings.** A lost index costs a rescan, not footage;
   deletion is a tombstone plus a file unlink, so audit history survives the file.
