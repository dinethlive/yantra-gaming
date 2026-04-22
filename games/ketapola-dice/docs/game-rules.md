# Game Rules: Ketapola Dice

> Single source of truth for how the game plays. Player-facing terms,
> operator-facing SLA, and cert-lab (GLI-11) submission all cite this
> document.

Paired documents:

- [par-sheet.md](./par-sheet.md), math model, RTP, volatility.
- [rng-spec.md](./rng-spec.md), cryptographic outcome derivation.
- [error-codes.md](../../../docs/error-codes.md), platform-wide status codes.

Any change to this document is a regated change, see
[change-management.md](../../../docs/change-management.md).

---

## 1. Game overview

Ketapola Dice (කැටපොල) is a Sri Lankan single-die wagering game. The die has six
faces split into two sides:

```
LOW  side  →  3,  6,  9
HIGH side  → 12, 15, 18
```

A player wagers on a **side** (LOW or HIGH). If the rolled face belongs to
that side, the player wins. The specific face value (3 vs 6 vs 9 within LOW)
does not affect payout, only the side matters.

---

## 2. Round lifecycle

Each round proceeds through the following phases. Durations are operator-
configurable; defaults shown.

| Phase | Default duration | Player can… | Server action |
| --- | --- | --- | --- |
| `PENDING` | transient |, | Allocate round id, snapshot seed state |
| `BETTING_OPEN` | 15 000 ms | place a bet | Accept bets, debit wallets on success |
| `ROLLING` | 4 000 ms |, | Derive outcome via `determineOutcome` |
| `RESULT` | transient |, | Emit result to all listeners |
| `SETTLED` | terminal |, | Credit winning bets to operator wallets |
| `VOIDED` | terminal |, | Refund every accepted bet via rollback |

Between rounds: a **cooldown** phase (default 3 000 ms) separates consecutive
rounds.

Phase transitions emit `round_state` events over Socket.IO. The terminal
events are `round_result` (on SETTLED) and `round_voided` (on VOIDED).

Configurable per operator per currency on `OperatorGameConfig`:
`bettingWindowMs`, `rollingWindowMs`, `cooldownMs`.

---

## 3. Placing a bet

### 3.1 Eligibility

A bet is accepted if **all** of the following hold:

1. The player's session is active (not terminated, not expired).
2. The current round phase is `BETTING_OPEN`.
3. `minBetMicro ≤ amountMicro ≤ maxBetMicro` for the operator's config.
4. The player has not already placed a bet in this round (one bet per player
   per round).
5. The operator's RG limits (daily loss, daily wager, session-time) allow the
   additional stake, enforced by `RGLimitsEnforcer.ts`.
6. The operator wallet returns `RS_OK` to the outbound `/wallet/bet` call.

### 3.2 Inputs

```ts
interface PlaceBetInput {
  side: 'LOW' | 'HIGH';
  amountMicro: bigint;   // stake in micro-units (× 100,000 of major unit)
}
```

### 3.3 Rejection reasons

Every rejection emits a `bet_rejected` event with a `reason` code:

| Code | Meaning |
| --- | --- |
| `bet_out_of_range` | Stake is below min or above max for this operator/currency |
| `session_not_found` | Session referenced by socket no longer exists in DB |
| `session_terminated` | Operator forced termination (self-exclusion, timeout, risk) |
| `session_expired` | JWT `exp` passed |
| `phase_not_open` | Bet arrived outside the BETTING_OPEN window |
| `already_bet_this_round` | Player already has one bet on this round |
| `rg_limit_reached` | Responsible-gambling limit would be breached |
| `wallet_rejected:<RS_*>` | Operator wallet returned a rejection status |
| `wallet_timeout` | Outbound `/wallet/bet` exceeded `WALLET_CALL_TIMEOUT_MS`; synthetic rollback scheduled |
| `invalid_payload` | Zod validation of input failed (non-recoverable client bug) |

---

## 4. Payout

### 4.1 Formula

Let `c = commissionMicro / MICRO_PER_UNIT` (unitless fraction; default `0.03`).

```
If outcome.side == player.side:
    gross_payout = 2.0 * stake
    commission   = gross_payout * c
    net_payout   = gross_payout - commission
                 = (2.0 - 2.0 * c) * stake
    wallet /win credits net_payout
    player net gain = net_payout - stake = (1.0 - 2.0 * c) * stake

If outcome.side != player.side:
    no payout, no /win call
    player net gain = -stake  (already debited at bet time)
```

At the default configuration (`payoutMultiplier = 2.0`, `c = 0.03`):

| Stake | On win (net payout) | Player net gain on win | Player net gain on loss |
| --- | --- | --- | --- |
| 100.00 LKR | 194.00 LKR | +94.00 LKR | −100.00 LKR |
| 1 000.00 LKR | 1 940.00 LKR | +940.00 LKR | −1 000.00 LKR |

### 4.2 Free bets

A free bet is one where the operator passes `isFree: true` on the outbound
`/wallet/bet` call (the operator's accounting flags this; the RGS does not
mint free bets). Behaviour:

| Event | Regular bet | Free bet |
| --- | --- | --- |
| Stake debited on bet | yes | no |
| Payout credited on win | net payout | net payout |
| Player net gain on win | `net_payout − stake` | `net_payout` |
| Player net gain on loss | `−stake` | `0` |

Free-bet accounting is the operator's responsibility; the RGS preserves the
`isFree` flag on every `Bet` and `WalletCall` row for audit.

### 4.3 Rounding

All money is in `bigint` micro-units end-to-end. There is no floating-point
arithmetic in the settlement path. Commission is computed as
`(gross × commissionMicro) / MICRO_PER_UNIT` with `bigint` division, which
truncates. The truncated remainder accrues to the operator (favouring the
house at the fifth decimal place), matching standard cert-lab practice.

---

## 5. Outcome derivation

See [rng-spec.md](./rng-spec.md) for the formal specification. In brief:

```
outcome = HMAC_SHA256( serverSeed, clientSeed + ":" + nonce )
  first 32 bits → side (weighted LOW/HIGH)
  next  32 bits → face index within side (mod 3)
```

A player can verify every outcome post-hoc via `GET /v1/rounds/:id/proof`
after the round settles or voids. See
[provably-fair.md](../../../docs/provably-fair.md) for the 20-line verifier.

---

## 6. Void and refund conditions

A round transitions to `VOIDED` (not `SETTLED`) in **any** of these cases:

1. **Outcome derivation failure**: `rng.determineOutcome` throws
   (should be impossible given schema validation; defensive).
2. **Server crash during ROLLING with no persisted outcome**: on startup
   recovery, `GameEngine.resumeUnsettledRounds()` detects `Round.settled =
   false` with no `outcome` and voids it.
3. **Operator-forced termination mid-round**: `POST
   /v1/session/:id/terminate` while round in `BETTING_OPEN` or `ROLLING`
   voids any bets belonging to that session.

When a round is voided:

- Every `Bet` with status `ACCEPTED` on that round is flipped to `VOIDED`.
- A `PendingWalletJob` of type `ROLLBACK` is enqueued for each, referencing
  the original `betTransactionUuid`.
- The corresponding `PendingRoundBet` transitions `HELD → REFUNDED` with
  `resolutionReason = 'ROUND_VOIDED'`.

The operator wallet will receive a `/wallet/rollback` call for each bet,
eventually (retried with exponential backoff until accepted or ticketed by
reconciliation).

**Invariant:** no money leaves the operator permanently on a voided round.
Every debit is reversed.

---

## 7. Disconnect handling

A player may drop their connection at any time. The game's behaviour is:

| When disconnect happens | Behaviour |
| --- | --- |
| Before `place_bet` in round N | No effect, no bet was placed |
| After `place_bet` ack, before round end | Bet remains in force. Round completes normally. Settlement fires against the operator wallet. Player can reconnect (same token) and see the result. |
| After `round_result`, before `SETTLED` | Settlement fires regardless of connection state |
| Mid-round, server crashes | See §6, round either resumes (outcome known) or voids (outcome unknown) |

Sessions are durable. Disconnect does not cancel or void a session. Session
termination is an explicit operator action (`/terminate`) or token
expiration.

---

## 8. Session lifecycle

### 8.1 Creation

`POST /v1/session`: operator-signed. See [wallet-api.md](../../../docs/wallet-api.md)
and Appendix B of `B2B_ROADMAP.md`.

Creates a `GameSession` row bound to:

- one `operatorId`
- one `playerRef` (opaque operator-side id)
- one `currency`
- one `gameCode` (e.g. `ketapola-dice` for this spec; other plugins ship as `crash-minimal` etc.)
- one `serverSeed` + `serverSeedHash`
- one `clientSeed` (operator- or RGS-provided)

### 8.2 Lifetime

- Max JWT `exp`: 60 minutes from creation (config: session JWT expiry).
- Max session duration (enforced): 60 minutes (cert-jurisdiction dependent).
- Seed rotation: player-initiated. Rotating produces a new server seed; the
  old seed is revealed via `/proof` for every round that used it.

### 8.3 Termination

A session ends by:

- JWT `exp` passing → `session_expired` on next bet attempt.
- Operator-forced termination (`POST /v1/session/:id/terminate`).
- Player closing the game, the RGS does not eagerly terminate on socket
  disconnect; sessions remain reconnectable until `exp`.

On termination:

- `GameSession.terminatedAt` is set.
- Any in-flight round belonging to that session voids (§6).
- The `serverSeed` of the session is revealed via `/proof` endpoints for
  every historical round.

---

## 9. Responsible gambling

RG limits are carried as claims in the session JWT and enforced at bet time
by `services/RGLimitsEnforcer.ts`:

| Claim | Unit | Check |
| --- | --- | --- |
| `dailyLossMicro` | micro-units per 24h | Reject bet if `sum(lost_stakes_last_24h) + stake > limit` |
| `dailyWagerMicro` | micro-units per 24h | Reject bet if `sum(wagers_last_24h) + stake > limit` |
| `sessionTimeSeconds` | seconds | Reject bet if `now − sessionStart > limit` |

A rejection here surfaces to the client as `bet_rejected / reason:
rg_limit_reached`, and the RGS does not attempt the outbound `/wallet/bet`.

Self-exclusion is an operator-side concern; the RGS relies on the operator
to not issue a session JWT for a self-excluded player.

---

## 10. Edge cases and tie-breaking

### 10.1 Two players bet different sides, same round

Independent, each bet settles against its own operator wallet entry. No
cross-player tie exists; the die outcome decides both independently.

### 10.2 Weight change mid-session

If an operator edits `lowWeight` / `highWeight` via the portal during a live
session, the edit is logged in `OperatorConfigAuditLog`. The engine picks up
the new weights on the next round (not retroactively applied). Mid-round
edits are impossible, the round snapshots `(lowWeight, highWeight)` at
`PENDING`.

### 10.3 Operator wallet returns a non-standard status

Unrecognised `RS_*` codes are treated as **uncertain**: the classifier
defaults to the retry-with-rollback path. This is the safe-by-construction
default: never double-spend, always reconcile.

### 10.4 Duplicate `transactionUuid` on /wallet/bet

Operator responds `RS_ERROR_DUPLICATE_TRANSACTION`. This is classified as
**success** (the operator has already processed the transaction). The RGS
does not retry, does not emit a rejection, and the bet proceeds as if
accepted.

### 10.5 `amountMicro = 0`

Rejected as `bet_out_of_range`: zero stakes are not permitted regardless of
operator config. (Even if `minBetMicro` is configured to 0, the Zod schema
rejects zero at the outer boundary.)

### 10.6 Currency mismatch

The session JWT binds a currency. A bet payload without an explicit currency
inherits the session currency. The RGS does not support switching currency
mid-session; the operator must issue a new session.

---

## 11. Spec version

| Field | Value |
| --- | --- |
| Spec version | 1.0.0 |
| Last reviewed | 2026-04-23 |
| Source of truth for rules | This document |
| Source of truth for math | [par-sheet.md](./par-sheet.md) |
| Source of truth for RNG | [rng-spec.md](./rng-spec.md) |
