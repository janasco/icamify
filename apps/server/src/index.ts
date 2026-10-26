/**
 * iCamify backend entrypoint.
 *
 * Phase 1 ships the configuration foundation and the `icamify` CLI
 * (see ./cli.ts). Phase 2 adds the composition root here: HTTP API, WebSocket
 * hub, WebRTC signaling and the FFmpeg supervisor wired from `loadConfig()`.
 */
export const SERVER_VERSION = '0.1.0';
