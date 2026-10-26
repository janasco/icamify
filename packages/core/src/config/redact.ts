/**
 * Redaction for `icamify config print`, structured logs and API responses.
 *
 * - String leaves under security-sensitive keys are masked.
 * - Credentials embedded in URLs (`rtsp://user:pass@host/...`) and sensitive
 *   query parameters (`?token=...`) are masked even when the key is innocuous.
 * - Containers stay visible so an operator can still see that, for example,
 *   three API tokens are configured without learning their values.
 */

const SECRET_KEY_PATTERN =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key|hmac|access[-_]?key|authorization)/i;

/** Identifiers that look sensitive but are not secrets. */
const NON_SECRET_KEYS = new Set(['profiletoken', 'tokenurl', 'tokenendpoint']);

const SECRET_QUERY_PARAM = /^(token|key|api[-_]?key|password|pass|secret|sig|signature|auth|access_token|apikey)$/i;

export const REDACTED = '***';

export function isSecretKey(key: string): boolean {
  if (NON_SECRET_KEYS.has(key.toLowerCase())) return false;
  return SECRET_KEY_PATTERN.test(key);
}

/** Mask userinfo and sensitive query parameters while keeping the URL readable. */
export function redactUrlSecrets(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  let changed = false;
  if (url.username) {
    url.username = REDACTED;
    changed = true;
  }
  if (url.password) {
    url.password = REDACTED;
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_PARAM.test(key)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }

  return changed ? url.toString() : value;
}

export function redactConfig<T>(value: T, mask: string = REDACTED): T {
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      if (key && isSecretKey(key) && node.length > 0) return mask;
      return redactUrlSecrets(node);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(node)) {
        out[childKey] = walk(child, childKey);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}
