import type { RouteContext, RouteHandler } from '../http/router.ts';
import { HttpError } from '../http/responses.ts';
import type { AuthService } from '../http/auth.ts';
import type { LiveRegistry, LiveViewer, ViewerStreamInfo } from '@icamify/stream';

/**
 * MJPEG fallback: `GET /api/cameras/:id/live.mjpeg`.
 *
 * The last rung of the ladder. It costs real CPU (JPEG encoding), so it is only
 * used when MSE cannot work — but it plays in every browser, including ones
 * where `MediaSource` is disabled or the codec is unsupported.
 */

export interface MjpegHandlerOptions {
  registry: LiveRegistry;
  auth: AuthService;
  boundary?: string;
}

export function createMjpegHandler(options: MjpegHandlerOptions): RouteHandler {
  const boundary = options.boundary ?? 'icamifyframe';
  let sequence = 0;

  return (context: RouteContext): void => {
    if (context.principal === undefined && !options.auth.anonymousViewing) {
      throw new HttpError(401, 'unauthenticated', 'Sign in to view cameras.');
    }
    const cameraId = context.params.id;
    if (cameraId === undefined) throw new HttpError(400, 'invalid-request', 'A camera id is required.');

    sequence += 1;
    const viewer = new MjpegViewer(context, boundary, `mjpeg${sequence}`);
    const result = options.registry.view(cameraId, 'mjpeg', viewer);
    if (!result.ok) {
      throw new HttpError(result.code === 'camera-not-found' ? 404 : 429, result.code, result.message);
    }
    // Send the multipart headers immediately: a client that waits for headers
    // would otherwise block until the camera's first JPEG, which can be seconds
    // away on a cold RTSP connection.
    viewer.open();

    const detach = (): void => {
      options.registry.removeViewer(cameraId, 'mjpeg', viewer.id);
    };
    context.req.on('close', detach);
    context.res.on('close', detach);
  };
}

class MjpegViewer implements LiveViewer {
  readonly id: string;
  private readonly context: RouteContext;
  private readonly boundary: string;
  private started = false;
  private closed = false;
  private frames = 0;

  constructor(context: RouteContext, boundary: string, id: string) {
    this.context = context;
    this.boundary = boundary;
    this.id = id;
  }

  sendInit(_info: ViewerStreamInfo): void {
    // Nothing to send: the multipart headers describe the stream.
  }

  /** Writes and flushes the response headers. Idempotent. */
  open(): void {
    this.ensureHeaders();
    this.context.res.flushHeaders?.();
  }

  sendSegment(data: Buffer): void {
    if (this.closed || this.context.res.writableEnded) return;
    this.ensureHeaders();
    const header = Buffer.from(
      `--${this.boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`,
      'latin1',
    );
    const res = this.context.res;
    res.write(header);
    res.write(data);
    res.write('\r\n');
    this.frames += 1;
  }

  sendError(message: string): void {
    // The body is already multipart; the only honest signal left is closing it.
    void message;
    this.closePeer();
  }

  close(_reason: string): void {
    this.closePeer();
  }

  bufferedBytes(): number {
    return this.context.res.writableLength;
  }

  private ensureHeaders(): void {
    if (this.started) return;
    this.started = true;
    this.context.res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${this.boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Frame-Options': 'DENY',
    });
  }

  private closePeer(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.context.res.writableEnded) {
      if (this.started) this.context.res.end(`--${this.boundary}--\r\n`);
      else this.context.res.end();
    }
  }
}
