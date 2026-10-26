# @icamify/web — HTML5 console

Zero-plugin Vue 3 SPA built with Vite. Same origin as the API, so the session
cookie, WebSocket and MSE socket need no CORS configuration.

**Phase:** 2 (grid + MSE/MJPEG live view). Timeline, settings and the zone editor
come later; the console does not link controls for them.

## Layout

```
src/
  main.ts                    mounts the app
  App.vue                    boot: /api/auth/me → login or dashboard
  api.ts                     fetch wrapper (`credentials: same-origin`), ApiError
  live.ts                    MSE player: WS → MediaSource, live-edge, reconnect
  types.ts                   API types mirrored by hand
  style.css                  dark console theme
  components/
    LoginView.vue            username/password, actionable hints
    Dashboard.vue            top bar, camera rail, grid, control socket
    CameraTile.vue           per-tile player, snapshot button, fullscreen
```

## Transport ladder

1. **MSE** (default) — `/api/cameras/:id/live.ws`, fragmented MP4. The server
   sends `stream:init` with the codec string, then the init segment, then one
   binary frame per fragment.
2. **MJPEG** — automatic fallback when the socket closes with a fatal reason
   (`codec-unsupported`, `transport-disabled`, viewer/session limits), when
   `MediaSource` is missing, or when the codec is unsupported. Uses
   `/api/cameras/:id/live.mjpeg`.
3. **WebRTC** — the signaling client is not wired because no media engine is
   registered yet; `/api/system` reports why, and the footer shows it.

`live.ts` keeps playback honest:

- the playhead is pulled to the live edge when it drifts more than 1.5 s behind;
- media older than ~30 s is evicted from the `SourceBuffer`, so a 12-hour wall
  does not grow memory;
- a dropped socket reconnects with exponential backoff (5 attempts) and a new
  `stream:init` rebuilds the `MediaSource` (the codec may have changed);
- `1008` closes are fatal and switch the tile to MJPEG instead of retrying.

## Dashboard behaviour

- Cameras come from `GET /api/cameras`; status changes arrive on `WS /ws`, with a
  10-second poll only while the socket is down.
- Grid columns are Auto (1/2/3/4 by camera count) or fixed 1–4.
- Drag a tile onto another to reorder; double-click for fullscreen; the rail
  focuses one camera.
- Preferences persist in `localStorage`: `icamify.columns`, `icamify.order`,
  `icamify.focus`. Configured layouts seed the initial order and column count.

## Development

```bash
npm run web:dev      # Vite on :5173, proxies /api and /ws to :8060
npm run web:build    # production build into apps/web/dist
npm run web:typecheck
```

`icamify serve` automatically serves `apps/web/dist` when it exists (override
with `--static-dir`, disable with `system.web.serveStatic: false`). Paths without
a file extension fall back to `index.html`; hashed assets under `/assets/` are
cached immutably, `index.html` is `no-cache`, and responses carry a strict CSP.
