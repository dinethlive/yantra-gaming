# PAR Sheet: Crash Minimal

> **Submission status:** pre-cert. The analytical derivation below tracks
> `games/crash-minimal/src/outcome.ts` and `settle.ts`. The 10M-round
> regression run, the tail-distribution confidence interval, and
> independent-reviewer sign-off remain open before GLI-11 submission.

The analytical specification of the Crash Minimal game: rules, probability
model, payout model, RTP derivation, volatility, and change-management
rules. A cert lab (GLI, BMM, iTech Labs) would test against the numbers
below using a multi-million-round simulation and compare observed behaviour
against the theoretical distribution declared here.

A change to any of the parameters in this document, or to
[`packages/rng-core/src/`](../../../packages/rng-core/src/) (shared primitives) or
[`games/crash-minimal/src/outcome.ts`](../src/outcome.ts) (game-specific mapping),
triggers re-certification in a real deployment.

**Machine-readable companions:**
- [`par-sheet.json`](./par-sheet.json), probabilities, payouts, RTP and volatility as structured JSON (diff-friendly for certification drift detection).
- [`rng-test-vectors.md`](./rng-test-vectors.md) + `../fixtures/rng-test-vectors.json`: fixed `(serverSeed, clientSeed, nonce, config)` → `(crashMultiplier, u)` tuples. _TBD, generate with `scripts/generate-test-vectors.ts crash-minimal` before submission._

---

## Game description

Crash Minimal is a single-multiplier crash game: every round produces one
`crashMultiplier ∈ [1.00, maxMultiplier]` with a heavy-tailed distribution.
The player commits to a `cashoutMultiplier` up front; wins if
`crashMultiplier ≥ cashoutMultiplier`. See
[game-rules.md](./game-rules.md) for the complete rule set.

---

## Distribution

Given uniform `u_raw ∈ [0, 1)` from the first 52 bits of the HMAC:

```
P(bust at 1.00)               = houseEdge
P(crashMultiplier ≥ K | no bust) = 1 / K     for K ∈ (1.00, maxMultiplier]
P(crashMultiplier ≥ K)        = (1 − houseEdge) / K
```

The 1/K survival function is the classic Bustabit-family crash curve; the
pre-roll bust branch is the standard way to inject house edge without
distorting the tail.

---

## RTP

For any cashout multiplier K ∈ (1.00, maxMultiplier]:

```
RTP(K) = K · P(crashMultiplier ≥ K)
       = K · (1 − houseEdge) · (1/K)
       = 1 − houseEdge
```

**The RTP is identical for every cashout choice**: this is the defining
property of the 1/K crash curve. Players cannot improve their expected
return by picking a different cashout; they can only change the variance.

| `houseEdge` | Theoretical RTP | House edge |
| --- | --- | --- |
| 0.00 | 100.00 % | 0.00 % |
| 0.01 (default) | 99.00 % | 1.00 % |
| 0.03 | 97.00 % | 3.00 % |

The `maxMultiplier` clamp subtracts a negligible amount from the
theoretical RTP because the truncated tail mass is `(1 − houseEdge) /
maxMultiplier`; at the default `maxMultiplier = 1000` this is
`< 0.001`: below cert-lab measurement noise.

---

## Volatility

| `cashoutMultiplier` | Hit frequency | StdDev of return per unit stake | Classification |
| --- | --- | --- | --- |
| 1.50 | 0.660 | ≈ 0.91 | low |
| 2.00 | 0.495 | ≈ 1.00 | medium |
| 5.00 | 0.198 | ≈ 1.99 | high |
| 10.00 | 0.099 | ≈ 2.98 | very high |

Values above use `houseEdge = 0.01` and ignore the `maxMultiplier` clamp.
Precise values for submission are computed by the regression run against
the production code path.

---

## Max exposure per bet

```
maxPayoutMicro = maxBetMicro · maxMultiplier − commissionMicro
```

At the default `maxMultiplier = 1000` and a `maxBetMicro` set by the
operator, the max exposure per bet is 1000× the stake. Operators cap this
via `maxBetMicro` and, optionally, per-player per-round concurrency limits
(not implemented in this repo).

---

## How cert labs test this

A GLI-19 / ISO/IEC 17025 cert lab would run the following tests against
the specification above. The repo ships the regression test at
`tests/games/crash-minimal/rtp-regression.spec.ts`.

### RTP regression

- Simulate 10,000,000 rounds at the declared `houseEdge` using the
  production RNG path (`determineCrashOutcome` in
  [`games/crash-minimal/src/outcome.ts`](../src/outcome.ts)).
- For each round, score a fixed basket of cashout multipliers (e.g.
  1.50×, 2.00×, 5.00×, 10.00×) and aggregate observed RTP per bucket.
- Assert each bucket is within ±0.5 pp of `1 − houseEdge`.

### Tail-distribution goodness-of-fit

- Bucket outcomes by multiplier range and compute a chi-square against
  the theoretical `P(crashMultiplier ∈ [a, b)) = (1 − houseEdge) · (1/a − 1/b)`.
- Assert p-value > 0.01.

### Bust-rate audit

- Count rounds with `crashMultiplier == 1.00`.
- Assert observed bust rate matches `houseEdge` within ±3σ.

### Determinism

- For fixed `(serverSeed, clientSeed, nonce, config)`, assert the outcome
  is bit-identical across runs, processes, and machines.

---

## Change management

The following changes require re-certification. The repo encodes this
policy in CI: any PR touching these files fails without a
`CERT-ATTEST-CRASH_MINIMAL:` line in the PR body.

| File | Reason |
| --- | --- |
| [`packages/rng-core/src/`](../../../packages/rng-core/src/) | Shared commit-reveal primitives, also invalidates every other game's cert |
| [`games/crash-minimal/src/outcome.ts`](../src/outcome.ts) | Crash-specific derivation: 52-bit uniform, house-bust branch, 100/(1-u) mapping |
| [`games/crash-minimal/src/settle.ts`](../src/settle.ts) | Win condition and payout arithmetic |
| [`games/crash-minimal/src/config.ts`](../src/config.ts) | `houseEdge` / `maxMultiplier` schema and defaults |
| This file | Declared probabilities / RTP are the cert-lab input |

---

## See also

- [provably-fair.md](../../../docs/provably-fair.md), the commit-reveal scheme (platform-wide, shared with Ketapola).
- [game-rules.md](./game-rules.md), Crash Minimal rule set.
- [rng-spec.md](./rng-spec.md), formal RNG spec.
- [rng-test-vectors.md](./rng-test-vectors.md), fixed input/output tuples (TBD).
- [par-sheet.json](./par-sheet.json), machine-readable PAR data.
- [observability.md](../../../docs/observability.md#rtp-drift-monitor), the rolling RTP drift alert.
- [`games/crash-minimal/src/outcome.ts`](../src/outcome.ts), reference implementation.
- `tests/games/crash-minimal/rtp-regression.spec.ts`: the 10M-round regression test.
