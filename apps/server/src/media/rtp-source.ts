import { createSocket, type Socket } from 'node:dgram';
import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import { MediaEngine, type IngestEvent } from '@icamify/media';
import type { RtpSource, RtpSourceContext, RtpSourceHandlers } from '@icamify/rtc';

/**
 * Bridges the WebRTC engine's `RtpSource` contract to an FFmpeg process.
 *
 * The media path is deliberately the same shape as the MSE one — one supervisor
 * per camera, restarts and backoff owned by `@icamify/media` — but the transport
 * differs: FFmpeg writes H.264 RTP to a loopback UDP socket instead of fragmented
 * MP4 to a pipe. UDP through the kernel keeps the process allocation-free per
 * packet, which is what makes sub-200 ms latency possible; a pipe would add a
 * copy and a JS round trip per packet.
 *
 * The socket is bound to `127.0.0.1` before FFmpeg starts, so the port is always
 * known and can never be guessed by another local process.
 */

export interface RtpSourceFactoryOptions {
  media: MediaEngine;
  config: ResolvedIcamifyConfig;
  log?: (line: string) => void;
  /** Payload type used between FFmpeg and the engine; the browser sees its own. */
  payloadType?: number;
}

/** Matches the engine's default; kept in one place on the server side. */
const DEFAULT_PAYLOAD_TYPE = 102;

export function createRtpSourceFactory(
  options: RtpSourceFactoryOptions,
): (context: RtpSourceContext) => RtpSource {
  return (context) => new SupervisorRtpSource(options, context.camera);
}

class SupervisorRtpSource implements RtpSource {
  private args: readonly string[] | undefined;
  private socket: Socket | undefined;
  private supervisor: ReturnType<MediaEngine['start']> | undefined;
  private stopping = false;
  private lastError: string | undefined;
  private readonly options: RtpSourceFactoryOptions;
  private readonly camera: CameraConfig;

  constructor(options: RtpSourceFactoryOptions, camera: CameraConfig) {
    this.options = options;
    this.camera = camera;
  }

  get argv(): readonly string[] | undefined {
    return this.args;
  }

  start(handlers: RtpSourceHandlers): void {
    void this.begin(handlers);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
    await this.supervisor?.stop().catch(() => undefined);
    this.supervisor = undefined;
  }

  private async begin(handlers: RtpSourceHandlers): Promise<void> {
    const socket = createSocket('udp4');
    try {
      await new Promise<void>((resolvePromise, reject) => {
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', () => {
          socket.off('error', reject);
          resolvePromise();
        });
      });
    } catch (error) {
      handlers.onError?.(`could not open the RTP socket: ${errorMessage(error)}`);
      try {
        socket.close();
      } catch {
        // Never bound.
      }
      return;
    }
    if (this.stopping) {
      socket.close();
      return;
    }
    this.socket = socket;
    const port = socket.address().port;
    socket.on('message', (message) => handlers.onPacket(message));
    socket.on('error', (error) => this.report(handlers, `RTP socket: ${error.message}`));

    const planOptions = {
      liveOutput: 'rtp' as const,
      rtp: {
        port,
        payloadType: this.options.payloadType ?? DEFAULT_PAYLOAD_TYPE,
      },
    };
    try {
      // Built before starting so a configuration problem (missing live profile,
      // no H.264 encoder) is reported instead of retried in a loop.
      this.args = this.options.media.plan(this.options.config, this.camera, 'live', planOptions).args;
    } catch (error) {
      this.report(handlers, errorMessage(error));
      return;
    }

    const stderr: string[] = [];
    this.supervisor = this.options.media.start(this.options.config, this.camera, 'live', {
      ...planOptions,
      // RTP leaves through the socket; stdout carries nothing.
      onStdout: () => undefined,
      onEvent: (event: IngestEvent) => {
        if (event.type === 'stderr') {
          stderr.push(event.line);
          if (stderr.length > 8) stderr.shift();
          this.report(handlers, event.line);
          return;
        }
        if (event.type === 'exited' && !event.requested && !this.stopping) {
          this.report(handlers, `pipeline exited (${event.code ?? 'signal'}), restarting`);
        }
        if (event.type === 'gave-up') {
          this.report(handlers, `pipeline gave up after repeated failures: ${stderr.at(-1) ?? 'unknown error'}`);
        }
      },
    });
    this.options.log?.(`webrtc rtp source for ${this.camera.id} on 127.0.0.1:${port}`);
  }

  private report(handlers: RtpSourceHandlers, message: string): void {
    // FFmpeg is chatty on a flaky camera; only changes reach the connection state.
    if (message === this.lastError) return;
    this.lastError = message;
    handlers.onError?.(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
