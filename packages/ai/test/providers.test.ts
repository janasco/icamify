import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CodeProjectProvider } from '@icamify/core';
import type { AiProviderClient, DetectionRequest } from '../src/index.ts';
import { createCodeProjectProvider } from '../src/providers/codeproject.ts';
import { createDeepStackProvider } from '../src/providers/deepstack.ts';
import { createGenericProvider } from '../src/providers/generic.ts';

function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

const IMAGE = jpegHeader(640, 360);

function request(overrides: Partial<DetectionRequest> = {}): DetectionRequest {
  return {
    camera: { id: 'front', name: 'Front door' },
    image: IMAGE,
    mimeType: 'image/jpeg',
    task: 'object',
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Records the request and answers with a canned JSON payload. */
function fakeFetch(payload: unknown, status = 200): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

describe('CodeProject.AI provider', () => {
  const config: CodeProjectProvider = {
    id: 'cpai',
    name: 'CodeProject',
    type: 'codeproject-ai',
    url: 'http://127.0.0.1:32168/',
    apiKey: 'secret',
    capabilities: ['object', 'face', 'lpr', 'scene'],
  };

  it('maps object predictions into pixel boxes', async () => {
    const fake = fakeFetch({
      success: true,
      predictions: [
        { label: 'person', confidence: 0.87, x_min: 32, y_min: 18, x_max: 96, y_max: 180 },
        { label: 'car', confidence: 0.55, x_min: 400, y_min: 200, x_max: 500, y_max: 300 },
      ],
    });
    const client = createCodeProjectProvider({ ...config, capabilities: ['object'] }, { fetch: fake.fetch });
    const detections = await client.detect(request());

    assert.equal(detections.length, 2);
    assert.deepEqual(detections[0], {
      label: 'person',
      confidence: 0.87,
      box: { x: 32, y: 18, width: 64, height: 162, normalized: false },
    });
    assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:32168/v1/vision/detection');
    assert.equal(fake.calls[0]?.init?.method, 'POST');
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'secret');
    assert.ok(fake.calls[0]?.init?.body instanceof FormData);
  });

  it('uses task paths and labels face detections that carry no label', async () => {
    const fake = fakeFetch({ success: true, predictions: [{ confidence: 0.99, userid: 'alice', x_min: 1, y_min: 2, x_max: 11, y_max: 22 }] });
    const client = createCodeProjectProvider(config, { fetch: fake.fetch });
    const detections = await client.detect(request({ task: 'face' }));

    assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:32168/v1/vision/face');
    assert.equal(detections[0]?.label, 'face');
    assert.deepEqual(detections[0]?.extra, { userId: 'alice' });
  });

  it('reads a scene label with no box', async () => {
    const fake = fakeFetch({ success: true, label: 'driveway', confidence: 0.8 });
    const client = createCodeProjectProvider(config, { fetch: fake.fetch });
    const detections = await client.detect(request({ task: 'scene' }));
    assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:32168/v1/vision/scene');
    assert.deepEqual(detections, [{ label: 'driveway', confidence: 0.8 }]);
  });

  it('honours the endpoint override (renamed ALPR module)', async () => {
    const fake = fakeFetch({ success: true, predictions: [] });
    const client = createCodeProjectProvider({ ...config, endpoint: '/v1/image/alpr' }, { fetch: fake.fetch });
    await client.detect(request({ task: 'lpr' }));
    assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:32168/v1/image/alpr');
  });

  it('filters detections below the requested confidence', async () => {
    const fake = fakeFetch({
      success: true,
      predictions: [
        { label: 'person', confidence: 0.3, x_min: 1, y_min: 1, x_max: 10, y_max: 10 },
        { label: 'person', confidence: 0.9, x_min: 1, y_min: 1, x_max: 10, y_max: 10 },
      ],
    });
    const client = createCodeProjectProvider({ ...config, capabilities: ['object'] }, { fetch: fake.fetch });
    assert.equal((await client.detect(request({ minConfidence: 0.6 }))).length, 1);
  });

  it('reports success=false and missing capabilities', async () => {
    const failing = createCodeProjectProvider(
      { ...config, capabilities: ['object'] },
      { fetch: fakeFetch({ success: false, error: 'ObjectDetection module is not installed' }).fetch },
    );
    await assert.rejects(failing.detect(request()), /ObjectDetection module is not installed/);

    const limited = createCodeProjectProvider({ ...config, capabilities: ['object'] }, { fetch: fakeFetch({}).fetch });
    await assert.rejects(limited.detect(request({ task: 'lpr' })), /does not declare the "lpr" capability/);
  });

  it('surfaces HTTP failures with their status', async () => {
    const client = createCodeProjectProvider({ ...config, capabilities: ['object'] }, { fetch: fakeFetch('unauthorised', 401).fetch });
    await assert.rejects(client.detect(request()), (error: unknown) => {
      const failure = error as { code?: string; status?: number; message?: string };
      assert.equal(failure.code, 'failed');
      assert.equal(failure.status, 401);
      assert.match(String(failure.message), /401/);
      return true;
    });
  });
});

describe('DeepStack provider', () => {
  it('uses its own paths and API key header', async () => {
    const fake = fakeFetch({ success: true, predictions: [{ label: 'AB 12 CD', confidence: 0.77, x_min: 5, y_min: 5, x_max: 105, y_max: 45 }] });
    const client = createDeepStackProvider(
      { id: 'ds', name: 'DeepStack', type: 'deepstack', url: 'http://10.0.0.5:5000/', apiKey: 'k', mode: 'lpr', capabilities: ['lpr'] },
      { fetch: fake.fetch },
    );
    const detections = await client.detect(request({ task: 'lpr' }));

    assert.equal(fake.calls[0]?.url, 'http://10.0.0.5:5000/v1/vision/alpr');
    assert.equal((fake.calls[0]?.init?.headers as Record<string, string>)['X-API-KEY'], 'k');
    assert.equal(detections[0]?.label, 'AB 12 CD');
  });

  it('applies the provider confidence floor unless the camera sets one', async () => {
    const payload = {
      success: true,
      predictions: [
        { label: 'person', confidence: 0.2, x_min: 0, y_min: 0, x_max: 10, y_max: 10 },
        { label: 'person', confidence: 0.8, x_min: 0, y_min: 0, x_max: 10, y_max: 10 },
      ],
    };
    const client = createDeepStackProvider(
      { id: 'ds', name: 'DS', type: 'deepstack', url: 'http://x:5000', mode: 'object', minConfidence: 0.5, capabilities: ['object'] },
      { fetch: fakeFetch(payload).fetch },
    );
    assert.equal((await client.detect(request())).length, 1);
    assert.equal((await client.detect(request({ minConfidence: 0.1 }))).length, 2);
  });
});

describe('generic HTTP provider', () => {
  const response = {
    detectionsPath: 'result.items',
    labelPath: 'class',
    confidencePath: 'score',
    box: { x: 'bbox.left', y: 'bbox.top', width: 'bbox.w', height: 'bbox.h', normalized: true },
  };

  it('base64-encodes the frame by default and maps the configured paths', async () => {
    const fake = fakeFetch({ result: { items: [{ class: 'person', score: 0.93, bbox: { left: 0.1, top: 0.2, w: 0.3, h: 0.4 } }] } });
    const client = createGenericProvider(
      { id: 'gen', name: 'Generic', type: 'generic-http', url: 'http://ai.local/detect', response },
      { fetch: fake.fetch },
    );
    const detections = await client.detect(request());

    const body = JSON.parse(String(fake.calls[0]?.init?.body)) as { image: string; minConfidence: number };
    assert.equal(body.image, IMAGE.toString('base64'));
    assert.equal(body.minConfidence, 0.4);
    assert.deepEqual(detections[0]?.box, { x: 64, y: 72, width: 192, height: 144, normalized: false });
  });

  it('supports templates and multipart uploads', async () => {
    const json = fakeFetch({ result: { items: [] } });
    const templated = createGenericProvider(
      {
        id: 'gen',
        name: 'Generic',
        type: 'generic-http',
        url: 'http://ai.local/detect',
        requestTemplate: '{"frame":"{{image}}","task":"{{task}}"}',
        response,
      },
      { fetch: json.fetch },
    );
    await templated.detect(request({ task: 'object' }));
    const body = JSON.parse(String(json.calls[0]?.init?.body)) as { frame: string; task: string };
    assert.equal(body.task, 'object');
    assert.equal(body.frame, IMAGE.toString('base64'));

    const multipart = fakeFetch({ result: { items: [] } });
    const uploaded = createGenericProvider(
      { id: 'gen', name: 'Generic', type: 'generic-http', url: 'http://ai.local/detect', contentType: 'multipart', response },
      { fetch: multipart.fetch },
    );
    await uploaded.detect(request());
    assert.ok(multipart.calls[0]?.init?.body instanceof FormData);
  });

  it('rejects a response whose detections path is not an array', async () => {
    const client = createGenericProvider(
      { id: 'gen', name: 'Generic', type: 'generic-http', url: 'http://ai.local/detect', response },
      { fetch: fakeFetch({ result: {} }).fetch },
    );
    await assert.rejects(client.detect(request()), /is not an array/);
  });
});

describe('provider health', () => {
  it('reports a reachable service as healthy', async () => {
    const fake = fakeFetch({ success: true, predictions: [] });
    const client: AiProviderClient = createCodeProjectProvider(
      { id: 'cpai', name: 'CP', type: 'codeproject-ai', url: 'http://127.0.0.1:32168', capabilities: ['object'] },
      { fetch: fake.fetch },
    );
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(typeof health.latencyMs, 'number');
  });

  it('reports an unreachable service with a reason', async () => {
    const client = createDeepStackProvider(
      { id: 'ds', name: 'DS', type: 'deepstack', url: 'http://10.255.255.1:5000', capabilities: ['object'] },
      {
        fetch: async () => {
          throw new Error('fetch failed: connect ECONNREFUSED');
        },
      },
    );
    const health = await client.health();
    assert.equal(health.ok, false);
    assert.match(String(health.detail), /ECONNREFUSED/);
  });
});
