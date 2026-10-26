import { AiError } from './errors.ts';

/**
 * HTTP transport for AI providers.
 *
 * Every request is bounded by a timeout and an abort signal, and every response
 * body is size-limited: a detector that starts streaming an error page must not
 * be able to allocate unbounded memory inside the NVR process.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpOptions {
  providerId: string;
  url: string;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

function combineSignals(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function readJson(providerId: string, response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AiError('invalid-response', providerId, `AI provider returned ${text.length} bytes, which exceeds the limit.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new AiError(
      'invalid-response',
      providerId,
      `AI provider did not return JSON (HTTP ${response.status}): ${preview.length > 0 ? preview : '(empty body)'}`,
      response.status,
    );
  }
}

async function send(options: HttpOptions, init: RequestInit): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.url, {
      ...init,
      signal: combineSignals(options.timeoutMs, options.signal),
      headers: { accept: 'application/json', ...options.headers, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (error) {
    throw toTransportError(options, error);
  }

  if (!response.ok) {
    // Keep the upstream message: "401 Unauthorized" is the whole diagnosis.
    const detail = await response.text().catch(() => '');
    throw new AiError(
      response.status === 429 || response.status >= 500 ? 'unavailable' : 'failed',
      options.providerId,
      `AI provider responded ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`,
      response.status,
    );
  }
  return readJson(options.providerId, response);
}

function toTransportError(options: HttpOptions, error: unknown): AiError {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AiError('timeout', options.providerId, `AI request timed out after ${options.timeoutMs} ms.`);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AiError('unavailable', options.providerId, `Could not reach the AI provider: ${message}`);
}

/** JSON body, used by generic HTTP providers and health checks. */
export function postJson(options: HttpOptions, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<unknown> {
  return send(options, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface ImagePostOptions extends HttpOptions {
  image: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  /** Multipart field name; CodeProject.AI and DeepStack both use `image`. */
  field?: string;
  extraFields?: Record<string, string>;
}

/**
 * Multipart upload of one image, the shape both CodeProject.AI and DeepStack
 * expect. `FormData` handles the boundary and Content-Length for us.
 */
export function postImage(options: ImagePostOptions, method: 'POST' | 'PUT' = 'POST'): Promise<unknown> {
  const form = new FormData();
  for (const [key, value] of Object.entries(options.extraFields ?? {})) form.append(key, value);
  const extension = options.mimeType === 'image/png' ? 'png' : 'jpg';
  form.append(options.field ?? 'image', new Blob([new Uint8Array(options.image)], { type: options.mimeType }), `frame.${extension}`);
  return send(options, { method, body: form });
}

export function getJson(options: HttpOptions): Promise<unknown> {
  return send(options, { method: 'GET' });
}
