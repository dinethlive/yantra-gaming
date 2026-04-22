// Webhook contract shared between the RGS dispatcher and operator
// receivers. Kept small on purpose — only the wire shapes + canonical
// serialisation rules live here. Business logic lives in the RGS.
//
// Security model:
//   * POST body is canonical-JSON-encoded (stable key order, no
//     whitespace, BigInt-as-string). See `canonicalJson` below.
//   * X-Yantra-Signature header carries HMAC-SHA256(shared_secret,
//     body).hex.
//   * X-Yantra-Event-Id header carries the logical event UUID.
//     Receivers MUST treat duplicate event ids as idempotent.
//   * X-Yantra-Signature-Version matches WebhookSubscription.secretVersion
//     so receivers know which key produced the signature during rotation.
//
// Expected response: 200/204 = success, any other status = retry.
// Receivers SHOULD respond within 5 seconds.

export const WEBHOOK_EVENT_TYPES = [
  'round.settled',
  'round.voided',
  'session.terminated',
  'session.rg_limit_tripped',
  'reconciliation.discrepancy',
  'credential.rotated',
  'credential.revoked',
  'webhook.test',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEnvelope<T = unknown> {
  eventId: string;              // UUID v4 — deduplication key
  eventType: WebhookEventType;
  occurredAt: string;           // ISO-8601
  operatorId: string;
  /**
   * Schema version for the `data` body. Bumped when the event payload
   * shape changes in a breaking way.
   */
  dataVersion: number;
  data: T;
}

// Per-event payload shapes. Keep them minimal — operators fetch full
// evidence via the dispute-pack endpoint if they need more.

export interface RoundSettledData {
  roundId: string;
  sessionId: string;
  gameCode: string;
  currency: string;
  outcomeSide: 'LOW' | 'HIGH' | null;
  outcomeSum: number | null;
  totalBetsMicro: string;
  totalPayoutsMicro: string;
  settledAt: string;
  rngVersion: string;
}

export interface RoundVoidedData {
  roundId: string;
  sessionId: string;
  gameCode: string;
  currency: string;
  voidedAt: string;
  reason: string | null;
}

export interface SessionTerminatedData {
  sessionId: string;
  playerRef: string;
  terminatedAt: string;
  reason: string | null;
}

export interface SessionRgLimitTrippedData {
  sessionId: string;
  playerRef: string;
  limitType: string;             // matches RGLimitBreach
  remainingMicro: string | null;
  stakeMicro: string;
  attemptedAt: string;
}

export interface ReconciliationDiscrepancyData {
  operatorId: string;
  currency: string;
  periodDate: string;            // YYYY-MM-DD
  maxDriftPct: number;
  status: 'MINOR_DRIFT' | 'MAJOR_DRIFT';
}

export interface CredentialRotatedData {
  credentialType: 'API_KEY_INBOUND' | 'WALLET_HMAC_OUTBOUND';
  newKid: string;
  previousKid: string | null;
  previousCredentialRetiresAt: string;
}

export interface CredentialRevokedData {
  credentialType: 'API_KEY_INBOUND' | 'WALLET_HMAC_OUTBOUND';
  kid: string;
  revokedAt: string;
}

export interface WebhookTestData {
  note: string;
}

// Canonical JSON — identical encoding rules to the replay / dispute
// pack signers. Keeps all RGS-to-operator signatures verifiable with
// one small helper on the operator side.
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'bigint') return `"${v.toString()}"`;
  if (v instanceof Date) return `"${v.toISOString()}"`;
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const WEBHOOK_HEADERS = {
  signature: 'X-Yantra-Signature',
  signatureAlg: 'X-Yantra-Signature-Alg',
  signatureVersion: 'X-Yantra-Signature-Version',
  eventId: 'X-Yantra-Event-Id',
  eventType: 'X-Yantra-Event-Type',
  timestamp: 'X-Yantra-Timestamp',
} as const;
