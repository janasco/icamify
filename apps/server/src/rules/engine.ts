import type { ResolvedIcamifyConfig, RuleConfig, Severity } from '@icamify/core';
import { interpolateTemplate, matchingRules, type RuleEvent } from '@icamify/ai';
import type { RecordingIndex } from '@icamify/storage';
import type { AlertPayload, DeliveryResult, Notifier } from '../alerts/notifier.ts';
import type { RecordingManager } from '../recording/manager.ts';

/**
 * Rules engine.
 *
 * Evaluates `rules[]` against what happened and executes the matching actions.
 * Matching itself is pure (`@icamify/ai`'s `matchingRules`); this class owns the
 * stateful parts — per-rule cooldowns, per-episode de-duplication and the side
 * effects — plus the reporting the console shows.
 */

export interface RuleTrigger extends RuleEvent {
  boxes?: unknown;
  snapshot?: string;
  severity?: Severity;
  /** Motion-only: share of zone cells that changed at the peak of the episode. */
  peakPercent?: number;
}

export interface RuleActionReport {
  action: 'record' | 'snapshot' | 'notify' | 'markEvent' | 'ptz' | 'script';
  ok: boolean;
  detail?: string;
  delivery?: DeliveryResult[];
}

export interface RuleOutcome {
  ruleId: string;
  ruleName: string;
  at: number;
  cameraId: string;
  actions: RuleActionReport[];
  alertEventId?: string;
  snapshot?: string;
}

export interface RuleEngineEvent {
  type: 'rule';
  outcome: RuleOutcome;
  trigger: RuleTrigger;
}

export interface RuleEngineOptions {
  config: ResolvedIcamifyConfig;
  recording?: RecordingManager;
  index?: RecordingIndex;
  notifier?: Notifier;
  /**
   * Captures and stores a frame for `then.snapshot`, returning the relative path.
   * Injected so the engine has no direct FFmpeg dependency.
   */
  snapshot?: (cameraId: string, labels: string[]) => Promise<string | undefined>;
  scheduleActive?: (scheduleIds: string[], at: number) => boolean;
  /**
   * Executes `then.ptz`; injected so the engine has no ONVIF dependency.
   * Throws when the camera cannot move, which is reported as a failed action.
   */
  ptz?: (request: { cameraId: string; preset: string }) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (event: RuleEngineEvent) => void;
}

interface Cooldown {
  at: number;
}

const EPISODE_TTL_MS = 10 * 60 * 1000;

export class RuleEngine {
  private readonly options: RuleEngineOptions;
  /** ruleId|cameraId → last fire time. */
  private readonly cooldowns = new Map<string, Cooldown>();
  /** ruleId|cameraId|eventId → fire time, so start/end cannot both fire a rule. */
  private readonly firedEpisodes = new Map<string, number>();
  private readonly reportedUnsupported = new Set<string>();

  constructor(options: RuleEngineOptions) {
    this.options = options;
  }

  get rules(): RuleConfig[] {
    return this.options.config.rules ?? [];
  }

  async handle(trigger: RuleTrigger): Promise<RuleOutcome[]> {
    const rules = this.rules;
    if (rules.length === 0) return [];

    const context = {
      at: trigger.at,
      ...(this.options.scheduleActive === undefined
        ? {}
        : { schedulesActive: (ids: string[]) => this.options.scheduleActive?.(ids, trigger.at) === true }),
    };
    const matches = matchingRules(rules, trigger, context);
    if (matches.length === 0) return [];

    const now = this.now();
    this.prune(now);
    const outcomes: RuleOutcome[] = [];

    for (const rule of matches) {
      const episodeKey = `${rule.id}|${trigger.cameraId}|${trigger.id ?? ''}`;
      if (trigger.id !== undefined && this.firedEpisodes.has(episodeKey)) continue;

      const cooldownSeconds = rule.when.cooldownSeconds ?? 60;
      const cooldownKey = `${rule.id}|${trigger.cameraId}`;
      const last = this.cooldowns.get(cooldownKey);
      if (cooldownSeconds > 0 && last !== undefined && now - last.at < cooldownSeconds * 1000) continue;

      if (trigger.id !== undefined) this.firedEpisodes.set(episodeKey, now);
      this.cooldowns.set(cooldownKey, { at: now });

      outcomes.push(await this.execute(rule, trigger));
    }

    return outcomes;
  }

  private async execute(rule: RuleConfig, trigger: RuleTrigger): Promise<RuleOutcome> {
    const camera = this.options.config.cameras.find((candidate) => candidate.id === trigger.cameraId);
    const cameraName = trigger.cameraName ?? camera?.name ?? trigger.cameraId;
    const actions: RuleActionReport[] = [];
    let snapshot = trigger.snapshot;
    let alertEventId: string | undefined;

    // The event row is written first: every other action can then reference it,
    // and the timeline shows the rule even if notification fails.
    const markEvent = rule.then.markEvent;
    if (this.options.index !== undefined) {
      try {
        const stored = this.options.index.insertEvent({
          cameraId: trigger.cameraId,
          kind: 'rule',
          startedAt: trigger.at,
          label: markEvent?.label ?? rule.name,
          ...(trigger.providerId === undefined ? {} : { providerId: trigger.providerId }),
          ...(trigger.confidence === undefined ? {} : { confidence: trigger.confidence }),
          ...(snapshot === undefined ? {} : { snapshot }),
        });
        alertEventId = stored.id;
        actions.push({ action: 'markEvent', ok: true, detail: stored.id });
      } catch (error) {
        actions.push({ action: 'markEvent', ok: false, detail: message(error) });
      }
    }

    const record = rule.then.record;
    if (record !== undefined && record.enabled !== false) {
      if (this.options.recording === undefined) {
        actions.push({ action: 'record', ok: false, detail: 'recording is not enabled' });
      } else {
        const seconds = record.seconds ?? 30;
        try {
          this.options.recording.trigger(
            trigger.cameraId,
            'alert',
            trigger.at,
            {
              ...(trigger.peakPercent === undefined ? {} : { peakPercent: trigger.peakPercent }),
              ...(trigger.boxes === undefined ? {} : { boxes: trigger.boxes }),
            },
            { holdSeconds: seconds },
          );
          actions.push({ action: 'record', ok: true, detail: `${seconds}s clip` });
        } catch (error) {
          actions.push({ action: 'record', ok: false, detail: message(error) });
        }
      }
    }

    const snapshotAction = rule.then.snapshot;
    if (snapshotAction !== undefined && snapshotAction.enabled !== false) {
      if (snapshot !== undefined) {
        actions.push({ action: 'snapshot', ok: true, detail: snapshot });
      } else if (this.options.snapshot === undefined) {
        actions.push({ action: 'snapshot', ok: false, detail: 'snapshot capture is unavailable' });
      } else {
        try {
          snapshot = await this.options.snapshot(trigger.cameraId, [trigger.label ?? rule.name]);
          if (snapshot !== undefined && alertEventId !== undefined) {
            this.options.index?.updateEvent(alertEventId, { snapshot });
          }
          actions.push(
            snapshot === undefined
              ? { action: 'snapshot', ok: false, detail: 'the camera returned no frame' }
              : { action: 'snapshot', ok: true, detail: snapshot },
          );
        } catch (error) {
          actions.push({ action: 'snapshot', ok: false, detail: message(error) });
        }
      }
    }

    const notify = rule.then.notify;
    if (notify !== undefined && (notify.channels ?? []).length > 0) {
      const channels = notify.channels ?? [];
      if (this.options.notifier === undefined) {
        actions.push({ action: 'notify', ok: false, detail: 'no notification channels are configured' });
      } else {
        const payload = this.buildPayload(rule, trigger, cameraName, notify, snapshot);
        const delivery = await this.options.notifier.send(payload, channels);
        actions.push({
          action: 'notify',
          ok: delivery.some((result) => result.ok),
          detail: delivery
            .map((result) => `${result.channelId}:${result.ok ? 'sent' : result.skipped ?? result.error ?? 'failed'}`)
            .join(', '),
          delivery,
        });
      }
    }

    const ptz = rule.then.ptz;
    if (ptz !== undefined) {
      const cameraId = ptz.cameraId ?? trigger.cameraId;
      if (this.options.ptz === undefined) {
        actions.push({ action: 'ptz', ok: false, detail: 'PTZ control is unavailable' });
      } else {
        try {
          await this.options.ptz({ cameraId, preset: ptz.preset });
          actions.push({ action: 'ptz', ok: true, detail: `${cameraId} → ${ptz.preset}` });
        } catch (error) {
          actions.push({ action: 'ptz', ok: false, detail: message(error) });
        }
      }
    }

    const script = rule.then.script;
    if (script !== undefined) {
      // Scripts are not executed: they need an explicit trust model (paths, args,
      // environment) before a camera event may run them. Saying so once per rule is
      // better than a silent no-op.
      const key = `${rule.id}|script`;
      if (!this.reportedUnsupported.has(key)) {
        this.reportedUnsupported.add(key);
        this.options.log?.(`rule "${rule.id}": the script action is not implemented yet and is being skipped`);
      }
      actions.push({ action: 'script', ok: false, detail: 'not implemented' });
    }

    const outcome: RuleOutcome = {
      ruleId: rule.id,
      ruleName: rule.name,
      at: trigger.at,
      cameraId: trigger.cameraId,
      actions,
      ...(alertEventId === undefined ? {} : { alertEventId }),
      ...(snapshot === undefined ? {} : { snapshot }),
    };
    this.options.onEvent?.({ type: 'rule', outcome, trigger });
    return outcome;
  }

  private buildPayload(
    rule: RuleConfig,
    trigger: RuleTrigger,
    cameraName: string,
    notify: NonNullable<RuleConfig['then']['notify']>,
    snapshot: string | undefined,
  ): AlertPayload {
    const values = {
      cameraName,
      cameraId: trigger.cameraId,
      label: trigger.label,
      confidence: trigger.confidence === undefined ? undefined : trigger.confidence.toFixed(2),
      time: new Date(trigger.at).toISOString(),
      ruleName: rule.name,
      kind: trigger.kind,
    };
    const title = notify.title ?? `${rule.name} — ${cameraName}`;
    const message =
      notify.message ??
      interpolateTemplate(
        trigger.label === undefined
          ? '{kind} on {cameraName} at {time}'
          : '{label} detected on {cameraName} ({confidence}) at {time}',
        values,
      );

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      cameraId: trigger.cameraId,
      cameraName,
      kind: trigger.kind,
      ...(trigger.label === undefined ? {} : { label: trigger.label }),
      ...(trigger.confidence === undefined ? {} : { confidence: trigger.confidence }),
      at: trigger.at,
      severity: notify.severity ?? 'warning',
      title: interpolateTemplate(title, values),
      message: interpolateTemplate(message, values),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(trigger.id === undefined ? {} : { eventId: trigger.id }),
    };
  }

  /** Keeps the de-duplication maps from growing without bound on a long run. */
  private prune(now: number): void {
    for (const [key, at] of this.firedEpisodes) {
      if (now - at > EPISODE_TTL_MS) this.firedEpisodes.delete(key);
    }
    for (const [key, cooldown] of this.cooldowns) {
      if (now - cooldown.at > 24 * 60 * 60 * 1000) this.cooldowns.delete(key);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
