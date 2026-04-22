# PAR Sheet: Ketapola Dice

The analytical specification of the Ketapola dice game: rules, probability model,
payout model, RTP derivation, volatility, and change-management rules. A cert lab
(GLI, BMM, iTech Labs) would test against the numbers in this document using a
multi-million-round simulation and compare observed behaviour against the theoretical
distribution declared here.

A change to any of the parameters in this document, or to
[`packages/rng-core/src/`](../../../packages/rng-core/src/) (shared primitives) or
[`games/ketapola-dice/src/outcome.ts`](../src/outcome.ts) (game-specific mapping),
triggers re-certification in a real deployment.

**Machine-readable companions:**
- [`par-sheet.json`](./par-sheet.json), probabilities, payouts, RTP and volatility as structured JSON (diff-friendly for certification drift detection).
- [`rng-test-vectors.md`](./rng-test-vectors.md) + [`../fixtures/rng-test-vectors.json`](../fixtures/rng-test-vectors.json), fixed `(serverSeed, clientSeed, nonce, weights)` → `(side, sum)` tuples. Regression-tested on every CI run by [`tests/games/ketapola-dice/rng-test-vectors.spec.ts`](../../../tests/games/ketapola-dice/rng-test-vectors.spec.ts).

---

## Game description

Ketapola Dice (කැටපොල) is a Sri Lankan dice game in which a single die is rolled and
lands on one of six faces. The faces are unusual:

```
LOW side   =  3,  6,  9
HIGH side  = 12, 15, 18
```

A round proceeds in three phases:

1. **Betting window** (default 15 s): the player picks a side, `LOW` or `HIGH`, and
   stakes an amount.
2. **Rolling** (default 4 s): the RNG derives the outcome deterministically from the
   committed session seed, the client seed, and the round nonce (see
   [provably-fair.md](../../../docs/provably-fair.md)).
3. **Result & settlement**: the outcome is displayed; winning bets are paid out, the
   round transitions to `SETTLED`.

Cooldown (default 3 s) separates consecutive rounds.

The wager is on the **side**, not on the specific face value. A player who bets
`LOW` wins if the die lands on 3, 6, or 9, the specific face is not rewarded or
penalised.

---

## Configuration parameters

Per-operator, per-currency, stored on `OperatorGameConfig`:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `lowWeight` | integer | 48 | Weight of LOW side in the RNG threshold |
| `highWeight` | integer | 48 | Weight of HIGH side in the RNG threshold |
| `minBetMicro` | BigInt | *operator-set* | Minimum stake in micro-units |
| `maxBetMicro` | BigInt | *operator-set* | Maximum stake in micro-units |
| `commissionMicro` | BigInt | 0 | Commission deducted per winning bet, in micro-units per micro-unit stake |
| `payoutMultiplier` | fixed | 2.0 | Not configurable; winning bets pay 2× stake gross |
| `bettingWindowMs` | integer | 15000 | Duration of the betting window |
| `rollingWindowMs` | integer | 4000 | Visual roll duration |
| `cooldownMs` | integer | 3000 | Pause between rounds |

The pair `(lowWeight, highWeight)` controls the side distribution. Default is
symmetric (48, 48), cert labs would exercise this default and any other live
configuration. `payoutMultiplier` is fixed at 2.0× in the code and is intentionally
not exposed, changing it is a re-certification event.

`commissionMicro` is the lever used to introduce a house edge without skewing the
dice. It is applied as a multiplicative factor on the gross payout (see
[RTP derivation](#rtp-derivation) below).

---

## Probability model

With `totalWeight = lowWeight + highWeight`:

### Side probability

```
P(side = LOW)  = lowWeight  / totalWeight
P(side = HIGH) = highWeight / totalWeight
```

At the default symmetric configuration (48, 48):

```
P(LOW)  = 0.5
P(HIGH) = 0.5
```

### Face probability given side

Each of the three faces on a side is equally likely. The `faceValue % 3` mapping in
`rng.ts` is uniform over a 32-bit integer, so:

```
P(face | side) = 1 / 3
```

Modular bias from `2^32 mod 3 = 1` is approximately `1 / 2^32 ≈ 2.3 × 10^-10` and
negligible for cert-lab chi-square tests.

### Joint face probability

`P(face) = P(side) × P(face | side)`

At the default symmetric configuration:

| Sum | Side | Weight path | Probability |
| --- | --- | --- | --- |
| 3 | LOW | `(48/96) × (1/3)` | `0.166667` |
| 6 | LOW | `(48/96) × (1/3)` | `0.166667` |
| 9 | LOW | `(48/96) × (1/3)` | `0.166667` |
| 12 | HIGH | `(48/96) × (1/3)` | `0.166667` |
| 15 | HIGH | `(48/96) × (1/3)` | `0.166667` |
| 18 | HIGH | `(48/96) × (1/3)` | `0.166667` |

Sum of probabilities: `6 × 1/6 = 1.0`. Every face is equiprobable at the default.

For an asymmetric example, `(lowWeight=60, highWeight=40)`:

| Sum | Side | Probability |
| --- | --- | --- |
| 3 | LOW | `(60/100) × (1/3) = 0.200` |
| 6 | LOW | `0.200` |
| 9 | LOW | `0.200` |
| 12 | HIGH | `(40/100) × (1/3) = 0.133` |
| 15 | HIGH | `0.133` |
| 18 | HIGH | `0.133` |

Sum: `0.600 + 0.400 = 1.000`.

---

## Payout model

```
Player stakes `stake` on side S ∈ {LOW, HIGH}.

If outcome.side == S:
  gross_payout = 2.0 × stake
  commission   = stake × (commissionMicro / MICRO_PER_UNIT)
  net_payout   = gross_payout - commission
  The operator receives a /wallet/win for `net_payout`. Stake is lost from the
  bet leg (debited at bet time); the win leg credits the payout. Net player gain
  on a winning round: net_payout - stake.

If outcome.side != S:
  The player loses the stake. No /wallet/win is issued. Net player gain on a
  losing round: -stake.
```

Notes:

- `commissionMicro` is stored as micro-units per micro-unit stake. A 3% commission is
  `commissionMicro = 3000` (since `3% × 100,000 = 3,000`). Or equivalently, with
  `MICRO_PER_UNIT = 100_000`: `commissionMicro / MICRO_PER_UNIT = 0.03`.
- Commission applies only on wins, a losing bet has no commission (the stake is
  already lost). This matches the way most table-style games are configured.
- Free bets (`isFree: true` on `/wallet/bet`) still pay out 2× stake if they win but
  the stake is never debited, so the player's net gain is `+payout` on win and `0`
  on loss. Promotional accounting is the operator's concern.

---

## RTP derivation

Return-to-Player (RTP) is the long-run expected return per unit staked:

```
RTP = E[payout per unit staked]
    = P(win) × (payout_on_win) / stake
```

### Without commission, symmetric weights

`P(win)` for a player who bets on the same side the dice lands is:

```
P(win) = P(outcome.side == player.side)
       = 0.5      (at symmetric 48, 48)
```

Gross payout on win is `2.0 × stake`. So:

```
RTP_gross = 0.5 × (2.0 × stake) / stake
          = 0.5 × 2.0
          = 1.0 = 100%
```

This is a fair game, no house edge, no player edge. It is not a realistic live
configuration but is useful as a sanity check and as the regression-test baseline
(see [testing](#how-cert-labs-test-this)).

### With commission

Commission `c` (a unitless fraction; e.g. 0.03 for 3%) applies on the gross payout:

```
net_payout = (1 - c) × 2.0 × stake

RTP = P(win) × net_payout / stake
    = P(win) × 2.0 × (1 - c)
```

At symmetric weights:

```
RTP = 0.5 × 2.0 × (1 - c) = 1 - c
```

At `c = 0.03`: `RTP = 0.97 = 97%`. This is the recommended production configuration.
Lottery-style games typically sit at 50-70%; slot-style games 90-98%. A 97% RTP
positions Yantra as a high-return table game.

### With asymmetric weights (non-default)

If `lowWeight ≠ highWeight`, both sides have a different win probability. Operators
must not expose an asymmetric configuration without adjusting commission or payout
multiplier to keep RTP consistent across sides, otherwise one side is systematically
disadvantaged. The operator portal's config page surfaces the computed RTP per side
at save-time and blocks saves that produce RTP > 100% or a side-delta > 0.5%.

---

## Volatility

### Hit frequency

```
hit_frequency = P(win) = 50%
```

Half of rounds return some payout (a winning bet on the chosen side). The other half
return nothing.

### Variance

For a unit stake on either side, per-round gross payout is the random variable `X`:

- `X = 2` with probability 0.5 (win)
- `X = 0` with probability 0.5 (loss)

```
E[X]     = 0.5 × 2 + 0.5 × 0     = 1
E[X²]    = 0.5 × 4 + 0.5 × 0     = 2
Var[X]   = E[X²] - E[X]² = 2 - 1 = 1
StdDev[X]                        = 1
```

So per unit staked, per round, the standard deviation of return is `1`. With
commission `c`, `E[X] = 1 - c`, so the coefficient of variation (StdDev / |mean|) is
very close to 1 / (1 - c). For `c = 0.03`, CoV ≈ 1.03.

This is a **medium-volatility** profile. Hit frequency is high but the spread is
wide. Compare: slot machines typically run CoV values of 5-20. This is inherent to a
two-outcome even-money game.

### Max win and loss per round

```
Max win (gross)  = 2 × maxBetMicro
Max win (net)    = (2 - c) × maxBetMicro  (≈ 1.97 × maxBetMicro at 3% commission)
Max loss         = 1 × maxBetMicro
```

Max exposure per round, aggregated across concurrent bets from different players in
the same round, is bounded by `Σ (2 × bet_amount)` for each bet on the winning side.
The engine does not cap this explicitly, operators cap it via `maxBetMicro` and,
optionally, a per-player per-round concurrency limit (not implemented in this repo).

---

## How cert labs test this

A GLI-19 / ISO/IEC 17025 cert lab would run the following tests against the
specification above. The repo ships the regression test at
`tests/games/ketapola-dice/rtp-regression.spec.ts`.

### RTP regression

- Simulate 10,000,000 rounds at the declared weight configuration using the
  production RNG path (`determineOutcome` in `games/ketapola-dice/src/outcome.ts`,
  composing the `roundHmac` primitive from `packages/rng-core/src/`).
- For each round, compute the payout using the declared `payoutMultiplier` and
  `commissionMicro`.
- Aggregate: `observed_RTP = Σ payouts / Σ stakes`.
- Assert: `|observed_RTP - theoretical_RTP| ≤ 0.005` (half a percentage point).

At 10M rounds the standard error of `observed_RTP` is approximately
`StdDev[X] / sqrt(N) ≈ 1 / sqrt(10^7) ≈ 0.00032`, so the ±0.5% gate passes with
very high confidence if the implementation is correct.

### Chi-square face distribution

- Bin the 10M outcomes by face.
- Compute chi-square against the expected probability table.
- Assert p-value > 0.01 (95% confidence the observed distribution is consistent).

### Side balance at symmetric weights

- Assert `|count(LOW) - count(HIGH)| / N < 0.002` (side imbalance < 0.2%).

### Determinism

- For a fixed `(serverSeed, clientSeed, nonce, lowWeight, highWeight)`, assert the
  outcome is bit-for-bit reproducible across runs, processes, and machines.

### Seed independence

- Run the simulation across 100 different `serverSeed` values and assert the
  aggregate RTP varies by less than 0.1% between seed batches.

### Bias from modular reduction

- Compute the theoretical bias introduced by `faceValue % 3` (where `faceValue` is a
  uniform 32-bit integer). The bias is `(2^32 mod 3) / 2^32 = 1 / 2^32 ≈ 2.3 × 10^-10`.
- Assert this is below the lab's bias threshold (typically 10^-8).

---

## Change management

The following changes require re-certification in a real product. The repo encodes
this policy in CI: any PR that touches these files fails without an explicit
attestation header (`X-RNG-Change-Attested: <reviewer-name>`).

| File | Reason |
| --- | --- |
| `packages/rng-core/src/` | Shared commit-reveal primitives (`generateSeedPair`, `roundHmac`, `uint32At`, `verifyServerSeed`), changes invalidate every game's RNG cert |
| `games/ketapola-dice/src/outcome.ts` | Ketapola-specific mapping: `determineOutcome`, face arrays (`LOW = [3,6,9]`, `HIGH = [12,15,18]`), weighted side selection |
| `OperatorGameConfig.lowWeight` / `highWeight` | Changing the side distribution |
| `OperatorGameConfig.commissionMicro` | Changes RTP; cert labs retest RTP regression |
| `OperatorGameConfig.minBetMicro` / `maxBetMicro` | Changes game theoretic max-win; retest max-win simulation |
| This file | The declared probabilities are the cert-lab input; drift here invalidates the previous cert |

Changes to visual timings (`bettingWindowMs`, `rollingWindowMs`, `cooldownMs`) do not
affect math and are not gated.

---

## See also

- [provably-fair.md](../../../docs/provably-fair.md), the commit-reveal scheme that produces
  these outcomes.
- [rng-test-vectors.md](./rng-test-vectors.md), fixed input/output tuples for
  independent RNG verification.
- [par-sheet.json](./par-sheet.json), machine-readable PAR data.
- [observability.md](../../../docs/observability.md#rtp-drift-monitor), the rolling RTP drift
  alert that catches configuration drift in production.
- `packages/rng-core/src/index.ts`: shared commit-reveal primitives.
- `games/ketapola-dice/src/outcome.ts`: Ketapola-specific outcome mapping.
- `tests/games/ketapola-dice/rtp-regression.spec.ts`: the 10M-round regression test.
- `tests/games/ketapola-dice/rng-test-vectors.spec.ts`: the vector regression test.
