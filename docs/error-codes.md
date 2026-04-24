# Error Codes

Every `RS_*` status code the operator may return from a wallet callback, or that the
RGS may synthesise internally. This is the authoritative behavioural contract, the
classifier helpers in `packages/wallet-spec` encode the same rules.

**Classification key**

| Class | Meaning |
| --- | --- |
| SUCCESS | Treat as success; commit the state change |
| REJECT | Clean business rejection; do not rollback, do not retry |
| UNCERTAIN | Outcome unknown; rollback with same `transactionUuid`, then retry |
| FATAL | Protocol or configuration error; alert, do not retry |
| TERMINATE | End the session immediately |
| CONDITIONAL | Behaviour depends on the endpoint it is returned from |

---

## Full reference

| Code | Class | When it fires | How the caller should handle it |
| --- | --- | --- | --- |
| `RS_OK` | SUCCESS | Operator booked the money movement cleanly | Commit, continue |
| `RS_ERROR_DUPLICATE_TRANSACTION` | SUCCESS | `transactionUuid` already exists in operator ledger | Treat identically to `RS_OK`; use the `balanceMicro` returned |
| `RS_ERROR_NOT_ENOUGH_MONEY` | REJECT | Player balance < stake at time of `/wallet/bet` | Mark the bet `REJECTED` in our ledger, surface "insufficient funds" to the player, do **not** rollback, do **not** retry |
| `RS_ERROR_LIMIT_REACHED` | REJECT | Operator-side responsible-gambling or velocity limit tripped | Same as `NOT_ENOUGH_MONEY`: clean reject |
| `RS_ERROR_USER_DISABLED` | TERMINATE | Player account locked (self-exclusion, ops intervention, fraud flag) | Terminate the session, mark the current bet `REJECTED`, do not rollback, do not retry |
| `RS_ERROR_INVALID_TOKEN` | TERMINATE | Session token presented to the operator is expired or malformed | Terminate the session, alert |
| `RS_ERROR_TOKEN_EXPIRED` | TERMINATE | Session token has aged past its `exp` claim | Terminate the session; player must launch a new session |
| `RS_ERROR_INVALID_SIGNATURE` | FATAL | HMAC verification failed on the operator side | Alert, either our outbound signing regressed, or the operator's shared secret drifted. Investigate and rotate if needed |
| `RS_ERROR_INVALID_PARTNER` | FATAL | `operatorId` in the request body does not match the `kid` we signed with | Alert, credential routing bug; do not retry with the same credentials |
| `RS_ERROR_WRONG_CURRENCY` | FATAL | Request currency does not match the currency of the player's wallet at the operator | Alert, abort the session; the `operatorGameConfig` currency may be misaligned |
| `RS_ERROR_WRONG_SYNTAX` | FATAL | Malformed JSON, missing fields, wrong shape | Alert (our bug); dump the exact outbound body into the `WalletCall` row and fix client-side |
| `RS_ERROR_WRONG_TYPES` | FATAL | Fields present but wrong type (e.g. `amountMicro` sent as decimal) | Alert (our bug); most commonly caused by sending `"100.00"` instead of integer-string micro-units |
| `RS_ERROR_TRANSACTION_DOES_NOT_EXIST` | CONDITIONAL | Operator cannot find the `referenceTransactionUuid` | See [conditional handling](#rs_error_transaction_does_not_exist) below |
| `RS_ERROR_TIMEOUT` | UNCERTAIN | Synthetic, the RGS `HttpWalletAdapter` aborted after `timeoutMs` (default 5,000 ms) | Fire `/wallet/rollback` with the same `transactionUuid`, enqueue retry with exponential backoff |
| `RS_ERROR_UNKNOWN` | UNCERTAIN | HTTP 5xx from operator, invalid JSON, network error, any status not in the allowlist | Same as `TIMEOUT`: rollback + retry |

---

## Classifier helpers

The following helpers are exported from `@yantra/wallet-spec` and used internally
by the RGS. Operators writing their own SDK should mirror them:

```ts
const REJECT = new Set([
  'RS_ERROR_NOT_ENOUGH_MONEY',
  'RS_ERROR_LIMIT_REACHED',
  'RS_ERROR_USER_DISABLED',
]);

const DUPLICATE = new Set(['RS_ERROR_DUPLICATE_TRANSACTION']);

function isRejectStatus(s: string): boolean {
  return REJECT.has(s);
}

function isSuccessOrDuplicate(s: string): boolean {
  return s === 'RS_OK' || DUPLICATE.has(s);
}
```

Use them as the decision oracle:

```ts
const result = await wallet.bet(req);

if (isSuccessOrDuplicate(result.status)) {
  // Commit
} else if (isRejectStatus(result.status)) {
  // Clean reject, no rollback
} else {
  // Uncertain, rollback with same transactionUuid + enqueue retry
}
```

---

## Conditional handling

### `RS_ERROR_TRANSACTION_DOES_NOT_EXIST`

Behaviour depends on which endpoint surfaces the error.

**From `/wallet/win`**: the operator cannot find the `referenceTransactionUuid`
(i.e. the original bet). This means either:

- The bet was never booked on the operator's side (the RGS logged a success that was
  not actually committed, alarming but possible after a partial failure), or
- The bet was previously rolled back, but the RGS never learned of it.

Handling: alert, mark the bet `SETTLED` with `won=false` regardless of outcome (we
cannot retroactively credit a win against a bet the operator doesn't have), and file
a reconciliation ticket.

**From `/wallet/rollback`**: the operator has no record of the referenced
transaction. This usually means the original `/wallet/bet` or `/wallet/win` never
actually committed, likely the one that produced the timeout that triggered this
rollback in the first place.

Handling: treat as a successful rollback. There is nothing to undo. The round
completes cleanly.

**From `/wallet/bet` or `/wallet/balance`**: should not occur for these endpoints
(they do not carry `referenceTransactionUuid`). If it does, treat as FATAL.

---

## How retries are paced

For any UNCERTAIN response:

1. The bet (or win) is marked pending, and a `PendingWalletJob` row is inserted.
2. Immediate rollback is attempted once with the same `transactionUuid`.
3. If the rollback also returns UNCERTAIN, the retry loop takes over:
   - Initial delay: 1 second
   - Doubling each attempt: 2s, 4s, 8s, 16s, 32s, 60s
   - Cap at 60 seconds, jittered ±20%
   - Total budget: 24 hours
4. At 24 hours, the job is marked `abandoned` and surfaces in the operator portal's
   wallet-calls page as a human-intervention ticket.

Retries preserve `requestUuid` and `transactionUuid`. This is critical, reusing both
ensures the operator can deduplicate cleanly even if our first attempt silently
landed on their side.

---

## Where to look when debugging

Every outbound wallet call appears in the `wallet_calls` table with:

- `direction = OUTBOUND`
- `endpoint`: BALANCE, BET, WIN, ROLLBACK
- `requestBody`, `responseBody`: full JSON captures
- `responseStatus`: the RS_* code returned
- `httpStatus`: transport status code
- `latencyMs`: wall-clock measurement
- `attempt`: retry counter
- `succeeded`: boolean, set once `isSuccessOrDuplicate(responseStatus)` is true

Filter in the operator portal under Wallet Calls, or query directly:

```sql
SELECT endpoint, response_status, http_status, latency_ms, attempt
FROM wallet_calls
WHERE operator_id = '<op>' AND succeeded = false
ORDER BY created_at DESC
LIMIT 50;
```

---

## See also

- [wallet-api.md](./wallet-api.md#retry-and-rollback-rules), the same table in
  context alongside each endpoint.
- [security.md](./security.md), signing and authentication failures that produce
  `RS_ERROR_INVALID_SIGNATURE` / `RS_ERROR_INVALID_PARTNER`.
- `packages/wallet-spec/src/index.ts`: authoritative definitions.
