import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { IngestSupervisor, type IngestEvent, type SpawnFn } from '../src/index.ts';

/**
 * Supervisor behaviour is tested against a fake child process: backoff policy,
 * health transitions and shutdown guarantees are pure control flow, so no real
 * FFmpeg (or camera) is needed to prove them.
 */

let nextPid = 5000;

class FakeChild extends EventEmitter {
  pid = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  /** Signals the child pretends to receive but never acts on (e.g. `-stream_loop`). */
  readonly ignore = new Set<NodeJS.Signals>();
  private exited = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (!this.ignore.has(signal)) this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    this.emit('exit', code, signal);
  }

  writeStdout(text: string): void {
    this.stdout.write(text);
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }
}

interface FakeSpawner {
  spawn: SpawnFn;
  children: FakeChild[];
  commands: Array<{ command: string; args: string[] }>;
}

function fakeSpawn(onSpawn?: (child: FakeChild, index: number) => void): FakeSpawner {
  const children: FakeChild[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  return {
    children,
    commands,
    spawn: (command: string, args: string[], _options: SpawnOptions) => {
      const child = new FakeChild();
      children.push(child);
      commands.push({ command, args });
      onSpawn?.(child, children.length - 1);
      return child as unknown as ChildProcess;
    },
  };
}

function collector(): { events: IngestEvent[]; onEvent: (event: IngestEvent) => void } {
  const events: IngestEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitFor(
  events: IngestEvent[],
  predicate: (event: IngestEvent) => boolean,
  timeoutMs = 3000,
): Promise<IngestEvent> {
  await waitUntil(() => events.some(predicate), timeoutMs);
  const found = events.find(predicate);
  assert.ok(found !== undefined);
  return found;
}

function plan(): { args: string[]; warnings: string[] } {
  return { args: ['-i', 'rtsp://camera/1', 'pipe:1'], warnings: [] };
}

const baseOptions = {
  cameraId: 'front-door',
  purpose: 'record' as const,
  build: plan,
  bin: 'ffmpeg',
  killGraceMs: 30,
  healthyAfterMs: 10_000,
  random: () => 0.5,
  // Tests fake the child, so signalling a real process group would be a bug.
  detached: false,
};

describe('IngestSupervisor', () => {
  test('reports starting then running, and stops cleanly on request', async () => {
    const fake = fakeSpawn();
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({ ...baseOptions, spawn: fake.spawn, onEvent });

    supervisor.start();
    await waitFor(events, (event) => event.type === 'running');

    assert.equal(supervisor.state(), 'running');
    const running = events.find((event) => event.type === 'running');
    assert.ok(running !== undefined && running.type === 'running');
    assert.equal(running.pid, fake.children[0]?.pid);
    assert.deepEqual(fake.commands[0], { command: 'ffmpeg', args: plan().args });

    await supervisor.stop();
    assert.equal(supervisor.state(), 'stopped');
    assert.equal(fake.children.length, 1, 'stop must not spawn a replacement');
    const exited = events.filter((event) => event.type === 'exited');
    assert.equal(exited.length, 1);
    assert.ok(exited[0]?.type === 'exited' && exited[0].requested);
  });

  test('restarts with exponential backoff and escalates to degraded', async () => {
    const fake = fakeSpawn((child) => setImmediate(() => child.finish(1)));
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({
      ...baseOptions,
      health: { restartBackoffSeconds: 0.01, maxBackoffSeconds: 1, offlineAfterFailures: 3 },
      spawn: fake.spawn,
      onEvent,
    });

    supervisor.start();
    await waitFor(events, (event) => event.type === 'degraded');
    await supervisor.stop();

    const delays = events
      .filter((event): event is Extract<IngestEvent, { type: 'restart-scheduled' }> => event.type === 'restart-scheduled')
      .map((event) => event.delayMs);
    assert.ok(delays.length >= 2, `expected at least two restarts, saw ${delays.length}`);
    assert.ok((delays[0] ?? 0) <= (delays[1] ?? 0), `backoff should grow: ${delays.join(',')}`);
    assert.equal(supervisor.state(), 'stopped');

    // Once stopped, the pending timer must not resurrect the pipeline.
    const attemptsAfterStop = supervisor.attempts;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(supervisor.attempts, attemptsAfterStop);
    assert.equal(supervisor.state(), 'stopped');
  });

  test('a run that survives the health window resets the failure counter', async () => {
    const fake = fakeSpawn((child, index) => {
      if (index === 0) setImmediate(() => child.finish(1));
      else setTimeout(() => child.finish(1), 40);
    });
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({
      ...baseOptions,
      healthyAfterMs: 15,
      health: { restartBackoffSeconds: 0.05, maxBackoffSeconds: 1, offlineAfterFailures: 5 },
      spawn: fake.spawn,
      onEvent,
    });

    supervisor.start();
    await waitUntil(() => events.filter((event) => event.type === 'exited' && !event.requested).length >= 2);
    assert.equal(supervisor.consecutiveFailures, 1, 'a healthy run should clear the failure count');
    assert.ok(events.some((event) => event.type === 'recovered'));
    await supervisor.stop();
  });

  test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
    const fake = fakeSpawn((child) => {
      child.ignore.add('SIGTERM');
    });
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({
      ...baseOptions,
      killGraceMs: 20,
      spawn: fake.spawn,
      onEvent,
    });

    supervisor.start();
    await waitFor(events, (event) => event.type === 'running');
    await supervisor.stop();

    assert.deepEqual(fake.children[0]?.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(supervisor.state(), 'stopped');
  });

  test('captures stderr and forwards it as events', async () => {
    const fake = fakeSpawn((child) => {
      child.writeStderr('rtsp://camera/1: Connection refused\n');
    });
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({ ...baseOptions, spawn: fake.spawn, onEvent });

    supervisor.start();
    const stderr = await waitFor(events, (event) => event.type === 'stderr');
    assert.ok(stderr.type === 'stderr' && /Connection refused/.test(stderr.line));
    await supervisor.stop();
  });

  test('a synchronous spawn failure is retried rather than crashed on', async () => {
    const { events, onEvent } = collector();
    const supervisor = new IngestSupervisor({
      ...baseOptions,
      health: { restartBackoffSeconds: 0.01, maxBackoffSeconds: 1 },
      spawn: () => {
        throw new Error('spawn ffmpeg ENOENT');
      },
      onEvent,
    });

    supervisor.start();
    const scheduled = await waitFor(events, (event) => event.type === 'restart-scheduled');
    assert.ok(scheduled.type === 'restart-scheduled');
    assert.match(scheduled.reason, /ENOENT/);
    await supervisor.stop();
  });

  test('progress frames are surfaced to the caller', async () => {
    const fake = fakeSpawn((child) => {
      child.writeStdout('frame=7\nout_time_us=280000\nspeed=1.0x\nprogress=continue\n');
    });
    const progress: string[] = [];
    const supervisor = new IngestSupervisor({
      ...baseOptions,
      spawn: fake.spawn,
      onProgress: (frame) => progress.push(`${frame.frame}:${String(frame.outTimeMs)}`),
    });

    supervisor.start();
    await waitUntil(() => progress.length > 0);
    // The frame number comes from FFmpeg's own `frame=` field, not a local tick
    // counter, so progress reflects what the encoder actually processed.
    assert.deepEqual(progress, ['7:280']);
    await supervisor.stop();
  });
});
