import type { TelegramChannel } from '@icamify/core';
import type { AlertAttachment } from './attachment.ts';

/**
 * Telegram Bot API delivery.
 *
 * The alert text is interpolated from camera and rule data, i.e. it is
 * attacker-influenced (a camera can be renamed, a label comes from an AI
 * provider). Both of Telegram's formatting modes therefore escape the text:
 * HTML entities or MarkdownV2 specials. Sending a snapshot switches to
 * `sendPhoto`, whose caption limit is 1024 characters rather than 4096.
 */

export interface TelegramOptions {
  fetch?: typeof fetch;
  /** Test seam; defaults to the public Bot API. */
  apiBase?: string;
  timeoutMs?: number;
}

export class TelegramError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TelegramError';
    if (status !== undefined) this.status = status;
  }
}

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeTelegramMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (character) => `\\${character}`);
}

function format(text: string, mode: TelegramChannel['parseMode']): string {
  if (mode === 'HTML') return escapeTelegramHtml(text);
  if (mode === 'MarkdownV2') return escapeTelegramMarkdown(text);
  return text;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export async function sendTelegram(
  channel: TelegramChannel,
  message: { title: string; text: string },
  attachment: AlertAttachment | undefined,
  options: TelegramOptions = {},
): Promise<{ method: 'sendPhoto' | 'sendMessage'; status: number }> {
  const base = options.apiBase ?? 'https://api.telegram.org';
  const endpoint = `${base.replace(/\/$/, '')}/bot${channel.botToken}`;
  const mode = channel.parseMode ?? 'HTML';
  const caption = truncate(`${message.title}\n${message.text}`, CAPTION_LIMIT);

  const doFetch = options.fetch ?? fetch;

  const call = async (
    method: 'sendPhoto' | 'sendMessage',
    body: string | FormData,
  ): Promise<{ method: 'sendPhoto' | 'sendMessage'; status: number }> => {
    const response = await doFetch(`${endpoint}/${method}`, {
      method: 'POST',
      body,
      ...(typeof body === 'string' ? { headers: { 'content-type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new TelegramError(
        `Telegram ${method} failed: HTTP ${response.status}${detail.length > 0 ? ` ${detail.slice(0, 200)}` : ''}`,
        response.status,
      );
    }
    return { method, status: response.status };
  };

  if (attachment !== undefined) {
    const form = new FormData();
    form.set('chat_id', channel.chatId);
    form.set('caption', format(caption, mode));
    if (mode !== 'none') form.set('parse_mode', mode);
    form.set(
      'photo',
      new Blob([new Uint8Array(attachment.content)], { type: attachment.contentType }),
      attachment.filename,
    );
    return await call('sendPhoto', form);
  }

  const payload = {
    chat_id: channel.chatId,
    text: format(truncate(`${message.title}\n${message.text}`, MESSAGE_LIMIT), mode),
    disable_web_page_preview: true,
    ...(mode === 'none' ? {} : { parse_mode: mode }),
  };
  return await call('sendMessage', JSON.stringify(payload));
}
