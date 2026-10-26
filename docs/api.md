# iCamify API (Phase 2)

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
| WS (upgrade) | `/ws` | optional | Control channel: status push + WebRTC signaling. |

Not implemented yet: recordings/timeline, events, settings writes, ONVIF scan,
PTZ commands (Phases 3–5). The console links no dead controls for them.

---

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
| `camera:status` | One camera changed state (viewers, pipeline, errors). |
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
