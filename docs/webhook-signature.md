# Webhook Signature Specification

Canonical signing rules for outbound webhooks the RGS dispatches to operators.
Parallel to the inbound wallet signing scheme ([wallet-api.md §Authentication](./wallet-api.md#authentication)), same primitive (HMAC-SHA256), same clock-skew window, different canonical
string (webhooks are a one-way notification, not a request / response).

Types and helpers are in `packages/webhook-spec`; this document is the
wire-level specification.

**Contents**

- [Event envelope](#event-envelope)
- [Headers](#headers)
- [Canonical string](#canonical-string)
- [Canonical JSON](#canonical-json)
- [Verification recipe](#verification-recipe)
- [Secret rotation](#secret-rotation)
- [Retry + idempotency semantics](#retry--idempotency-semantics)
- [Event types](#event-types)

---

## Event envelope

Every webhook POST body is a JSON object with this shape:

```ts
interface WebhookEnvelope<T> {
  eventId:     string;          // UUID v4, deduplication key
  eventType:   WebhookEventType;
  occurredAt:  string;          // ISO-8601
  operatorId:  string;
  dataVersion: number;          // Bumped when `data` shape breaks
  data:        T;               // Per-event payload
}
```

`WebhookEventType` is one of:

- `round.settled`
- `round.voided`
- `session.terminated`
- `session.rg_limit_tripped`
- `reconciliation.discrepancy`
- `credential.rotated`
- `credential.revoked`
- `webhook.test`

Per-event `data` shapes are defined in `packages/webhook-spec/src/index.ts`
and documented in [integration-guide.md#webhooks](./integration-guide.md).

---

## Headers

Every webhook carries six headers:

| Header | Value | Purpose |
| --- | --- | --- |
| `X-Yantra-Signature` | `base64( HMAC_SHA256(secret, canonical) )` | Authenticity + integrity |
| `X-Yantra-Signature-Alg` | `HMAC-SHA256` | Algorithm agility for future migrations |
| `X-Yantra-Signature-Version` | Integer matching `WebhookSubscription.secretVersion` | Which secret produced the signature (supports overlap-then-cut rotation) |
| `X-Yantra-Event-Id` | UUID v4 from the envelope | Cheap dedupe without parsing the body |
| `X-Yantra-Event-Type` | Event type from the envelope | Cheap routing without parsing the body |
| `X-Yantra-Timestamp` | Unix seconds at dispatch time | ±30s replay-window bound |

---

## Canonical string

The string signed is **exactly** (no trailing newline):

```
POST\n<path>\n<timestamp>\n<sha256_hex(canonical_body)>
```

Where:

- `<path>` is the webhook URL's path (the operator's side, e.g. `/webhooks/yantra`).
  Query string is **not** included (webhooks don't use query strings).
- `<timestamp>` is the `X-Yantra-Timestamp` integer, as a string.
- `<sha256_hex(canonical_body)>` is the hex-encoded SHA-256 of the
  canonicalised JSON body (see below).

The canonical string for bets is structurally identical to the wallet-call
signing scheme, operators that already implemented wallet-call verification
can reuse the canonicaliser.

---

## Canonical JSON

Webhooks are signed over a **canonical** JSON encoding of the envelope, not
the raw bytes, so operators can verify without re-serialising with the same
library.

Rules (implemented in `packages/webhook-spec/src/index.ts::canonicalJson`):

1. Object keys are sorted **lexicographically** (code-point order).
2. No whitespace between tokens.
3. `undefined` values are omitted (not serialised as `null`).
4. `null` serialises as `null`.
5. `bigint` values serialise as **quoted decimal strings** (not JS `BigInt`
   syntax). Wallet amounts are decimal strings already so this only matters
   for per-event internal fields.
6. `Date` values serialise as ISO-8601 strings.
7. Strings, numbers, booleans: standard `JSON.stringify` semantics.

Example: the envelope

```js
{ eventType: 'round.settled', occurredAt: new Date('2026-04-24T10:15:30Z'),
  data: { roundId: 'r1', totalBetsMicro: '100000' }, eventId: 'e1',
  operatorId: 'op1', dataVersion: 1 }
```

canonicalises to (newlines added for readability, actual encoding has none):

```
{"data":{"roundId":"r1","totalBetsMicro":"100000"},
 "dataVersion":1,
 "eventId":"e1",
 "eventType":"round.settled",
 "occurredAt":"2026-04-24T10:15:30.000Z",
 "operatorId":"op1"}
```

---

## Verification recipe

**Node.js** (identical to the wallet-side verify in `packages/wallet-spec`):

```ts
import crypto from 'node:crypto';
import { canonicalJson, WEBHOOK_HEADERS } from '@yantra/webhook-spec';

export function verifyWebhook(
  req: { headers: Record<string, string>; body: unknown; path: string },
  secretsByVersion: Record<string, string>, // { "1": "abc...", "2": "def..." }
): boolean {
  const sig = req.headers[WEBHOOK_HEADERS.signature.toLowerCase()];
  const alg = req.headers[WEBHOOK_HEADERS.signatureAlg.toLowerCase()];
  const ver = req.headers[WEBHOOK_HEADERS.signatureVersion.toLowerCase()];
  const ts  = req.headers[WEBHOOK_HEADERS.timestamp.toLowerCase()];

  if (alg !== 'HMAC-SHA256') return false;
  const secret = secretsByVersion[ver];
  if (!secret) return false;

  // Replay window: reject > 300s skew for webhooks (looser than wallet
  // calls because retries can arrive late).
  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  const body = canonicalJson(req.body);
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = `POST\n${req.path}\n${ts}\n${bodyHash}`;
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('base64');

  const a = Buffer.from(expected, 'base64');
  const b = Buffer.from(sig, 'base64');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

**Non-Node operators** implement the same four steps:

1. Look up the secret by `X-Yantra-Signature-Version`.
2. Validate `X-Yantra-Timestamp` is within ±300s (wall-clock; assumes NTP).
3. Compute the canonical string (`POST` + path + timestamp + sha256 hex).
4. HMAC-SHA256 + base64 + constant-time compare to `X-Yantra-Signature`.

Python, Go, PHP, Java, and C# reference snippets will ship with the
auto-generated SDKs in v1.1 (see [`B2B_ROADMAP.md` §17](../B2B_ROADMAP.md#17-versioning-and-delivery)).

---

## Secret rotation

Webhook secrets rotate on the same overlap-then-cut pattern as operator API
credentials ([security.md#rotation](./security.md#rotation)):

1. The operator issues a new secret via `POST /v1/admin/webhooks/:id/rotate`
   (portal UI at Settings → Webhooks → Rotate).
2. `WebhookSubscription.secretVersion` increments; both old and new secrets
   are stored.
3. The RGS signs outbound webhooks with the **new** secret, stamping
   `X-Yantra-Signature-Version` with the new version.
4. The operator verifier is expected to accept **both** old and new for a
   configurable overlap window (default 24h).
5. After confirmation, the operator revokes the old secret via
   `POST /v1/admin/webhooks/:id/revoke-version?v=<old>`. The RGS drops the
   old secret.

---

## Retry + idempotency semantics

- **Retries:** exponential backoff, 8 attempts, cap 24h. Per-attempt timeout
  is 5 s. A retry carries the **same** `eventId`, `eventType`, `occurredAt`,
  body, and signature, signatures are deterministic given the secret +
  canonical string, so retries are bit-identical to the first dispatch.
- **Success:** any HTTP 2xx response from the operator. The RGS does not
  read the response body.
- **Failure:** any other status (3xx, 4xx, 5xx) or timeout. The next attempt
  is scheduled per the backoff schedule (roughly: 30s, 2min, 5min, 15min,
  1h, 4h, 12h, 24h).
- **Idempotency:** operators MUST dedupe on `eventId`. The RGS emits at
  least once; retries are expected to be idempotent on the operator side.
- **Persistent failure:** after 8 attempts, the event is dead-lettered into
  the operator-portal "failed webhooks" view, alerting the on-call team.
  The operator can manually re-dispatch from the portal.

---

## Event types

| Type | `dataVersion` | Meaning |
| --- | --- | --- |
| `round.settled` | 1 | A round reached `SETTLED` state. Payload includes outcome + bet + payout totals. |
| `round.voided` | 1 | A round moved to `VOIDED` (e.g. startup recovery found it unsettleable). |
| `session.terminated` | 1 | A session ended, player logout, TTL expiry, or operator-initiated termination. |
| `session.rg_limit_tripped` | 1 | A session's RG limit was hit at bet-time. Bet rejected. |
| `reconciliation.discrepancy` | 1 | Daily reconciliation found a drift between RGS and operator ledgers. `status: MINOR_DRIFT | MAJOR_DRIFT`. |
| `credential.rotated` | 1 | A credential on the `Operator` was rotated. Informational, no action required by the operator. |
| `credential.revoked` | 1 | A credential was revoked. If it was the credential the operator was using, subsequent calls will fail with `RS_ERROR_INVALID_SIGNATURE`. |
| `webhook.test` | 1 | Dispatched by the portal "Send test event" button. |

`dataVersion` is bumped whenever the payload shape changes in a
backward-incompatible way; operators that handle only their supported
`dataVersion` should ignore unrecognised versions safely.
