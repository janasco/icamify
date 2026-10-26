import type { IncomingMessage, ServerResponse } from 'node:http';

/** Response helpers shared by every route, so error shapes stay consistent. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers: Record<string, string> = {},
): void {
  const body: ErrorBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  sendJson(res, status, body, headers);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(payload.length), 'Cache-Control': 'no-store' });
  res.end(payload);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  payload: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export interface JsonBodyOptions {
  maxBytes?: number;
}

/** Reads and parses a JSON body; empty bodies are `{}` so optional fields work. */
export async function readJsonBody(req: IncomingMessage, options: JsonBodyOptions = {}): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      throw new HttpError(413, 'body-too-large', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  if (received === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid-body', 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid-json', 'Request body is not valid JSON.');
  }
}

export function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendError(res, 405, 'method-not-allowed', `Allowed methods: ${allowed.join(', ')}.`, undefined, { Allow: allowed.join(', ') });
}
