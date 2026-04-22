import crypto from 'node:crypto';
import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signPayload,
  type CreateSessionRequest,
  type CreateSessionResponse,
} from '@yantra/wallet-spec';
import { SessionCreationError } from './errors.js';

export interface CreateSessionParams {
  /** Full URL of the RGS session endpoint — e.g. `https://rgs.yantra.example/v1/session`. */
  endpoint: string;
  /** The `kid` (key id) the RGS issued at onboarding. Goes in `X-Yantra-Key-Id`. */
  apiKeyId: string;
  /** The HMAC secret paired with `apiKeyId`. Never log this. */
  apiSecret: string;
  /** Session parameters per the wallet-spec {@link CreateSessionRequest} contract. */
  payload: CreateSessionRequest;
  /**
   * Optional per-request UUID used for inbound idempotency at the RGS. If the
   * operator retries a session create with the same `requestUuid`, the RGS
   * returns the cached response. Auto-generated (v4) if omitted.
   */
  requestUuid?: string;
  /** Outbound HTTP timeout. Default 10_000 ms. */
  timeoutMs?: number;
  /** Injectable fetch, for testing or for platforms that polyfill differently. */
  fetch?: typeof fetch;
  /** Inject a clock for deterministic tests. */
  nowSeconds?: () => number;
}

export interface CreateSessionResult extends CreateSessionResponse {
  /** The `requestUuid` actually sent (useful for logging / reconciliation). */
  requestUuid: string;
}

const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Create a launch session at the RGS.
 *
 * Example:
 *
 * ```ts
 * const { launchUrl, sessionToken } = await createSession({
 *   endpoint:  'https://rgs.yantra.example/v1/session',
 *   apiKeyId:  process.env.YANTRA_KEY_ID!,
 *   apiSecret: process.env.YANTRA_API_SECRET!,
 *   payload: {
 *     operatorId:   'op_abc123',
 *     playerRef:    player.id,
 *     gameCode:     'yantra',
 *     currency:     'LKR',
 *     lang:         'si',
 *     jurisdiction: 'LK',
 *     mode:         'real',
 *     returnUrl:    'https://casino.example.com/lobby',
 *     rgLimits:     { dailyLossMicro: '5000000000' },
 *   },
 * });
 * // res.redirect(launchUrl);  — or  <iframe src={launchUrl} />
 * ```
 *
 * Throws {@link SessionCreationError}. Inspect `err.retryable` to decide whether
 * to retry with exponential backoff.
 */
export async function createSession(
  params: CreateSessionParams,
): Promise<CreateSessionResult> {
  const requestUuid = params.requestUuid ?? crypto.randomUUID();
  const body = JSON.stringify({ ...params.payload, requestUuid });
  const url = new URL(params.endpoint);
  const timestamp = Math.floor((params.nowSeconds?.() ?? Date.now() / 1000));

  const signature = signPayload(
    params.apiSecret,
    'POST',
    url.pathname,
    timestamp,
    body,
  );

  const fetchImpl = params.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetchImpl(params.endpoint, {
      method: 'POST',
      headers: {
        'content-type': JSON_CONTENT_TYPE,
        [KEY_ID_HEADER]: params.apiKeyId,
        [TIMESTAMP_HEADER]: timestamp.toString(),
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    throw new SessionCreationError(
      aborted ? 'session request timed out' : 'network error contacting RGS',
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      /* retryable */ true,
      undefined,
      undefined,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new SessionCreationError(
      'invalid JSON in RGS response',
      'INVALID_RESPONSE',
      /* retryable */ false,
      res.status,
      undefined,
      err,
    );
  }

  if (res.status >= 500) {
    throw new SessionCreationError(
      `RGS 5xx (${res.status})`,
      'RGS_SERVER_ERROR',
      /* retryable */ true,
      res.status,
      parsed,
    );
  }
  if (res.status >= 400) {
    throw new SessionCreationError(
      `RGS rejected session request (${res.status})`,
      'RGS_REJECTED',
      /* retryable */ false,
      res.status,
      parsed,
    );
  }

  if (!isValidSessionResponse(parsed)) {
    throw new SessionCreationError(
      'RGS response missing required fields',
      'INVALID_RESPONSE',
      /* retryable */ false,
      res.status,
      parsed,
    );
  }

  return { ...parsed, requestUuid };
}

function isValidSessionResponse(v: unknown): v is CreateSessionResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.sessionId === 'string' &&
    typeof r.sessionToken === 'string' &&
    typeof r.launchUrl === 'string' &&
    typeof r.expiresAt === 'string' &&
    typeof r.serverSeedHash === 'string'
  );
}
