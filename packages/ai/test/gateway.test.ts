import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiProviderConfig } from '@icamify/core';
import type { AiProviderClient, Detection, DetectionRequest } from '../src/index.ts';
import { AiError } from '../src/errors.ts';
import { Gateway } from '../src/gateway.ts';

const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function request(): DetectionRequest {
  return { camera: { id: 'cam', name: 'Camera' }, image: IMAGE, mimeType: 'image/jpeg', task: 'object' };
}

const PROVIDER: AiProviderConfig = {
  id: 'p1',
  name: 'Provider one',
  type: 'generic-http',
  url: 'http://ai.local/detect',
  concurrency: 1,
  timeoutMs: 100,
  response: {
    detectionsPath: 'predictions',
    labelPath: 'label',
    confidencePath: 'confidence',
    box: { x: 'x', y: 'y', width: 'width', height: 'height' },
  },
};

/** Provider double whose behaviour is driven by the test. */
function scripted(behaviour: (call: number) => Promise<Detection[]>): { client: AiProviderClient; calls: () => number } {
  let calls = 0;
  const client: AiProviderClient = {
    id: 'p1',
    capabilities: ['object'],
    async detect() {
      calls += 1;
      return await behaviour(calls);
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
    async close() {
      return undefined;
    },
  };
  return { client, calls: () => calls };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AI gateway queueing', () => {
  it('drops frames beyond the queue limit instead of growing a backlog', async () => {
    const gate = defer();
    const { client } = scripted(async () => {
      await gate.promise;
      return [{ label: 'person', confidence: 0.9 }];
    });
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client, maxQueuePerProvider: 1 });

    const first = gateway.detect('p1', request());
    const second = gateway.detect('p1', request());
    await assert.rejects(gateway.detect('p1', request()), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'busy');
      return true;
    });

    gate.resolve();
    assert.equal((await first).length, 1);
    assert.equal((await second).length, 1);
    await gateway.close();
  });

  it('runs up to `concurrency` requests at once', async () => {
    let active = 0;
    let peak = 0;
    const { client } = scripted(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [];
    });
    const gateway = new Gateway({
      providers: [{ ...PROVIDER, concurrency: 2 }],
      createProvider: () => client,
      maxQueuePerProvider: 4,
    });
    await Promise.all([gateway.detect('p1', request()), gateway.detect('p1', request())]);
    assert.equal(peak, 2);
    await gateway.close();
  });
});

describe('AI gateway resilience', () => {
  it('opens the circuit after repeated failures and skips calls while it is open', async () => {
    const { client, calls } = scripted(async () => {
      throw new AiError('unavailable', 'p1', 'connect ECONNREFUSED');
    });
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client, failureThreshold: 2, cooldownMs: 60_000 });

    await assert.rejects(gateway.detect('p1', request()));
    await assert.rejects(gateway.detect('p1', request()));
    assert.equal(calls(), 2);

    await assert.rejects(gateway.detect('p1', request()), /cooldown/);
    assert.equal(calls(), 2, 'a call while the circuit is open must not reach the provider');
    assert.equal(gateway.status()[0]?.circuit, 'open');
    await gateway.close();
  });

  it('does not trip the breaker for configuration errors', async () => {
    const { client } = scripted(async () => {
      throw new AiError('invalid-response', 'p1', 'response path is not an array');
    });
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client, failureThreshold: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(gateway.detect('p1', request()));
    }
    assert.equal(gateway.status()[0]?.circuit, 'closed');
    await gateway.close();
  });

  it('recovers and closes the breaker after a success', async () => {
    const { client } = scripted(async (call) => {
      if (call === 1) throw new AiError('unavailable', 'p1', 'temporary');
      return [{ label: 'person', confidence: 0.9 }];
    });
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client, failureThreshold: 3 });
    await assert.rejects(gateway.detect('p1', request()));
    await gateway.detect('p1', request());
    assert.equal(gateway.status()[0]?.failures, 0);
    assert.equal(gateway.status()[0]?.errors, 1);
    await gateway.close();
  });

  it('enforces the timeout even when a provider ignores its signal', async () => {
    const { client } = scripted(() => new Promise<Detection[]>(() => undefined));
    const gateway = new Gateway({ providers: [{ ...PROVIDER, timeoutMs: 10 }], createProvider: () => client });
    await assert.rejects(gateway.detect('p1', request()), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'timeout');
      return true;
    });
    await gateway.close();
  });

  it('rejects unknown, disabled and closed-gateway calls', async () => {
    const { client } = scripted(async () => []);
    const gateway = new Gateway({
      providers: [PROVIDER, { ...PROVIDER, id: 'off', name: 'Off', enabled: false }],
      createProvider: () => client,
    });
    await assert.rejects(gateway.detect('nope', request()), /not configured/);
    await assert.rejects(gateway.detect('off', request()), /disabled/);
    await gateway.close();
    await assert.rejects(gateway.detect('p1', request()), /shutting down/);
  });

  it('resolves the camera provider against the configured default', async () => {
    const { client } = scripted(async () => []);
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client });
    assert.equal(gateway.resolveProviderId(undefined, 'p1'), 'p1');
    assert.equal(gateway.resolveProviderId('missing', 'p1'), 'p1');
    assert.equal(gateway.resolveProviderId('p1', undefined), 'p1');
    assert.equal(gateway.resolveProviderId(undefined, undefined), undefined);
    assert.deepEqual(gateway.capabilitiesOf('p1'), ['object']);
    await gateway.close();
  });

  it('reports provider health', async () => {
    const { client } = scripted(async () => []);
    const gateway = new Gateway({ providers: [PROVIDER], createProvider: () => client });
    assert.deepEqual(await gateway.health(), [{ providerId: 'p1', ok: true, latencyMs: 1 }]);
    await gateway.close();
  });
});
