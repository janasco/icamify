# @icamify/server — backend composition root

The only process iCamify runs. It loads and validates the configuration, starts
the media engines on demand, serves the API and console, and brokers WebRTC
signaling.

**Phase:** 1 (CLI, config, diagnostics), 2 (HTTP/WS/live view/signaling),
3 (recording, pre-buffer, motion, clip playback), 4 (AI gateway, detections,
rules, webhook alerts), 4b (ONVIF discovery, PTZ control and patrols),
5 (retention, archive, timeline), 6 (WebRTC media plane). The script rule action
and non-webhook notification channels remain.

WebRTC is a real media plane, not just signalling: `/api/webrtc/*` parses the
offer, spawns one FFmpeg per camera that writes RTP into the peer connection
(`@icamify/rtc` rewrites sequence numbers and timestamps across restarts), and
falls back to the MSE endpoint when the browser or network cannot do WebRTC.

```bash
npx icamify serve --config config/icamify.json   # the normal way to run iCamify
npx icamify serve --port 3000 --host 0.0.0.0     # explicit bind
```

Startup order is deliberate: config → FFmpeg toolchain → media engine → HTTP
listener. A machine without a working FFmpeg fails at boot instead of serving a
console where every camera is a black tile.

## Files

```
src/
  cli.ts                     argument parsing + command dispatch
  serve.ts                   composition root: config → media → registry → HTTP → hooks
  runtime.ts                 camera read model (status, redacted views, snapshots)
  index.ts                   public exports for tests and future modules
  version.ts
  commands/
    diagnostics.ts           doctor | probe | ingest
    serve.ts                 serve lifecycle + signals
    user.ts                  user hash (password from stdin)
  http/
    server.ts                listener, security headers, auth, CSRF, rate limit, logging
    router.ts                method + `:param` path router
    auth.ts                  argon2id, HMAC session cookies, bearer tokens, lockout
    responses.ts             JSON/text/buffer helpers, body parsing, HttpError
    static.ts                console build serving, SPA fallback, traversal guard
  ws/
    hub.ts                   authenticated control socket, heartbeat, backpressure
    protocol.ts              typed message parsing
  live/
    ws-stream.ts             MSE endpoint (JSON init + binary init/fragments)
    mjpeg.ts                 multipart MJPEG endpoint
  webrtc/
    signaling.ts             SDP validation, sessions, ICE forwarding, engine seam
  media/
    live-source.ts           LiveSource → MediaEngine supervisor bridge
  motion/service.ts          detect pipelines, motion episodes, zone/sensitivity API
  recording/manager.ts       recorders ↔ index ↔ WebSocket events
  ai/service.ts              motion → frame → detector → events; AI tuning API
  ai/plugins.ts              plugin discovery + trust gate (manifest scan)
  ai/snapshots.ts            snapshot paths, safe resolution, writer
  rules/engine.ts            rule evaluation, cooldowns, recording/snapshot/notify/PTZ actions
  onvif/service.ts           endpoint resolution, client cache, PTZ moves, patrol timers, discovery
  alerts/notifier.ts         webhook delivery, HMAC signing, dedupe
  storage/service.ts         retention timer, volume plans, detection pruning, disk warnings
  storage-paths.ts           rootDir/stateDir/recordingsDir resolution
  routes/index.ts            route table, roles, anonymous-viewing rule
test/
  auth.test.ts               13 tests: hashes, sessions, revocation, TTL, lockout, tokens
  http.test.ts               22 tests: routes, roles, CSRF, static, control socket, AI/rules API
  streams.test.ts             4 tests: MSE framing, MJPEG parts, auth rejection
  signaling.test.ts           9 tests: SDP validation, sessions, caps, failures
  recording.test.ts           7 tests: adoption, motion events, range playback, zone API
  ai.test.ts                  8 tests: filtering, crop remap, snapshots, throttling, overrides
  rules.test.ts              11 tests: rule actions, cooldowns, schedules, webhook HMAC, dedupe, PTZ
  storage.test.ts            10 tests: storage overview, dry run, purge, timeline, protect/delete, 410s
  onvif.test.ts              11 tests: endpoint resolution, presets, patrol pause, PTZ HTTP routes
  helpers.ts                 fixtures: stub toolchain, ephemeral server, WS clients
```

## Recording and motion

A recording camera gets one long-lived `copy` FFmpeg process that writes segments
into `<recordings>/<camera>/.hot`. `CameraRecorder` adopts (renames) segments into
the recordings tree and the `RecordingIndex` rows are written here — the recorder
knows nothing about SQLite and the index knows nothing about FFmpeg.

`MotionService` runs one `detect` pipeline per motion-enabled camera, feeds raw
luma into `@icamify/motion`, and calls back into the manager when an episode starts
(and once a second while it lasts, so the recorder's window stays open). It also
owns the zone/sensitivity overrides persisted to `<stateDir>/motion-overrides.json`.

Both services start **after** the HTTP listener exists: a camera that cannot be
reached must never delay the API, and a slow RTSP handshake must not look like a
hung process.

## Routes

Full reference: [docs/api.md](../../docs/api.md).

| Area | Routes |
| ---- | ------ |
| Liveness | `GET /health` (public), `GET /api/health` |
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| System | `GET /api/system`, `GET /api/system/config` (admin), `GET /api/webrtc` |
| Cameras | `GET /api/cameras`, `GET /api/cameras/:id`, `snapshot.jpg`, `live-argv` (operator) |
| Live | `GET /api/cameras/:id/live.mjpeg`, `WS /api/cameras/:id/live.ws` |
| Motion | `GET`/`PUT /api/cameras/:id/motion` (PUT: operator) |
| AI | `GET`/`PUT /api/cameras/:id/ai`, `POST /api/cameras/:id/ai/detect`, `GET /api/ai/providers[?health=1]` |
| Rules | `GET /api/rules` (rules + which channels are implemented) |
| Recordings | `GET /api/recordings`, `/api/recordings/:id`, `/api/recordings/:id/file` (Range), `/api/recordings/:id/play.mp4` (remux window), `/api/cameras/:id/recording`, `GET /api/events`, `GET /api/events/:id/snapshot` |
| Timeline | `GET /api/timeline` (one day: segments + events) |
| Storage | `GET /api/storage`, `POST /api/storage/sweep` (operator), `POST /api/recordings/:id/protect` (operator), `DELETE /api/recordings/:id` (operator) |
| Dashboards | `GET /api/layouts` |
| Control | `WS /ws` (status push, motion, recording, AI detections, rule alerts, storage sweeps/warnings, WebRTC signaling) |

## Operational rules

- Bind explicitly to `system.server.host`; there is no framework default.
- Every route declares `public` / `optional` / `required` auth and an optional
  minimum role. `optional` respects `auth.allowAnonymousViewing`.
- Cookie-authenticated mutations require a same-origin `Origin`.
- WebSocket messages are bounded (128 KiB), rate-limited (30 burst, 20/s), and
  clients that stop reading are dropped at 4 MiB.
- Live fan-out is per camera+transport: one encoder serves every viewer, and it is
  stopped after `streaming.sessionIdleTimeoutSeconds` with no viewers.
- Graceful shutdown: stop accepting → close sockets → stop encoders → exit,
  bounded by `system.shutdownGraceSeconds`.
- Camera credentials never leave the process: views use masked URLs and
  `live-argv` is redacted.

## Storage

`StorageService` turns the validated `storage` section into byte/millisecond
plans, runs the retention engine on `purge.intervalSeconds` (first pass five
seconds after boot) and prunes detection history after `ai.storeDetectionsDays`.
It is also the only place that deletes a clip on request: file first, tombstone
second, and `409` when the clip is starred.

Sweeps are serialized, so the timer and an operator pressing **Run retention
sweep** can never race the same files. A volume whose archive target cannot be
built (missing credentials, password-only SFTP) keeps recording and reports the
reason on `/api/storage` rather than failing startup.

## Notifications and automation scripts

`apps/server/src/alerts/` implements all four channels without third-party
packages: `smtp.ts` (EHLO, STARTTLS or implicit TLS, AUTH PLAIN/LOGIN, MIME body
with optional snapshot attachment), `mqtt.ts` (CONNECT/PUBLISH with QoS 0/1/2 and
retained Home Assistant discovery), `telegram.ts` (escaped text, `sendPhoto` for
snapshots) and `notifier.ts` (dedupe, per-channel outcomes, attachments).

`apps/server/src/automation/script-runner.ts` executes `then.script` only when
`scripts.enabled` is true. A path must resolve inside `scripts.directories`, the
process is spawned without a shell, event fields arrive as `ICAMIFY_*` variables,
and each run is bounded by a timeout (killed as a process group) and a concurrency
cap.

## Not implemented yet

Boot-time disk ↔ index reconciliation, the resizable layout editor and the HLS
segmenter. SFTP archiving requires the OpenSSH client and key authentication.
`scheduled` recording evaluates windows in UTC. Custom `system.api.basePath` values
and `corsOrigins` are not honoured yet — routes are always under `/api` and the
console is same-origin.
