# RNG Technical Specification: Crash Minimal

> Cert-lab submission document for the Crash Minimal game. This spec
> accompanies `packages/rng-core/src/index.ts` (shared commit-reveal
> primitives), `games/crash-minimal/src/outcome.ts` (game-specific mapping),
> and the test artefacts under `./rng-test-vectors.md` +
> `../fixtures/rng-test-vectors.json`.
>
> **Certified against rng-core commit:** `<CERTIFIED-AGAINST-RNG-CORE: pending-first-submission>`
>, filled in at GLI-11 submission time with the exact SHA of
> `packages/rng-core/src/` this spec was certified against. Enforced by
> `scripts/export-cert-packet.ts` which pins the SHA into the submission zip.
>
> **Submission status:** pre-cert. Not yet submitted to any lab. The
> derivations below track the production code path; the statistical test
> runs remain open before GLI-11 submission.

**Audience:** iTech Labs, BMM, GLI, internal security review, independent audit.

**Companion documents:**

- [par-sheet.md](./par-sheet.md) / [par-sheet.json](./par-sheet.json), probability + payout + RTP analysis.
- [provably-fair.md](../../../docs/provably-fair.md), player-facing verification scheme (platform-wide, shared by every game).
- [rng-test-vectors.md](./rng-test-vectors.md), fixed input/output tuples (TBD).
- [change-management.md](../../../docs/change-management.md), what triggers re-cert (platform-wide).

---

## 1. Scope

This document specifies the random number generation used to determine
round outcomes for Crash Minimal. It covers:

- The shared commit-reveal scheme (inherited from
  `packages/rng-core`, documented in
  [provably-fair.md](../../../docs/provably-fair.md)).
- The Crash-Minimal-specific derivation of `crashMultiplier` from the
  52-bit uniform `u`.
- The house-edge injection point.
- The `maxMultiplier` clamp.
- The statistical test plan a cert lab would run.

Primitives (HMAC-SHA256, `roundHmac`, `generateSeedPair`,
`verifyServerSeed`) are shared with every other game and are specified in
`packages/rng-core` + the platform-wide provably-fair doc; this spec does
not re-derive them.

---

## 2. Classification

| Attribute | Value |
| --- | --- |
| RNG class | Cryptographic pseudo-random (CSPRNG-seeded, deterministic-derived) |
| Entropy source | Operating-system CSPRNG (shared with `rng-core`) |
| Entropy consumption per round | 0 bytes, seed reused across rounds via incrementing nonce |
| Outcome bit-width | 52 bits of HMAC output consumed per round |
| Outcome domain | `crashMultiplier ∈ [1.00, maxMultiplier]`, two-decimal precision |
| Player-influenced? | Yes, player/operator may provide `clientSeed` |

---

## 3. Derivation

Implemented in [`games/crash-minimal/src/outcome.ts`](../src/outcome.ts).

```text
hmac  = HMAC_SHA256(serverSeed, clientSeed || ':' || nonce)      // 256 bits
bits52 = first 52 bits of hmac as unsigned integer               // [0, 2^52)
u_raw  = bits52 / 2^52                                           // uniform[0, 1)

if u_raw < houseEdge:
  crashMultiplier := 1.00                                         // house-bust branch
else:
  u := (u_raw - houseEdge) / (1 - houseEdge)                      // rescale to uniform[0, 1)
  raw := floor(100 / (1 - u)) / 100                               // two-decimal multiplier
  crashMultiplier := clamp(raw, 1.00, maxMultiplier)
```

Why 52 bits: Number's safe-integer range is `2^53 - 1`, so a 52-bit integer
converted via `Number(BigInt)` is lossless. Using 53 bits would risk a
precision edge case; using 32 bits would quantise the tail coarsely.

---

## 4. House-edge injection

The `u_raw < houseEdge` pre-roll branch is the standard Bustabit-family
approach. It:

1. Preserves the 1/K survival tail above the bust point, so RTP is
   identical for every cashout choice (see `par-sheet.md`).
2. Keeps the proof verification one-branch-free for the non-bust path ,
   external verifiers can recompute `u_raw` and check `crashMultiplier`
   without knowing the implementation.
3. Is a visible single parameter (`houseEdge`), auditable from
   `OperatorGameConfig.configJson` at any time.

---

## 5. Bias analysis

- **52-bit quantisation of uniform[0,1):** the uniform is
  `bits52 / 2^52`, exact rational with 2^52 possible values. No rounding
  bias. Any implementation that uses `Math.random()` or JavaScript Number
  directly for entropy derivation is non-compliant.
- **`floor(100 / (1 - u)) / 100` mapping:** introduces two-decimal
  quantisation of the tail. At `u → 1` the raw multiplier approaches
  infinity; the `maxMultiplier` clamp bounds this. Probability of clamp
  firing is `(1 − houseEdge) / maxMultiplier`, which at the default
  `maxMultiplier = 1000` is `< 0.001`.
- **No modular reduction** in the outcome path, unlike Ketapola Dice.

---

## 6. Statistical test plan

| Test | Tool | Pass criterion |
| --- | --- | --- |
| Bust-rate audit | built-in | `|observed − houseEdge| / √(houseEdge·(1−houseEdge)/N) < 3σ`, N = 10⁷ |
| Tail goodness-of-fit | chi-square | p > 0.01, N = 10⁷, bucketed multipliers |
| RTP per cashout bucket | `tests/games/crash-minimal/rtp-regression.spec.ts` | each bucket within ±0.5 pp of `1 − houseEdge` |
| Determinism | `tests/games/crash-minimal/rng-test-vectors.spec.ts` (TBD) | exact match on fixed vectors |

---

## 7. Failure modes and mitigations

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Entropy source not ready at boot | `randomBytes` blocks | `/readyz` fails closed; shared with every game via `rng-core` |
| `serverSeed` leaked pre-reveal | Adversary can precompute for that session | Seed is AES-GCM encrypted at rest; no raw seed in any log; session-bounded blast radius |
| `floor()` / `Math.min` drift across engines | Divergent outcomes across JS runtimes | `games/crash-minimal/src/outcome.ts` uses `BigInt` for the 52-bit read then a single `Number` cast; `Math.floor` and `Math.min` are IEEE-754-specified deterministic operations |
| `maxMultiplier` misconfigured at 1.01 | Effectively constant-multiplier game | Schema enforces `maxMultiplier ≥ 1.01` (allowed but silly); operators should default to 1000+ per this spec |

---

## 8. Reference implementation

Split across two files:

**`packages/rng-core/src/index.ts`**: shared primitives (`roundHmac`).

**`games/crash-minimal/src/outcome.ts`**: Crash-specific mapping:

- `determineCrashOutcome(ctx, config)`: the function specified in §3.
- `verifyCrashOutcome(ctx, config, claimed)`: symmetric to
  `determineCrashOutcome`, compares to floating-point tolerance.
- `RNG_VERSION = 'crash-minimal-rng-v1'`: stamped on every Round.

Both files are change-gated: CI rejects any PR touching
`packages/rng-core/src/` without a `CERT-ATTEST-CORE:` line, or any file
under `games/crash-minimal/src/{outcome,settle,config}.ts` without a
`CERT-ATTEST-CRASH_MINIMAL:` line. See
[change-management.md](../../../docs/change-management.md).

---

## 9. Artefacts for cert-lab submission

| Artefact | Location |
| --- | --- |
| Shared RNG primitives | `packages/rng-core/src/index.ts` |
| Crash outcome mapping | `games/crash-minimal/src/outcome.ts` |
| RNG spec (this doc) | `games/crash-minimal/docs/rng-spec.md` |
| PAR sheet | `games/crash-minimal/docs/par-sheet.md` + `par-sheet.json` |
| Test vectors | `games/crash-minimal/docs/rng-test-vectors.md` + `fixtures/rng-test-vectors.json` (TBD) |
| Regression test | `tests/games/crash-minimal/rtp-regression.spec.ts` |
| Commit-reveal spec (platform) | `docs/provably-fair.md` |
| Change-management policy (platform) | `docs/change-management.md` |
| Audit trail schema | `apps/rgs-server/prisma/schema.prisma` (`Round`, `GameSession`, `WalletCall` models) |

Run `bun scripts/export-cert-packet.ts crash-minimal` to assemble these
into a single self-contained zip for GLI-11 submission.

---

## 10. Specification version

| Field | Value |
| --- | --- |
| Spec version | 0.1.0-draft |
| Status | Pre-cert, tracking `games/crash-minimal/src/` |
| Last reviewed | 2026-04-24 |
