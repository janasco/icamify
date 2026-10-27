# @icamify/rtc

WebRTC media plane: ICE/DTLS-SRTP peers fed by an FFmpeg RTP source.

Signaling lives in `apps/server/src/webrtc/signaling.ts` (SDP validation, viewer
caps, session accounting). This package owns everything that touches media:

```
camera ──RTSP/file──▶ FFmpeg ──RTP/UDP(127.0.0.1)──▶ RtpContinuity ──▶ N × werift peers
```

## Why FFmpeg writes RTP instead of the engine parsing MP4

The MSE path reads fragmented MP4 from a pipe. Doing the same for WebRTC would
mean parsing `moof`/`trun` in JavaScript and re-packetising H.264 by hand. Letting
FFmpeg's `rtp` muxer do it (packetisation mode 1: STAP-A for parameter sets, FU-A
for fragments) leaves this package with two jobs: keep the header monotonic and
fan the payload out to every peer. UDP through the kernel also avoids a copy and a
JavaScript round trip per packet, which is what sub-200 ms depends on.

## RTP continuity (`src/rtp.ts`)

A camera pipeline restarts (reboot, RTSP drop, supervisor retry) and its sequence
numbers and timestamps start again. Forwarding that verbatim is the classic
"video connects but never decodes again" bug. `RtpContinuity`:

- rewrites SSRC and payload type to the negotiated values;
- advances the outgoing sequence number and timestamp monotonically;
- treats a large backwards timestamp jump as a restart (one step forward) and a
  small one as a late packet (dropped, because a decoder cannot go back in time);
- collapses a huge forward sequence gap to a single step so the receiver's jitter
  buffer is not asked to wait for thousands of missing packets.

`inspectH264Payload` reads the NAL type out of a payload (single NAL, STAP-A,
FU-A) and is used by diagnostics, the API counters and the RTC probe.

## Offer handling (`src/sdp.ts`, `src/engine.ts`)

Only H.264 is offered. The answer echoes the **browser's own** payload type and
fmtp string (`profile-level-id`, `packetization-mode`); renumbering them is what
makes Chrome drop a track silently. A browser that offers VP8 only is rejected
with a readable reason before any pipeline starts.

One `RTCPeerConnection` per viewer, one FFmpeg source per camera: ten viewers of
one camera cost ten SRTP encryptions and one decoder.

## Optional dependency

`werift` is an **optional** dependency, imported dynamically. With
`npm install --omit=optional` the engine still constructs, reports
`available: false` with the reason, and `/api/system` tells the console to use
MSE. Nothing else in the server depends on it.

## Configuration that matters

| Setting | Effect |
| ------- | ------ |
| `streaming.webrtc.enabled` | `false` removes WebRTC from the ladder |
| `streaming.webrtc.iceServers` | STUN/TURN; the default is a public STUN server |
| `streaming.webrtc.publicIp` | NAT address advertised in ICE candidates |
| `streaming.webrtc.portRange` | UDP range for ICE (`{min,max}`, max > min) |
| `streaming.webrtc.maxViewersPerCamera` | Cap per camera, enforced by signaling |
| `streaming.webrtc.fallbackAfterMs` | How long the console tries before MSE |

## Tests

```bash
node --test packages/rtc/test/*.test.ts
```

`engine.test.ts` connects a real `werift` peer over loopback and asserts that RTP
(with IDR payloads), keyframe detection and session accounting all work — the
part that cannot be faked without re-testing the fake.
