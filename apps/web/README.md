# @icamify/web — HTML5 console

Zero-plugin Vue 3 SPA built with Vite. Same origin as the API, so the session
cookie, WebSocket and MSE socket need no CORS configuration.

**Phase:** 5 (grid + MSE/MJPEG live view + motion/AI overlays + zone editor +
clips + event log + AI settings + storage panel + timeline player) plus 4b (PTZ
pad, patrol toggle, ONVIF discovery and inspection). The PTZ button only appears
on cameras the server reports an ONVIF endpoint for, so there is no dead control.

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
    Dashboard.vue            top bar, camera rail, grid, control socket, drawers
    CameraTile.vue           per-tile player, motion/AI boxes, REC state, snapshot, fullscreen
    MotionEditor.vue         paintable zone matrix + sensitivity (GET/PUT motion API)
    PtzPanel.vue             PTZ pad, speed/step, presets, patrol toggle (PTZ API)
    OnvifDiscovery.vue       WS-Discovery scan, device inspection, copy-ready snippet
    AiEditor.vue             per-camera AI task, label filter, confidence, detect-now (GET/PUT/POST AI API)
    ClipsPanel.vue           recordings + events drawer, inline playback from the Range endpoint
    StoragePanel.vue         volume usage, quotas, archive state, manual sweep + dry run
    TimelinePlayer.vue       day lane: clip blocks, motion/AI/rule ticks, seek → remuxed window
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
- A camera with an ONVIF endpoint gets a PTZ button on its tile: the pad sends
  bounded `ContinuousMove` requests (arrow keys work, Space stops, Esc closes) and
  the panel shows presets, whether the camera is reachable and the patrol state.
- **Discover** (operators and admins) probes the subnet, reads the selected
  device's profiles/URIs/presets and offers a configuration snippet to copy;
  credentials typed there are used for that inspection only.

### Motion and recordings

- The control socket pushes `motion` messages: episode start/end plus at most one
  update per second while active. The tile draws those normalised boxes as an SVG
  overlay, pulses the MOTION pill and shows the changed percentage.
- `camera.recording.state` drives the tile indicator: `recording` (pulsing REC),
  `buffering` (BUF, motion mode holding pre-roll), `stalled`/`error` (warn/err),
  plus `pre-buffer Ns` from `bufferedSeconds` and a `re-encode` hint when the
  record profile is not direct-to-disk.
- The gear button on a tile opens the zone editor: paint cells with a click-drag,
  switch include/exclude, fill/clear/invert, set sensitivity, save. Saving sends
  `PUT /api/cameras/:id/motion` (operator or admin) and the mask is persisted
  server-side, so it survives a reload and a restart.
- `ai` messages draw the detected boxes in green with a `label confidence%` tag
  for six seconds after the last analysis, and the tile badge shows the last labels
  (or the AI error, in red). The tile footer shows the detector latency.
- The Clips button opens the drawer: **Clips** lists finalized segments (live via
  `recording:segment`) with inline playback from `/api/recordings/:id/file` and a
  download link; **Events** lists motion, `ai.*` and `rule` rows from `/api/events`
  with confidence and a link to the saved snapshot (`/api/events/:id/snapshot`).
  Both follow the focused camera.
- The ✳ button opens the AI panel: enable analysis, choose the task the provider
  declares, edit the label filter, set the confidence floor, and run **Detect now**
  against the real pipeline to see actual detections, boxes, latency and the
  snapshot.
- The **Timeline** button opens a day view for the focused camera: recorded
  segments are blocks on a 24-hour lane, motion in amber, alert clips in red,
  with event ticks beneath (motion, `ai.*` in green, `rule` in red). Clicking the
  lane or a block asks `/api/recordings/:id/play.mp4` for a stream-copied window
  starting at that instant; the playhead tracks the video and says where the window
  sits in the day. Day boundaries are local.
- The **Storage** button opens the storage panel: per-volume usage against the
  configured ceiling (or against the whole disk when no ceiling exists), free
  space, oldest clip, archive target, retention policy and per-camera totals. An
  operator can run a sweep, defaulting to a dry run. A `storage:warning` push
  raises the badge and prints the message in the footer.
- Viewers see the gear, the save button and the sweep button disabled: the API
  requires `operator`, and the UI does not offer an action the server will reject.

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
