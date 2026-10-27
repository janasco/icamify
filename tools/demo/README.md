# Demo harness

Everything needed to see iCamify working end to end, with no cameras and no AI
server. `npm run demo` from the repository root:

```bash
npm install            # werift is an optional dependency; the demo needs it
npm run web:build      # the demo serves the console from apps/web/dist
npm run demo
```

Then open <http://127.0.0.1:3000>. The demo uses `auth.mode: "none"` with
anonymous viewing, so there is no login.

## What runs

| Process | Port | What it is |
| ------- | ---- | ---------- |
| `icamify serve` | 3000 | the real server, with the `.demo/config.json` written by the runner |
| `fake-ai.mjs` | 8765 | DeepStack-shaped detector: `person` (0.91) every call, plus `car` (0.78) on alternate calls |
| `fake-onvif.mjs` | 8990 | ONVIF Profile S device: capabilities, profiles, stream URIs, presets, PTZ moves — and a WS-Discovery responder on 239.255.255.250:3702 |
| three FFmpeg pipelines | — | the server ingests the generated clips like any RTSP camera |

`.demo/` is gitignored and disposable: delete it to start clean. Media clips are
generated once with the FFmpeg found via `--ffmpeg`, `ICAMIFY_FFMPEG_PATH`, a
`.tools/ffmpeg-*` build or `PATH` (in that order), together with `ffprobe` sitting
next to it.

Cameras:

- **front-door** — motion recording, AI labels `person`/`car`, a motion zone
  matrix, motion + AI rule
- **parking** — continuous recording, segment per minute (the timeline subject)
- **porch-ptz** — streams a clip but drives the fake ONVIF camera; presets
  `porch`/`gate`/`parking`, patrol off, and a rule that aims it at `gate`

## Proving WebRTC works

```bash
npm run demo:rtc -- --camera front-door --seconds 6
```

This is not a ping. The probe acts as a browser: it opens the control socket,
offers H.264 with a real `werift` peer, applies the server's answer, then reports
what actually arrived:

```
answer: a=rtpmap:102 H264/90000 | a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
rtp:        548 packets, 481 KiB, payload type 102
h264:       71 keyframe packet(s), 5 parameter-set packet(s), NAL types 1,5,24
connection: connected; server session connected (575 packets forwarded)
pipeline:   634 packets, 0 restart(s), 1 viewer(s)
pipeline argv: ... -c:v copy -bsf:v h264_mp4toannexb -f rtp -payload_type 102 rtp://127.0.0.1:38029
RESULT: live video arrived over WebRTC
```

Exit codes: `0` media arrived, `1` no media, `2` WebRTC is disabled on the server.

## Other checks worth running by hand

```bash
curl -s localhost:3000/api/health
curl -s localhost:3000/api/cameras | python3 -m json.tool | head -40
curl -s -X POST -H 'content-type: application/json' -d '{"timeoutMs":2500}' \
     localhost:3000/api/onvif/scan
curl -s -X POST -H 'content-type: application/json' -d '{"name":"gate"}' \
     localhost:3000/api/cameras/porch-ptz/ptz/preset   # fake device logs "GotoPreset 2 (gate)"
curl -s --max-time 3 localhost:3000/api/cameras/parking/live.mjpeg -o /tmp/frames.mjpeg
```

The fake device prints every PTZ request, so a move in the console can be
confirmed against what the "camera" received.

## Notes and limits

- The demo detector answers instantly and identically; it tests the pipeline, not
  accuracy.
- Rules fire per detection, so at a 1 s AI interval a `then.record` rule still
  produces one clip request per detection. The demo's rule cooldown is 120 s for
  that reason; a real deployment tunes `cooldownSeconds` and `camera.ai.intervalMs`
  together.
- Motion must be enabled **per camera** (`cameras[].motion.enabled`), not only
  globally; the demo sets it on all three.
- WebRTC over the loopback ICE path is what the probe verifies. A real browser on
  another machine also needs `streaming.webrtc.publicIp` (and usually a TURN
  server); without it the console falls back to MSE.
