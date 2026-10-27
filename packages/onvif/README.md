# @icamify/onvif — discovery and PTZ

**Phase:** 4b, complete. Dependency-free: a minimal XML parser, SOAP 1.2 envelopes
and a UDP multicast probe, all in `node:` builtins. ONVIF is a SOAP API over HTTP,
so no native module or WSDL stack is needed.

## Layout

```
src/
  xml.ts           # minimal XML parser, entity decoding, escaping
  soap.ts          # envelopes, WS-Security UsernameToken, every request we send
  discovery.ts     # WS-Discovery Probe/ProbeMatches over UDP multicast
  client.ts        # GetDeviceInformation/GetProfiles/GetStreamUri/GetSnapshotUri,
                   # GetPresets/GotoPreset/ContinuousMove/AbsoluteMove/Stop/GetStatus
  errors.ts        # OnvifError with a classified code
  index.ts         # contracts + exports
test/
  xml-soap.test.ts # parser, escaping, envelope construction (18 cases)
  discovery.test.ts# probe parsing, dedupe, subnet expansion
  client.test.ts   # real HTTP fake device: capabilities, presets, digest, timeouts
```

## Behaviour

- **Capabilities first.** Media and PTZ service URLs come from `GetCapabilities`;
  when a device does not answer (or omits XAddrs) the conventional
  `/onvif/media_service` and `/onvif/ptz_service` paths next to the device service
  are used, and only then the endpoints are remembered for the connection.
- **Discovery is explicit.** `discoverDevices()` sends one `Probe` to
  `239.255.255.250:3702` (overridable), collects `ProbeMatches` until the timeout
  and de-duplicates by device URN. `onWarning` reports interfaces that could not be
  bound — a container without multicast is common, and a silent 0 results page is
  worse than a warning.
- **Authentication is negotiated.** A WS-Security `UsernameToken` (with a digest
  password, never the plaintext) travels in the body; a `401` is answered once with
  the challenge the device offers — RFC 7616 `Digest` when present, `Basic`
  otherwise — and the accepted scheme is reused afterwards. Bad credentials become
  `unauthorized`: retried no further, and never logged with the password.
- **Every call is bounded.** `timeoutMs` (default 8000) applies to each request via
  `AbortSignal.timeout`, and a device that accepts the connection but never answers
  is reported as `timeout` rather than hanging a patrol.
- **Errors are classified**, because the server maps them to HTTP: `unreachable`,
  `timeout`, `unauthorized`, `protocol`, `soap-fault`, `unsupported`,
  `invalid-target`. `gotoPreset` names the presets the device *does* have when one
  is missing.

## What this package does not do

Profile G media, event subscriptions, imaging/encoder controls, device
configuration (`SetPreset`, `SetNetworkInterfaces`) and analytics are deliberately
absent: the server records through FFmpeg, and a write API nobody calls would be
surface area with a security cost. Profile S is what the PTZ feature needs.

## Used by

`apps/server/src/onvif/service.ts` decides which endpoint each camera has (explicit
`ptz.host`, an `onvif` source, or the host of an `rtsp` URL), caches one client per
camera, owns patrol timers and pauses them for 60 seconds after any manual move.
The HTTP surface is in `apps/server/src/routes/index.ts` and the console renders it
through `PtzPanel.vue` and `OnvifDiscovery.vue`.

## Verified

`npm test` (24 tests in this package): XML entity handling, envelope and WS-Security
construction, probe parsing and dedupe, and — against a fake device over real HTTP —
capabilities resolution, profile/URI mapping, preset round-trips, digest
verification (`verifyDigest` recomputes the response server-side), plaintext never
appearing in the body, timeouts and unreachable devices. A physical PTZ camera is
still pending hardware.
