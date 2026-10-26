# @icamify/media — FFmpeg pipeline

Owns every interaction with FFmpeg: probing, demuxing, remuxing, transcoding,
recording and the pre-roll cache. Node never touches pixel data except the small
frames produced for motion detection.

**Phase:** 1 (ingest + probe), 3 (recording + pre-buffer).

## Planned layout

```
src/
  ffmpeg/
    locate.ts        # resolve ffmpeg/ffprobe binaries, version check, capability probe
    args.ts          # pure builders: buildRecordArgs, buildLiveArgs, buildDetectArgs
    process.ts       # child_process supervisor, stderr parsing, restart backoff
    progress.ts      # -progress pipe:1 parsing -> bytes/segment events
  ingest/
    source.ts        # StreamSource -> argv input section (RTSP/RTMP/HTTP/USB/ONVIF/file)
    probe.ts         # ffprobe JSON -> StreamProbe
    supervisor.ts    # per-camera state machine, health checks, exponential backoff
  live/
    transcode.ts     # one encoder per profile, many subscribers
    mse.ts           # fragmented MP4 segmenter
    mjpeg.ts         # JPEG fan-out fallback
  recording/
    segmenter.ts     # split on duration/size, atomic rename, sidecar metadata
    prebuffer.ts     # GOP-aligned ring buffer
    muxer.ts         # mkv/mp4 remux without re-encode
```

## Invariants

- Recording uses `-c copy`; a `copy` profile must never fall back to an encoder
  without raising a loud warning, because that silently multiplies CPU cost.
- Every FFmpeg child is spawned in its own process group and killed with
  `SIGTERM` → grace period → `SIGKILL` on the whole group, so no orphan encoders.
- Segments are written to a `.part` file and renamed on clean close; retention and
  the timeline only ever see finalized files.
- RTSP defaults to TCP (`-rtsp_transport tcp`) because UDP packet loss produces
  corrupt keyframes and unusable motion detection.
