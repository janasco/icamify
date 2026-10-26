# @icamify/web — HTML5 console

**Phase:** 2 (player grid + signaling client), 5 (timeline).

Zero-plugin Vue 3 SPA built with Vite. It talks to the backend over the REST API
for CRUD, one WebSocket for events and WebRTC signaling, and WebRTC/fMP4 for
video. No native codecs, no browser extensions.

## Planned layout

```
src/
  main.ts
  App.vue
  router.ts
  stores/
    auth.ts          # session, role, CSRF
    cameras.ts       # camera list, live status
    player.ts        # active transport per tile, fallback state
    events.ts        # motion/AI/storage event feed
    layout.ts        # grid layout editing (drag, resize, persist)
  views/
    LiveView.vue     # grid dashboard
    PlaybackView.vue # timeline player
    SettingsView.vue # cameras, profiles, storage, AI, notifications
    ScannerView.vue  # ONVIF discovery
  components/
    CameraTile.vue
    VideoPlayer.vue  # transport ladder: WebRTC -> MSE -> MJPEG
    GridLayout.vue   # CSS grid, pointer-based drag/resize
    ZoneEditor.vue   # paint include/exclude motion cells
    MotionTimeline.vue
    EventFeed.vue
    PtzPad.vue
    StorageGauge.vue
  lib/
    api.ts           # typed fetch wrapper
    signaling.ts     # WebSocket client with reconnect + ticket auth
    webrtc.ts        # RTCPeerConnection lifecycle, ICE restart
    mse.ts           # MediaSource append queue
    mjpeg.ts         # multipart image consumer
```

## Transport ladder

1. **WebRTC** — sub-second, the default. Offer/answer over the authenticated
   signaling socket; ICE servers from `streaming.webrtc.iceServers`.
2. **MSE** — fragmented MP4 over the same socket when WebRTC is blocked.
3. **MJPEG** — multipart JPEG for locked-down browsers or ancient devices.

The player starts with WebRTC, and if `streaming.webrtc.fallbackAfterMs` elapses
without a connected `RTCPeerConnection`, it walks `streaming.fallbackChain` and
shows a small transport badge. Tiles pause decoding when scrolled out of view.

## Conventions

- One RTCPeerConnection per visible tile, closed when the tile unmounts; the
  backend stops the encoder when the last viewer leaves (`onDemandStart`).
- Grid layouts are stored as cell coordinates (`x`, `y`, `width`, `height`), so
  the same layout renders on a phone and a video wall.
- All dates render in `system.timezone`; the timeline is anchored to it.
