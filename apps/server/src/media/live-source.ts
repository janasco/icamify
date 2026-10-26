import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import { MediaEngine, type IngestEvent, type IngestSupervisor } from '@icamify/media';
import { liveLimits, type LiveSource, type LiveSourceFactory, type LiveSourceHandlers } from '@icamify/stream';

/**
 * Bridges the stream layer's `LiveSource` contract to the media supervisor.
 *
 * The supervisor already owns restart/backoff and process-group cleanup, so this
 * class only has to: build the live plan for the requested transport, forward
 * stdout bytes, and translate supervisor events into the source contract. When
 * the pipeline dies the supervisor restarts it, which is exactly what
 * `LiveSession` expects while it waits with viewers still attached.
 */

export interface LiveSourceFactoryOptions {
  media: MediaEngine;
  config: ResolvedIcamifyConfig;
  log?: (line: string) => void;
}

export function createLiveSourceFactory(options: LiveSourceFactoryOptions): LiveSourceFactory {
  return ({ camera, transport }) => new SupervisorLiveSource(options, camera, transport);
}

class SupervisorLiveSource implements LiveSource {
  argv: readonly string[] = [];
  private readonly options: LiveSourceFactoryOptions;
  private readonly camera: CameraConfig;
  private readonly transport: 'mse' | 'mjpeg';
  private supervisor: IngestSupervisor | undefined;
  private handlers: LiveSourceHandlers | undefined;
  private stopping = false;

  constructor(options: LiveSourceFactoryOptions, camera: CameraConfig, transport: 'mse' | 'mjpeg') {
    this.options = options;
    this.camera = camera;
    this.transport = transport;
  }

  start(handlers: LiveSourceHandlers): void {
    this.handlers = handlers;
    const planOptions = this.planOptions();

    // Built once up front so a configuration problem (missing profile, no
    // encoder) surfaces as a start error the session can report, rather than a
    // silent supervisor that retries forever.
    this.argv = this.options.media.plan(this.options.config, this.camera, 'live', planOptions).args;

    const stderr: string[] = [];
    this.supervisor = this.options.media.start(this.options.config, this.camera, 'live', {
      ...planOptions,
      onStdout: (chunk) => handlers.onData(chunk),
      onEvent: (event: IngestEvent) => {
        if (event.type === 'stderr') {
          stderr.push(event.line);
          if (stderr.length > 8) stderr.shift();
          return;
        }
        if (event.type === 'exited') {
          handlers.onExit({
            code: event.code,
            signal: event.signal,
            requested: event.requested || this.stopping,
            stderr: [...stderr],
          });
        }
        if (event.type === 'gave-up') {
          handlers.onExit({ code: null, signal: null, requested: false, stderr: [...stderr] });
        }
      },
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.supervisor?.stop();
  }

  private planOptions(): Parameters<MediaEngine['plan']>[3] {
    const limits = liveLimits(this.options.config);
    if (this.transport === 'mjpeg') {
      return {
        liveOutput: 'mjpeg',
        liveWidth: limits.mjpeg.width,
        liveFps: limits.mjpeg.fps,
        mjpegQuality: limits.mjpeg.quality,
      };
    }
    return { liveOutput: 'fmp4', segmentDurationMs: limits.segmentDurationMs };
  }
}
