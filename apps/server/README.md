# @icamify/server — backend composition root

The only process iCamify runs. It loads and validates the configuration, starts
the media engines on demand, serves the API and console, and brokers WebRTC
signaling.

**Phase:** 1 (CLI, config, diagnostics), 2 (HTTP/WS/live view/signaling), 3–5
(recording wiring, motion/AI, retention).

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
  routes/index.ts            route table, roles, anonymous-viewing rule
test/
  auth.test.ts               13 tests: hashes, sessions, revocation, TTL, lockout, tokens
  http.test.ts               17 tests: routes, roles, CSRF, static, control socket
  streams.test.ts             4 tests: MSE framing, MJPEG parts, auth rejection
  signaling.test.ts           9 tests: SDP validation, sessions, caps, failures
  helpers.ts                 fixtures: stub toolchain, ephemeral server, WS clients
```

## Routes

Full reference: [docs/api.md](../../docs/api.md).

| Area | Routes |
| ---- | ------ |
| Liveness | `GET /health` (public), `GET /api/health` |
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| System | `GET /api/system`, `GET /api/system/config` (admin), `GET /api/webrtc` |
| Cameras | `GET /api/cameras`, `GET /api/cameras/:id`, `snapshot.jpg`, `live-argv` (operator) |
| Live | `GET /api/cameras/:id/live.mjpeg`, `WS /api/cameras/:id/live.ws` |
| Dashboards | `GET /api/layouts` |
| Control | `WS /ws` (status push + WebRTC signaling) |

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

## Not implemented yet

Recordings/timeline and events (Phase 3), motion + AI wiring (Phase 3–4), ONVIF
discovery/PTZ and notifications (Phase 4), retention and archive (Phase 5), and a
WebRTC media engine (signaling is ready; the engine seam is empty by design).
Custom `system.api.basePath` values and `corsOrigins` are not honoured yet —
routes are always under `/api` and the console is same-origin.
