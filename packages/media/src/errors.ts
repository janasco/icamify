/**
 * Errors raised by the media layer. Every failure mode that a supervisor or the
 * CLI has to react to differently gets its own code, so callers never have to
 * pattern-match on message text.
 */
export type MediaErrorCode =
  | 'toolchain-missing'
  | 'toolchain-unsupported'
  | 'invalid-argument'
  | 'unsupported-source'
  | 'probe-failed'
  | 'snapshot-failed'
  | 'ingest-failed'
  | 'timeout';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /** Multi-line remediation text shown by the CLI. */
  readonly detail?: string;

  constructor(code: MediaErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}
