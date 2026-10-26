import { createHmac } from 'node:crypto';
import { interpolateTemplate } from '@icamify/ai';
import type { NotificationChannel, Severity } from '@icamify/core';

/**
 * Notification delivery.
 *
 * One alert payload, one delivery routine per channel. Webhooks are the only
 * channel implemented today; the others are *recognised* and reported as not
 * implemented rather than silently dropped, so an operator who configured
 * Telegram does not wonder why nothing arrives.
 */

export interface AlertPayload {
  ruleId: string;
  ruleName: string;
  cameraId: string;
  cameraName: string;
  kind: string;
  label?: string;
  confidence?: number;
  at: number;
  severity: Severity;
  title: string;
  message: string;
  /** Relative snapshot path, served through /api/events/:id/snapshot. */
  snapshot?: string;
  eventId?: string;
}

export interface DeliveryResult {
  channelId: string;
  ok: boolean;
  skipped?: 'dedupe' | 'disabled' | 'not-implemented';
  error?: string;
  status?: number;
}

export interface NotifierOptions {
  channels: NotificationChannel[];
  /** Global de-duplication window, from notifications.dedupeSeconds. */
  dedupeSeconds?: number;
  now?: () => number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Notifier {
  private readonly options: NotifierOptions;
  private readonly lastSent = new Map<string, number>();

  constructor(options: NotifierOptions) {
    this.options = options;
  }

  channelIds(): string[] {
    return this.options.channels.map((channel) => channel.id);
  }

  async send(payload: AlertPayload, channelIds: ReadonlyArray<string>): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    for (const channelId of channelIds) {
      results.push(await this.deliver(payload, channelId));
    }
    return results;
  }

  private async deliver(payload: AlertPayload, channelId: string): Promise<DeliveryResult> {
    const channel = this.options.channels.find((candidate) => candidate.id === channelId);
    if (channel === undefined) {
      return { channelId, ok: false, skipped: 'not-implemented', error: 'channel is not configured' };
    }
    if (channel.enabled === false) return { channelId, ok: false, skipped: 'disabled' };

    const key = `${channelId}|${payload.cameraId}|${payload.ruleId}|${payload.label ?? ''}`;
    const now = this.now();
    const dedupeMs = Math.max(0, this.options.dedupeSeconds ?? 30) * 1000;
    const previous = this.lastSent.get(key);
    if (dedupeMs > 0 && previous !== undefined && now - previous < dedupeMs) {
      return { channelId, ok: false, skipped: 'dedupe' };
    }

    if (channel.type !== 'webhook') {
      this.options.log?.(`notification channel ${channelId} (${channel.type}): delivery is not implemented yet; alert kept in the log only`);
      return { channelId, ok: false, skipped: 'not-implemented' };
    }

    try {
      const result = await this.postWebhook(channel, payload);
      if (result.ok) this.lastSent.set(key, now);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`notification channel ${channelId}: ${message}`);
      return { channelId, ok: false, error: message };
    }
  }

  private async postWebhook(
    channel: Extract<NotificationChannel, { type: 'webhook' }>,
    payload: AlertPayload,
  ): Promise<DeliveryResult> {
    const values: Record<string, string | number | undefined> = {
      ruleName: payload.ruleName,
      ruleId: payload.ruleId,
      cameraName: payload.cameraName,
      cameraId: payload.cameraId,
      label: payload.label,
      confidence: payload.confidence === undefined ? undefined : payload.confidence.toFixed(2),
      time: new Date(payload.at).toISOString(),
      kind: payload.kind,
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      snapshot: payload.snapshot,
    };

    const body =
      channel.bodyTemplate === undefined
        ? JSON.stringify({
            type: 'icamify.alert',
            rule: { id: payload.ruleId, name: payload.ruleName },
            camera: { id: payload.cameraId, name: payload.cameraName },
            event: {
              kind: payload.kind,
              at: new Date(payload.at).toISOString(),
              ...(payload.label === undefined ? {} : { label: payload.label }),
              ...(payload.confidence === undefined ? {} : { confidence: payload.confidence }),
              ...(payload.eventId === undefined ? {} : { eventId: payload.eventId }),
            },
            severity: payload.severity,
            title: payload.title,
            message: payload.message,
            ...(payload.snapshot === undefined ? {} : { snapshot: payload.snapshot }),
          })
        : interpolateTemplate(channel.bodyTemplate, values);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...channel.headers,
    };
    if (channel.hmacSecret !== undefined) {
      // HMAC over the exact bytes body: receivers can verify without trusting TLS.
      headers['x-icamify-signature'] = `sha256=${createHmac('sha256', channel.hmacSecret).update(body).digest('hex')}`;
    }

    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(channel.url, {
      method: channel.method ?? 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(channel.timeoutMs ?? this.options.timeoutMs ?? 5000),
    });

    if (!response.ok) {
      return { channelId: channel.id, ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { channelId: channel.id, ok: true, status: response.status };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
