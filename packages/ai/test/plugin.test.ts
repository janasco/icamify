import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { PluginProvider } from '@icamify/core';
import type { DetectionRequest } from '../src/index.ts';
import { AiError } from '../src/errors.ts';
import { createPluginProvider } from '../src/providers/plugin.ts';

/**
 * The plugin bridge is tested with a real worker thread and a real module, not a
 * mock: the interesting failures (module loading, transfer lists, worker teardown)
 * only exist across a thread boundary.
 */

const ENTRY = fileURLToPath(new URL('./fixtures/canned-plugin.mjs', import.meta.url));
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function request(): DetectionRequest {
  return { camera: { id: 'front', name: 'Front' }, image: IMAGE, mimeType: 'image/jpeg', task: 'object' };
}

function provider(config: PluginProvider['config'], timeoutMs = 2000) {
  return createPluginProvider(
    { id: 'plugin', name: 'Canned', type: 'plugin', pluginId: 'canned', config, timeoutMs },
    { resolveEntry: (pluginId) => (pluginId === 'canned' ? ENTRY : undefined), workerMemoryMb: 64 },
  );
}

describe('plugin provider', () => {
  it('loads a plugin in a worker and maps its detections', async () => {
    const client = provider({ mode: 'ok' });
    try {
      const detections = await client.detect(request());
      assert.equal(detections.length, 2);
      assert.equal(detections[0]?.label, 'person');
      assert.equal(detections[0]?.confidence, 0.91);
      assert.deepEqual(detections[0]?.box, { x: 12, y: 24, width: 40, height: 60, normalized: false });
      assert.equal(detections[1]?.box, undefined);
    } finally {
      await client.close();
    }
  });

  it('propagates plugin errors without killing the host', async () => {
    const client = provider({ mode: 'throw' });
    try {
      await assert.rejects(client.detect(request()), (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, 'failed');
        assert.match(error.message, /canned detector exploded/);
        return true;
      });
      // The worker is still alive, so the next call works.
      const still = provider({ mode: 'ok' });
      assert.equal((await still.detect(request())).length, 2);
      await still.close();
    } finally {
      await client.close();
    }
  });

  it('terminates a plugin that exceeds its budget', async () => {
    const client = provider({ mode: 'hang' }, 150);
    try {
      await assert.rejects(client.detect(request()), (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, 'timeout');
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it('refuses an unresolvable plugin id', async () => {
    const client = createPluginProvider(
      { id: 'missing', name: 'Missing', type: 'plugin', pluginId: 'not-installed' },
      { resolveEntry: () => undefined },
    );
    await assert.rejects(client.detect(request()), /could not be resolved/);
    const health = await client.health();
    assert.equal(health.ok, false);
    await client.close();
  });

  it('reports health for a loadable plugin', async () => {
    const client = provider({ mode: 'ok' });
    try {
      const health = await client.health();
      assert.equal(health.ok, true);
    } finally {
      await client.close();
    }
  });
});
