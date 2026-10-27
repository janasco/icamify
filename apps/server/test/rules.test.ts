import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import type { NotificationChannel, RuleConfig } from '@icamify/core';
import { RecordingIndex } from '@icamify/storage';
import { Notifier, type AlertPayload } from '../src/alerts/notifier.ts';
import type { RecordingManager } from '../src/recording/manager.ts';
import { RuleEngine } from '../src/rules/engine.ts';
import { testConfig } from './helpers.ts';

interface Received {
  body: string;
  signature?: string;
  contentType?: string;
}

const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

/** Tiny webhook receiver: records bodies and answers 204. */
async function webhookServer(status = 204): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        ...(typeof request.headers['x-icamify-signature'] === 'string'
          ? { signature: request.headers['x-icamify-signature'] }
          : {}),
        ...(typeof request.headers['content-type'] === 'string'
          ? { contentType: request.headers['content-type'] }
          : {}),
      });
      response.writeHead(status).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/hook`, received };
}

const AI_RULE: RuleConfig = {
  id: 'person-alert',
  name: 'Person at the door',
  when: { events: ['ai.object'], ai: { labels: ['person'], minConfidence: 0.6 }, cooldownSeconds: 60 },
  then: {
    record: { enabled: true, seconds: 25 },
    notify: { channels: ['hook'], severity: 'warning' },
    markEvent: { label: 'person-alert' },
  },
};

function recordingStub(): { record: RecordingManager; triggers: Array<{ cameraId: string; kind: string; at: number; holdSeconds?: number }> } {
  const triggers: Array<{ cameraId: string; kind: string; at: number; holdSeconds?: number }> = [];
  const record = {
    trigger: (cameraId: string, kind: string, at: number, _meta?: unknown, options?: { holdSeconds?: number }) => {
      triggers.push({ cameraId, kind, at, ...(options?.holdSeconds === undefined ? {} : { holdSeconds: options.holdSeconds }) });
    },
  } as unknown as RecordingManager;
  return { record, triggers };
}

function configWith(options: {
  rules: RuleConfig[];
  channel?: NotificationChannel;
  schedules?: ReturnType<typeof testConfig>['schedules'];
}) {
  const config = testConfig();
  config.rules = options.rules;
  config.schedules = options.schedules ?? [];
  config.notifications = {
    dedupeSeconds: 0,
    channels: [options.channel ?? { id: 'hook', name: 'Hook', type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
  };
  return config;
}

describe('RuleEngine', () => {
  test('fires recording, notification and an indexed event for a matching detection', async () => {
    const hook = await webhookServer();
    const config = configWith({
      rules: [AI_RULE],
      channel: { id: 'hook', name: 'Hook', type: 'webhook', url: hook.url, hmacSecret: 'shakey' },
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record, triggers } = recordingStub();
    const notifier = new Notifier({ channels: config.notifications.channels ?? [], dedupeSeconds: 0, log: () => {} });

    try {
      const engine = new RuleEngine({ config, recording: record, index, notifier, log: () => {} });
      const outcomes = await engine.handle({
        id: 'episode-1',
        cameraId: 'front-door',
        cameraName: 'Front door',
        kind: 'ai.object',
        at: 1_700_000_000_000,
        label: 'person',
        confidence: 0.93,
        providerId: 'stub',
      });

      assert.equal(outcomes.length, 1);
      const outcome = outcomes[0]!;
      assert.equal(outcome.ruleId, 'person-alert');
      assert.equal(triggers.length, 1);
      assert.equal(triggers[0]?.kind, 'alert');
      assert.equal(triggers[0]?.holdSeconds, 25);
      assert.ok(outcome.actions.every((action) => action.ok), JSON.stringify(outcome.actions));

      assert.equal(hook.received.length, 1);
      const delivered = hook.received[0]!;
      const expected = createHmac('sha256', 'shakey').update(delivered.body).digest('hex');
      assert.equal(delivered.signature, `sha256=${expected}`);
      const payload = JSON.parse(delivered.body) as {
        type: string;
        event: { label: string; confidence: number };
        camera: { name: string };
        rule: { id: string };
      };
      assert.equal(payload.type, 'icamify.alert');
      assert.equal(payload.event.label, 'person');
      assert.equal(payload.event.confidence, 0.93);
      assert.equal(payload.camera.name, 'Front door');
      assert.equal(payload.rule.id, 'person-alert');

      const events = index.listEvents({ kind: 'rule' });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.label, 'person-alert');
      assert.equal(outcome.alertEventId, events[0]?.id);
    } finally {
      index.close();
    }
  });

  test('does not fire again inside the cooldown window', async () => {
    const config = configWith({ rules: [AI_RULE] });
    const index = new RecordingIndex({ path: ':memory:' });
    let clock = 1_000_000;
    const { record, triggers } = recordingStub();
    try {
      const engine = new RuleEngine({ config, recording: record, index, now: () => clock, log: () => {} });
      const event = {
        cameraId: 'front-door',
        kind: 'ai.object' as const,
        at: clock,
        label: 'person',
        confidence: 0.9,
      };
      assert.equal((await engine.handle({ ...event, id: 'a' })).length, 1);

      clock += 10_000;
      assert.equal((await engine.handle({ ...event, id: 'b', at: clock })).length, 0);

      clock += 60_000;
      assert.equal((await engine.handle({ ...event, id: 'c', at: clock })).length, 1);
      assert.equal(triggers.length, 2);
    } finally {
      index.close();
    }
  });

  test('applies minDurationSeconds to the end of a motion episode', async () => {
    const config = configWith({
      rules: [{ id: 'slow', name: 'Lingering motion', when: { events: ['motion'], minDurationSeconds: 5 }, then: {} }],
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    try {
      const engine = new RuleEngine({ config, recording: record, index, log: () => {} });
      const start = await engine.handle({
        id: 'ep',
        cameraId: 'front-door',
        kind: 'motion',
        at: 1_000,
        phase: 'start',
        durationSeconds: 0,
      });
      assert.equal(start.length, 0);

      const end = await engine.handle({
        id: 'ep',
        cameraId: 'front-door',
        kind: 'motion',
        at: 1_000,
        phase: 'end',
        durationSeconds: 7,
      });
      assert.equal(end.length, 1);
    } finally {
      index.close();
    }
  });

  test('fires an immediate motion rule once per episode, not on start and end', async () => {
    const config = configWith({ rules: [{ id: 'any-motion', name: 'Any motion', when: { events: ['motion'] }, then: {} }] });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    try {
      const engine = new RuleEngine({ config, recording: record, index, log: () => {} });
      assert.equal((await engine.handle({ id: 'ep', cameraId: 'front-door', kind: 'motion', at: 1_000, durationSeconds: 0 })).length, 1);
      assert.equal((await engine.handle({ id: 'ep', cameraId: 'front-door', kind: 'motion', at: 1_000, durationSeconds: 3 })).length, 0);
    } finally {
      index.close();
    }
  });

  test('honours schedules through the injected clock', async () => {
    const config = configWith({
      rules: [
        { id: 'night', name: 'Night only', when: { events: ['motion'], scheduleIds: ['night'] }, then: {} },
        { id: 'day', name: 'Day only', when: { events: ['motion'], outsideScheduleIds: ['night'] }, then: {} },
      ],
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    try {
      const atNight = new RuleEngine({ config, recording: record, index, scheduleActive: () => true, log: () => {} });
      const nightOutcomes = await atNight.handle({ id: 'n', cameraId: 'front-door', kind: 'motion', at: 1 });
      assert.deepEqual(nightOutcomes.map((outcome) => outcome.ruleId), ['night']);

      const atDay = new RuleEngine({ config, recording: record, index, scheduleActive: () => false, log: () => {} });
      const dayOutcomes = await atDay.handle({ id: 'd', cameraId: 'front-door', kind: 'motion', at: 2 });
      assert.deepEqual(dayOutcomes.map((outcome) => outcome.ruleId), ['day']);
    } finally {
      index.close();
    }
  });

  test('saves a snapshot for the snapshot action and links it to the event', async () => {
    const config = configWith({
      rules: [{ id: 'snap', name: 'Snapshot only', when: { events: ['motion'] }, then: { snapshot: { enabled: true } } }],
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    try {
      const engine = new RuleEngine({
        config,
        recording: record,
        index,
        snapshot: async () => 'front-door/2026-01-01/120000-person.jpg',
        log: () => {},
      });
      const outcomes = await engine.handle({ id: 'snap-1', cameraId: 'front-door', kind: 'motion', at: 1 });
      assert.equal(outcomes[0]?.snapshot, 'front-door/2026-01-01/120000-person.jpg');
      const stored = index.getEvent(outcomes[0]?.alertEventId ?? '');
      assert.equal(stored?.snapshot, 'front-door/2026-01-01/120000-person.jpg');
    } finally {
      index.close();
    }
  });

  test('drives PTZ through the injected controller, defaulting to the trigger camera', async () => {
    const config = configWith({
      rules: [
        { id: 'turn', name: 'Turn to gate', when: { events: ['motion'] }, then: { ptz: { preset: 'gate' } } },
        {
          id: 'elsewhere',
          name: 'Turn another camera',
          when: { events: ['ai.object'] },
          then: { ptz: { cameraId: 'back-yard', preset: 'drive' } },
        },
      ],
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    const calls: Array<{ cameraId: string; preset: string }> = [];
    try {
      const engine = new RuleEngine({
        config,
        recording: record,
        index,
        ptz: async (request) => {
          calls.push(request);
        },
        log: () => {},
      });
      const outcomes = await engine.handle({ id: 'p1', cameraId: 'front-door', kind: 'motion', at: 1 });
      assert.deepEqual(calls, [{ cameraId: 'front-door', preset: 'gate' }]);
      assert.equal(outcomes[0]?.actions.find((action) => action.action === 'ptz')?.ok, true);

      const second = await engine.handle({ id: 'a1', cameraId: 'front-door', kind: 'ai.object', at: 2, label: 'person' });
      assert.deepEqual(calls[1], { cameraId: 'back-yard', preset: 'drive' });
      assert.equal(second[0]?.actions.find((action) => action.action === 'ptz')?.ok, true);
    } finally {
      index.close();
    }
  });

  test('reports a failed PTZ move and actions it cannot execute instead of pretending they ran', async () => {
    const config = configWith({
      rules: [
        {
          id: 'ptz',
          name: 'PTZ on motion',
          when: { events: ['motion'] },
          then: { ptz: { cameraId: 'front-door', preset: 'gate' }, script: { path: '/bin/true' } },
        },
      ],
    });
    const index = new RecordingIndex({ path: ':memory:' });
    const { record } = recordingStub();
    const warnings: string[] = [];
    try {
      const unavailable = new RuleEngine({ config, recording: record, index, log: () => {} });
      const blocked = await unavailable.handle({ id: 'p0', cameraId: 'front-door', kind: 'motion', at: 1 });
      assert.equal(blocked[0]?.actions.find((action) => action.action === 'ptz')?.ok, false);

      const engine = new RuleEngine({
        config,
        recording: record,
        index,
        ptz: async () => {
          throw new Error('the camera rejected the credentials');
        },
        log: (line) => warnings.push(line),
      });
      const outcomes = await engine.handle({ id: 'p1', cameraId: 'front-door', kind: 'motion', at: 2 });
      const actions = outcomes[0]?.actions ?? [];
      assert.equal(actions.find((action) => action.action === 'ptz')?.ok, false);
      assert.match(actions.find((action) => action.action === 'ptz')?.detail ?? '', /rejected the credentials/);
      assert.equal(actions.find((action) => action.action === 'script')?.ok, false);
      assert.equal(warnings.filter((line) => line.includes('not implemented')).length, 1);

      // The warning is reported once per rule, not on every event.
      await engine.handle({ id: 'p2', cameraId: 'front-door', kind: 'motion', at: 3 });
      assert.equal(warnings.filter((line) => line.includes('not implemented')).length, 1);
    } finally {
      index.close();
    }
  });
});

describe('Notifier', () => {
  test('dedupes identical alerts inside the window', async () => {
    const hook = await webhookServer();
    const payload: AlertPayload = {
      ruleId: 'r1',
      ruleName: 'Rule',
      cameraId: 'front',
      cameraName: 'Front',
      kind: 'ai.object',
      label: 'person',
      at: 1,
      severity: 'warning',
      title: 'Person',
      message: 'Person detected',
    };
    const notifier = new Notifier({
      channels: [{ id: 'hook', name: 'Hook', type: 'webhook', url: hook.url }],
      dedupeSeconds: 60,
      log: () => {},
    });

    assert.deepEqual((await notifier.send(payload, ['hook']))[0]?.ok, true);
    assert.equal((await notifier.send(payload, ['hook']))[0]?.skipped, 'dedupe');
    assert.equal(hook.received.length, 1);
  });

  test('reports unimplemented channels and disabled channels', async () => {
    const notifier = new Notifier({
      channels: [
        { id: 'tg', name: 'Telegram', type: 'telegram', botToken: 'x', chatId: '1' },
        { id: 'off', name: 'Off hook', type: 'webhook', url: 'http://127.0.0.1:1/x', enabled: false },
      ],
      log: () => {},
    });
    const payload: AlertPayload = {
      ruleId: 'r1',
      ruleName: 'Rule',
      cameraId: 'front',
      cameraName: 'Front',
      kind: 'motion',
      at: 1,
      severity: 'info',
      title: 't',
      message: 'm',
    };
    const results = await notifier.send(payload, ['tg', 'off', 'unknown']);
    assert.equal(results[0]?.skipped, 'not-implemented');
    assert.equal(results[1]?.skipped, 'disabled');
    assert.equal(results[2]?.error, 'channel is not configured');
  });

  test('templates the body when a channel asks for it', async () => {
    const hook = await webhookServer();
    const notifier = new Notifier({
      channels: [
        {
          id: 'hook',
          name: 'Hook',
          type: 'webhook',
          url: hook.url,
          bodyTemplate: '{"text":"{label} at {cameraName}","confidence":"{confidence}"}',
        },
      ],
      log: () => {},
    });
    await notifier.send(
      {
        ruleId: 'r1',
        ruleName: 'Rule',
        cameraId: 'front',
        cameraName: 'Front door',
        kind: 'ai.object',
        label: 'person',
        confidence: 0.912,
        at: 1,
        severity: 'warning',
        title: 't',
        message: 'm',
      },
      ['hook'],
    );
    assert.deepEqual(JSON.parse(hook.received[0]?.body ?? '{}'), {
      text: 'person at Front door',
      confidence: '0.91',
    });
  });
});
