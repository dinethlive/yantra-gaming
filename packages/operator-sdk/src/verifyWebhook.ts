import {
  DEFAULT_CLOCK_TOLERANCE_SECONDS,
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyPayload,
  type BalanceRequestWire,
  type BetRequestWire,
  type RollbackRequestWire,
  type WinRequestWire,
} from '@yantra/wallet-spec';
import { WebhookHeaderError } from './errors.js';

export interface VerifyWebhookParams {
  /** HTTP method of the incoming request (usually `POST`). */
  method: string;
  /** Request path, exactly as the RGS signed it (e.g. `/wallet/bet`). */
  path: string;
  /** Raw request body. Pass the bytes *before* JSON parsing — the signature is over the raw body. */
  body: string | Uint8Array;
  /** Shared HMAC secret for this operator's wallet callbacks. */
  secret: string;
  /** Timestamp header value (unix seconds, as string). */
  timestamp: string | number;
  /** Signature header value (base64). */
  signature: string;
  /** Clock skew allowance. Default 30 seconds (same as the RGS). */
  toleranceSeconds?: number;
  /** Injectable for tests. */
  nowSeconds?: number;
}

/**
 * Verify an inbound webhook signature from the RGS.
 *
 * Returns `true` if the signature is valid AND the timestamp is within the
 * configured window. Returns `false` otherwise (bad signature, expired
 * timestamp, mismatched body).
 *
 * Throws {@link WebhookHeaderError} only if required headers are
 * missing or unparseable — i.e. the request is structurally invalid, not
 * just unauthenticated.
 *
 * Example (Express):
 *
 * ```ts
 * import express from 'express';
 * import { verifyWebhookSignature } from '@yantra/operator-sdk';
 *
 * const app = express();
 * app.use(express.json({
 *   verify: (req, _res, buf) => { (req as any).rawBody = buf; },
 * }));
 *
 * app.post('/wallet/bet', (req, res) => {
 *   const ok = verifyWebhookSignature({
 *     method:    req.method,
 *     path:      req.path,
 *     body:      (req as any).rawBody,
 *     secret:    process.env.YANTRA_WALLET_SECRET!,
 *     timestamp: req.header('x-yantra-timestamp')!,
 *     signature: req.header('x-yantra-signature')!,
 *   });
 *   if (!ok) return res.status(401).json({ status: 'RS_ERROR_INVALID_SIGNATURE' });
 *
 *   // ... process bet ...
 * });
 * ```
 */
export function verifyWebhookSignature(params: VerifyWebhookParams): boolean {
  if (!params.timestamp || !params.signature) {
    throw new WebhookHeaderError(
      `missing required header — ${TIMESTAMP_HEADER} and ${SIGNATURE_HEADER} are both required`,
      'MISSING_HEADERS',
    );
  }
  return verifyPayload({
    secret: params.secret,
    method: params.method,
    path: params.path,
    timestamp: params.timestamp,
    body: params.body,
    signature: params.signature,
    toleranceSeconds: params.toleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
    nowSeconds: params.nowSeconds,
  });
}

// ── Webhook body parser ─────────────────────────────────────
//
// Given a validated request, parse the body into one of the four canonical
// wallet-call shapes. Use the discriminated union to narrow. Amounts are
// returned as the wire-format string — the caller converts to BigInt with
// `toMicro()` / `fromMicro()` from wallet-spec as needed.

export type WalletCallbackEndpoint = 'balance' | 'bet' | 'win' | 'rollback';

export type WalletCallback =
  | { endpoint: 'balance'; body: BalanceRequestWire }
  | { endpoint: 'bet'; body: BetRequestWire }
  | { endpoint: 'win'; body: WinRequestWire }
  | { endpoint: 'rollback'; body: RollbackRequestWire };

/**
 * Parse and shape-check an inbound wallet-callback body. Does NOT verify the
 * signature — call {@link verifyWebhookSignature} first.
 */
export function parseWalletCallback(
  endpoint: WalletCallbackEndpoint,
  body: unknown,
): WalletCallback {
  if (typeof body !== 'object' || body === null) {
    throw new WebhookHeaderError('body must be a JSON object', 'INVALID_BODY');
  }
  const b = body as Record<string, unknown>;

  const common = [
    'requestUuid',
    'operatorId',
    'playerRef',
    'currency',
    'gameCode',
  ] as const;
  for (const k of common) {
    if (typeof b[k] !== 'string') {
      throw new WebhookHeaderError(
        `missing or non-string field "${k}"`,
        'INVALID_BODY',
      );
    }
  }

  switch (endpoint) {
    case 'balance':
      return { endpoint, body: b as unknown as BalanceRequestWire };

    case 'bet':
      requireStringField(b, 'transactionUuid');
      requireStringField(b, 'amountMicro');
      requireStringField(b, 'roundId');
      return { endpoint, body: b as unknown as BetRequestWire };

    case 'win':
      requireStringField(b, 'transactionUuid');
      requireStringField(b, 'referenceTransactionUuid');
      requireStringField(b, 'amountMicro');
      requireStringField(b, 'roundId');
      return { endpoint, body: b as unknown as WinRequestWire };

    case 'rollback':
      requireStringField(b, 'transactionUuid');
      requireStringField(b, 'referenceTransactionUuid');
      return { endpoint, body: b as unknown as RollbackRequestWire };

    default: {
      // Exhaustiveness check
      const exhaustive: never = endpoint;
      throw new WebhookHeaderError(
        `unknown endpoint ${exhaustive}`,
        'UNKNOWN_ENDPOINT',
      );
    }
  }
}

function requireStringField(b: Record<string, unknown>, key: string): void {
  if (typeof b[key] !== 'string') {
    throw new WebhookHeaderError(
      `missing or non-string field "${key}"`,
      'INVALID_BODY',
    );
  }
}

export { KEY_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER };
