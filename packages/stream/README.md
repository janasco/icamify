# @icamify/stream — live fan-out

One FFmpeg pipeline per camera, N viewers. This package turns the bytes FFmpeg
writes to stdout into something a browser can append, and owns the lifecycle
rules that keep a many-viewer wall cheap.

## Layout

```
src/
  fmp4.ts            fragmented-MP4 box reader, init/fragment split, codec string
  jpeg.ts            MJPEG frame splitter (FFD8…FFD9 across chunk boundaries)
  live/
    types.ts         LiveSource / LiveViewer contracts, session events
    limits.ts        config → live limits (transports, caps, idle timeout, MJPEG q)
    session.ts       one camera+transport: late-joiner window, backpressure, restarts
    registry.ts      global caps, transport availability, camera lookup
test/
  fmp4.test.ts       boxes, 64-bit sizes, chunk boundaries, reset, HEVC codec string
  jpeg.test.ts       split, reassembly, garbage, runaway frame
  live.test.ts       fan-out, replay window, slow viewer, idle teardown, restart, registry caps
```

30 tests, no FFmpeg required: every pipeline is a fake `LiveSource`.

## Invariants

1. **No duplicate encoders.** A session exists per `cameraId + transport`; the
   second viewer reuses it. `LiveRegistry` enforces `maxConcurrentSessions` and
   `streaming.webrtc.maxViewersPerCamera`.
2. **Late joiners do not wait for a keyframe.** The session keeps the init
   segment plus the last `streaming.mse.windowSegments` fragments and replays
   them on attach.
3. **Slow consumers are dropped, never buffered.** A viewer whose queue exceeds
   8 MiB is disconnected (`slow-consumer`) rather than growing the process.
4. **No idle encoders.** After the last viewer leaves, the pipeline stops after
   `streaming.sessionIdleTimeoutSeconds`.
5. **Restarts are explicit.** When the source exits, parser state and fragment
   numbering are discarded, viewers get a non-fatal notice, and the next init
   segment is broadcast so clients can rebuild their `MediaSource`. If no data
   arrives within 30 s the session gives up and disconnects viewers.
6. **Codec strings are derived, not guessed.** `avc1`/`hvc1`/`av01` come from
   `avcC`/`hvcC`/`av1C` in the init segment. Unknown codecs (currently VP9)
   close with `codec-unsupported`, which is what makes the MJPEG fallback work.

## Measured on FFmpeg 7.0.2

`icamify serve` with the `live-sub` profile (h264 main @ 640×360, 15 fps):

- init segment 792 bytes, first fragments ~90 KB for 1 s of video;
- codec string derived as `avc1.4d4016` (Main, level 2.2);
- two simultaneous viewers share one MSE session and one FFmpeg process;
- closing both sockets releases the pipeline and drops the viewer count to 0.

## Deliberately not here

- The WebRTC media plane (RTP packetisation, DTLS/ICE) — it needs a native/WASM
  WebRTC stack and plugs into `@icamify/server`'s `WebRtcMediaEngine` instead.
- HLS segmenting (`streaming.hls`), which is reported as unavailable rather than
  silently half-working.
- Audio in the live view: the live plan maps video only, so a player never has
  to juggle two `SourceBuffer`s before it can paint.
