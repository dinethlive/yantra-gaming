# RNG Technical Specification: Ketapola Dice

> Cert-lab submission document for the Ketapola Dice game. This spec
> accompanies `packages/rng-core/src/index.ts` (shared commit-reveal
> primitives), `games/ketapola-dice/src/outcome.ts` (game-specific mapping),
> and the test artefacts under `./rng-test-vectors.md` +
> `../fixtures/rng-test-vectors.json`. A reviewer should be able to read this
> document, read the two source files (together ~150 lines), and sign off.
>
> **Certified against rng-core commit:** `<CERTIFIED-AGAINST-RNG-CORE: pending-first-submission>`
>, filled in at GLI-11 submission time with the exact SHA of
> `packages/rng-core/src/` this spec was certified against. Enforced by
> `scripts/export-cert-packet.ts` (bundles the pinned SHA into the submission
> zip so a re-cert can diff against it).

**Audience:** iTech Labs, BMM, GLI, internal security review, independent audit.

**Companion documents:**

- [par-sheet.md](./par-sheet.md) / [par-sheet.json](./par-sheet.json), probability + payout + RTP analysis.
- [provably-fair.md](../../../docs/provably-fair.md), player-facing verification scheme (platform-wide).
- [rng-test-vectors.md](./rng-test-vectors.md), fixed input/output tuples.
- [change-management.md](../../../docs/change-management.md), what triggers re-cert (platform-wide).

---

## 1. Scope

This document specifies the random number generation used to determine round
outcomes for the Ketapola dice game. It covers:

- The entropy source feeding `serverSeed` generation.
- The commit-reveal scheme binding outcomes to pre-committed secrets.
- The deterministic derivation of `(side, face)` from `(serverSeed, clientSeed, nonce, weights)`.
- Bias analysis, including the modular-reduction step.
- The statistical test plan a cert lab would run.
- Failure modes and their mitigations.

**Out of scope for this document:** operator wallet integration, round
lifecycle, bet/win/rollback semantics, RTP derivation, see the respective
docs.

---

## 2. Classification

| Attribute | Value |
| --- | --- |
| RNG class | Cryptographic pseudo-random (CSPRNG-seeded, deterministic-derived) |
| Entropy source | Operating-system CSPRNG (see §3) |
| Entropy consumption per round | 0 bytes, seed is reused across rounds via incrementing nonce |
| Entropy consumption per session | 32 bytes at session creation (serverSeed); 32 additional bytes on every seed rotation |
| Deterministic given seed? | Yes, full re-derivation is public (commit-reveal) |
| Player-influenced? | Yes, player/operator may provide `clientSeed` at session creation |
| Outcome bit-width | 32 bits side + 32 bits face (lifted from HMAC-SHA256 output) |

This is a **seeded PRNG** in the GLI-19 sense: entropy is drawn at seed time
from the OS CSPRNG, subsequent outcomes are deterministic derivations, and the
seed is bounded to one session + optional rotations within it.

---

## 3. Entropy source

`serverSeed` is produced by `crypto.randomBytes(32)` from the Node.js / Bun
standard library. The underlying OS syscall depends on the host:

| Platform | Syscall | Notes |
| --- | --- | --- |
| Linux ≥ 3.17 | `getrandom(2)` | Blocks until kernel entropy pool is initialised at boot, then non-blocking |
| FreeBSD / OpenBSD | `getrandom(2)` / `arc4random_buf(3)` | Same guarantees |
| macOS | `arc4random_buf(3)` (kernel-backed) |, |
| Windows | `BCryptGenRandom(BCRYPT_USE_SYSTEM_PREFERRED_RNG)` | FIPS-140 approved generator when OS is in FIPS mode |

`crypto.randomBytes` will throw if the OS CSPRNG is not ready (never, except
on an ill-provisioned VM at first-boot, which is a separate operational issue
covered in `security.md §startup`).

**Entropy budget.** 32 bytes = 256 bits. The birthday bound against collision
is `2^128` session-seeds, well beyond the cardinality of any plausible
deployment. Seed rotation within a session draws another 32 bytes; rotation
frequency is player-driven and has no effect on entropy adequacy.

`clientSeed` is not required to be random. It is treated as public input and
may be chosen by the operator or player. The scheme's security does not depend
on `clientSeed` being unpredictable, it depends on `serverSeed` being secret
until the round is settled.

---

## 4. Cryptographic primitives

| Primitive | Use | Algorithm |
| --- | --- | --- |
| Hash | `serverSeedHash = SHA256(serverSeed)`: commit | SHA-256 (FIPS 180-4) |
| MAC | Outcome derivation `HMAC(serverSeed, clientSeed:nonce)` | HMAC-SHA256 (FIPS 198-1, RFC 2104) |
| Constant-time compare | `verifyServerSeed` | `crypto.timingSafeEqual` |

All primitives are NIST-approved. No custom cryptography. No block-cipher
constructions beyond the library's HMAC implementation.

---

## 5. Seed lifecycle

```
            ┌─────────────────────────┐
            │     Session created     │
            │ (POST /v1/session)      │
            └────────────┬────────────┘
                         │ randomBytes(32) → serverSeed
                         │ SHA256(serverSeed) → serverSeedHash
                         ▼
            ┌─────────────────────────┐
            │   COMMITTED  (in DB)    │───────┐
            │ serverSeed encrypted,   │       │ serverSeedHash returned
            │ serverSeedHash public.  │       │ to player in session response
            └────────────┬────────────┘       │ (public commit).
                         │                    │
                         │ round N fires      │
                         ▼                    │
            ┌─────────────────────────┐       │
            │  USED (one round)       │       │
            │ determineOutcome(       │       │
            │   serverSeed, client,   │       │
            │   nonce=N, weights)     │       │
            └────────────┬────────────┘       │
                         │                    │
                         ├── loop: N = N+1    │
                         │                    │
                         │ rotate OR          │
                         │ session ends       │
                         ▼                    │
            ┌─────────────────────────┐       │
            │   REVEALED              │◀──────┘
            │ /v1/rounds/:id/proof    │
            │ returns raw serverSeed  │
            │ for every round that    │
            │ used it.                │
            └─────────────────────────┘
```

**Invariants enforced by the code:**

- `serverSeed` is never returned by any API while the round is in
  `BETTING_OPEN` or `ROLLING`. `ProofService` checks `state ∈ {SETTLED,
  VOIDED}` before revealing.
- `serverSeedHash` is immutable once committed; it is snapshotted onto every
  `Round` row at round creation.
- A new `(serverSeed, serverSeedHash)` pair is required on every seed
  rotation; reusing a revealed seed is rejected at the schema + service level.

---

## 6. Outcome derivation: formal

```
determineOutcome : (serverSeed, clientSeed, nonce, lowWeight, highWeight) → (side, sum)

Inputs:
  serverSeed   ∈ {0,1}^256                 (32-byte hex string)
  clientSeed   ∈ UTF-8 string, any length
  nonce        ∈ ℕ, 0 ≤ nonce < 2^53
  lowWeight    ∈ ℕ, 1 ≤ lowWeight
  highWeight   ∈ ℕ, 1 ≤ highWeight

Steps:
  1. message    := UTF-8(clientSeed) || UTF-8(":") || UTF-8(decimal(nonce))
  2. h          := HMAC-SHA256(serverSeed, message)                  ∈ {0,1}^256
  3. S          := uint32_be(h[0..4])                                ∈ [0, 2^32)
  4. T          := ⌊(lowWeight / (lowWeight + highWeight)) · (2^32 − 1)⌋
  5. side       := "LOW" if S < T else "HIGH"
  6. F          := uint32_be(h[4..8])                                ∈ [0, 2^32)
  7. faces      := [3,6,9] if side = "LOW" else [12,15,18]
  8. sum        := faces[F mod |faces|]                              ∈ faces

Output: (side, sum).
```

The reference implementation in TypeScript uses `parseInt(hex.slice(0,8), 16)`
which is the same as `uint32_be(bytes[0..4])`. A cert-lab harness written in
any language will match bit-for-bit.

### Bit budget

| Derivation step | Bits consumed |
| --- | --- |
| Side selection | 32 |
| Face selection | 32 |
| Total | 64 / 256 available |

192 bits of the HMAC are unused. This is intentional, future game variants
(e.g., more faces per side) can consume additional bytes without invalidating
the cert on the current game.

---

## 7. Bias analysis

### 7.1 Side selection bias

The threshold computation is:

```
T = ⌊(lowWeight / totalWeight) · (2^32 − 1)⌋
```

For the default symmetric case `lowWeight = highWeight = 48`:

```
T = ⌊0.5 · 4294967295⌋ = 2147483647
P(S < T) = 2147483648 / 2^32 ≈ 0.50000000023
```

Bias from the floor-and-compare construction: **≈ 5.8 × 10⁻¹⁰**. Below any
cert-lab threshold (typically `1 × 10⁻⁸`).

For asymmetric weights, the bias is the same floor-reduction: `|P(LOW) − lowWeight/totalWeight| < 2^−32`.

### 7.2 Face selection bias (modular reduction)

Face is chosen by `F mod 3` where `F` is a uniform 32-bit integer. The bias
introduced by modular reduction:

```
2^32     = 4294967296
2^32 / 3 = 1431655765.33...
P(F mod 3 = 0) = ⌈2^32 / 3⌉ / 2^32 = 1431655766 / 4294967296 ≈ 0.33333333372
P(F mod 3 = 1) = 1431655765 / 4294967296                    ≈ 0.33333333302
P(F mod 3 = 2) = 1431655765 / 4294967296                    ≈ 0.33333333302
```

Maximum per-face bias: **≈ 2.33 × 10⁻¹⁰**. Passes the GLI threshold of `10⁻⁸`
by eight orders of magnitude.

### 7.3 Independence across rounds

`nonce` strictly increments. HMAC-SHA256 is modelled as a PRF: changing the
message by any amount produces an output independent of the prior output. No
state carries between rounds, each round's derivation is a fresh HMAC call.
There is no internal RNG state that could accumulate bias.

### 7.4 Combined joint probability at default config

| Face | P(face) (theoretical) | P(face) (implementation) | Δ |
| --- | --- | --- | --- |
| 3 | 1/6 = 0.166666666… | 0.166666667… | ≈ 2 × 10⁻¹⁰ |
| 6 | 1/6 | 0.166666667 | ≈ 2 × 10⁻¹⁰ |
| 9 | 1/6 | 0.166666667 | ≈ 2 × 10⁻¹⁰ |
| 12 | 1/6 | 0.166666666 | ≈ 2 × 10⁻¹⁰ |
| 15 | 1/6 | 0.166666666 | ≈ 2 × 10⁻¹⁰ |
| 18 | 1/6 | 0.166666666 | ≈ 2 × 10⁻¹⁰ |

Below measurement noise at any practical sample size.

---

## 8. Statistical test plan

A certification lab would run the following against the bit stream
`h[0..16]` concatenated over a large sample of `(serverSeed, nonce)` pairs.
The repo ships the sample-generation driver at `tests/games/ketapola-dice/rtp-regression.spec.ts`.

### 8.1 Mandatory (GLI-19 §4)

| Test | Tool | Pass criterion |
| --- | --- | --- |
| Chi-square face distribution | built-in | p > 0.01, N = 10⁷ |
| RTP regression | `tests/games/ketapola-dice/rtp-regression.spec.ts` | \|observed − theoretical\| < 0.5 pp |
| Side balance | built-in | \|count(LOW) − count(HIGH)\| / N < 0.002 |
| Determinism | `tests/games/ketapola-dice/rng-test-vectors.spec.ts` | Exact match on 12 fixed vectors |
| Seed independence | scripted | Aggregate RTP varies < 0.1 % across 100 seeds |

### 8.2 Recommended (NIST SP 800-22)

The underlying HMAC-SHA256 is FIPS-approved and has been tested exhaustively
against NIST STS; the repo does not re-run the primitive tests. The
*implementation* harness treats the bit stream of concatenated HMAC outputs as
the subject of NIST STS when the lab requests it. All 15 tests are expected to
pass; historical cert submissions of commit-reveal HMAC schemes have reported
aggregate pass rates indistinguishable from an ideal source.

### 8.3 Recommended (Dieharder / PractRand)

Same bit stream, same expectation. These are entropy-quality tests against a
deterministic PRF, so they primarily test that the derivation wiring (message
formatting, byte order) doesn't accidentally collapse entropy. Failure here
would indicate a bug, not a cryptographic weakness.

---

## 9. Failure modes and mitigations

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Entropy source not ready at boot | `randomBytes` blocks or throws | `/readyz` fails closed until entropy is available; operator load balancer won't route traffic |
| `serverSeed` leaked before reveal | Adversary can precompute future outcomes for that session | Seed is stored AES-GCM encrypted; no log line ever contains raw seed; session is bound to one player so blast radius is one session |
| Clock drift affecting nonce increment | n/a, nonce is DB-tracked, not clock-derived |, |
| Duplicate `(serverSeed, clientSeed, nonce)` tuple | Two rounds produce identical outcomes | `GameSession.nonce` is a strictly-monotonic DB column; duplicate nonce would violate a schema check |
| `nonce` overflow (2⁵³) | Impossible in practice (would require > 285 billion rounds on one session) | Sessions cap at 1h duration per `../../../docs/security.md`; implicit bound |
| HMAC collision | `2⁻¹²⁸` per pair; negligible | Cryptographic assumption; documented dependency on SHA-256 |
| Compromised operator-provided `clientSeed` | None, `clientSeed` is public input; compromise is a no-op | The scheme does not rely on `clientSeed` secrecy |
| Rotated seed reused | Schema-blocked | `GameSession.serverSeedHash` is part of a unique index per session |

---

## 10. Reference implementation

Split across two files, both no-dependency beyond `node:crypto` + `zod`:

**`packages/rng-core/src/index.ts`**: shared commit-reveal primitives used
by every game plugin:

- `generateSeedPair()`: returns `{ serverSeed, serverSeedHash }`.
- `generateClientSeed()`: 16-byte hex default when neither operator nor
  player provides one.
- `roundHmac({ serverSeed, clientSeed, nonce })`: `HMAC_SHA256` over
  `clientSeed + ':' + nonce`, returned as lowercase hex.
- `uint32At(hmacHex, hexOffset)`: read 32 bits from the HMAC hex string.
- `verifyServerSeed(serverSeed, expectedHash)`: constant-time compare.

**`games/ketapola-dice/src/outcome.ts`**: Ketapola-specific mapping:

- `determineOutcome(serverSeed, clientSeed, nonce, lowWeight, highWeight)`: the function specified in §6. Composes `roundHmac` + `uint32At` with the
  weighted-side threshold and the face table (`LOW = [3,6,9]`,
  `HIGH = [12,15,18]`).
- `verifyOutcome(...)`: symmetric to `determineOutcome`, used by the proof
  endpoint.
- `RNG_VERSION = 'ketapola-rng-v1'`: stamped on every Round for
  cert-lab traceability.

Both files are change-gated: CI rejects any PR touching
`packages/rng-core/src/` without a `CERT-ATTEST-CORE:` line, or any file
under `games/ketapola-dice/src/{outcome,settle,config}.ts` without a
`CERT-ATTEST-KETAPOLA_DICE:` line. See
[change-management.md](../../../docs/change-management.md).

---

## 11. Artefacts for cert-lab submission

Everything the lab asks for is in this repo:

| Artefact | Location |
| --- | --- |
| Shared RNG primitives | `packages/rng-core/src/index.ts` |
| Ketapola outcome mapping | `games/ketapola-dice/src/outcome.ts` |
| RNG spec (this doc) | `games/ketapola-dice/docs/rng-spec.md` |
| PAR sheet | `games/ketapola-dice/docs/par-sheet.md` + `par-sheet.json` |
| Test vectors | `games/ketapola-dice/docs/rng-test-vectors.md` + `fixtures/rng-test-vectors.json` |
| Regression test | `tests/games/ketapola-dice/rtp-regression.spec.ts` |
| Vector regression | `tests/games/ketapola-dice/rng-test-vectors.spec.ts` |
| Commit-reveal spec (platform) | `docs/provably-fair.md` |
| Change-management policy (platform) | `docs/change-management.md` |
| Audit trail schema | `apps/rgs-server/prisma/schema.prisma` (`Round`, `GameSession`, `WalletCall` models) |

Run `bun scripts/export-cert-packet.ts ketapola-dice` to assemble these into
a single self-contained zip for GLI-11 submission, the script pins the
`rng-core` commit SHA, bundles the source, docs, fixtures, and regression
runs into one file.

---

## 12. Specification version

| Field | Value |
| --- | --- |
| Spec version | 1.0.0 |
| Last reviewed | 2026-04-23 |
| Next review trigger | Any change to §3, §4, §6, or §7 |
| RNG algorithm version | `rng-v1` (HMAC-SHA256 commit-reveal) |
