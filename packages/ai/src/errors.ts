/**
 * AI gateway errors.
 *
 * The caller (motion/AI service) must be able to tell three situations apart,
 * because each one deserves a different response:
 * - `unavailable`: the provider is down or the breaker is open → skip this frame,
 *   keep recording motion-only events;
 * - `timeout`: the detector is slower than the budget → drop the frame, do not
 *   queue a backlog;
 * - `invalid-response`: the provider answered something we cannot map → a
 *   configuration problem the operator has to see, not a transient failure.
 */

export type AiErrorCode = 'unavailable' | 'timeout' | 'invalid-response' | 'busy' | 'unsupported' | 'failed';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly providerId: string;
  /** HTTP status, when the failure came from an HTTP call. */
  readonly status?: number;

  constructor(code: AiErrorCode, providerId: string, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.providerId = providerId;
    if (status !== undefined) this.status = status;
  }

  /** True when retrying later might work without an operator changing anything. */
  get transient(): boolean {
    return this.code === 'unavailable' || this.code === 'timeout' || this.code === 'busy' || this.code === 'failed';
  }
}
