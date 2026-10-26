# @icamify/onvif — discovery and PTZ

**Phase:** 4.

## Planned layout

```
src/
  discovery.ts     # WS-Discovery probe, response parsing, dedupe by URN
  soap.ts          # minimal SOAP 1.2 envelope builder/parser (no heavy WSDL stack)
  device.ts        # GetDeviceInformation, GetProfiles, GetStreamUri, GetSnapshotUri
  ptz.ts           # ContinuousMove, AbsoluteMove, Stop, GetPresets, GotoPreset
  patrol.ts        # scheduled preset tours with dwell time
```

## Behaviour

- Discovery runs in the background every `onvif.discovery.intervalSeconds`, on
  the configured subnets (default: every local interface), and publishes results
  over the WebSocket hub so the UI can offer one-click "add camera".
- Credentials come from `onvif.defaults` or the camera entry; they are never
  logged and are redacted from API responses.
- Every SOAP call has a hard timeout (`onvif.defaults.timeoutMs`) and one retry
  on transient connection errors. Cameras that fail authentication are marked
  `unauthorized` rather than retried forever.
- PTZ is available to operators and admins only; viewer accounts get 403.
- Patrols are suspended while a human moves the camera and resume after
  `dwellSeconds` of inactivity.
