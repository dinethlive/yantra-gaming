/**
 * Error classes thrown by the SDK.
 *
 * All SDK errors extend {@link SdkError}. Use `instanceof` checks to branch on
 * retryability:
 *
 *   try {
 *     await createSession(...);
 *   } catch (err) {
 *     if (err instanceof SessionCreationError && err.retryable) {
 *       // retry with exponential backoff
 *     } else {
 *       // escalate
 *     }
 *   }
 */

export class SdkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

/**
 * Thrown when `createSession()` fails. `retryable` is true for network-level
 * failures (timeout, 5xx) and false for client-side errors (4xx, invalid
 * response shape).
 */
export class SessionCreationError extends SdkError {
  constructor(
    message: string,
    code: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly responseBody?: unknown,
    cause?: unknown,
  ) {
    super(message, code, cause);
    this.name = 'SessionCreationError';
  }
}

/**
 * Thrown by {@link verifyWebhookSignature} when the signature headers are
 * structurally invalid. A mismatched-but-well-formed signature does NOT throw
 * — the function returns `false` instead, so callers can branch cleanly.
 */
export class WebhookHeaderError extends SdkError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'WebhookHeaderError';
  }
}
