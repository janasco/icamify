import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AiProviderConfig, CameraAiConfig } from '@icamify/core';
import { Gateway } from '@icamify/ai';
import type { AiProviderClient, Detection, DetectionRequest } from '@icamify/ai';
import { RecordingIndex } from '@icamify/storage';
import { AiService, type AiServiceEvent, type CaptureFrame } from '../src/ai/service.ts';
import { CAMERA, testConfig } from './helpers.ts';

/** Minimal JPEG with a real SOF header: enough for dimension mapping. */
function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

const STUB_PROVIDER: AiProviderConfig = {
  id: 'stub',
  name: 'Stub detector',
  type: 'generic-http',
  url: 'http://ai.invalid/detect',
  capabilities: ['object'],
  response: {
    detectionsPath: 'predictions',
    labelPath: 'label',
    confidencePath: 'confidence',
    box: { x: 'x', y: 'y', width: 'width', height: 'height' },
  },
};

interface Harness {
  service: AiService;
  config: ReturnType<typeof testConfig>;
  index: RecordingIndex;
  events: AiServiceEvent[];
  captures: Array<{ crop?: { x: number; y: number; width: number; height: number }; maxWidth: number }>;
  requests: DetectionRequest[];
  close: () => Promise<void>;
  root: string;
}

function harness(options: {
  cameraAi?: CameraAiConfig;
  detections?: (request: DetectionRequest) => Detection[];
  /** Async detector override, for in-flight and timing tests. */
  detect?: (request: DetectionRequest) => Promise<Detection[]>;
  captureSize?: { width: number; height: number };
  root?: string;
  overridesPath?: string;
  now?: () => number;
  /** Simulates a config with no usable provider at all. */
  noProvider?: boolean;
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'icamify-ai-'));
  const config = testConfig({
    cameras: [{ ...CAMERA, ai: options.cameraAi ?? { enabled: true, providerId: 'stub', labels: ['person'], minConfidence: 0.5 } }],
  });
  config.ai = { ...config.ai, providers: options.noProvider === true ? [] : [STUB_PROVIDER] };
  if (options.noProvider !== true) config.ai.defaultProviderId = 'stub';

  const events: AiServiceEvent[] = [];
  const captures: Harness['captures'] = [];
  const requests: DetectionRequest[] = [];
  const size = options.captureSize ?? { width: 320, height: 180 };

  const capture: CaptureFrame = async (_camera, captureOptions) => {
    captures.push(captureOptions);
    return { jpeg: jpegHeader(size.width, size.height), width: size.width, height: size.height };
  };

  const client: AiProviderClient = {
    id: 'stub',
    capabilities: ['object'],
    async detect(request) {
      requests.push(request);
      if (options.detect !== undefined) return await options.detect(request);
      return options.detections?.(request) ?? [];
    },
    async health() {
      return { ok: true };
    },
    async close() {
      return undefined;
    },
  };

  const gateway = new Gateway({ providers: [STUB_PROVIDER], createProvider: () => client });
  const index = new RecordingIndex({ path: ':memory:' });
  const service = new AiService({
    config,
    gateway,
    capture,
    index,
    recording: undefined,
    snapshotsDir: join(root, 'snapshots'),
    ...(options.overridesPath === undefined ? {} : { overridesPath: options.overridesPath }),
    ...(options.now === undefined ? {} : { now: options.now }),
    log: () => {},
    onEvent: (event) => events.push(event),
  });

  return {
    service,
    config,
    index,
    events,
    captures,
    requests,
    root,
    close: async () => {
      await service.stop();
      index.close();
    },
  };
}

describe('AiService', () => {
  test('detects, filters, normalizes and indexes a detection', async () => {
    const test_ = harness({
      detections: () => [
        { label: 'person', confidence: 0.91, box: { x: 10, y: 20, width: 60, height: 120 } },
        { label: 'dog', confidence: 0.95, box: { x: 1, y: 1, width: 20, height: 20 } },
        { label: 'person', confidence: 0.2, box: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    });
    try {
      await test_.service.start();
      const summary = await test_.service.analyze('front-door', { manual: true });

      assert.ok(summary !== undefined);
      // "dog" is not in the camera's label filter, and the weak person is below
      // the confidence floor.
      assert.deepEqual(summary.detections.map((detection) => detection.label), ['person']);
      assert.equal(summary.detections[0]?.confidence, 0.91);
      assert.deepEqual(summary.detections[0]?.box, {
        x: 0.031,
        y: 0.111,
        width: 0.188,
        height: 0.667,
        normalized: true,
      });
      assert.equal(test_.requests.length, 1);
      assert.equal(test_.requests[0]?.task, 'object');
      assert.deepEqual(test_.requests[0]?.labels, ['person']);

      const stored = test_.index.listEvents({ kind: 'ai.object' });
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.label, 'person');
      assert.equal(stored[0]?.confidence, 0.91);
      assert.equal(stored[0]?.providerId, 'stub');

      const detectionEvent = test_.events.find((event) => event.type === 'ai:detection');
      assert.ok(detectionEvent !== undefined);
    } finally {
      await test_.close();
    }
  });

  test('crops to the motion region and maps boxes back to the full frame', async () => {
    const test_ = harness({
      cameraAi: { enabled: true, providerId: 'stub', labels: ['person'], cropToMotion: true },
      captureSize: { width: 160, height: 90 },
      detections: () => [{ label: 'person', confidence: 0.9, box: { x: 0, y: 0, width: 160, height: 90 } }],
    });
    try {
      await test_.service.start();
      const summary = await test_.service.analyze('front-door', {
        manual: true,
        boxes: [{ x: 0.25, y: 0.5, width: 0.5, height: 0.5, normalized: true }],
      });

      const crop = test_.captures[0]?.crop;
      assert.ok(crop !== undefined);
      // The union box is padded by 8% and clamped.
      assert.ok(crop.x < 0.25 && crop.y < 0.5);
      assert.ok(crop.width > 0.5 && crop.height > 0.5);

      const box = summary?.detections[0]?.box;
      assert.ok(box !== undefined);
      // A detection filling the crop must map back onto the crop rectangle.
      assert.equal(box.x, crop.x);
      assert.equal(box.y, crop.y);
      assert.ok(Math.abs(box.width - crop.width) < 0.002);
      assert.ok(Math.abs(box.height - crop.height) < 0.002);
    } finally {
      await test_.close();
    }
  });

  test('saves a snapshot only when the camera asks for one', async () => {
    const quiet = harness({ detections: () => [{ label: 'person', confidence: 0.9 }] });
    try {
      await quiet.service.start();
      const summary = await quiet.service.analyze('front-door', { manual: true });
      assert.equal(summary?.snapshot, undefined);
    } finally {
      await quiet.close();
    }

    const saving = harness({
      cameraAi: { enabled: true, providerId: 'stub', labels: ['person'], saveSnapshots: true },
      detections: () => [{ label: 'person', confidence: 0.9 }],
    });
    try {
      await saving.service.start();
      const summary = await saving.service.analyze('front-door', { manual: true });
      assert.ok(summary?.snapshot !== undefined);
      const file = join(saving.root, 'snapshots', ...summary.snapshot.split('/'));
      assert.equal(readFileSync(file).subarray(0, 2).toString('hex'), 'ffd8');
      assert.equal(saving.index.getEvent(summary.eventIds[0] ?? '')?.snapshot, summary.snapshot);
    } finally {
      await saving.close();
      rmSync(saving.root, { recursive: true, force: true });
    }
  });

  test('throttles motion-driven analysis but never manual analysis', async () => {
    let clock = 1_000_000;
    const test_ = harness({
      cameraAi: { enabled: true, providerId: 'stub', labels: ['person'], intervalMs: 5000 },
      detections: () => [{ label: 'person', confidence: 0.9 }],
      now: () => clock,
    });
    try {
      await test_.service.start();
      assert.ok((await test_.service.analyze('front-door')) !== undefined);
      assert.equal(await test_.service.analyze('front-door'), undefined);
      assert.equal(test_.requests.length, 1);

      clock += 6000;
      assert.ok((await test_.service.analyze('front-door')) !== undefined);
      assert.equal(test_.requests.length, 2);

      // A manual run ignores the interval: the operator asked for it.
      clock += 100;
      assert.ok((await test_.service.analyze('front-door', { manual: true })) !== undefined);
      assert.equal(test_.requests.length, 3);
    } finally {
      await test_.close();
      rmSync(test_.root, { recursive: true, force: true });
    }
  });

  test('does not start a second analysis while one is in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test_ = harness({
      detect: async () => {
        await gate;
        return [];
      },
    });
    try {
      await test_.service.start();
      const first = test_.service.analyze('front-door', { manual: true });
      const second = await test_.service.analyze('front-door', { manual: true });
      assert.equal(second, undefined);
      release?.();
      assert.ok((await first) === undefined, 'no detections means no summary');
      assert.equal(test_.requests.length, 1);
    } finally {
      await test_.close();
      rmSync(test_.root, { recursive: true, force: true });
    }
  });

  test('reports a camera with no usable provider instead of throwing', async () => {
    const test_ = harness({ cameraAi: { enabled: true, providerId: 'missing' }, noProvider: true });
    try {
      await test_.service.start();
      const summary = await test_.service.analyze('front-door', { manual: true });
      assert.equal(summary, undefined);
      const status = test_.service.status('front-door');
      assert.match(String(status?.lastError), /not configured/);
      assert.equal(test_.captures.length, 0);
    } finally {
      await test_.close();
      rmSync(test_.root, { recursive: true, force: true });
    }
  });

  test('persists runtime overrides so a restart keeps the operator choice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icamify-ai-'));
    const overridesPath = join(root, 'ai-overrides.json');
    const first = harness({ root, overridesPath, detections: () => [] });
    try {
      await first.service.start();
      const status = await first.service.configure('front-door', {
        task: 'face',
        labels: ['face', 'person'],
        minConfidence: 0.8,
      });
      assert.equal(status.task, 'face');
      assert.deepEqual(status.labels, ['face', 'person']);
      assert.equal(status.minConfidence, 0.8);

      const persisted = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(persisted['front-door'], { task: 'face', labels: ['face', 'person'], minConfidence: 0.8 });
    } finally {
      await first.close();
    }

    const second = harness({ root, overridesPath, detections: () => [] });
    try {
      await second.service.start();
      assert.equal(second.service.status('front-door')?.task, 'face');
    } finally {
      await second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid overrides', async () => {
    const test_ = harness();
    try {
      await test_.service.start();
      await assert.rejects(test_.service.configure('front-door', { minConfidence: 2 }), /between 0 and 1/);
      await assert.rejects(test_.service.configure('nope', { task: 'face' }), /does not exist/);
    } finally {
      await test_.close();
      rmSync(test_.root, { recursive: true, force: true });
    }
  });
});
