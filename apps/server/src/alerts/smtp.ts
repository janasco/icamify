import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { AlertAttachment } from './attachment.ts';

/**
 * Minimal SMTP client.
 *
 * A purpose-built client rather than a mail library: iCamify sends one short
 * alert at a time, needs no mailbox parsing, and a dependency-free client keeps
 * the deployment to a single Node process. The subset implemented is the one
 * every provider speaks — EHLO, STARTTLS or implicit TLS, AUTH PLAIN/LOGIN,
 * one envelope, one MIME body, QUIT.
 *
 * Everything is bounded by a timeout, and failures carry the protocol `stage`
 * so an operator can tell a TLS problem from a rejected recipient.
 */

export type MailSocket = Socket | TLSSocket;

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: AlertAttachment[];
  headers?: Record<string, string>;
  date?: Date;
}

export interface SmtpOptions {
  host: string;
  port?: number;
  /** True for implicit TLS (usually port 465); false upgrades via STARTTLS. */
  secure?: boolean;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export class SmtpError extends Error {
  readonly stage: string;
  readonly responseCode?: number;

  constructor(message: string, stage: string, responseCode?: number) {
    super(message);
    this.name = 'SmtpError';
    this.stage = stage;
    if (responseCode !== undefined) this.responseCode = responseCode;
  }
}

interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

const CRLF = '\r\n';

/** Reads complete SMTP replies, including the multi-line `250-...` form. */
class ReplyReader {
  private buffer = '';
  private partial: string[] = [];
  private readonly queue: SmtpReply[] = [];
  private waiter: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private failure: Error | undefined;
  private socket: MailSocket;

  constructor(socket: MailSocket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Stops listening; used before a STARTTLS upgrade wraps the socket. */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  async next(timeoutMs: number, stage: string): Promise<SmtpReply> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.failure !== undefined) throw this.failure;
    return await new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new SmtpError(`timed out after ${timeoutMs}ms waiting for the server (${stage})`, stage));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) break;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length < 3) continue;
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code)) continue;
      this.partial.push(line);
      // A reply is complete only when the fourth character is a space; `-`
      // means "more lines follow".
      if (line.length > 3 && line[3] !== ' ') continue;
      const lines = this.partial.splice(0);
      this.deliver({ code, lines, text: lines.map((entry) => entry.slice(4)).join('\n') });
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private readonly onClose = (): void => {
    this.fail(new SmtpError('the server closed the connection', 'closed'));
  };

  private fail(error: Error): void {
    this.failure = error;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private deliver(reply: SmtpReply): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
      return;
    }
    this.queue.push(reply);
  }
}

function write(socket: MailSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error === undefined || error === null ? resolve() : reject(error)));
  });
}

async function openSocket(host: string, port: number, secure: boolean, timeoutMs: number): Promise<MailSocket> {
  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  // Registered before awaiting so a connection error is never unhandled.
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(`timed out connecting to ${host}:${port}`, 'connect'));
    }, timeoutMs);
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    if (secure) socket.once('secureConnect', () => settle());
    else socket.once('connect', () => settle());
    socket.once('error', (error) => settle(error));
    socket.once('close', () => settle(new SmtpError(`the connection to ${host}:${port} closed during setup`, 'connect')));
  });
  socket.setNoDelay(true);
  return socket;
}

async function upgradeToTls(socket: MailSocket, host: string, timeoutMs: number): Promise<TLSSocket> {
  const secure = tlsConnect({ socket, servername: host });
  secure.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SmtpError('timed out during the STARTTLS handshake', 'starttls'));
    }, timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve();
    });
    secure.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return secure;
}

async function command(
  socket: MailSocket,
  reader: ReplyReader,
  line: string,
  expected: ReadonlyArray<number>,
  stage: string,
  timeoutMs: number,
): Promise<SmtpReply> {
  await write(socket, `${line}${CRLF}`);
  const reply = await reader.next(timeoutMs, stage);
  if (!expected.includes(reply.code)) {
    throw new SmtpError(`${stage} failed: ${reply.code} ${reply.text}`, stage, reply.code);
  }
  return reply;
}

function capabilitiesOf(reply: SmtpReply): Map<string, string> {
  const capabilities = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const body = line.slice(4).trim();
    if (body.length === 0) continue;
    const [name, ...rest] = body.split(/\s+/);
    if (name !== undefined) capabilities.set(name.toUpperCase(), rest.join(' '));
  }
  return capabilities;
}

function headerValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new SmtpError('a header value contains a line break', 'message');
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function encodeSubject(subject: string): string {
  const clean = headerValue(subject);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function crlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, CRLF);
}

function base64Lines(content: Buffer): string {
  const encoded = content.toString('base64');
  const chunks = encoded.match(/.{1,76}/g) ?? [];
  return chunks.join(CRLF);
}

export function buildSmtpMessage(message: SmtpMessage): string {
  if (message.to.length === 0) throw new SmtpError('a message needs at least one recipient', 'message');
  const boundaryMixed = `icamify-mixed-${randomUUID()}`;
  const boundaryAlt = `icamify-alt-${randomUUID()}`;
  const attachments = message.attachments ?? [];
  const html = message.html !== undefined && message.html.length > 0 ? message.html : undefined;

  const textPart = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(crlf(message.text), 'utf8')),
  ].join(CRLF);

  const alternative =
    html === undefined
      ? textPart
      : [
          `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
          '',
          `--${boundaryAlt}`,
          textPart,
          `--${boundaryAlt}`,
          'Content-Type: text/html; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          base64Lines(Buffer.from(crlf(html), 'utf8')),
          `--${boundaryAlt}--`,
        ].join(CRLF);

  const body =
    attachments.length === 0
      ? alternative
      : [
          `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
          '',
          `--${boundaryMixed}`,
          alternative,
          ...attachments.flatMap((attachment) => [
            `--${boundaryMixed}`,
            `Content-Type: ${headerValue(attachment.contentType)}; name="${headerValue(attachment.filename)}"`,
            `Content-Disposition: attachment; filename="${headerValue(attachment.filename)}"`,
            'Content-Transfer-Encoding: base64',
            '',
            base64Lines(attachment.content),
          ]),
          `--${boundaryMixed}--`,
        ].join(CRLF);

  const headers = [
    `Date: ${(message.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${randomUUID()}@icamify>`,
    `From: ${headerValue(message.from)}`,
    `To: ${message.to.map(headerValue).join(', ')}`,
    `Subject: ${encodeSubject(message.subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers ?? {}).map(([name, value]) => `${headerValue(name)}: ${headerValue(value)}`),
  ];

  return [...headers, '', body, ''].join(CRLF);
}

/** Delivers one message; resolves on the server's final `250`, throws `SmtpError` otherwise. */
export async function sendMail(options: SmtpOptions, message: SmtpMessage): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const port = options.port ?? (options.secure === true ? 465 : 587);
  const body = buildSmtpMessage(message);

  let socket = await openSocket(options.host, port, options.secure === true, timeoutMs);
  let reader = new ReplyReader(socket);

  try {
    const greeting = await reader.next(timeoutMs, 'greeting');
    if (greeting.code !== 220) {
      throw new SmtpError(`the server refused the connection: ${greeting.code} ${greeting.text}`, 'greeting', greeting.code);
    }

    const ehlo = `EHLO ${hostname() || 'icamify.local'}`;
    let capabilities = capabilitiesOf(await command(socket, reader, ehlo, [250], 'ehlo', timeoutMs));

    if (options.secure !== true && capabilities.has('STARTTLS')) {
      await command(socket, reader, 'STARTTLS', [220], 'starttls', timeoutMs);
      reader.detach();
      socket = await upgradeToTls(socket, options.host, timeoutMs);
      reader = new ReplyReader(socket);
      capabilities = capabilitiesOf(await command(socket, reader, ehlo, [250], 'ehlo', timeoutMs));
    }

    if (options.username !== undefined && options.password !== undefined) {
      const mechanisms = (capabilities.get('AUTH') ?? capabilities.get('AUTH-PLAIN') ?? '')
        .toUpperCase()
        .split(/\s+/)
        .filter((mechanism) => mechanism.length > 0);
      const token = Buffer.from(`\0${options.username}\0${options.password}`, 'utf8').toString('base64');
      if (mechanisms.includes('PLAIN') || mechanisms.length === 0) {
        await command(socket, reader, `AUTH PLAIN ${token}`, [235], 'auth', timeoutMs);
      } else if (mechanisms.includes('LOGIN')) {
        await command(socket, reader, 'AUTH LOGIN', [334], 'auth', timeoutMs);
        await command(socket, reader, Buffer.from(options.username, 'utf8').toString('base64'), [334], 'auth', timeoutMs);
        await command(socket, reader, Buffer.from(options.password, 'utf8').toString('base64'), [235], 'auth', timeoutMs);
      } else {
        throw new SmtpError(`the server offers no supported AUTH mechanism (${mechanisms.join(', ')})`, 'auth');
      }
    }

    await command(socket, reader, `MAIL FROM:<${headerValue(message.from)}>`, [250], 'mail-from', timeoutMs);
    for (const recipient of message.to) {
      await command(socket, reader, `RCPT TO:<${headerValue(recipient)}>`, [250, 251], 'rcpt-to', timeoutMs);
    }
    await command(socket, reader, 'DATA', [354], 'data', timeoutMs);

    // Dot-stuffing: a line that starts with "." would otherwise end the body.
    const stuffed = body
      .split(CRLF)
      .map((line) => (line.startsWith('.') ? `.${line}` : line))
      .join(CRLF);
    const terminated = stuffed.endsWith(CRLF) ? stuffed : `${stuffed}${CRLF}`;
    await write(socket, `${terminated}.${CRLF}`);
    const accepted = await reader.next(timeoutMs, 'data-end');
    if (accepted.code !== 250) {
      throw new SmtpError(`the server rejected the message: ${accepted.code} ${accepted.text}`, 'data-end', accepted.code);
    }

    await command(socket, reader, 'QUIT', [221], 'quit', timeoutMs);
  } finally {
    reader.detach();
    socket.destroy();
  }
}
