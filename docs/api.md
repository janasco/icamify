# iCamify API (Phase 3)

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
| WS (upgrade) | `/ws` | optional | Control channel: status push + WebRTC signaling + motion/clip events. |

Not implemented yet: retention/purge writes, ONVIF scan, PTZ commands, settings
writes beyond motion tuning, and the AI gateway (Phases 4–5). The console links
no dead controls for them.

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
