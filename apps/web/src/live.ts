/**
 * MSE live player.
 *
 * One WebSocket per tile, carrying fragmented MP4. The server sends a JSON
 * `stream:init` (codec + MIME type), then the init segment as its own binary
 * frame, then one frame per `moof`+`mdat` fragment.
 *
 * Three details make this feel live rather than "a video that eventually
 * catches up":
 * - the playhead is dragged to the live edge when it falls more than 1.5 s behind;
 * - old media is evicted from the SourceBuffer so a long shift does not grow
 *   memory without bound;
 * - a stalled socket reconnects with backoff, and a browser that cannot play the
 *   codec reports a fatal error so the tile can switch to MJPEG.
 */

export type PlayerPhase = 'connecting' | 'buffering' | 'playing' | 'retrying' | 'failed';

export interface StreamMeta {
  cameraId: string;
  mimeType: string;
  codec?: string;
  width?: number;
  height?: number;
}

export interface LivePlayerCallbacks {
  onPhase(phase: PlayerPhase): void;
  onMeta(meta: StreamMeta): void;
  /** The tile should switch to its fallback transport. */
  onFatal(message: string, code?: string): void;
  /** Non-fatal message worth showing briefly (e.g. pipeline restarting). */
  onNotice?(message: string): void;
}

export interface LivePlayerOptions {
  cameraId: string;
  video: HTMLVideoElement;
  callbacks: LivePlayerCallbacks;
  /** Seconds of already-played media kept behind the playhead. */
  retainSeconds?: number;
  maxRetries?: number;
}

const MAX_QUEUED_BYTES = 24 * 1024 * 1024;
const FATAL_CLOSE_CODES = new Set([1008]);

export class LivePlayer {
  private readonly options: LivePlayerOptions;
  private socket: WebSocket | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private meta: StreamMeta | null = null;
  private phase: PlayerPhase = 'connecting';
  private stopped = false;
  private retries = 0;
  private generation = 0;
  private retryTimer: number | null = null;
  private firstFrameTimer: number | null = null;
  private seeking = false;

  constructor(options: LivePlayerOptions) {
    this.options = options;
    this.options.video.addEventListener('timeupdate', () => this.followLiveEdge());
    this.options.video.addEventListener('playing', () => this.setPhase('playing'));
    this.options.video.addEventListener('waiting', () => {
      if (this.phase === 'playing') this.setPhase('buffering');
    });
  }

  start(): void {
    this.stopped = false;
    this.retries = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.teardownMedia();
    try {
      this.options.video.pause();
      this.options.video.removeAttribute('src');
      this.options.video.load();
    } catch {
      // A detached video element can throw on load() in some engines.
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.setPhase(this.retries > 0 ? 'retrying' : 'connecting');
    this.meta = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.teardownMedia();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/cameras/${encodeURIComponent(this.options.cameraId)}/live.ws`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not open the stream socket.', 'socket-failed');
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (generation !== this.generation || this.stopped) return;
      if (typeof event.data === 'string') this.handleControl(event.data);
      else this.handleBinary(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (generation !== this.generation || this.stopped) return;
      this.clearFirstFrameTimer();
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.fail(event.reason.length > 0 ? reasonText(event.reason) : 'The server refused the stream.', event.reason);
        return;
      }
      if (event.code === 1000 && /shutdown|idle|pipeline-offline/.test(event.reason)) {
        this.fail(reasonText(event.reason), event.reason);
        return;
      }
      this.scheduleRetry();
    };
    socket.onerror = () => {
      // `close` always follows; retry logic lives there.
    };

    this.firstFrameTimer = window.setTimeout(() => {
      if (generation !== this.generation || this.meta !== null || this.stopped) return;
      this.fail('The camera did not send any video in time.', 'stream-timeout');
    }, 15_000);
  }

  private handleControl(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'stream:init') {
      this.clearFirstFrameTimer();
      this.retries = 0;
      const mimeType = typeof message.mimeType === 'string' ? message.mimeType : '';
      const meta: StreamMeta = {
        cameraId: typeof message.cameraId === 'string' ? message.cameraId : this.options.cameraId,
        mimeType,
        ...(typeof message.codec === 'string' ? { codec: message.codec } : {}),
        ...(typeof message.width === 'number' ? { width: message.width } : {}),
        ...(typeof message.height === 'number' ? { height: message.height } : {}),
      };
      this.meta = meta;
      this.options.callbacks.onMeta(meta);

      if (typeof MediaSource === 'undefined') {
        this.fail('This browser has no Media Source Extensions support.', 'mse-unsupported');
        return;
      }
      if (mimeType.length === 0 || !MediaSource.isTypeSupported(mimeType)) {
        this.fail(`This browser cannot play ${meta.codec ?? 'this stream codec'}.`, 'codec-unsupported');
        return;
      }
      this.setupMedia(meta);
      return;
    }
    if (message.type === 'stream:error') {
      const text = typeof message.message === 'string' ? message.message : 'The stream reported an error.';
      const code = typeof message.code === 'string' ? message.code : undefined;
      this.options.callbacks.onNotice?.(text);
      return;
    }
  }

  private handleBinary(data: ArrayBuffer): void {
    if (this.meta === null) return;
    this.enqueue(data);
  }

  private setupMedia(meta: StreamMeta): void {
    this.teardownMedia();
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    this.objectUrl = URL.createObjectURL(mediaSource);
    const video = this.options.video;
    video.src = this.objectUrl;

    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (this.stopped) return;
        try {
          const sourceBuffer = mediaSource.addSourceBuffer(meta.mimeType);
          sourceBuffer.mode = 'segments';
          sourceBuffer.addEventListener('updateend', () => this.onUpdateEnd());
          sourceBuffer.addEventListener('error', () => this.fail('The browser rejected the video stream.', 'append-failed'));
          this.sourceBuffer = sourceBuffer;
          this.setPhase('buffering');
          this.pump();
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'Could not create the video buffer.', 'sourcebuffer-failed');
        }
      },
      { once: true },
    );

    // Autoplay policies allow muted playback without a gesture.
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {
      // The play() call is retried on the first append; a rejection here only
      // means the element was not ready yet.
    });
  }

  private enqueue(chunk: ArrayBuffer): void {
    if (chunk.byteLength === 0) return;
    this.queue.push(chunk);
    this.queuedBytes += chunk.byteLength;
    while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 1) {
      const dropped = this.queue.shift();
      if (dropped === undefined) break;
      this.queuedBytes -= dropped.byteLength;
    }
    this.pump();
  }

  private pump(): void {
    const sourceBuffer = this.sourceBuffer;
    if (sourceBuffer === null || sourceBuffer.updating || this.queue.length === 0) return;
    const chunk = this.queue.shift();
    if (chunk === undefined) return;
    this.queuedBytes -= chunk.byteLength;
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        // Put it back and make room by dropping media behind the playhead.
        this.queue.unshift(chunk);
        this.queuedBytes += chunk.byteLength;
        this.evictOldMedia(true);
        return;
      }
      this.fail(error instanceof Error ? error.message : 'The video buffer rejected a segment.', 'append-failed');
    }
  }

  private onUpdateEnd(): void {
    const video = this.options.video;
    if (video.paused) void video.play().catch(() => undefined);
    this.evictOldMedia(false);
    this.followLiveEdge();
    this.pump();
  }

  /** Drops media far behind the playhead so memory stays flat over hours. */
  private evictOldMedia(aggressive: boolean): void {
    const sourceBuffer = this.sourceBuffer;
    const video = this.options.video;
    if (sourceBuffer === null || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return;
    const retain = this.options.retainSeconds ?? 10;
    const cutoff = aggressive ? video.currentTime - 1 : video.currentTime - retain * 3;
    if (cutoff <= 0) return;
    const bufferedStart = sourceBuffer.buffered.start(0);
    if (bufferedStart >= cutoff) return;
    try {
      sourceBuffer.remove(bufferedStart, cutoff);
    } catch {
      // Removing before the first append or during a seek can throw; harmless.
    }
  }

  /** Keeps playback at the live edge instead of drifting seconds behind. */
  private followLiveEdge(): void {
    const video = this.options.video;
    const sourceBuffer = this.sourceBuffer;
    if (sourceBuffer === null || this.seeking || video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    const drift = end - video.currentTime;
    if (drift > 1.5) {
      this.seeking = true;
      video.currentTime = Math.max(0, end - 0.35);
      window.setTimeout(() => {
        this.seeking = false;
      }, 500);
    }
  }

  private scheduleRetry(): void {
    const maxRetries = this.options.maxRetries ?? 5;
    if (this.retries >= maxRetries) {
      this.fail('The live stream could not be reconnected.', 'reconnect-failed');
      return;
    }
    this.retries += 1;
    this.setPhase('retrying');
    const delay = Math.min(8000, 500 * 2 ** (this.retries - 1));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private fail(message: string, code?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.teardownMedia();
    this.setPhase('failed');
    this.options.callbacks.onFatal(message, code);
  }

  private setPhase(phase: PlayerPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.callbacks.onPhase(phase);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }

  private teardownMedia(): void {
    this.sourceBuffer = null;
    if (this.mediaSource !== null) {
      const mediaSource = this.mediaSource;
      if (mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {
          // Already detached.
        }
      }
      this.mediaSource = null;
    }
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.queue = [];
    this.queuedBytes = 0;
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer !== null) {
      window.clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearFirstFrameTimer();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'codec-unsupported':
      return 'The camera codec cannot be played in this browser.';
    case 'transport-disabled':
      return 'MSE streaming is disabled on the server.';
    case 'camera-disabled':
      return 'This camera is disabled.';
    case 'viewer-limit':
      return 'Too many viewers are already watching this camera.';
    case 'session-limit':
      return 'The server has no free streaming session.';
    case 'pipeline-offline':
      return 'The camera pipeline went offline.';
    case 'shutdown':
    case 'idle':
      return 'The stream was closed by the server.';
    default:
      return reason.length > 0 ? reason : 'The stream was closed.';
  }
}
