import type { CameraConfig, Role } from '@icamify/core';
import { inspectH264Payload, RtpContinuity } from './rtp.ts';
import { answerCodecFor, describeUnsupportedOffer, parseMediaSections, selectH264 } from './sdp.ts';

/**
 * WebRTC media engine.
 *
 * The server's signaling layer owns authentication, limits and session accounting;
 * this engine owns the media plane. One peer connection per viewer, one FFmpeg
 * source per camera: the same design rule as the MSE path, because ten viewers of
 * one camera must never mean ten decoders.
 *
 * The transport stack (ICE, DTLS-SRTP) comes from `werift`, which is an *optional*
 * dependency and is loaded through a dynamic import. A deployment that installs
 * with `--omit=optional` still runs: signaling reports `available: false` with the
 * reason, and the console falls back to MSE exactly as it does today.
 *
 * Media flow:
 *
 *   camera ──RTSP──▶ FFmpeg ──RTP/UDP(loopback)──▶ RtpContinuity ──▶ every peer's
 *                                                                    H.264 track
 *
 * FFmpeg does the packetisation, so the payload is never parsed here — only the
 * header is rewritten to keep sequence numbers and timestamps monotonic across
 * pipeline restarts.
 */

// ---------------------------------------------------------------------------
// Minimal structural view of werift, so the package typechecks when it is absent.
// ---------------------------------------------------------------------------

interface WeriftTrack {
  writeRtp(packet: Buffer): void;
  stop(): void;
}

interface WeriftTransceiver {
  readonly sender: { replaceTrack?(track: WeriftTrack): Promise<void> | void };
}

interface WeriftEvent<T> {
  subscribe(listener: (value: T) => void): () => void;
}

type WeriftConnectionState = 'closed' | 'disconnected' | 'new' | 'connected' | 'failed' | 'connecting';
type WeriftGatheringState = 'complete' | 'new' | 'gathering';

interface WeriftPeerConnection {
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(description: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  addTransceiver(kindOrTrack: WeriftTrack | 'video', options?: { direction?: string }): WeriftTransceiver;
  close(): Promise<void> | void;
  readonly localDescription: { type: string; sdp: string } | undefined;
  readonly iceGatheringState: WeriftGatheringState;
  readonly connectionState: WeriftConnectionState;
  readonly iceGatheringStateChange: WeriftEvent<WeriftGatheringState>;
  readonly connectionStateChange: WeriftEvent<WeriftConnectionState>;
}

interface WeriftModule {
  RTCPeerConnection: new (config?: unknown) => WeriftPeerConnection;
  RTCRtpCodecParameters: new (init: unknown) => unknown;
  MediaStreamTrack: new (init: { kind: string }) => WeriftTrack;
}

// ---------------------------------------------------------------------------
// Contracts shared with the server
// ---------------------------------------------------------------------------

export interface IceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface RtpSourceHandlers {
  onPacket(packet: Buffer): void;
  /** Non-fatal source problem (FFmpeg stderr, a restart) for the UI banner. */
  onError?(message: string): void;
}

/** One FFmpeg pipeline per camera, emitting RTP to the engine. */
export interface RtpSource {
  readonly argv?: readonly string[];
  start(handlers: RtpSourceHandlers): void;
  stop(): Promise<void>;
}

export interface RtpSourceContext {
  cameraId: string;
  camera: CameraConfig;
}

export interface NegotiateInputLike {
  camera: CameraConfig;
  offerSdp: string;
  iceServers: IceServerLike[];
  user: { username: string; role: Role };
}

export interface NegotiateResultLike {
  answerSdp: string;
  sessionId?: string;
}

export interface WebRtcEngineStats {
  sessions: Array<{
    sessionId: string;
    cameraId: string;
    user: string;
    createdAt: number;
    state: string;
    packets: number;
    bytes: number;
    keyframeSeen: boolean;
  }>;
  sources: Array<{
    cameraId: string;
    viewers: number;
    startedAt?: number;
    packets: number;
    bytes: number;
    discontinuities: number;
    dropped: number;
    lastError?: string;
    argv?: readonly string[];
  }>;
}

export interface WebRtcEngine {
  readonly name: string;
  readonly available: boolean;
  readonly reason?: string;
  negotiate(input: NegotiateInputLike): Promise<NegotiateResultLike>;
  addIceCandidate(sessionId: string, candidate: IceCandidateLike): void;
  closeSession(sessionId: string): void;
  stats(): WebRtcEngineStats;
  shutdown(): Promise<void>;
}

export interface WebRtcEngineOptions {
  createSource: (context: RtpSourceContext) => RtpSource;
  iceServers?: IceServerLike[];
  /** Address advertised in ICE candidates behind NAT (1:1 NAT or port forward). */
  publicIp?: string;
  portRange?: { min?: number; max?: number };
  /** How long ICE gathering may take before the answer goes out without it. */
  gatherTimeoutMs?: number;
  /** How long a camera pipeline is kept alive after its last viewer leaves. */
  sourceIdleMs?: number;
  /** Payload type used on the wire between FFmpeg and the engine. */
  payloadType?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Test seam: injects the transport stack (or undefined to simulate absence). */
  loadWerift?: () => Promise<WeriftModule | undefined>;
}

interface MediaSourceState {
  cameraId: string;
  source: RtpSource;
  continuity: RtpContinuity;
  subscribers: Set<SessionState>;
  startedAt?: number;
  idleTimer?: NodeJS.Timeout;
  lastError?: string;
}

interface SessionState {
  sessionId: string;
  cameraId: string;
  user: string;
  createdAt: number;
  pc: WeriftPeerConnection;
  track: WeriftTrack;
  state: string;
  packets: number;
  bytes: number;
  keyframeSeen: boolean;
  closed: boolean;
}

const DEFAULT_PAYLOAD_TYPE = 102;
const DEFAULT_GATHER_TIMEOUT_MS = 3000;
const DEFAULT_SOURCE_IDLE_MS = 5000;

export async function createWebRtcEngine(options: WebRtcEngineOptions): Promise<WebRtcEngine> {
  const load = options.loadWerift ?? (() => importWerift());
  let werift: WeriftModule | undefined;
  let reason: string | undefined;
  try {
    werift = await load();
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    werift = undefined;
  }
  if (werift === undefined) {
    return new UnavailableEngine(
      reason ??
        'The "werift" package is not installed; install it (it is an optional dependency) or keep the MSE transport.',
    );
  }
  return new WeriftEngine(werift, options);
}

async function importWerift(): Promise<WeriftModule | undefined> {
  try {
    const loaded = (await import('werift')) as unknown as Partial<WeriftModule>;
    if (typeof loaded.RTCPeerConnection !== 'function') return undefined;
    if (typeof loaded.MediaStreamTrack !== 'function') return undefined;
    return loaded as WeriftModule;
  } catch {
    // Optional dependency: absent is a supported state, not a crash.
    return undefined;
  }
}

/** Reports why WebRTC cannot run, in the words the operator sees in the console. */
class UnavailableEngine implements WebRtcEngine {
  readonly name = 'werift';
  readonly available = false;
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async negotiate(): Promise<NegotiateResultLike> {
    throw new Error(this.reason);
  }

  addIceCandidate(): void {
    // No session can exist while the engine is unavailable.
  }

  closeSession(): void {
    // Nothing to close.
  }

  stats(): WebRtcEngineStats {
    return { sessions: [], sources: [] };
  }

  async shutdown(): Promise<void> {
    // Nothing to shut down.
  }
}

class WeriftEngine implements WebRtcEngine {
  readonly name = 'werift';
  readonly available = true;

  private readonly werift: WeriftModule;
  private readonly options: WebRtcEngineOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sources = new Map<string, MediaSourceState>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private sequence = 0;
  private shuttingDown = false;

  constructor(werift: WeriftModule, options: WebRtcEngineOptions) {
    this.werift = werift;
    this.options = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  async negotiate(input: NegotiateInputLike): Promise<NegotiateResultLike> {
    if (this.shuttingDown) throw new Error('The WebRTC engine is shutting down.');

    const sections = parseMediaSections(input.offerSdp);
    const video = sections.find((section) => section.kind === 'video');
    if (video === undefined) throw new Error('The offer has no video section.');
    const selection = selectH264(video);
    if (selection === undefined) throw new Error(describeUnsupportedOffer(sections));
    const codec = answerCodecFor(selection);

    const source = this.ensureSource(input.camera);
    this.sequence += 1;
    const sessionId = `rtc${this.sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const peerConfig: Record<string, unknown> = {
      codecs: {
        video: [
          new this.werift.RTCRtpCodecParameters({
            mimeType: codec.mimeType,
            clockRate: codec.clockRate,
            payloadType: codec.payloadType,
            ...(codec.parameters === undefined ? {} : { parameters: codec.parameters }),
          }),
        ],
      },
    };
    const iceServers = toWeriftIceServers(input.iceServers);
    if (iceServers.length > 0) peerConfig.iceServers = iceServers;
    const portRange = this.portRange();
    if (portRange !== undefined) peerConfig.icePortRange = portRange;
    if (this.options.publicIp !== undefined && this.options.publicIp.length > 0) {
      // Advertising the NAT address is what makes a camera reachable from outside
      // the LAN without deploying a TURN server.
      peerConfig.iceAdditionalHostAddresses = [this.options.publicIp];
    }

    const pc = new this.werift.RTCPeerConnection(peerConfig);
    const track = new this.werift.MediaStreamTrack({ kind: 'video' });
    // The sendonly transceiver must exist before the offer is applied, otherwise
    // the answer grows a second video section and the browser rejects the track.
    pc.addTransceiver(track, { direction: 'sendonly' });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: input.offerSdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc, this.options.gatherTimeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS);
    } catch (error) {
      closePeer(pc);
      throw error instanceof Error ? error : new Error(String(error));
    }

    const answerSdp = pc.localDescription?.sdp;
    if (answerSdp === undefined || !/a=rtpmap:/i.test(answerSdp)) {
      closePeer(pc);
      throw new Error('The WebRTC engine produced no answer SDP.');
    }

    const session: SessionState = {
      sessionId,
      cameraId: input.camera.id,
      user: input.user.username,
      createdAt: this.now(),
      pc,
      track,
      state: pc.connectionState,
      packets: 0,
      bytes: 0,
      keyframeSeen: false,
      closed: false,
    };
    this.sessions.set(sessionId, session);
    source.subscribers.add(session);
    clearIdle(source);

    pc.connectionStateChange.subscribe((state) => {
      session.state = state;
      if (state === 'failed' || state === 'closed') {
        this.log(`webrtc session ${sessionId} (${session.cameraId}) ${state}`);
        this.closeSession(sessionId);
      }
    });

    this.log(
      `webrtc session ${sessionId} for ${input.camera.id} (${input.user.username}, pt ${codec.payloadType}, ${codec.fmtp['profile-level-id'] ?? 'profile unknown'})`,
    );
    return { answerSdp, sessionId };
  }

  addIceCandidate(sessionId: string, candidate: IceCandidateLike): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // An end-of-candidates marker has nothing to add.
    if (candidate.candidate === undefined && candidate.sdpMid == null && candidate.sdpMLineIndex == null) return;
    void session.pc.addIceCandidate(candidate).catch((error: unknown) => {
      this.log(`webrtc candidate rejected for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.closed) return;
    session.closed = true;
    this.sessions.delete(sessionId);

    const source = this.sources.get(session.cameraId);
    source?.subscribers.delete(session);
    try {
      session.track.stop();
    } catch {
      // Already stopped.
    }
    closePeer(session.pc);

    if (source !== undefined && source.subscribers.size === 0) {
      scheduleIdleStop(source, this.options.sourceIdleMs ?? DEFAULT_SOURCE_IDLE_MS);
    }
  }

  stats(): WebRtcEngineStats {
    return {
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        cameraId: session.cameraId,
        user: session.user,
        createdAt: session.createdAt,
        state: session.state,
        packets: session.packets,
        bytes: session.bytes,
        keyframeSeen: session.keyframeSeen,
      })),
      sources: [...this.sources.values()].map((source) => {
        const continuity = source.continuity.stats();
        return {
          cameraId: source.cameraId,
          viewers: source.subscribers.size,
          ...(source.startedAt === undefined ? {} : { startedAt: source.startedAt }),
          packets: continuity.packets,
          bytes: continuity.bytes,
          discontinuities: continuity.discontinuities,
          dropped: continuity.dropped,
        ...(source.lastError === undefined ? {} : { lastError: source.lastError }),
        // Read live: the FFmpeg argv only exists once the source has started, which
        // happens after the first viewer, not when the engine is constructed.
        ...(source.source.argv === undefined ? {} : { argv: source.source.argv }),
        };
      }),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
    const sources = [...this.sources.values()];
    this.sources.clear();
    await Promise.all(
      sources.map(async (source) => {
        clearIdle(source);
        await source.source.stop().catch(() => undefined);
      }),
    );
  }

  /** Starts one camera pipeline lazily, on the first viewer. */
  private ensureSource(camera: CameraConfig): MediaSourceState {
    const existing = this.sources.get(camera.id);
    if (existing !== undefined) return existing;

    const source = this.options.createSource({ cameraId: camera.id, camera });
    const continuity = new RtpContinuity({ payloadType: this.options.payloadType ?? DEFAULT_PAYLOAD_TYPE });
    const state: MediaSourceState = {
      cameraId: camera.id,
      source,
      continuity,
      subscribers: new Set(),
    };
    this.sources.set(camera.id, state);

    source.start({
      onPacket: (packet) => {
        const rewritten = state.continuity.rewrite(packet);
        if (rewritten === undefined) return;
        if (state.startedAt === undefined) state.startedAt = this.now();
        for (const session of state.subscribers) {
          if (session.closed) continue;
          try {
            session.track.writeRtp(rewritten);
            session.packets += 1;
            session.bytes += rewritten.length;
            if (!session.keyframeSeen) {
              const info = inspectH264Payload(rewritten.subarray(12));
              if (info?.keyframe === true) session.keyframeSeen = true;
            }
          } catch (error) {
            // A failed write means that peer is gone; the connection state handler
            // cleans it up, so this must not abort the loop for other viewers.
            this.log(
              `webrtc write failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      },
      onError: (message) => {
        state.lastError = message;
        this.log(`webrtc source ${camera.id}: ${message}`);
      },
    });
    this.log(`webrtc source started for ${camera.id}`);
    return state;
  }

  private portRange(): [number, number] | undefined {
    const range = this.options.portRange;
    if (range?.min === undefined || range.max === undefined) return undefined;
    if (!Number.isInteger(range.min) || !Number.isInteger(range.max)) return undefined;
    // werift requires a real range; an equal min/max is rejected by the ICE layer.
    if (range.max <= range.min) return undefined;
    return [range.min, range.max];
  }
}

function closePeer(pc: WeriftPeerConnection): void {
  try {
    const result = pc.close();
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Already closed.
  }
}

function clearIdle(source: MediaSourceState): void {
  if (source.idleTimer !== undefined) {
    clearTimeout(source.idleTimer);
    source.idleTimer = undefined;
  }
}

function scheduleIdleStop(source: MediaSourceState, idleMs: number): void {
  clearIdle(source);
  source.idleTimer = setTimeout(() => {
    source.idleTimer = undefined;
    if (source.subscribers.size > 0) return;
    void source.source.stop().catch(() => undefined);
  }, idleMs);
  source.idleTimer.unref?.();
}

function waitForIceGathering(pc: WeriftPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    const unsubscribe = pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') finish();
    });
  });
}

function toWeriftIceServers(servers: IceServerLike[]): Array<Record<string, unknown>> {
  return servers
    .filter((server) => server.urls.length > 0)
    .map((server) => ({
      urls: [...server.urls],
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    }));
}
