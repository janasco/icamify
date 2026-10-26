import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CameraConfig, ResolvedIcamifyConfig } from '@icamify/core';
import {
  LiveRegistry,
  LiveSession,
  type LiveSessionOptions,
  type LiveSource,
  type LiveSourceHandlers,
  type LiveViewer,
  type ViewerStreamInfo,
} from '../src/index.ts';

const CAMERA: CameraConfig = {
  id: 'front-door',
  name: 'Front door',
  streams: { main: { type: 'file', path: './data/sample.mp4' } },
};

// -- fixtures ---------------------------------------------------------------

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function initSegment(width = 640, height = 360): Buffer {
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
  };
  const prefix = Buffer.alloc(78);
  prefix.writeUInt16BE(1, 6);
  prefix.writeUInt16BE(width, 24);
  prefix.writeUInt16BE(height, 26);
  const entry = box('avc1', Buffer.concat([prefix, box('avcC', Buffer.from([1, 0x42, 0xc0, 0x1f, 0xff]))]));
  const stsd = Buffer.concat([Buffer.alloc(4), u32(1), entry]);
  const stbl = box('stbl', box('stsd', stsd));
  const mdhd = box('mdhd', Buffer.concat([Buffer.alloc(4), u32(0), u32(0), u32(12800), u32(0)]));
  const hdlr = box('hdlr', Buffer.concat([Buffer.alloc(4), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)]));
  const moov = box('moov', box('trak', Buffer.concat([box('tkbd', Buffer.alloc(4)), box('mdia', Buffer.concat([mdhd, hdlr, box('minf', stbl)]))])));
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), moov]);
}

function fragment(sequence: number): Buffer {
  return Buffer.concat([
    box('moof', box('mfhd', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, sequence])]))),
    box('mdat', Buffer.alloc(8, sequence)),
  ]);
}

class FakeSource implements LiveSource {
  readonly argv = ['ffmpeg', '-i', 'fake'];
  handlers: LiveSourceHandlers | undefined;
  stops = 0;

  start(handlers: LiveSourceHandlers): void {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  push(chunk: Buffer): void {
    this.handlers?.onData(chunk);
  }

  exit(): void {
    this.handlers?.onExit({ code: 1, signal: null, requested: false, stderr: ['boom'] });
  }
}

class FakeViewer implements LiveViewer {
  readonly id: string;
  init: { info: ViewerStreamInfo; data: Buffer } | undefined;
  inits = 0;
  segments: Buffer[] = [];
  errors: string[] = [];
  closedWith: string | undefined;
  buffered = 0;

  constructor(id: string) {
    this.id = id;
  }

  sendInit(info: ViewerStreamInfo, data: Buffer): void {
    this.init = { info, data };
    this.inits += 1;
  }

  sendSegment(data: Buffer): void {
    this.segments.push(data);
  }

  sendError(message: string): void {
    this.errors.push(message);
  }

  close(reason: string): void {
    this.closedWith = reason;
  }

  bufferedBytes(): number {
    return this.buffered;
  }
}

function makeSession(overrides: Partial<LiveSessionOptions> = {}): {
  session: LiveSession;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const session = new LiveSession({
    camera: CAMERA,
    transport: 'mse',
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    idleTimeoutMs: 20,
    windowSegments: 2,
    ...overrides,
  });
  return { session, sources };
}

// -- session ----------------------------------------------------------------

describe('LiveSession', () => {
  test('starts one pipeline on the first viewer and fans frames out to all', () => {
    const { session, sources } = makeSession();
    const first = new FakeViewer('a');
    const second = new FakeViewer('b');
    assert.equal(session.addViewer(first), 'added');
    assert.equal(session.addViewer(second), 'added');
    assert.equal(sources.length, 1, 'one encoder serves every viewer');

    sources[0]?.push(Buffer.concat([initSegment(), fragment(1)]));
    assert.equal(first.init?.info.mimeType, 'video/mp4; codecs="avc1.42c01f"');
    assert.equal(first.segments.length, 1);
    assert.equal(second.segments.length, 1);
    assert.equal(session.stats().fragments, 1);
    void session.stop();
  });

  test('replays the init segment and the recent window to a late joiner', () => {
    const { session, sources } = makeSession({ windowSegments: 2 });
    const early = new FakeViewer('early');
    session.addViewer(early);
    sources[0]?.push(Buffer.concat([initSegment(), fragment(1), fragment(2), fragment(3)]));
    assert.equal(early.segments.length, 3);

    const late = new FakeViewer('late');
    session.addViewer(late);
    assert.equal(late.init?.info.codec, 'avc1.42c01f');
    assert.equal(late.segments.length, 2, 'only the configured window is replayed');
    void session.stop();
  });

  test('drops a viewer whose socket is backed up instead of buffering for it', () => {
    const { session, sources } = makeSession();
    const viewer = new FakeViewer('slow');
    session.addViewer(viewer);
    viewer.buffered = 9 * 1024 * 1024;

    sources[0]?.push(Buffer.concat([initSegment(), fragment(1)]));
    assert.equal(viewer.closedWith, 'slow-consumer');
    assert.equal(session.viewerCount, 0);
    void session.stop();
  });

  test('tears the pipeline down after the last viewer leaves', async () => {
    const { session, sources } = makeSession({ idleTimeoutMs: 10 });
    const viewer = new FakeViewer('only');
    session.addViewer(viewer);
    session.removeViewer(viewer.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(sources[0]?.stops, 1);
    assert.equal(session.closed, true);
    assert.equal(session.stats().state, 'closed');
  });

  test('keeps viewers while the pipeline restarts, then resumes with a new init', () => {
    const { session, sources } = makeSession();
    const viewer = new FakeViewer('v');
    session.addViewer(viewer);
    sources[0]?.push(Buffer.concat([initSegment(), fragment(1)]));

    sources[0]?.exit();
    assert.equal(session.stats().state, 'restarting');
    assert.equal(viewer.errors.length, 1);
    assert.equal(viewer.closedWith, undefined, 'a restart must not disconnect the viewer');

    sources[0]?.push(initSegment(1280, 720));
    assert.equal(session.stats().state, 'running');
    assert.equal(viewer.inits, 2);
    assert.equal(viewer.init?.info.width, 1280);
    void session.stop();
  });

  test('enforces the per-camera viewer cap', () => {
    const { session } = makeSession({ maxViewers: 1 });
    assert.equal(session.addViewer(new FakeViewer('one')), 'added');
    assert.equal(session.addViewer(new FakeViewer('two')), 'viewer-limit');
    void session.stop();
  });

  test('stops cleanly and closes viewers exactly once', async () => {
    const { session, sources } = makeSession();
    const viewer = new FakeViewer('v');
    session.addViewer(viewer);
    await session.stop('test');
    assert.equal(viewer.closedWith, 'test');
    assert.equal(sources[0]?.stops, 1);
    await session.stop('again');
    assert.equal(sources[0]?.stops, 1);
  });
});

// -- registry ---------------------------------------------------------------

function registryConfig(streaming: Record<string, unknown> = {}): ResolvedIcamifyConfig {
  return {
    cameras: [CAMERA, { ...CAMERA, id: 'disabled', enabled: false }],
    streaming: {
      mse: { enabled: true },
      mjpeg: { enabled: true },
      webrtc: { enabled: true, maxViewersPerCamera: 2 },
      fallbackChain: ['webrtc', 'mse', 'mjpeg'],
      maxConcurrentSessions: 2,
      sessionIdleTimeoutSeconds: 10,
      ...streaming,
    },
  } as unknown as ResolvedIcamifyConfig;
}

function makeRegistry(config = registryConfig()): LiveRegistry {
  const sources: FakeSource[] = [];
  const registry = new LiveRegistry({
    config,
    camera: (id) => config.cameras.find((camera) => camera.id === id),
    createSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  });
  return registry;
}

describe('LiveRegistry', () => {
  test('rejects unknown, disabled and disabled-transport requests with reasons', () => {
    const registry = makeRegistry();
    const viewer = new FakeViewer('v');
    assert.equal(registry.view('nope', 'mse', viewer).ok, false);
    const disabled = registry.view('disabled', 'mse', viewer);
    assert.deepEqual(disabled.ok === false ? disabled.code : '', 'camera-disabled');

    const noMjpeg = makeRegistry(registryConfig({ mjpeg: { enabled: false } }));
    const result = noMjpeg.view('front-door', 'mjpeg', viewer);
    assert.equal(result.ok === false ? result.code : '', 'transport-disabled');
    assert.match(result.ok === false ? result.message : '', /streaming\.mjpeg\.enabled/);
  });

  test('reuses one session for concurrent viewers and reports viewer-limit', () => {
    const registry = makeRegistry();
    assert.equal(registry.view('front-door', 'mse', new FakeViewer('a')).ok, true);
    assert.equal(registry.view('front-door', 'mse', new FakeViewer('b')).ok, true);
    const third = registry.view('front-door', 'mse', new FakeViewer('c'));
    assert.equal(third.ok === false ? third.code : '', 'viewer-limit');
    assert.equal(registry.stats().length, 1);
    assert.equal(registry.viewerCount('front-door'), 2);
    void registry.shutdown();
  });

  test('enforces the global session cap', () => {
    const registry = makeRegistry(registryConfig({ maxConcurrentSessions: 1 }));
    assert.equal(registry.view('front-door', 'mse', new FakeViewer('a')).ok, true);
    const blocked = registry.view('front-door', 'mjpeg', new FakeViewer('b'));
    assert.equal(blocked.ok === false ? blocked.code : '', 'session-limit');
    void registry.shutdown();
  });

  test('reports the fallback ladder, including why WebRTC is unusable', () => {
    const registry = makeRegistry();
    const chain = registry.availability();
    assert.deepEqual(chain.map((entry) => entry.transport), ['webrtc', 'mse', 'mjpeg']);
    assert.equal(chain[0]?.available, false);
    assert.match(chain[0]?.reason ?? '', /WebRTC media engine/);
    assert.equal(chain[1]?.available, true);
    assert.equal(chain[2]?.available, true);
  });

  test('shutdown stops every pipeline', async () => {
    const registry = makeRegistry();
    registry.view('front-door', 'mse', new FakeViewer('a'));
    registry.view('front-door', 'mjpeg', new FakeViewer('b'));
    assert.equal(registry.stats().length, 2);
    await registry.shutdown();
    assert.equal(registry.stats().length, 0);
  });
});
