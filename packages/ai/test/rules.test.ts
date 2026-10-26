import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuleConfig } from '@icamify/core';
import { explainRule, interpolateTemplate, matchingRules, ruleMatches, type RuleEvent } from '../src/rules.ts';

function rule(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    id: 'r1',
    name: 'Person at the door',
    when: { ai: { labels: ['person'], minConfidence: 0.6 }, events: ['ai.object'] },
    then: { notify: { channels: ['push'], title: 'Person' } },
    ...overrides,
  };
}

function event(overrides: Partial<RuleEvent> = {}): RuleEvent {
  return { cameraId: 'front', kind: 'ai.object', at: 1_000, label: 'person', confidence: 0.9, ...overrides };
}

const context = { at: 1_000 };

describe('rule matching', () => {
  it('matches labels and confidence', () => {
    assert.equal(ruleMatches(rule(), event(), context), true);
    assert.equal(ruleMatches(rule(), event({ label: 'dog' }), context), false);
    assert.equal(ruleMatches(rule(), event({ confidence: 0.5 }), context), false);
    assert.match(String(explainRule(rule(), event({ confidence: 0.5 }), context)), /below 0.6/);
  });

  it('treats empty camera and event filters as any', () => {
    const anyRule = rule({ when: {} });
    assert.equal(ruleMatches(anyRule, event({ kind: 'motion', cameraId: 'garage' }), context), true);
  });

  it('requires the configured cameras and event kinds', () => {
    assert.equal(ruleMatches(rule({ when: { cameraIds: ['front'] } }), event(), context), true);
    assert.equal(ruleMatches(rule({ when: { cameraIds: ['rear'] } }), event(), context), false);
    assert.equal(ruleMatches(rule({ when: { events: ['motion'] } }), event(), context), false);
  });

  it('ignores disabled rules', () => {
    assert.equal(ruleMatches(rule({ enabled: false }), event(), context), false);
    assert.match(String(explainRule(rule({ enabled: false }), event(), context)), /disabled/);
  });

  it('honours minimum episode duration', () => {
    const slow = rule({ when: { minDurationSeconds: 5 } });
    assert.equal(ruleMatches(slow, event({ durationSeconds: 3 }), context), false);
    assert.equal(ruleMatches(slow, event({ durationSeconds: 7 }), context), true);
  });

  it('evaluates inside/outside schedules through the provided clock', () => {
    const inside = rule({ when: { scheduleIds: ['night'] } });
    assert.equal(ruleMatches(inside, event(), { at: 1_000, schedulesActive: (ids) => ids.includes('night') }), true);
    assert.equal(ruleMatches(inside, event(), { at: 1_000, schedulesActive: () => false }), false);
    assert.equal(ruleMatches(inside, event(), { at: 1_000 }), false);

    const outside = rule({ when: { outsideScheduleIds: ['business'] } });
    assert.equal(ruleMatches(outside, event(), { at: 1_000, schedulesActive: () => true }), false);
    assert.equal(ruleMatches(outside, event(), { at: 1_000, schedulesActive: () => false }), true);
  });

  it('filters on the provider that produced the detection', () => {
    const scoped = rule({ when: { ai: { providerIds: ['cpai'] } } });
    assert.equal(ruleMatches(scoped, event({ providerId: 'cpai' }), context), true);
    assert.equal(ruleMatches(scoped, event({ providerId: 'ds' }), context), false);
    assert.equal(ruleMatches(scoped, event(), context), false);
  });
});

describe('rule ordering', () => {
  it('runs lower priority numbers first and keeps declaration order for ties', () => {
    const rules = [
      rule({ id: 'later', priority: 200, when: {} }),
      rule({ id: 'first', priority: 10, when: {} }),
      rule({ id: 'tie-a', priority: 50, when: {} }),
      rule({ id: 'tie-b', priority: 50, when: {} }),
      rule({ id: 'never', when: { cameraIds: ['elsewhere'] } }),
    ];
    assert.deepEqual(
      matchingRules(rules, event(), context).map((entry) => entry.id),
      ['first', 'tie-a', 'tie-b', 'later'],
    );
  });
});

describe('templates', () => {
  it('replaces known placeholders and keeps unknown ones visible', () => {
    const text = interpolateTemplate('{cameraName}: {label} ({confidence}) at {time} {nope}', {
      cameraName: 'Front door',
      label: 'person',
      confidence: 0.91,
      time: '12:00',
    });
    assert.equal(text, 'Front door: person (0.91) at 12:00 {nope}');
  });
});
