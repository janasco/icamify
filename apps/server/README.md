# @icamify/server — backend composition root

The only process iCamify runs. It loads and validates the configuration, starts
the media supervisor, serves the API and the SPA, and brokers WebRTC sessions.
The `icamify` CLI lives here.

**Phase:** 1 (CLI + config), 2 (HTTP/WS/WebRTC), 3–5 (module wiring).

## Current files

```
src/
  cli.ts     # icamify config validate | print | schema
  index.ts   # composition root (Phase 2)
test/
  cli.test.ts
```

## Planned layout

```
src/
  index.ts             # bootstrap: loadConfig -> logger -> db -> hub -> listeners
  app.ts               # builds the HTTP server and route table
  http/
    server.ts          # node:http listener, TLS, static SPA fallback, timeouts
    router.ts          # tiny method+path router (no framework dependency)
    auth.ts            # session cookie + bearer token verification, roles
    routes/
      cameras.ts       # CRUD + probe + snapshot + PTZ
      recordings.ts    # timeline query, byte-range streaming, download
      events.ts        # motion/AI/alert query and acknowledgement
      layouts.ts       # dashboard layouts
      settings.ts      # config read (redacted), validate-on-write, reload
      scanner.ts       # ONVIF discovery
      health.ts        # liveness/readiness, disk, ffmpeg version
      streams.ts       # MSE/MJPEG endpoints, WebRTC signaling handshake
  ws/
    hub.ts             # authenticated socket, topic subscriptions, backpressure
    protocol.ts        # typed client/server messages
    tickets.ts         # short-lived stream tickets bound to session + camera
  webrtc/
    signaling.ts       # offer/answer, ICE restart, session lifecycle
    session.ts         # one peer connection per viewer, codec negotiation
    track.ts           # attaches the shared live encoder output to peers
  events/
    bus.ts             # in-process typed event bus
    dispatcher.ts      # rules engine: conditions -> record/snapshot/notify/PTZ
  supervisor/
    runtime.ts         # orchestrates media, motion, ai, storage per camera
```

## Operational rules

- Bind explicitly to `system.server.host`; never rely on framework defaults.
- Every request is authenticated unless on the allowlist
  (`/health`, `/api/auth/login`, static assets).
- Mutating endpoints require same-origin `Origin` and CSRF token.
- WebSocket messages are bounded and rate-limited; slow consumers are dropped
  rather than buffered without limit.
- Graceful shutdown order: stop accepting → stop encoders → flush segments →
  close DB → exit, bounded by `system.shutdownGraceSeconds`.
- `GET /health` is liveness; `GET /api/health` reports camera and storage state.
