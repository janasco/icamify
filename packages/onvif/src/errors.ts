/**
 * ONVIF failures, classified so the API can say something useful.
 *
 * Camera firmware is not consistent, so the distinction that matters to an
 * operator is whether a problem is credentials, network, or the device refusing
 * the operation — not the exact SOAP fault code.
 */

export type OnvifErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'soap-fault'
  | 'protocol'
  | 'unsupported'
  | 'invalid-target';

export class OnvifError extends Error {
  readonly code: OnvifErrorCode;
  /** SOAP fault text or HTTP status, when there is one. */
  readonly detail?: string;

  constructor(code: OnvifErrorCode, message: string, options: { detail?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OnvifError';
    this.code = code;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}
