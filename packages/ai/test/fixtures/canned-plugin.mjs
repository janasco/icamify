/**
 * Test plugin for the worker bridge.
 *
 * `config.mode` selects the behaviour so one fixture can exercise the happy
 * path, a hung detector and a crashing one.
 */
export function createProvider(config, context) {
  context.log('info', 'canned plugin created', { mode: config.mode });

  return {
    id: 'canned',
    capabilities: ['object'],
    async detect() {
      if (config.mode === 'hang') return await new Promise(() => undefined);
      if (config.mode === 'throw') throw new Error('canned detector exploded');
      return [
        { label: 'person', confidence: 0.91, box: { x: 12, y: 24, width: 40, height: 60 } },
        { label: 'dog', confidence: 0.72 },
      ];
    },
    async health() {
      return { ok: true };
    },
    async close() {},
  };
}
