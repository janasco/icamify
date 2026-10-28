import { createHmac } from 'node:crypto';
import { interpolateTemplate } from '@icamify/ai';
import type { EmailChannel, MqttChannel, NotificationChannel, Severity, TelegramChannel, WebhookChannel } from '@icamify/core';
import type { AlertAttachment } from './attachment.ts';
import { publishMqtt, type MqttPublish } from './mqtt.ts';
import { sendMail } from './smtp.ts';
import { sendTelegram, type TelegramOptions } from './telegram.ts';

/**
 * Notification delivery.
 *
 * One alert payload, one delivery routine per channel: webhook, email (SMTP),
 * MQTT and Telegram all deliver. De-duplication and per-channel results live
 * here so the rule engine only has to say "notify these channels" and can report
 * exactly what happened.
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
  /** True when the rule asked for the snapshot to travel with the alert. */
  attachSnapshot?: boolean;
  eventId?: string;
}

export interface DeliveryResult {
  channelId: string;
  ok: boolean;
  skipped?: 'dedupe' | 'disabled';
  error?: string;
  status?: number;
  detail?: string;
}

export interface NotifierOptions {
  channels: NotificationChannel[];
  /** Global de-duplication window, from notifications.dedupeSeconds. */
  dedupeSeconds?: number;
  now?: () => number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Loads a stored snapshot for channels that attach it. */
  snapshot?: (relativePath: string) => Promise<AlertAttachment | undefined>;
  /** Telegram overrides (test seam); production uses the public Bot API. */
  telegram?: Pick<TelegramOptions, 'apiBase'>;
}

const MAX_DETAIL_CHARS = 200;

export class Notifier {
  private readonly options: NotifierOptions;
  private readonly lastSent = new Map<string, number>();
  private readonly discoverySent = new Set<string>();

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
      return { channelId, ok: false, error: 'channel is not configured' };
    }
    if (channel.enabled === false) return { channelId, ok: false, skipped: 'disabled' };

    const key = `${channelId}|${payload.cameraId}|${payload.ruleId}|${payload.label ?? ''}`;
    const now = this.now();
    const dedupeMs = Math.max(0, this.options.dedupeSeconds ?? 30) * 1000;
    const previous = this.lastSent.get(key);
    if (dedupeMs > 0 && previous !== undefined && now - previous < dedupeMs) {
      return { channelId, ok: false, skipped: 'dedupe' };
    }

    try {
      const result = await this.dispatch(channel, payload);
      if (result.ok) this.lastSent.set(key, now);
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.options.log?.(`notification channel ${channelId}: ${text}`);
      return { channelId, ok: false, error: text };
    }
  }

  private async dispatch(channel: NotificationChannel, payload: AlertPayload): Promise<DeliveryResult> {
    switch (channel.type) {
      case 'webhook':
        return await this.postWebhook(channel, payload);
      case 'email':
        return await this.sendEmail(channel, payload);
      case 'mqtt':
        return await this.postMqtt(channel, payload);
      case 'telegram':
        return await this.postTelegram(channel, payload);
    }
  }

  private async postWebhook(channel: WebhookChannel, payload: AlertPayload): Promise<DeliveryResult> {
    const body =
      channel.bodyTemplate === undefined
        ? JSON.stringify(this.envelope(payload))
        : interpolateTemplate(channel.bodyTemplate, templateValues(payload));

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

  private async sendEmail(channel: EmailChannel, payload: AlertPayload): Promise<DeliveryResult> {
    const attachment = await this.attachmentFor(payload);
    const port = channel.smtp.port ?? 587;
    // `secure` means implicit TLS; without it the client upgrades with STARTTLS
    // when the server offers it.
    const secure = channel.smtp.secure ?? port === 465;

    await sendMail(
      {
        host: channel.smtp.host,
        port,
        secure,
        ...(channel.smtp.username === undefined ? {} : { username: channel.smtp.username }),
        ...(channel.smtp.password === undefined ? {} : { password: channel.smtp.password }),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
      {
        from: channel.smtp.from,
        to: channel.to,
        subject: interpolateTemplate(
          channel.subjectTemplate ?? '[iCamify] {cameraName}: {title}',
          { ...templateValues(payload), title: payload.title },
        ),
        text: textBody(payload),
        html: htmlBody(payload),
        ...(attachment === undefined ? {} : { attachments: [attachment] }),
      },
    );

    return {
      channelId: channel.id,
      ok: true,
      detail: `mailed ${channel.to.length} recipient${channel.to.length === 1 ? '' : 's'}${attachment === undefined ? '' : ' with snapshot'}`,
    };
  }

  private async postMqtt(channel: MqttChannel, payload: AlertPayload): Promise<DeliveryResult> {
    const publishes: MqttPublish[] = [];
    if (channel.homeAssistantDiscovery === true && !this.discoverySent.has(channel.id)) {
      publishes.push({
        topic: `homeassistant/sensor/icamify_${channel.id}/config`,
        payload: JSON.stringify(discoveryDocument(channel)),
        qos: 0,
        retain: true,
      });
      this.discoverySent.add(channel.id);
    }
    publishes.push({
      topic: channel.topic,
      payload: JSON.stringify(this.envelope(payload)),
      qos: channel.qos ?? 1,
      retain: channel.retain === true,
    });

    await publishMqtt(
      {
        url: channel.url,
        ...(channel.username === undefined ? {} : { username: channel.username }),
        ...(channel.password === undefined ? {} : { password: channel.password }),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
      publishes,
    );

    return { channelId: channel.id, ok: true, detail: `published to ${channel.topic}` };
  }

  private async postTelegram(channel: TelegramChannel, payload: AlertPayload): Promise<DeliveryResult> {
    const attachment = await this.attachmentFor(payload);
    const result = await sendTelegram(
      channel,
      { title: payload.title, text: payload.message },
      attachment,
      {
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.telegram?.apiBase === undefined ? {} : { apiBase: this.options.telegram.apiBase }),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
    );
    return { channelId: channel.id, ok: true, status: result.status, detail: result.method };
  }

  private async attachmentFor(payload: AlertPayload): Promise<AlertAttachment | undefined> {
    if (payload.attachSnapshot !== true || payload.snapshot === undefined) return undefined;
    const reader = this.options.snapshot;
    if (reader === undefined) return undefined;
    try {
      return await reader(payload.snapshot);
    } catch (error) {
      // A missing snapshot must not swallow the alert itself.
      const text = error instanceof Error ? error.message : String(error);
      this.options.log?.(`notification: could not read snapshot ${payload.snapshot}: ${text}`);
      return undefined;
    }
  }

  /** The canonical JSON envelope used by webhooks and MQTT. */
  private envelope(payload: AlertPayload): Record<string, unknown> {
    return {
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
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function templateValues(payload: AlertPayload): Record<string, string | number | undefined> {
  return {
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
}

function textBody(payload: AlertPayload): string {
  const lines = [
    payload.title,
    '',
    payload.message,
    '',
    `camera: ${payload.cameraName} (${payload.cameraId})`,
    `event: ${payload.kind}`,
  ];
  if (payload.label !== undefined) lines.push(`label: ${payload.label}`);
  if (payload.confidence !== undefined) lines.push(`confidence: ${(payload.confidence * 100).toFixed(0)}%`);
  lines.push(
    `time: ${new Date(payload.at).toISOString()}`,
    `severity: ${payload.severity}`,
    `rule: ${payload.ruleName} (${payload.ruleId})`,
  );
  if (payload.snapshot !== undefined) lines.push(`snapshot: ${payload.snapshot}`);
  if (payload.eventId !== undefined) lines.push(`event id: ${payload.eventId}`);
  return `${lines.join('\n')}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlBody(payload: AlertPayload): string {
  const rows: Array<[string, string]> = [
    ['Camera', `${payload.cameraName} (${payload.cameraId})`],
    ['Event', payload.kind],
    ['Time', new Date(payload.at).toISOString()],
    ['Severity', payload.severity],
    ['Rule', `${payload.ruleName} (${payload.ruleId})`],
  ];
  if (payload.label !== undefined) rows.splice(2, 0, ['Label', payload.label]);
  if (payload.confidence !== undefined) rows.push(['Confidence', `${(payload.confidence * 100).toFixed(0)}%`]);

  const cells = rows
    .map(
      ([name, value]) =>
        `<tr><th align="left" style="padding:2px 12px 2px 0;color:#555">${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  return [
    '<html><body style="font-family:system-ui,sans-serif;font-size:14px">',
    `<h2 style="margin:0 0 8px">${escapeHtml(payload.title)}</h2>`,
    `<p style="margin:0 0 12px">${escapeHtml(payload.message)}</p>`,
    `<table>${cells}</table>`,
    '</body></html>',
  ].join('');
}

function discoveryDocument(channel: MqttChannel): Record<string, unknown> {
  return {
    name: 'iCamify last alert',
    unique_id: `icamify_${channel.id}_last_alert`,
    state_topic: channel.topic,
    value_template: '{{ value_json.title }}',
    json_attributes_topic: channel.topic,
    icon: 'mdi:cctv',
    device: {
      identifiers: ['icamify'],
      name: 'iCamify',
      manufacturer: 'iCamify',
      model: 'NVR',
    },
  };
}

/** Trims provider error bodies so a log line stays one line. */
export function shortDetail(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_DETAIL_CHARS ? collapsed : `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
