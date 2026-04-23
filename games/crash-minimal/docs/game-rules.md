# Game Rules: Crash Minimal

> Single source of truth for how Crash Minimal plays. Player-facing terms,
> operator-facing SLA, and cert-lab (GLI-11) submission all cite this
> document.

Paired documents:

- [par-sheet.md](./par-sheet.md), math model, RTP, volatility.
- [rng-spec.md](./rng-spec.md), cryptographic outcome derivation.
- [error-codes.md](../../../docs/error-codes.md), platform-wide status codes.

Any change to this document is a regated change, see
[change-management.md](../../../docs/change-management.md).

> **Submission status:** pre-cert. This plugin has not been submitted to any
> cert lab. The rules below are derivable from `games/crash-minimal/src/`
> as of the most recent commit; the RTP regression, test vectors, and
> independent math review remain open before GLI-11 submission.

---

## 1. Game overview

Crash Minimal is a provably-fair single-multiplier crash game. Each round
rolls a multiplier ≥ 1.00× with a long right tail. The player commits to a
**cashout multiplier** before the round starts; if the rolled
`crashMultiplier` reaches or exceeds the player's `cashoutMultiplier`, the
player wins `stake × cashoutMultiplier` (minus operator commission);
otherwise the stake is lost.

This plugin ships as the second reference implementation of the
`GamePlugin` contract (see [B2B_ROADMAP.md §4](../../../B2B_ROADMAP.md)), its purpose is to validate the plugin seam against a continuous-outcome
game, as distinct from Ketapola Dice's discrete LOW/HIGH shape.

---

## 2. Round lifecycle

Same plugin-driven state machine as every other game: `PENDING →
BETTING_OPEN → ROLLING → RESULT → SETTLED / VOIDED`. Plugin-specific
observations:

- Only one selection shape: `{ cashoutMultiplier: number }` with
  `1.01 ≤ cashoutMultiplier ≤ 10_000` (`games/crash-minimal/src/selection.ts`).
- No manual cashout in this minimal variant, the commit is the cashout.
  A richer variant with live cashout would be a separate plugin.

---

## 3. Outcome

The round produces a single `crashMultiplier ∈ [1.00, maxMultiplier]` with
two decimal precision. Derivation is in
[rng-spec.md](./rng-spec.md) §6; the brief form:

```
hmac = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
u_raw = first 52 bits / 2^52, uniform[0, 1)
if u_raw < houseEdge:
  crashMultiplier = 1.00, house-bust branch
else:
  u = (u_raw - houseEdge) / (1 - houseEdge)
  crashMultiplier = floor(100 / (1 - u)) / 100, two-decimal
clamp to [1.00, maxMultiplier]
```

---

## 4. Settlement

From `games/crash-minimal/src/settle.ts`:

- **Win** (`crashMultiplier ≥ cashoutMultiplier`):
  `gross = stake × cashoutMultiplier`, `payout = max(0, gross − commissionMicro)`.
- **Loss** (`crashMultiplier < cashoutMultiplier`): stake is lost, no payout.

Commission is a flat `commissionMicro` per bet, matching the
`OperatorGameConfig` shape used by every game.

---

## 5. Configuration parameters

Per-operator-per-currency, stored on `OperatorGameConfig.configJson` and
validated by the plugin at engine startup
(`games/crash-minimal/src/config.ts`):

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `houseEdge` | number ∈ [0, 1) | 0.01 | Pre-roll bust probability, sets RTP to `1 − houseEdge`. |
| `maxMultiplier` | number ≥ 1.01 | 1000 | Hard cap on `crashMultiplier` to bound the client animation and wire payload. |

---

## 6. Session lifecycle

Identical to Ketapola Dice, see
[ketapola-dice/docs/game-rules.md §8](../../ketapola-dice/docs/game-rules.md)
for the platform-wide contract. One `gameCode` (`crash-minimal`) per
session; `serverSeed` / `clientSeed` / `nonce` drive RNG; seed rotation
mechanics unchanged.

---

## 7. Source of truth

| Question | Answer lives in |
| --- | --- |
| Rules (this doc) | `games/crash-minimal/docs/game-rules.md` |
| Math | [par-sheet.md](./par-sheet.md) |
| RNG | [rng-spec.md](./rng-spec.md) |
| Outcome code | `games/crash-minimal/src/outcome.ts` |
| Settlement code | `games/crash-minimal/src/settle.ts` |
| Platform wallet contract | `docs/wallet-api.md` |
