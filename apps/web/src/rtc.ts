/**
 * WebRTC live player.
 *
 * Signaling rides the control WebSocket (one authorization decision per browser
 * tab), media arrives as a single H.264 track from the server's peer connection.
 * Three behaviours make this usable rather than merely present:
 *
 * - offers are serialised per tab. `webrtc:error` carries no camera id, so two
 *   concurrent negotiations could hand one tile another tile's failure;
 * - ICE candidates are buffered until the answer names the session id, then
 *   flushed — a candidate sent before that is rejected by the hub;
 * - a connection that reaches `connected` but never paints is a failure, not a
 *   success. Without that check a blocked UDP path looks exactly like a working
 *   one (black tile, no error), and the caller never falls back to MSE.
 */

export type RtcPhase = 'idle' | 'negotiating' | 'connecting' | 'playing' | 'failed';

export interface RtcAnswer {
  sessionId: string;
  sdp: string;
}

export class RtcSignalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RtcSignalError';
    this.code = code;
  }
}

export interface WebRtcSignalerOptions {
  /** Sends a JSON message on the control socket; false when it is closed. */
  send: (message: Record<string, unknown>) => boolean;
  /** How long to wait for an answer before the tile falls back. */
  timeoutMs?: number;
}

interface PendingOffer {
  cameraId: string;
  resolve: (answer: RtcAnswer) => void;
  reject: (error: RtcSignalError) => void;
  timer: number;
}

/**
 * Owns the offer/answer exchange for every camera tile in one tab.
 *
 * One instance per control socket: the Dashboard creates it, feeds it every
 * inbound message, and hands it to the tiles.
 */
export class WebRtcSignaler {
  private readonly send: (message: Record<string, unknown>) => boolean;
  private readonly timeoutMs: number;
  private pending: PendingOffer | undefined;
  /** Negotiations are queued so an answer can be attributed to its request. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: WebRtcSignalerOptions) {
    this.send = options.send;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  /** Returns true when the message belonged to WebRTC signaling. */
  handleMessage(message: Record<string, unknown>): boolean {
    if (message.type === 'webrtc:answer') {
      const pending = this.pending;
      if (pending === undefined) return true;
      if (typeof message.sessionId !== 'string' || typeof message.sdp !== 'string') {
        this.settle(pending, () =>
          pending.reject(new RtcSignalError('invalid-answer', 'The server sent an unreadable WebRTC answer.')),
        );
        return true;
      }
      this.settle(pending, () => pending.resolve({ sessionId: message.sessionId as string, sdp: message.sdp as string }));
      return true;
    }
    if (message.type === 'webrtc:error') {
      const pending = this.pending;
      if (pending === undefined) return true;
      const code = typeof message.code === 'string' ? message.code : 'webrtc-error';
      const text = typeof message.message === 'string' ? message.message : 'The server refused the WebRTC session.';
      this.settle(pending, () => pending.reject(new RtcSignalError(code, text)));
      return true;
    }
    return false;
  }

  offer(cameraId: string, sdp: string): Promise<RtcAnswer> {
    const run = this.tail.then(
      () => this.offerNow(cameraId, sdp),
      () => this.offerNow(cameraId, sdp),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  candidate(sessionId: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: 'webrtc:ice', sessionId, candidate });
  }

  close(sessionId: string): void {
    this.send({ type: 'webrtc:close', sessionId });
  }

  private offerNow(cameraId: string, sdp: string): Promise<RtcAnswer> {
    return new Promise<RtcAnswer>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending?.cameraId !== cameraId) return;
        this.pending = undefined;
        reject(new RtcSignalError('timeout', 'The server did not answer the WebRTC offer in time.'));
      }, this.timeoutMs);
      this.pending = { cameraId, resolve, reject, timer };
      const sent = this.send({ type: 'webrtc:offer', cameraId, sdp });
      if (!sent) {
        window.clearTimeout(timer);
        this.pending = undefined;
        reject(new RtcSignalError('socket-closed', 'The control connection is not open.'));
      }
    });
  }

  private settle(pending: PendingOffer, action: () => void): void {
    window.clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = undefined;
    action();
  }
}

export interface WebRtcPlayerCallbacks {
  onPhase(phase: RtcPhase): void;
  /** The tile should switch to its next transport. */
  onFatal(message: string, code?: string): void;
}

export interface WebRtcPlayerOptions {
  cameraId: string;
  video: HTMLVideoElement;
  signaler: WebRtcSignaler;
  callbacks: WebRtcPlayerCallbacks;
  iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
  /** Give up when no frame paints within this window (blocked UDP looks idle). */
  firstFrameTimeoutMs?: number;
}

export class WebRtcPlayer {
  private readonly options: WebRtcPlayerOptions;
  private readonly video: HTMLVideoElement;
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private phase: RtcPhase = 'idle';
  private stopped = false;
  private frames = 0;
  private firstFrameTimer: number | null = null;
  private pollTimer: number | null = null;

  constructor(options: WebRtcPlayerOptions) {
    this.options = options;
    this.video = options.video;
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.frames = 0;
    this.sessionId = null;
    this.pendingCandidates = [];
    this.setPhase('negotiating');

    if (typeof RTCPeerConnection === 'undefined') {
      this.fail('This browser has no WebRTC support.', 'webrtc-unsupported');
      return;
    }

    const iceServers = (this.options.iceServers ?? []).map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    }));
    const pc = new RTCPeerConnection(iceServers.length === 0 ? undefined : { iceServers });
    this.pc = pc;

    // recvonly: the server answers with a sendonly track, which keeps the answer
    // a single media section that matches this offer.
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (event: RTCTrackEvent) => {
      if (this.stopped) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.video.srcObject = stream;
      void this.video.play().catch(() => {
        // A gesture may be required; the retry on the first frame handles it.
      });
      this.watchForFirstFrame();
    };
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate === null) return;
      const init = event.candidate.toJSON();
      if (this.sessionId === null) {
        this.pendingCandidates.push(init);
        return;
      }
      this.options.signaler.candidate(this.sessionId, init);
    };
    pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'failed') {
        this.fail('The WebRTC connection failed; UDP may be blocked on this network.', 'ice-failed');
        return;
      }
      if (state === 'disconnected') {
        // ICE can recover from a short disconnection; only the first-frame timeout
        // turns this into a fallback, so a two-second blip does not drop to MJPEG.
        return;
      }
      if (state === 'connected' && this.phase === 'negotiating') this.setPhase('connecting');
    };
    this.watchForFirstFrame();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (sdp === undefined) {
        this.fail('The browser produced no SDP offer.', 'offer-failed');
        return;
      }
      const answer = await this.options.signaler.offer(this.options.cameraId, sdp);
      if (this.stopped) return;
      this.sessionId = answer.sessionId;
      for (const candidate of this.pendingCandidates.splice(0)) {
        this.options.signaler.candidate(answer.sessionId, candidate);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      if (this.phase === 'negotiating') this.setPhase('connecting');
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'The WebRTC negotiation failed.', errorCode(error));
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.sessionId !== null) {
      this.options.signaler.close(this.sessionId);
      this.sessionId = null;
    }
    if (this.pc !== null) {
      try {
        this.pc.close();
      } catch {
        // Already closed.
      }
      this.pc = null;
    }
    try {
      this.video.srcObject = null;
      this.video.pause();
    } catch {
      // A detached element can throw; nothing to clean up then.
    }
  }

  /**
   * A peer that is "connected" but never renders a frame is the classic symptom of
   * a firewall that allows the ICE handshake and drops the media. The timeout turns
   * that into a visible fallback instead of a permanent black tile.
   */
  private watchForFirstFrame(): void {
    if (this.firstFrameTimer !== null) return;
    const timeout = this.options.firstFrameTimeoutMs ?? 8000;
    this.firstFrameTimer = window.setTimeout(() => {
      this.firstFrameTimer = null;
      if (this.stopped || this.phase === 'playing') return;
      this.fail('WebRTC connected but no video arrived; falling back.', 'no-frames');
    }, timeout);

    const markPlaying = (): void => {
      this.frames += 1;
      if (this.phase === 'playing') return;
      this.clearTimers();
      this.setPhase('playing');
      void this.video.play().catch(() => undefined);
    };

    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const onFrame = (): void => {
        if (this.stopped) return;
        markPlaying();
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
      return;
    }

    // Firefox has no requestVideoFrameCallback: the playhead moving is the signal.
    this.pollTimer = window.setInterval(() => {
      if (this.stopped) return;
      if (this.video.currentTime > 0 && this.video.readyState >= 2) markPlaying();
    }, 500);
  }

  private fail(message: string, code?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.setPhase('failed');
    this.options.callbacks.onFatal(message, code);
    this.stop();
  }

  private setPhase(phase: RtcPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.callbacks.onPhase(phase);
  }

  private clearTimers(): void {
    if (this.firstFrameTimer !== null) {
      window.clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof RtcSignalError) return error.code;
  return undefined;
}
