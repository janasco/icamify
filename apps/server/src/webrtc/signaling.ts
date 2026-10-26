import type { CameraConfig, ResolvedIcamifyConfig, Role } from '@icamify/core';
import type { Principal } from '../http/auth.ts';

/**
 * WebRTC signaling.
 *
 * This module owns everything that can be decided without a media stack: SDP
 * validation, per-camera session accounting, the ICE candidate handshake, and
 * the capability answer the UI needs to fall back cleanly. The actual peer
 * connection is a `WebRtcMediaEngine` implementation — plugging one in (for
 * example a `werift` bridge that consumes the same live RTP/bitstream) requires
 * no change here, and until one is registered the service reports exactly why
 * WebRTC is unavailable instead of leaving the player hanging until its
 * `fallbackAfterMs` expires.
 */

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface NegotiateInput {
  camera: CameraConfig;
  offerSdp: string;
  iceServers: IceServerConfig[];
  user: { username: string; role: Role };
}

export interface NegotiateResult {
  answerSdp: string;
  /** Engine-side session id; defaults to the signaling session id. */
  sessionId?: string;
}

/** Media-plane adapter. One implementation the server does not ship yet. */
export interface WebRtcMediaEngine {
  readonly name: string;
  readonly available: boolean;
  /** Set when `available` is false; shown to the operator verbatim. */
  readonly reason?: string;
  negotiate(input: NegotiateInput): Promise<NegotiateResult>;
  addIceCandidate?(sessionId: string, candidate: IceCandidateInit): void | Promise<void>;
  closeSession?(sessionId: string): void;
}

export interface SignalingSession {
  sessionId: string;
  cameraId: string;
  username: string;
  createdAt: number;
  engineSessionId?: string;
  candidates: number;
}

export type OfferResult =
  | { ok: true; sessionId: string; cameraId: string; sdp: string; type: 'answer' }
  | { ok: false; code: 'engine-unavailable' | 'invalid-offer' | 'camera-not-found' | 'camera-disabled' | 'viewer-limit' | 'forbidden' | 'negotiation-failed'; message: string };

export interface SignalingServiceOptions {
  config: ResolvedIcamifyConfig;
  engine?: WebRtcMediaEngine;
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_SDP_BYTES = 128 * 1024;
const SESSION_TTL_MS = 120_000;

export class SignalingService {
  private readonly config: ResolvedIcamifyConfig;
  private readonly engine: WebRtcMediaEngine | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sessions = new Map<string, SignalingSession>();

  constructor(options: SignalingServiceOptions) {
    this.config = options.config;
    this.engine = options.engine;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.config.streaming.webrtc?.enabled !== false;
  }

  get available(): boolean {
    return this.enabled && this.engine?.available === true;
  }

  get reason(): string | undefined {
    if (!this.enabled) return 'WebRTC is disabled in streaming.webrtc.enabled.';
    if (this.engine === undefined) return 'No WebRTC media engine is registered; the console falls back to MSE.';
    if (!this.engine.available) return this.engine.reason ?? 'The WebRTC media engine is not available.';
    return undefined;
  }

  get engineName(): string | undefined {
    return this.engine?.name;
  }

  iceServers(): IceServerConfig[] {
    const configured = this.config.streaming.webrtc?.iceServers;
    if (configured !== undefined && configured.length > 0) return configured;
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  capabilities(): {
    enabled: boolean;
    available: boolean;
    engine?: string;
    reason?: string;
    iceServers: IceServerConfig[];
    fallbackAfterMs: number;
    maxBitrateKbps: number;
    codecPreference: string[];
    maxViewersPerCamera: number;
  } {
    const webrtc = this.config.streaming.webrtc ?? {};
    const result: ReturnType<SignalingService['capabilities']> = {
      enabled: this.enabled,
      available: this.available,
      iceServers: this.iceServers(),
      fallbackAfterMs: webrtc.fallbackAfterMs ?? 4000,
      maxBitrateKbps: webrtc.maxBitrateKbps ?? 4000,
      codecPreference: webrtc.codecPreference ?? ['h264', 'vp8', 'vp9'],
      maxViewersPerCamera: webrtc.maxViewersPerCamera ?? 8,
    };
    const engineName = this.engineName;
    const reason = this.reason;
    if (engineName !== undefined) result.engine = engineName;
    if (reason !== undefined) result.reason = reason;
    return result;
  }

  async offer(input: { cameraId: string; sdp: unknown; principal?: Principal }): Promise<OfferResult> {
    if (!this.available) {
      return { ok: false, code: 'engine-unavailable', message: this.reason ?? 'WebRTC is unavailable.' };
    }
    const invalid = validateOfferSdp(input.sdp);
    if (invalid !== undefined) {
      return { ok: false, code: 'invalid-offer', message: invalid };
    }

    const camera = (this.config.cameras ?? []).find((candidate) => candidate.id === input.cameraId);
    if (camera === undefined) {
      return { ok: false, code: 'camera-not-found', message: `Camera "${input.cameraId}" does not exist.` };
    }
    if (camera.enabled === false) {
      return { ok: false, code: 'camera-disabled', message: `Camera "${input.cameraId}" is disabled.` };
    }
    const principal = input.principal;
    if (principal === undefined) {
      return { ok: false, code: 'forbidden', message: 'Sign in to open a WebRTC session.' };
    }

    this.pruneSessions();
    const active = [...this.sessions.values()].filter((session) => session.cameraId === camera.id).length;
    const limit = this.config.streaming.webrtc?.maxViewersPerCamera ?? 8;
    if (active >= limit) {
      return {
        ok: false,
        code: 'viewer-limit',
        message: `Camera "${camera.name}" already has ${limit} WebRTC viewers.`,
      };
    }

    const sessionId = `rtc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    try {
      const result = await this.engine?.negotiate({
        camera,
        offerSdp: input.sdp as string,
        iceServers: this.iceServers(),
        user: { username: principal.username, role: principal.role },
      });
      if (result === undefined) {
        return { ok: false, code: 'negotiation-failed', message: 'The WebRTC engine returned no answer.' };
      }
      const record: SignalingSession = {
        sessionId,
        cameraId: camera.id,
        username: principal.username,
        createdAt: this.now(),
        candidates: 0,
        ...(result.sessionId === undefined ? {} : { engineSessionId: result.sessionId }),
      };
      this.sessions.set(sessionId, record);
      return { ok: true, sessionId, cameraId: camera.id, sdp: result.answerSdp, type: 'answer' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`webrtc negotiation failed for ${camera.id}: ${message}`);
      return { ok: false, code: 'negotiation-failed', message };
    }
  }

  addCandidate(sessionId: string, candidate: IceCandidateInit): { ok: boolean; message?: string } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, message: 'Unknown WebRTC session.' };
    if (candidate.candidate === undefined && candidate.sdpMid == null && candidate.sdpMLineIndex == null) {
      return { ok: true };
    }
    session.candidates += 1;
    void this.engine?.addIceCandidate?.(session.engineSessionId ?? session.sessionId, candidate);
    return { ok: true };
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    this.engine?.closeSession?.(session.engineSessionId ?? session.sessionId);
  }

  closeForUser(username: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.username === username) this.close(session.sessionId);
    }
  }

  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId);
  }

  sessions_(): SignalingSession[] {
    this.pruneSessions();
    return [...this.sessions.values()];
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) this.close(sessionId);
    }
  }
}

/** Returns a human-readable reason, or undefined when the SDP looks usable. */
export function validateOfferSdp(sdp: unknown): string | undefined {
  if (typeof sdp !== 'string') return 'The offer must be an SDP string.';
  if (sdp.length === 0) return 'The offer is empty.';
  if (Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) return `The offer exceeds ${MAX_SDP_BYTES} bytes.`;
  if (sdp.includes('\0')) return 'The offer contains a NUL byte.';
  const normalized = sdp.replace(/\r\n/g, '\n').trimStart();
  if (!normalized.startsWith('v=0')) return 'The offer is not an SDP document (missing "v=0").';
  if (!/\nm=video\s/.test(`\n${normalized}`)) return 'The offer has no video media section.';
  if (!/\na=ice-ufrag:/.test(`\n${normalized}`)) return 'The offer has no ICE credentials.';
  return undefined;
}
