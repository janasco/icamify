import type { EventKind, RuleConfig } from '@icamify/core';
import { labelMatches } from './mapping.ts';

/**
 * Rule matching.
 *
 * Pure predicates over a `RuleEvent`: no clocks beyond the timestamp in the
 * context, no I/O, no shared state. The engine that keeps cooldowns and executes
 * actions is in the server; this file is what can be unit-tested exhaustively.
 */

export interface RuleEvent {
  /** Stable id of the underlying episode, so `start`/`end` cannot double-fire. */
  id?: string;
  cameraId: string;
  cameraName?: string;
  kind: EventKind;
  /** Epoch milliseconds. */
  at: number;
  label?: string;
  confidence?: number;
  providerId?: string;
  /** How long the episode had lasted when this event was raised. */
  durationSeconds?: number;
  phase?: 'start' | 'end';
}

export interface RuleContext {
  at: number;
  /** True when at least one of these schedules is inside a window right now. */
  schedulesActive?: (scheduleIds: string[]) => boolean;
}

/** Returns the reason a rule did not match, or `undefined` when it does. */
export function explainRule(rule: RuleConfig, event: RuleEvent, context: RuleContext): string | undefined {
  if (rule.enabled === false) return 'rule is disabled';
  const when = rule.when;

  if ((when.cameraIds ?? []).length > 0 && !(when.cameraIds ?? []).includes(event.cameraId)) {
    return `camera "${event.cameraId}" is not selected`;
  }

  const events = when.events ?? [];
  if (events.length > 0 && !events.includes(event.kind)) {
    return `event "${event.kind}" is not selected`;
  }

  const ai = when.ai;
  if (ai !== undefined) {
    if ((ai.providerIds ?? []).length > 0 && (event.providerId === undefined || !(ai.providerIds ?? []).includes(event.providerId))) {
      return `provider "${event.providerId ?? 'none'}" is not selected`;
    }
    if ((ai.labels ?? []).length > 0) {
      if (event.label === undefined) return 'event has no label to match';
      if (!labelMatches(event.label, ai.labels)) return `label "${event.label}" is not selected`;
    }
    const minConfidence = ai.minConfidence ?? 0;
    if (minConfidence > 0 && (event.confidence ?? 0) < minConfidence) {
      return `confidence ${event.confidence ?? 0} is below ${minConfidence}`;
    }
  }

  const required = when.minDurationSeconds ?? 0;
  if (required > 0 && (event.durationSeconds ?? 0) < required) {
    return `episode is ${Math.round(event.durationSeconds ?? 0)}s, needs ${required}s`;
  }

  const inside = when.scheduleIds ?? [];
  if (inside.length > 0) {
    if (context.schedulesActive === undefined) return 'schedules are not available';
    if (!context.schedulesActive(inside)) return 'outside the required schedule';
  }

  const outside = when.outsideScheduleIds ?? [];
  if (outside.length > 0) {
    if (context.schedulesActive === undefined) return 'schedules are not available';
    if (context.schedulesActive(outside)) return 'inside an excluded schedule';
  }

  return undefined;
}

export function ruleMatches(rule: RuleConfig, event: RuleEvent, context: RuleContext): boolean {
  return explainRule(rule, event, context) === undefined;
}

/** Matching rules in execution order (lower `priority` first). */
export function matchingRules(rules: ReadonlyArray<RuleConfig>, event: RuleEvent, context: RuleContext): RuleConfig[] {
  return rules
    .filter((rule) => ruleMatches(rule, event, context))
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => (left.rule.priority ?? 100) - (right.rule.priority ?? 100) || left.index - right.index)
    .map((entry) => entry.rule);
}

/**
 * Substitutes `{placeholder}` tokens in notification text.
 *
 * Unknown placeholders are left untouched rather than blanked: a typo in a
 * template should be visible in the alert, not silently produce an empty message.
 */
export function interpolateTemplate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
