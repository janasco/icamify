# @icamify/media — FFmpeg pipeline

Owns every interaction with FFmpeg: discovering the binaries, turning a camera and
a profile into an argv, probing sources, supervising child processes and grabbing
snapshots. Node never touches pixel data except the small raw frames produced for
motion detection.

**Phase:** 1 (ingest, probing, supervision) and 3 (segmenting recorder, pre-buffer
ring) done; live fan-out lives in `@icamify/stream` (Phase 2).

## Layout

```
src/
  errors.ts          MediaError taxonomy (toolchain-missing, probe-failed, …)
  types.ts           StreamProbe, MediaPipeline, probe/snapshot options
  plan.ts            config → PipelinePlan; profile, stream and volume selection
  snapshot.ts        one-shot JPEG grab, validates the JPEG magic bytes
  ffmpeg/
    locate.ts        binary discovery, version floor, encoder/filter/muxer table
    args.ts          pure builders: record / live / detect / snapshot / probe
    process.ts       child supervisor, -progress parser, SIGTERM→SIGKILL ladder
  ingest/
    source.ts        StreamSource → demuxer args, credential injection, masking
    probe.ts         ffprobe JSON → StreamProbe with actionable failures
    supervisor.ts    per-camera state machine: backoff, health, restart events
  record/
    paths.ts         hot dir, dated recordings tree, local-time file names
    watcher.ts       segment completion (newer file appeared, or mtime is stale)
    prebuffer.ts     SegmentWindow: overlap lookup, expiry, take
    recorder.ts      CameraRecorder: modes, trigger windows, adopt/drop, status
test/                96 tests (argv, toolchain, plans, supervisor, processes, watcher, recorder)
```

## Recording model

`CameraRecorder` keeps **one** long-lived FFmpeg process per recording camera and
writes 2–10 s segments (motion/alert) or `segmentMinutes`-sized files (continuous)
into `<recordings>/<camera>/.hot`. A `SegmentWatcher` decides a file is complete
when a newer one appears (names are timestamp-ordered) or when its mtime has been
idle for 1.5× the segment length. Complete files are either:

- **adopted** — renamed into `<camera>/<YYYYMMDD>/<HHMMSS>-<reason>.mkv` and handed
  to the caller (which indexes it), or
- **buffered** — kept in `SegmentWindow` as the pre-buffer, until a trigger adopts
  them or the window slides past and they are deleted.

A trigger opens a window from `now − preBufferSeconds` to
`lastTrigger + postRollSeconds`; overlapping buffered segments are adopted
immediately, so the clip contains the seconds before the event. Repeat triggers
(the motion service's once-per-second heartbeat) extend the window without opening
new events. `trigger(kind, at, {holdMs})` lets a rule ask for a longer clip, and an
`alert` trigger during an open motion episode *escalates* it: the window is extended
and every later segment is filed as `reason: alert`.

`captureSnapshot()` accepts a normalized `crop` rectangle (`crop=in_w*…:in_h*…`), so
the AI layer can send a detector only the motion region without probing the source
first.

`mode: 'off'` starts nothing, and `@icamify/media` never imports the index: the
recorder emits `RecordedSegmentInfo` and the server persists it.

## Invariants

- **Recording uses `-c copy`.** A non-copy record profile is allowed but warned
  about loudly, because it silently multiplies CPU cost per camera.
- **One process per job, one job per purpose.** Live view fans out from a single
  encoder; `detect` reads fixed-size raw frames; `record` writes segments.
- **No shell.** Every command is an argv array, so camera names, paths and URLs
  containing spaces or shell metacharacters are safe.
- **No orphan encoders.** Children run in their own process group
  (`detached`), and shutdown escalates: `q` on stdin (when a pipe exists) →
  `SIGTERM` → `SIGKILL`, each with a grace period.
- **Credentials never reach a log.** URL userinfo is injected from config and
  masked by `redactArgv` before anything is printed.
- **RTSP defaults to TCP** (`-rtsp_transport tcp`): UDP loss corrupts keyframes.
- **Storage paths are relative to `storage.rootDir`** unless absolute, and a
  camera assigned to a volume records there (`resolveRecordingsDir`).

## Shutdown behaviour (measured, not assumed)

FFmpeg handles `SIGTERM` between input reads, so stop latency depends on the
source:

| Source | Observed stop | Why |
| ------ | ------------- | --- |
| File, no loop | ~0 ms after `SIGTERM` | handler runs on the next iteration |
| RTSP / live | ms | packets keep arriving; the handler is serviced |
| File with `-stream_loop -1` | not until `SIGKILL` | the loop reopens the input and never returns |

`-stream_loop` is only used for file sources (tests, demo clips), and the
supervisor's ladder guarantees the process still dies. The consequence is that a
forced `SIGKILL` can leave the last Matroska segment without its trailer — which is
exactly why MKV is the default container: the file stays decodable (verified with
FFmpeg 7.0.2: a killed 3s segment still yielded all packets up to the kill),
whereas an MP4 would be unplayable. The recorder additionally treats a segment as
complete only after the muxer has moved on or its mtime has gone stale, and adopts
it with a rename inside the same volume — so an interrupted write is never indexed
as a clip.

## Verification

`icamify doctor` builds every enabled camera's record/live/detect plan without
starting it, then checks the chosen encoders and source protocols against the
detected FFmpeg build — catching "profile asks for nvenc on a CPU-only box" at
boot rather than at 03:00.
