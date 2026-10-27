/**
 * Storage-layer failures.
 *
 * Retention never throws at an operator: a failed delete or a failed upload is
 * recorded in the sweep result and reported. These errors exist for the cases a
 * caller has to decide about — a target that cannot be built at all, or an
 * archive that refused the object.
 */

export type StorageErrorCode =
  | 'archive-unavailable'
  | 'archive-credentials'
  | 'archive-failed'
  | 'archive-invalid-key';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** Provider id, when the error belongs to one archive target. */
  readonly providerId?: string;

  constructor(code: StorageErrorCode, message: string, options: { providerId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
    if (options.providerId !== undefined) this.providerId = options.providerId;
  }
}
