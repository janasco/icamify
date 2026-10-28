# Configuration reference

Everything iCamify does is governed by one document: `config/icamify.json`. It
defines the camera matrix, stream profiles, storage quotas, motion zones, AI
providers, schedules, alert rules, layouts and plugins.

- Schema: [`config/icamify.schema.json`](../config/icamify.schema.json)
- Worked example: [`config/icamify.example.json`](../config/icamify.example.json)
- Types: [`packages/core/src/config/types.ts`](../packages/core/src/config/types.ts)

The schema is normative. Editors that understand JSON Schema (VS Code, JetBrains)
will autocomplete and validate as you type because the file starts with
`"$schema": "./icamify.schema.json"`.

---

## 1. File discovery and precedence

The loader looks for, in order:

1. `--config <path>` (CLI) or the `path` argument (API)
2. `$ICAMIFY_CONFIG`
3. `./config/icamify.json`

The shipped example is not loaded implicitly. Start with:

```bash
cp config/icamify.example.json config/icamify.json
node apps/server/src/cli.ts config validate
```

Precedence, lowest to highest:

```
built-in defaults  →  icamify.json  →  ICAMIFY_* env vars  →  programmatic overrides
```

Merge semantics: **objects merge recursively, arrays replace**. Setting
`cameras` replaces the whole list (there are no built-in cameras); setting
`motion.sensitivity` only changes that field. `null` is not used as "delete" —
omit the key instead.

The file is parsed as JSONC: `//` and `/* */` comments and trailing commas are
accepted, so you can annotate a camera matrix without a build step.

---

## 2. Validation

```bash
# human output, exit 1 on errors
node apps/server/src/cli.ts config validate

# machine output for CI / dashboards
node apps/server/src/cli.ts config validate --json

# fully resolved config, secrets masked
node apps/server/src/cli.ts config print

# the schema itself
node apps/server/src/cli.ts config schema --output /tmp/icamify.schema.json
```

Validation runs in three stages:

1. **Schema** — types, enums, ranges, unknown keys, discriminators (`source.type`,
   `provider.type`, `channel.type`). Unknown keys are errors, not ignored.
2. **Environment** — unresolved `${...}` references are errors; `config print`
   masks secret values.
3. **Integrity** — profile/volume/schedule/channel/camera/group references,
   zone mask dimensions, tile bounds, duplicate ids, layout geometry.

Errors always block startup. Warnings (unbounded volume, disabled notification
channel targeted by a rule, placeholder password hash, missing camera password,
weak session secret) are reported and logged but do not block.

---

## 3. Environment and secrets

Any string value may reference the environment:

```json
{
  "password": "${FRONT_DOOR_PASS}",
  "publicUrl": "${PUBLIC_URL:-http://localhost:8060}"
}
```

- `${VAR}` — required. Missing variable → startup error naming the variable and
  the config path.
- `${VAR:-fallback}` — optional with fallback; `${VAR:-}` means empty string.
- Substitution is string-only. A reference inside a numeric field stays a string
  and fails schema validation; use the env overrides below for numbers.

Deployment overrides (validated, applied after the file):

| Variable | Config path |
| -------- | ----------- |
| `ICAMIFY_HOST` | `system.server.host` |
| `ICAMIFY_PORT` | `system.server.port` |
| `ICAMIFY_PUBLIC_URL` | `system.server.publicUrl` |
| `ICAMIFY_LOG_LEVEL` | `system.logging.level` |
| `ICAMIFY_TIMEZONE` | `system.timezone` |
| `ICAMIFY_DATA_DIR` | `storage.rootDir` |

Secret handling:

- Nothing secret needs to live in the config file; `.env.example` lists every
  variable the example config references.
- Keys matching password/secret/token/apiKey/credential/hmac are masked as `***`
  in `config print`, structured logs and API responses. Containers stay visible so
  you can see *that* two channels are configured. Non-secret identifiers that
  merely contain "token" (such as an ONVIF `profileToken`) are left readable.
- Credentials embedded in URLs are masked too: the userinfo in
  `rtsp://user:pass@host/...` and query parameters named token/key/password/secret
  become `***`, even though their key is just `url`.
- `config print --show-secrets` exists for recovery, but avoid it in shared
  terminals and never paste its output into a ticket. Prefer rotating a leaked
  secret over trying to scrub it.

---

## 4. Top-level sections

| Section | Purpose |
| ------- | ------- |
| `system` | Listen address, TLS, logging, timezone, worker pools, API/WS limits |
| `auth` | Users, roles, sessions, API tokens, lockout |
| `storage` | Data directories, volumes, quotas, purge policy, archive targets |
| `streaming` | Named encoding profiles, WebRTC/MSE/HLS/MJPEG, fallback ladder |
| `motion` | Global pixel-motion defaults and zone matrix |
| `cameras` | The camera matrix: sources, dual streams, recording, AI, PTZ, privacy |
| `groups` | Camera groupings for the UI |
| `layouts` | Saved dashboard grids |
| `schedules` | Reusable time windows with exceptions |
| `rules` | Alert-triggered recording, notifications, PTZ, scripts |
| `notifications` | Webhook/email/MQTT/Telegram channels |
| `ai` | Provider registry and detection retention |
| `onvif` | WS-Discovery scanner and PTZ defaults |
| `plugins` | Hot-load directories, trust allowlist, worker limits |

Only `version` is required; everything else has defaults. A minimal valid file:

```json
{ "version": "1.0" }
```

That file starts the app, but with no cameras, users or volumes — validation will
warn you about the missing pieces.

---

## 5. `system`

```json
{
  "system": {
    "server": { "host": "0.0.0.0", "port": 8060, "publicUrl": "https://nvr.example.com", "trustProxy": false },
    "tls": { "enabled": false },
    "logging": { "level": "info", "pretty": false, "maxFileMb": 64, "maxFiles": 5 },
    "timezone": "Europe/Berlin",
    "workers": { "motion": 2, "ai": 2, "thumbnail": 1 },
    "api": {
      "basePath": "/api",
      "corsOrigins": [],
      "rateLimit": { "windowMs": 60000, "max": 600 },
      "websocket": { "path": "/ws", "heartbeatSeconds": 20, "maxClients": 64 }
    },
    "web": { "serveStatic": true, "staticDir": "./apps/web/dist" }
  }
}
```

Notes:

- `publicUrl` is used for WebRTC ICE candidates and absolute links; set it to the
  URL your browser uses. Wrong values cause video that negotiates but never
  connects.
- `trustProxy` must only be enabled behind a reverse proxy you control, because
  it lets `X-Forwarded-*` decide client identity and scheme.
- `workers` bound CPU work; FFmpeg children are separate and not counted here.
- `corsOrigins` must be explicit; `"*"` is rejected.
- `timezone` drives schedules, the timeline axis and filename templates.

---

## 6. `auth`

```json
{
  "auth": {
    "mode": "local",
    "allowAnonymousViewing": false,
    "session": {
      "secret": "${ICAMIFY_SESSION_SECRET}",
      "cookieName": "icamify_session",
      "ttlHours": 24,
      "idleTimeoutMinutes": 120,
      "secureCookie": true,
      "sameSite": "lax"
    },
    "users": [
      { "id": "admin", "username": "admin", "role": "admin", "passwordHash": "$argon2id$..." }
    ],
    "apiTokens": [
      { "id": "ha", "name": "Home Assistant", "tokenHash": "<sha256>", "role": "viewer", "expiresAt": "2027-12-31" }
    ],
    "lockout": { "maxAttempts": 8, "windowMinutes": 15, "blockMinutes": 15 }
  }
}
```

- Roles: `admin` (everything), `operator` (live, PTZ, acknowledge), `viewer`
  (live and playback only).
- `mode: "none"` disables the login screen — only appropriate on a fully trusted
  network.
- `allowAnonymousViewing` allows unauthenticated live streams but never
  recordings, settings or PTZ.
- `session.secret` should be at least 32 random characters and supplied via env.
  If omitted, the server logs a warning and generates a process-local secret, so
  sessions do not survive restarts.
- Password hashes are argon2id. Plaintext passwords are not accepted. Generate one with
  `icamify user hash` (the password is read from stdin, never from argv).
- API tokens are stored as SHA-256 hashes; the plaintext token is shown once by
  the (Phase 2) token-creation flow.

---

## 7. `storage`

```json
{
  "storage": {
    "rootDir": "./data",
    "recordingsDir": "recordings",
    "snapshotsDir": "snapshots",
    "stateDir": "state",
    "tempDir": "tmp",
    "format": "mkv",
    "filenameTemplate": "{cameraId}/{date}/{time}-{reason}.{ext}",
    "segmentMinutes": 15,
    "preBufferSeconds": 5,
    "preBufferMaxMemoryMb": 512,
    "defaultVolume": "nvme",
    "volumes": [
      {
        "id": "nvme",
        "path": "recordings",
        "maxSizeGb": 500,
        "maxAgeHours": 168,
        "minFreeDiskGb": 10,
        "priority": 10,
        "cameraIds": ["front-door", "driveway"],
        "archive": { "enabled": true, "providerId": "cold-s3", "afterHours": 24, "keepLocalDays": 7 }
      }
    ],
    "purge": { "enabled": true, "intervalSeconds": 300, "strategy": "oldest-first", "batchSize": 50, "dryRun": false, "protectFlagged": true },
    "archiveProviders": [
      {
        "id": "cold-s3",
        "type": "s3",
        "bucket": "${ARCHIVE_S3_BUCKET}",
        "accessKeyId": "${ARCHIVE_S3_ACCESS_KEY}",
        "secretAccessKey": "${ARCHIVE_S3_SECRET_KEY}",
        "storageClass": "STANDARD_IA"
      }
    ]
  }
}
```

Volume resolution: a camera records to the volume whose `cameraIds` includes it;
volumes without `cameraIds` accept any camera. If no volume matches, validation
fails with `no-volume-for-camera` rather than silently dropping recordings.

Limits:

| Field | Effect |
| ----- | ------ |
| `maxSizeGb` | Delete per strategy while the volume exceeds this size |
| `maxAgeHours` | Delete segments older than this |
| `minFreeDiskGb` | Emergency floor; wins over age and size |
| `priority` | Lower fills first and purges last |

Both `maxSizeGb` and `maxAgeHours` are optional, but omitting both produces an
`unbounded-volume` warning: the volume grows until the disk fills.

`filenameTemplate` supports `{cameraId}`, `{cameraName}`, `{date}`, `{time}`,
`{reason}` (continuous/motion/alert/scheduled/manual) and `{ext}`.

`preBufferSeconds` is the global pre-roll depth (0–30s); cameras can override.
Memory cost is roughly bitrate × seconds × cameras — see
`preBufferMaxMemoryMb` before setting 30s on ten 4K cameras.

Archive provider types: `s3` (any S3-compatible endpoint, `forcePathStyle` for
MinIO), `sftp`, `local` (a second mount/NAS path).

---

## 8. `streaming`

Profiles are the only place codecs and bitrates exist; cameras reference them by
name.

```json
{
  "streaming": {
    "profiles": {
      "record-main": { "copy": true, "video": { "codec": "copy" }, "audio": { "codec": "copy" }, "container": "mkv" },
      "live-sub": {
        "purpose": "live",
        "video": { "codec": "h264", "width": 640, "height": 360, "fps": 15, "bitrateKbps": 700,
                   "gopSeconds": 1, "preset": "veryfast", "bframes": 0 },
        "audio": { "codec": "opus", "bitrateKbps": 32 },
        "container": "fmp4",
        "latency": "low"
      },
      "detect-sub": {
        "purpose": "detect",
        "video": { "codec": "h264", "width": 320, "height": 180, "fps": 5, "bitrateKbps": 200 },
        "audio": { "codec": "none" },
        "container": "mpegts"
      }
    },
    "defaults": { "record": "record-main", "live": "live-sub", "detect": "detect-sub" },
    "webrtc": {
      "enabled": true,
      "iceServers": [{ "urls": ["stun:stun.l.google.com:19302"] }],
      "portRange": { "min": 40000, "max": 40099 },
      "publicIp": "${WEBRTC_PUBLIC_IP:-}",
      "codecPreference": ["h264", "vp8", "vp9"],
      "maxBitrateKbps": 4000,
      "maxViewersPerCamera": 4,
      "fallbackAfterMs": 4000
    },
    "mse": { "enabled": true, "segmentDurationMs": 1000, "windowSegments": 8 },
    "hls": { "enabled": false },
    "mjpeg": { "enabled": true, "fps": 5, "width": 640, "quality": 70 },
    "fallbackChain": ["webrtc", "mse", "mjpeg"],
    "onDemandStart": true
  }
}
```

| Concept | Meaning |
| ------- | ------- |
| `copy: true` | Remux the camera stream unchanged (`-c copy`). ~0% CPU, required for direct-to-disk. |
| `purpose` | Documentation/lint hint only; any profile can fill any role |
| `gopSeconds` | Keyframe interval. Keep ≤1s for low-latency WebRTC and clean segment boundaries |
| `latency: low` | Drops B-frames, small muxer buffers |
| `fallbackChain` | Order the browser tries: WebRTC → MSE → HLS → MJPEG |
| `onDemandStart` | Live encoders start when the first viewer connects and stop after the last one leaves |
| `webrtc.publicIp` | NAT address advertised in ICE candidates. Without it a viewer outside the LAN cannot reach the media ports and falls back to MSE |
| `webrtc.portRange` | UDP range for ICE (`min`/`max` must differ). Forward the same range on the router |
| `webrtc.iceServers` | STUN or TURN; needed on both sides when the viewer is behind carrier-grade NAT |
| `webrtc.maxViewersPerCamera` | Cap on simultaneous WebRTC viewers per camera |
| `webrtc.fallbackAfterMs` | How long the tile negotiates before switching to MSE |

WebRTC carries H.264 only. A live profile whose codec is `h264` (or `copy`) is
passed through unchanged, so WebRTC costs what the camera costs; a `h265`, `vp9`,
`av1` or `mjpeg` profile is re-encoded to H.264 for WebRTC viewers, which adds a
decoder and an encoder per camera. Parameter sets are re-inserted before every
keyframe (`h264_mp4toannexb`), because a copy of an MP4/RTSP stream otherwise
carries them only in container metadata and a late joiner never decodes a frame.

`werift` is an optional dependency. `npm install --omit=optional` leaves the
server working: `/api/system` reports `features.webrtc: false` with a reason and
the ladder skips straight to MSE.

Avoid `copy` profiles for the live grid unless the camera already emits
browser-friendly H.264 in a supported container; the browser cannot play every
camera's raw stream.

---

## 9. `motion` and zone masks

```json
{
  "motion": {
    "enabled": true,
    "intervalMs": 200,
    "sensitivity": 60,
    "minBlobPercent": 0.2,
    "blurRadius": 2,
    "grayscale": true,
    "denoise": 1,
    "zones": {
      "cols": 8,
      "rows": 8,
      "cells": "00000000/00000000/11111111/11111111/11111111/11111111/00000000/00000000",
      "mode": "include"
    },
    "cooldownSeconds": 10,
    "warmupFrames": 10,
    "postMotionSeconds": 10
  }
}
```

The zone matrix is a painted grid: one row per line, one character per cell,
`1` = active, `0` = ignored, rows separated by `/`. Dimensions must match
`cols` × `rows` or validation fails (`mask-rows` / `mask-cols`). `mode: exclude`
inverts the interpretation.

Thresholds:

- `sensitivity` (1–100) is the dial. If `threshold` and `percentThreshold` are
  omitted, iCamify interpolates: 1 → threshold 60 / 5%, 50 → 34 / 2.62%,
  100 → 8 / 0.2%.
- Explicit `threshold` / `percentThreshold` always win.
- `minBlobPercent` drops isolated changed pixels (sensor noise).
- `colorFilter` restricts contributing hues (e.g. suppress a green tree line).

Camera-level `motion` merges field-by-field over the global block:

```json
"motion": { "sensitivity": 75 }
```

If a camera supplies `zones`, it should supply all three zone fields; a partial
zone block inherits the global dimensions and is likely to fail dimension checks.

---

## 10. `cameras`

```json
{
  "id": "front-door",
  "name": "Front Door",
  "description": "PTZ dome above the porch",
  "enabled": true,
  "groupIds": ["outdoor"],
  "tags": ["entrance", "ptz"],
  "streams": {
    "main": {
      "type": "onvif",
      "host": "192.168.1.21",
      "port": 80,
      "credentials": { "username": "${FRONT_DOOR_USER}", "password": "${FRONT_DOOR_PASS}" },
      "profileToken": "profile_main"
    },
    "sub": {
      "type": "rtsp",
      "url": "rtsp://192.168.1.21:554/stream2",
      "transport": "tcp",
      "credentials": { "username": "${FRONT_DOOR_USER}", "password": "${FRONT_DOOR_PASS}" }
    }
  },
  "profiles": { "record": "record-main", "live": "live-sub", "detect": "detect-sub" },
  "recording": { "enabled": true, "mode": "motion", "preBufferSeconds": 8, "postRollSeconds": 15, "segmentMinutes": 10 },
  "ai": { "enabled": true, "providerId": "codeproject-objects", "labels": ["person", "package"], "minConfidence": 0.55, "intervalMs": 750 },
  "ptz": {
    "enabled": true,
    "presets": [{ "name": "gate", "pan": -0.6, "tilt": -0.1, "zoom": 0.4 }],
    "patrol": { "enabled": true, "presets": ["gate", "porch"], "dwellSeconds": 20, "scheduleIds": ["nights"] }
  },
  "privacyMasks": [{ "x": 0, "y": 0, "width": 0.18, "height": 0.14, "label": "Neighbour window" }],
  "health": { "probeIntervalSeconds": 30, "offlineAfterFailures": 3, "restartBackoffSeconds": 5, "maxBackoffSeconds": 300 },
  "ui": { "order": 10 }
}
```

### Source types

| `type` | Required | Notes |
| ------ | -------- | ----- |
| `rtsp` | `url` | `transport` defaults to `tcp` (UDP loss corrupts keyframes) |
| `rtmp` | `url` | `live: true` for push feeds, false to read a file |
| `http` | `url` | `format` auto/mjpeg/h264/h265; `auth` none/basic/digest; optional `snapshotUrl` |
| `onvif` | `host` | Resolves the RTSP URI over ONVIF; also enables PTZ discovery |
| `usb` | `device` | `inputFormat` v4l2/dshow/avfoundation, resolution, fps |
| `file` | `path` | `loop`, `realtime` for lab/replay sources |

### Dual stream

`streams.main` is the high-resolution recording source. `streams.sub` is the
small stream for the grid and motion detection. Omitting `sub` makes iCamify
derive one with FFmpeg (correct, but costs a decode per camera — always prefer
the camera's native sub-stream).

### Recording modes

| `mode` | Behaviour |
| ------ | --------- |
| `off` | No recording |
| `continuous` | Always recording, split every `segmentMinutes` |
| `motion` | Record while motion is active, with pre-roll and post-roll |
| `alert` | Record only when a rule fires a `record` action |
| `scheduled` | Record inside `scheduleIds` windows; requires at least one schedule |

`preBufferSeconds` replays the GOP cache into the clip so the event is not cut
off. `postRollSeconds` extends the clip after motion stops. `maxFileSizeMb`
forces a split before a size cap (FAT/exFAT targets).

### AI

`ai.enabled` on a camera requires `ai.providers[]` to contain `providerId`.
`labels` gates which detections become events; an empty list means every label
(validation warns). `cropToMotion` sends only the motion region, which is faster
and more accurate. `intervalMs` protects a slow detector from a backlog.

### PTZ

`pan`/`tilt` are −1..1, `zoom` is 0..1. Use `token` for presets that already
exist on the device. Patrols reference preset names and optionally schedules;
referencing an unknown preset is a validation error.

The ONVIF service endpoint is resolved in this order: an explicit `ptz.host`, the
host of an `onvif` main stream, then the host of an `rtsp` URL (ONVIF is HTTP, so
that case uses port 80 — set `ptz.port` when the device listens elsewhere).
`onvif.defaults` supplies shared credentials when the source has none.

At runtime a preset is visited by `token` (GotoPreset), else by
`pan`/`tilt`/`zoom` (AbsoluteMove), else by name against the presets the camera
itself reports. `ptz.patrol` starts a tour with the process: each preset is visited
after `dwellSeconds` (minimum 5), in order or at random, and only inside
`scheduleIds` when given. Any manual move from the console pauses the tour for 60
seconds, so an operator can look at something without fighting the patroller.

### Privacy masks

Normalized rectangles (`0..1`) blacked out in live views and snapshots.
`x + width` and `y + height` must stay ≤ 1.

A `copy` (remux) recording profile cannot burn a mask into the recorded video.
If recordings must be masked, give the camera a transcoding record profile —
and accept the CPU cost that direct-to-disk otherwise avoids.

---

## 11. `groups` and `layouts`

```json
{
  "groups": [{ "id": "outdoor", "name": "Outdoor", "order": 10 }],
  "layouts": [
    {
      "id": "overview",
      "name": "Overview",
      "isDefault": true,
      "columns": 2,
      "rows": 2,
      "autoFill": true,
      "tiles": [{ "cameraId": "front-door", "x": 0, "y": 0, "width": 1, "height": 1, "stream": "sub", "muted": true }]
    }
  ]
}
```

Tiles use grid cells, not pixels, so a layout survives any screen size. `x/y` are
the top-left cell; `width/height` the span. Tiles outside the grid are errors;
overlaps are warnings. `autoFill` fills empty cells with the next enabled cameras
by `ui.order`. At most one layout may be `isDefault`.

---

## 12. `schedules`

```json
{
  "schedules": [
    {
      "id": "work-hours",
      "name": "Work hours",
      "timezone": "Europe/Berlin",
      "windows": [
        { "days": ["mon", "tue", "wed", "thu", "fri"], "start": "08:00", "end": "18:00" },
        { "days": ["sat"], "start": "09:00", "end": "13:00" }
      ],
      "exceptions": [{ "date": "2026-12-24", "closed": true }]
    }
  ]
}
```

- `end` earlier than `start` means the window crosses midnight.
- `start == end` is rejected as ambiguous.
- `exceptions` close a day (`closed: true`) or reopen a holiday (`false`).
- Times are local to the schedule's timezone (defaults to `system.timezone`).

---

## 13. `ai`

```json
{
  "ai": {
    "enabled": true,
    "defaultProviderId": "codeproject-objects",
    "storeDetectionsDays": 30,
    "maxDetectionsPerFrame": 50,
    "providers": [
      {
        "id": "codeproject-objects",
        "name": "CodeProject.AI",
        "type": "codeproject-ai",
        "url": "${CODEPROJECT_AI_URL:-http://127.0.0.1:32168}",
        "endpoint": "/v1/vision/detection",
        "capabilities": ["object"],
        "timeoutMs": 8000,
        "concurrency": 2
      },
      {
        "id": "lpr-agent",
        "name": "LPR agent",
        "type": "generic-http",
        "url": "http://127.0.0.1:8080/detect",
        "contentType": "json",
        "requestTemplate": "{\"image\":\"{{image}}\",\"min_confidence\":{{minConfidence}}}",
        "response": {
          "detectionsPath": "results",
          "labelPath": "plate",
          "confidencePath": "score",
          "box": { "x": "bbox.x1", "y": "bbox.y1", "width": "bbox.w", "height": "bbox.h" }
        },
        "capabilities": ["lpr", "object"]
      }
    ]
  }
}
```

| `type` | Use |
| ------ | --- |
| `codeproject-ai` | CodeProject.AI Server, `POST {url}{endpoint}` |
| `deepstack` | DeepStack, `mode` object/face/scene/lpr |
| `generic-http` | Any service; response mapped with dot paths, optional base64 template |
| `plugin` | Hot-loaded provider (see `plugins/`) |

`capabilities` tells the gateway which tasks a provider can serve. A plugin
provider must also appear in `plugins.trustedPlugins`; otherwise validation warns
and the provider is not loaded.

---

## 14. `rules` and `notifications`

```json
{
  "rules": [
    {
      "id": "person-at-night",
      "name": "Person at night",
      "enabled": true,
      "priority": 10,
      "when": {
        "cameraIds": ["front-door", "driveway"],
        "events": ["ai.object"],
        "ai": { "labels": ["person"], "minConfidence": 0.6 },
        "outsideScheduleIds": ["work-hours"],
        "cooldownSeconds": 120
      },
      "then": {
        "record": { "enabled": true, "seconds": 45, "profile": "record-main" },
        "snapshot": { "enabled": true, "annotate": true },
        "notify": {
          "channels": ["telegram-alerts"],
          "severity": "critical",
          "title": "Person detected",
          "message": "{cameraName}: {label} ({confidence}%) at {time}",
          "attachSnapshot": true
        },
        "ptz": { "cameraId": "front-door", "preset": "gate" }
      }
    }
  ],
  "notifications": {
    "dedupeSeconds": 30,
    "channels": [
      { "id": "telegram-alerts", "name": "Telegram", "type": "telegram", "botToken": "${TELEGRAM_BOT_TOKEN}", "chatId": "${TELEGRAM_CHAT_ID}" }
    ]
  }
}
```

Conditions are ANDed. Empty `cameraIds` / `events` mean "any". `events` values:
`motion`, `ai.object`, `ai.face`, `ai.lpr`, `camera.online`, `camera.offline`,
`storage.warning`, `storage.critical`.

Actions: `record`, `snapshot`, `notify`, `ptz`, `script`, `markEvent`. Rules run
in ascending `priority`; `cooldownSeconds` is enforced per rule per camera.
Message placeholders: `{cameraName}`, `{label}`, `{confidence}`, `{time}` (and
`{cameraId}`). Notification channels: `webhook` (optional HMAC-SHA256 signature),
`email` (SMTP with STARTTLS or implicit TLS), `mqtt` (QoS 0/1/2, optional Home
Assistant discovery), `telegram` (`sendMessage`, or `sendPhoto` when the rule sets
`notify.attachSnapshot`).

### Script actions

`then.script` is gated by the `scripts` section. It is **disabled by default**:

```json
{
  "scripts": {
    "enabled": false,
    "directories": ["./data/scripts"],
    "timeoutSeconds": 10,
    "maxOutputBytes": 4096,
    "maxConcurrent": 2,
    "environment": { "ICAMIFY_LOG_LEVEL": "info" }
  }
}
```

With `enabled: true`, a script path must resolve (after symlinks) inside one of
`directories`, otherwise the rule outcome reports why it was refused. The process
is spawned without a shell — so `args` entries are argv values, never shell text —
and `{placeholder}` tokens in `args` are substituted from the event. The event is
also exported as `ICAMIFY_RULE_ID`, `ICAMIFY_RULE_NAME`, `ICAMIFY_CAMERA_ID`,
`ICAMIFY_CAMERA_NAME`, `ICAMIFY_EVENT_KIND`, `ICAMIFY_EVENT_TIME`,
`ICAMIFY_SEVERITY`, `ICAMIFY_TITLE`, `ICAMIFY_MESSAGE`, and, when present,
`ICAMIFY_LABEL`, `ICAMIFY_CONFIDENCE`, `ICAMIFY_SNAPSHOT` and `ICAMIFY_EVENT_ID`.
Runs are killed as a process group at `timeoutSeconds` (or the rule's override),
output is capped at `maxOutputBytes`, and `maxConcurrent` bounds the fleet.

---

## 15. `onvif` and `plugins`

```json
{
  "onvif": {
    "discovery": {
      "enabled": true,
      "intervalSeconds": 300,
      "multicastAddress": "239.255.255.250",
      "multicastPort": 3702,
      "subnets": ["192.168.1.0/24"],
      "timeoutMs": 3000
    },
    "defaults": { "username": "${ONVIF_USER}", "password": "${ONVIF_PASS}", "timeoutMs": 5000 },
    "ptz": { "continuousMoveMs": 400, "defaultSpeed": 0.5 }
  },
  "plugins": {
    "enabled": true,
    "directories": ["./plugins", "./data/plugins"],
    "trustedPlugins": ["yolo-custom-plugin"],
    "timeoutMs": 15000,
    "workerMemoryMb": 256
  }
}
```

Discovery uses WS-Discovery multicast; `subnets: []` derives probe ranges from
local interfaces. Plugins load in worker threads, only when their id is listed in
`trustedPlugins` (secure default: empty = load nothing). A worker thread isolates
crashes and memory, not malicious code — install only plugins you trust.

---

## 16. Recipes

### Add an ONVIF PTZ camera

```json
{
  "id": "gate",
  "name": "Gate",
  "streams": {
    "main": {
      "type": "onvif",
      "host": "192.168.1.30",
      "credentials": { "username": "admin", "password": "${GATE_PASS}" }
    }
  },
  "ptz": {
    "enabled": true,
    "presets": [{ "name": "entry", "pan": 0, "tilt": 0, "zoom": 0.3 }]
  },
  "recording": { "mode": "motion" }
}
```

Then add a volume that accepts `gate` (or omit `cameraIds` on your default
volume) and validate. Reachability is easy to confirm from the console: **Discover**
lists ONVIF devices on the subnet and prints the RTSP URI, profiles and preset
names of the one you select, and the tile's PTZ button only appears for cameras
the server resolved an endpoint for.

### Keep 30 days of continuous recording and archive older footage

```json
{
  "storage": {
    "defaultVolume": "bulk",
    "volumes": [
      {
        "id": "bulk",
        "path": "/mnt/recordings",
        "maxAgeHours": 720,
        "minFreeDiskGb": 20,
        "archive": { "enabled": true, "providerId": "cold", "afterHours": 48, "keepLocalDays": 7 }
      }
    ],
    "archiveProviders": [{ "id": "cold", "type": "s3", "bucket": "my-nvr-archive", "region": "eu-central-1" }]
  }
}
```

What that configuration actually does, every `storage.purge.intervalSeconds`:

1. clips older than `archive.afterHours` (48 h) are uploaded under
   `camera/YYYY-MM-DD/file`, then the local copy is kept for `keepLocalDays` (7 d);
2. anything older than `maxAgeHours` (720 h) is archived if it was not already, then
   deleted;
3. the volume is slimmed to `maxSizeGb` if one is set, in batches, stopping as soon
   as it is under quota;
4. if free space is below `minFreeDiskGb` (20 GB), the oldest unprotected clips go
   until the floor is met.

A starred clip is never deleted (`purge.protectFlagged`, default true). If an upload
fails, the local file is kept and the error is reported — retention would rather
exceed quota than lose footage. `purge.dryRun` reports the same plan without
touching anything, and the Storage panel's **Run retention sweep** does the same on
demand.

Archive target notes:

- `local` copies into a directory (verify the mount is present at boot; a missing
  mount shows as an `error` on the volume, and nothing is deleted).
- `s3` works with AWS and S3-compatible endpoints; set `endpoint` and
  `forcePathStyle` for MinIO/Ceph, and put `accessKeyId`/`secretAccessKey` behind
  `${ENV}` references.
- `sftp` uses the OpenSSH client in batch mode, so it needs `privateKeyPath` (or a
  key the ssh agent knows). A `password`-only provider is refused with that
  explanation instead of silently archiving nothing.

Detection history follows the same clock: `ai.storeDetectionsDays` removes event
rows older than that, then unlinks snapshots older than the same cutoff that no
surviving event references.

### Alert only on people, only at night

Use the example's `person-at-night` rule: `events: ["ai.object"]`,
`ai.labels: ["person"]`, `outsideScheduleIds: ["work-hours"]`, and a Telegram
channel. Give the camera an AI provider with `capabilities: ["object"]`.

### Ignore a swaying tree

Paint the tree cells as `0` and keep the walkway as `1`:

```json
"motion": {
  "zones": { "cols": 8, "rows": 8, "cells": "11110000/11110000/11110000/11110000/11110000/11110000/11110000/11110000" }
}
```

Use `sensitivity` first; only mask when geometry cannot solve it.

### Docker-hosted AI on another machine

```json
"ai": {
  "providers": [{
    "id": "remote-ai",
    "name": "CodeProject.AI (NAS)",
    "type": "codeproject-ai",
    "url": "http://192.168.1.50:32168",
    "apiKey": "${CODEPROJECT_AI_KEY:-}",
    "capabilities": ["object"],
    "timeoutMs": 6000
  }]
}
```

Network AI adds latency; keep `timeoutMs` well under the motion clip length.

---

## 17. Versioning and migration

`version` is the document contract version and must be `"1.0"` today. Older
documents are migrated in `load.ts` before validation; unknown newer versions
fail loudly rather than being partially understood.

When the schema changes, update together:

1. `config/icamify.schema.json`
2. `packages/core/src/config/types.ts`
3. `packages/core/src/config/defaults.ts` (if a default applies)
4. `config/icamify.example.json` — it must stay valid
5. `packages/core/test/config.test.ts` — add a failing case for the new rule

`npm run check` (typecheck + 95 tests) is the gate; `icamify doctor` additionally
checks the configuration against the installed FFmpeg build (encoders, protocol
support, storage paths) before a single camera is started.
