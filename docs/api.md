# iCamify API (Phase 4)

The HTTP API, control WebSocket and the two media endpoints the console uses.
Everything is served from the same origin as the console, so there is no CORS
surface and cookies work without `credentials: include` gymnastics.

Everything below is implemented and covered by `apps/server/test/*`.

---

## Authentication

Two credential types, both stored only as hashes in `icamify.json`:

| Credential | Transport | Config field |
| ---------- | --------- | ------------ |
| Local user | `POST /api/auth/login` → signed session cookie | `auth.users[].passwordHash` (argon2id) |
| API token | `Authorization: Bearer <token>` | `auth.apiTokens[].tokenHash` (SHA-256) |

- Session cookies are `HttpOnly`, `SameSite` from `auth.session.sameSite`, and
  `Secure` unless `auth.session.secureCookie` is `false` (use `false` only for
  plain-HTTP LAN deployments).
- Sessions are tracked server-side, so `POST /api/auth/logout` revokes them and
  the idle timeout (`auth.session.idleTimeoutMinutes`) is enforced.
- Failed logins are counted per client IP + username and locked for
  `auth.lockout.blockMinutes` after `auth.lockout.maxAttempts`.
- Generate a password hash with `icamify user hash` (reads the password from
  stdin — never argv).

Roles are cumulative: `viewer` < `operator` < `admin`.

| Need | Role |
| ---- | ---- |
| Camera list, snapshots, live view, layouts, system info | viewer |
| Live pipeline argv (troubleshooting) | operator |
| Full configuration (`/api/system/config`) | admin |

`auth.mode: "none"` turns authentication off (single-user appliance); every
request is treated as an admin. `auth.allowAnonymousViewing: true` keeps login
required for everything except camera/live read endpoints.

### CSRF

Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must be same-origin:
a mismatched `Origin` header is rejected with `403 cross-origin`. Bearer-token
requests are exempt because they are not ambient credentials.

### Error shape

```json
{ "error": { "code": "snapshot-failed", "message": "Could not capture a snapshot from \"Front door\": …", "details": { "hint": "…" } } }
```

Codes are stable strings (`unauthenticated`, `forbidden`, `camera-not-found`,
`transport-disabled`, `viewer-limit`, `rate-limited`, …), not status text.

---

## Routes

`A` = auth requirement. `public` needs nothing, `optional` allows anonymous
when `auth.allowAnonymousViewing` is on, `required` always needs a principal.

| Method | Path | A | Notes |
| ------ | ---- | - | ----- |
| GET | `/health` | public | Liveness only: `{status, version}`. Use for load balancers. |
| GET | `/api/health` | optional | Camera counts, live sessions, viewer count, FFmpeg version. |
| POST | `/api/auth/login` | public | `{username, password}` → sets the session cookie, returns the user. |
| POST | `/api/auth/logout` | optional | Revokes the session and clears the cookie. |
| GET | `/api/auth/me` | optional | `{authenticated, user, auth:{mode, signInRequired, allowAnonymousViewing, userCount}}`. |
| GET | `/api/system` | optional | Version, uptime, FFmpeg capabilities, transport ladder, feature flags. |
| GET | `/api/system/config` | admin | Fully resolved config, secrets redacted. |
| GET | `/api/webrtc` | optional | WebRTC capability, ICE servers, fallback timeout, codec preference. |
| GET | `/api/cameras` | optional | Camera views incl. derived status and transport availability. |
| GET | `/api/cameras/:id` | optional | One camera view. |
| GET | `/api/cameras/:id/snapshot.jpg?w=960` | optional | Single JPEG from the sub-stream (falls back to main), `no-store`. |
| GET | `/api/cameras/:id/live-argv?transport=mse\|mjpeg` | operator | Exact FFmpeg argv, credentials redacted. |
| GET | `/api/cameras/:id/live.mjpeg` | optional | Multipart MJPEG live stream. |
| WS (upgrade) | `/api/cameras/:id/live.ws` | optional | Fragmented MP4 live stream. |
| GET | `/api/layouts` | optional | Configured layouts plus camera ordering. |
| GET | `/api/cameras/:id/motion` | optional | Motion status incl. zone matrix, thresholds, live boxes. |
| PUT | `/api/cameras/:id/motion` | operator | `{sensitivity?, zones?}`; persists a runtime override. |
| GET | `/api/cameras/:id/recording` | optional | Recorder status, storage stats and the 10 newest clips. |
| GET | `/api/recordings` | optional | Clip index, filterable and pageable (see below). |
| GET | `/api/recordings/:id` | optional | One clip plus the events linked to it. |
| GET | `/api/recordings/:id/file` | optional | The clip file with `Range` support. |
| GET | `/api/events` | optional | Motion/AI/rule events from the index. |
| GET | `/api/events/:id/snapshot` | optional | Saved detection JPEG for an event (`404` when the event has none). |
| GET | `/api/cameras/:id/ai` | optional | AI status: provider, task, labels, counters, last crop/error. |
| PUT | `/api/cameras/:id/ai` | operator | `{enabled?, task?, labels?, minConfidence?}`; persists a runtime override. |
| POST | `/api/cameras/:id/ai/detect` | operator | One analysis now (`{boxes?}` optional); returns detections + status. |
| GET | `/api/ai/providers?health=1` | optional | Provider status (requests, errors, circuit) and, for a signed-in caller, a live health probe. |
| GET | `/api/rules` | optional | Configured rules and which notification channels are implemented. |
| WS (upgrade) | `/ws` | optional | Control channel: status push + WebRTC signaling + motion/clip/AI/alert events. |

Not implemented yet: retention/purge writes, ONVIF scan, PTZ commands, PTZ/script
rule actions, email/MQTT/Telegram delivery, and settings writes beyond motion and
AI tuning (Phases 4b–5). The console links no dead controls for them.

---

## Recordings

`GET /api/recordings?cameraId=front-door&from=…&to=…&limit=50&order=desc`

| Parameter | Meaning |
| --------- | ------- |
| `cameraId` | Filter to one camera. |
| `from` / `to` | Epoch milliseconds or ISO timestamps; `from` inclusive, `to` exclusive, matched against segment start. |
| `reason` | `continuous`, `motion`, `alert`, `scheduled`, `manual`. |
| `hasMotion` / `hasAlert` | `true`/`false`. |
| `limit` / `offset` | Page size (default 100, max 500) and offset. |
| `order` | `desc` (newest first, default) or `asc` for timeline playback. |

```json
{
  "segments": [
    {"id":"6f1c…","cameraId":"front-door","volumeId":"default",
     "path":"/data/recordings/front-door/20261026/054901-motion.mkv",
     "startedAt":1793000941000,"endedAt":1793000945000,"bytes":600291,
     "reason":"motion","hasMotion":true,"hasAlert":false,"eventIds":["evt_…"]}
  ],
  "total": 1,
  "stats": {"segments": 1, "bytes": 600291, "oldestAt":1793000941000, "newestAt":1793000945000},
  "request": { "cameraId": "front-door", "limit": 50, "order": "desc" }
}
```

**A segment is one file on disk.** Motion clips are made of several segments linked
to the same event; there is no "clip" object that has to be re-muxed. The path is
where the bytes are; the timestamps are what the timeline should draw.

`GET /api/recordings/:id/file` serves the file with `Accept-Ranges: bytes`:

- no `Range` header → `200` + `Content-Length`;
- `Range: bytes=0-255` → `206` with `Content-Range: bytes 0-255/624376`;
- unsatisfiable range → `416` with `Content-Range: bytes */<size>`;
- the file was deleted (retention, manual cleanup) → `410 recording-missing`.

`Content-Type` follows the container: `video/x-matroska`, `video/mp4`,
`video/webm` or `video/mp2t`. Auth is the normal viewer requirement, so a
`<video src>` works because the session cookie is sent with the request.

## Motion tuning

`GET /api/cameras/:id/motion` returns the worker state even when motion is disabled
or the pipeline failed, because the zones and thresholds are what an operator needs
to fix it:

```json
{
  "cameraId": "front-door", "enabled": true, "running": true, "state": "running",
  "analysis": {"width":320,"height":180,"fps":5,"pixelFormat":"gray"},
  "thresholds": {"threshold":34,"percentThreshold":2.62,"sensitivity":50,"derivedFromSensitivity":true},
  "zones": {"cols":16,"rows":16,"mode":"include","cells":[[true,…],…]},
  "activeCells": 256, "totalCells": 256,
  "motion": true, "lastPercent": 18.75, "peakPercent": 27.73,
  "lastMotionAt": 1793000942600, "boxes": [{"x":0.05,"y":0.12,"width":0.4,"height":0.5,"normalized":true}],
  "frames": 812, "analysed": 790
}
```

`PUT /api/cameras/:id/motion` (operator) accepts:

```json
{"sensitivity": 80, "zones": {"cols": 16, "rows": 16, "mode": "exclude", "cells": [[false,…],…]}}
```

`cells` may be a boolean matrix or the compact `"0110/…"` string used by the
config file. `mode: include` monitors the selected cells; `mode: exclude` ignores
them. A matrix that monitors nothing is rejected (`400 invalid-motion-settings`).

The override is written to `<storage.stateDir>/motion-overrides.json` and applied
after the config at boot, so tuning survives a restart while `icamify.json` stays
the as-shipped source of truth. Setting `sensitivity` re-derives the thresholds,
which means explicit `threshold`/`percentThreshold` values in the config stop
applying for that camera (the response reports `derivedFromSensitivity`).

## AI detection

`GET /api/cameras/:id/ai` returns the per-camera view even when the pipeline never
started, because the labels and threshold are what an operator needs to fix it:

```json
{
  "cameraId": "front-door", "enabled": true,
  "providerId": "codeproject-objects", "providerName": "CodeProject.AI (objects)",
  "task": "object", "capabilities": ["object"],
  "labels": ["person", "package"], "minConfidence": 0.55, "intervalMs": 750,
  "cropToMotion": true, "saveSnapshots": true,
  "analyses": 42, "detections": 17, "lastDetectionAt": 1793000942000,
  "lastLatencyMs": 96, "lastLabels": ["person"],
  "lastCrop": {"x": 0.31, "y": 0.22, "width": 0.28, "height": 0.4, "normalized": true},
  "circuit": "closed"
}
```

`PUT` accepts `{enabled, task, labels, minConfidence}`; `task` is one of
`object`, `face`, `lpr`, `scene` and must be declared by the provider. The override
is stored in `<storage.stateDir>/ai-overrides.json` and survives restarts.

`POST /api/cameras/:id/ai/detect` runs exactly one analysis through the real
pipeline (capture → crop → detector → filter) and answers:

```json
{
  "cameraId": "front-door", "at": 1793000942000, "task": "object", "providerId": "codeproject-objects",
  "latencyMs": 118, "snapshot": "front-door/2026-10-26/122222-person.jpg", "eventIds": ["evt_…"],
  "detections": [
    {"label": "person", "confidence": 0.88, "box": {"x": 0.095, "y": 0.088, "width": 0.473, "height": 0.7, "normalized": true}}
  ]
}
```

With no usable provider it returns `200` with `detections: []` and a `reason`, so
the console can show the cause instead of an empty panel.

### How frames reach the detector

1. Motion starts an episode → the AI service is called with the episode's boxes.
2. `intervalMs` per camera and an in-flight guard are enforced *before* capture.
3. One still is grabbed from the sub-stream (`streams.sub`, else main) at
   `storage.snapshot.maxWidth`; with `cropToMotion` the FFmpeg `crop` filter keeps
   only the padded union of the motion boxes.
4. The provider answers in pixels of the submitted image. iCamify reads the JPEG
   SOF header for its size, normalizes each box, and remaps it into full-frame
   coordinates when the frame was cropped.
5. Labels and `minConfidence` are applied, `ai.maxDetectionsPerFrame` caps the list,
   one event row is written per distinct label, and the result is handed to the
   rule engine.

Provider failures never block recording: the camera keeps producing motion events,
the AI status carries `lastError`, and three consecutive failures open the
provider circuit for 30 s.

## Rules and notifications

`GET /api/rules`:

```json
{
  "rules": [{"id": "person-at-night", "name": "Person at night", "when": {"events": ["ai.object"], "ai": {"labels": ["person"]}}, "then": {"record": {"seconds": 45}}}],
  "channels": [
    {"id": "automation-webhook", "name": "Automation", "type": "webhook", "enabled": true, "implemented": true},
    {"id": "telegram-alerts", "name": "Telegram", "type": "telegram", "enabled": true, "implemented": false}
  ],
  "dedupeSeconds": 30
}
```

A matching rule executes, in order: index a `rule` event (`markEvent.label` or the
rule name), start/extend an alert clip (`then.record.seconds`), save a snapshot
(`then.snapshot`), deliver notifications (`then.notify`). `then.ptz` and
`then.script` are reported as `not implemented` in the outcome and warned once.

Webhook payloads are `POST`ed as JSON with `content-type: application/json` and,
when the channel has `hmacSecret`, an `x-icamify-signature: sha256=<hex>` header
covering the exact body. `bodyTemplate` supports `{cameraName}`, `{label}`,
`{confidence}`, `{time}`, `{kind}`, `{ruleName}`, `{severity}`, `{title}`,
`{message}` and `{snapshot}`. Identical alerts (channel + camera + rule + label)
are suppressed for `notifications.dedupeSeconds`, and each rule honours its own
`when.cooldownSeconds`.

## MSE media socket

`GET (Upgrade) /api/cameras/:id/live.ws`

One FFmpeg pipeline per camera serves every socket. Nothing is started until the
first viewer arrives and the pipeline stops after the last one leaves plus
`streaming.sessionIdleTimeoutSeconds`.

Frames, in order:

1. **Text** `stream:init`
   ```json
   {"type":"stream:init","cameraId":"front-door","transport":"mse",
    "mimeType":"video/mp4; codecs=\"avc1.4d4016\"","codec":"avc1.4d4016",
    "width":640,"height":360,"segmentMode":"fmp4"}
   ```
2. **Binary** — the init segment (`ftyp`+`moov`), exactly once.
3. **Binary** — one message per `moof`+`mdat` fragment, in order.

A pipeline restart (camera reboot, profile change) resets the parser and sends a
new `stream:init`; the client must rebuild its `MediaSource` because the codec
can change. A fatal reject is a close with code `1008` and one of these reasons:

| Close reason | Meaning | What the console does |
| ------------ | ------- | --------------------- |
| `codec-unsupported` | No RFC 6381 codec string could be derived (e.g. HEVC from this build). | Falls back to MJPEG. |
| `transport-disabled` | `streaming.mse.enabled: false`. | Falls back to MJPEG. |
| `camera-disabled` / `camera-not-found` | Camera not usable. | Shows offline. |
| `viewer-limit` | `streaming.webrtc.maxViewersPerCamera` reached. | Shows the limit. |
| `session-limit` | `streaming.maxConcurrentSessions` reached. | Shows the limit. |
| `pipeline-offline` | The source did not come back within 30 s. | Offers retry. |

Slow consumers are disconnected (`close` reason `slow-consumer`) when their
socket queue exceeds 8 MiB, rather than buffering without limit.

The server derives the codec string by parsing `avcC` / `hvcC` / `av1C` from the
init segment, so no separate probe round-trip is needed. VP9 (`vpcC`) is not
derived yet and therefore reports `codec-unsupported`.

## MJPEG media endpoint

`GET /api/cameras/:id/live.mjpeg` — `multipart/x-mixed-replace; boundary=icamifyframe`.
Each part is a complete JPEG with `Content-Length`. Uses `streaming.mjpeg`
(fps, width, quality) and costs real CPU, so it is the last rung of the ladder.

---

## Control socket

`/ws` (`system.api.websocket.path`), authenticated with the session cookie or a
bearer token. Messages are JSON objects with a `type` tag; binary frames are
rejected. The rate limit is a 30-message burst with 20/s refill, and clients
that stop reading are dropped at 4 MiB of queued data.

### Server → client

| Type | When |
| ---- | ---- |
| `welcome` | On connect. Contains user (or `null`), server version/uptime, the camera snapshot, subscribed topics. |
| `cameras` | Full camera list (after `subscribe`). |
| `camera:status` | One camera changed state (viewers, pipeline, errors, recorder state). |
| `motion` | `{cameraId, active, at, percent, peakPercent, boxes[]}` — episode start/end plus at most one update per second while active; boxes are 0..1 image coordinates. |
| `recording:segment` | `{segment}` — a clip was finalized and indexed; the same object as in `GET /api/recordings`. |
| `recording:event` | `{event, closed}` — a motion/rule episode opened or closed. |
| `ai` | `{cameraId, at, task, providerId, latencyMs, detections:[{label, confidence, box?}], snapshot?}` — one analysis result; boxes are 0..1 full-frame coordinates. |
| `ai:error` | `{cameraId, at, message}` — the detector failed, timed out or is not configured. |
| `alert` | `{ruleId, ruleName, cameraId, at, kind, label?, confidence?, actions[], snapshot?, eventId?}` — a rule fired; `actions` reports what actually ran. |
| `subscribed` | Acknowledges `subscribe`/`unsubscribe` with the current topics. |
| `pong` | Answer to `ping`, echoing `t`. |
| `webrtc:answer` | `{sessionId, cameraId, sdp}` for an accepted offer. |
| `webrtc:error` | `{code, message}`; `engine-unavailable` when no media engine is registered. |
| `error` | Protocol/validation/rate-limit problem; the socket stays open. |

### Client → server

```json
{"type":"subscribe","topics":["cameras"]}
{"type":"ping","t":1712345678901}
{"type":"webrtc:offer","cameraId":"front-door","sdp":"v=0\r\n…"}
{"type":"webrtc:ice","sessionId":"rtc_ab12…","candidate":{"candidate":"candidate:1 1 udp …","sdpMid":"0","sdpMLineIndex":0}}
{"type":"webrtc:close","sessionId":"rtc_ab12…"}
```

---

## WebRTC status

The signaling service is complete: SDP validation (must be `v=0`, contain a
video section and ICE credentials), per-camera session cap
(`streaming.webrtc.maxViewersPerCamera`), ICE candidate forwarding, 2-minute
session expiry, and a capability answer the console uses to fall back
immediately instead of waiting `fallbackAfterMs`.

The media plane is a pluggable `WebRtcMediaEngine`. **No engine ships yet**, so
`GET /api/webrtc` reports `available:false` with a reason and offers return
`engine-unavailable`; the console therefore starts at MSE. Registering an engine
(a `werift`-based H.264 bridge is the intended adapter) requires no API change —
`SignalingService` calls `negotiate`, `addIceCandidate` and `closeSession` on it.
