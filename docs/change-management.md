# Change Management Policy

> How RNG, game-math, and money-path changes get reviewed, gated, and re-certified.

This is the policy an auditor sees when they ask "what stops a developer from
silently changing the RNG?" It is both documented here and enforced in CI.

**Scope:** everything that invalidates a certification or changes money
handling. Changes to UI skins, telemetry, documentation prose, or internal
refactors that preserve behaviour follow the normal review process without the
gates described below.

---

## 1. Regated assets

The following assets are regated. A change to any of them requires the full
procedure in §3.

### 1.1 Code

| Path | Why |
| --- | --- |
| `packages/rng-core/src/` | Shared commit-reveal primitives, changes invalidate every game's RNG cert (gated by `CERT-ATTEST-CORE`) |
| `games/<code>/src/outcome.ts` / `settle.ts` / `config.ts` | Per-game outcome mapping, settlement math, and config schema, changes invalidate that game's RNG/math cert (gated by `CERT-ATTEST-<GAMECODE>`) |
| `apps/rgs-server/src/utils/signing.ts` | Outbound HMAC construction, changes invalidate integration |
| `apps/rgs-server/src/utils/secrets.ts` | AES-GCM encryption of operator secrets at rest, KMS contract |
| `apps/rgs-server/src/wallet/WalletClient.ts` | Circuit breaker, audit-log ordering, classifier |
| `apps/rgs-server/src/wallet/HttpWalletAdapter.ts` | Outbound wallet semantics (timeout → rollback) |
| `apps/rgs-server/src/services/GameEngine.ts` | Round lifecycle state machine, settlement ordering |
| `apps/rgs-server/src/services/ProofService.ts` | Seed-reveal gating |
| `packages/wallet-spec/src/index.ts` | Wire-format contract, breaking operators |

### 1.2 Schema

Any migration that changes the shape, constraints, or indexes on:

- `Round`, `Bet`, `WalletCall`, `PendingRoundBet`, `PendingWalletJob`,
  `InboundIdempotency`, `GameSession`.

Purely additive migrations on non-money-path tables (e.g., new columns on
`OperatorUser`) do **not** trigger this procedure.

### 1.3 Configuration

| Field | Why |
| --- | --- |
| `OperatorGameConfig.lowWeight` / `highWeight` | Side distribution, RTP changes |
| `OperatorGameConfig.commissionMicro` | House edge, RTP changes |
| `OperatorGameConfig.minBetMicro` / `maxBetMicro` | Max-win exposure |

Visual timings (`bettingWindowMs`, `rollingWindowMs`, `cooldownMs`) are **not**
regated, they affect only pacing.

### 1.4 Artefacts

| Path | Why |
| --- | --- |
| `games/<code>/docs/par-sheet.md` + `par-sheet.json` | Declared probability model, per game (GLI-11 scope) |
| `games/<code>/docs/rng-spec.md` | Cert-submission document, per game (GLI-11 scope) |
| `games/<code>/docs/rng-test-vectors.md` + `games/<code>/fixtures/rng-test-vectors.json` | Fixed input/output tuples, per game |
| `docs/provably-fair.md` | Player-facing commit-reveal verification contract, platform-wide (shared by every game) |

---

## 2. CI gate

The `.github/workflows/ci.yml` `rng-change-gate` job runs on every pull
request. It enforces two independent, per-scope attestations:

- A PR touching `packages/rng-core/src/` is rejected unless the PR
  description contains a `CERT-ATTEST-CORE:` line. (Changes here invalidate
  every game's certification, so the attestation is platform-wide.)
- A PR touching `games/<code>/src/{outcome,settle,config}.ts` is rejected
  unless the PR description contains a `CERT-ATTEST-<GAMECODE>:` line,
  uppercased with dashes replaced by underscores, e.g.
  `CERT-ATTEST-KETAPOLA_DICE:` for `games/ketapola-dice/`.

Per-scope gating means a Ketapola math fix does not force a Crash Minimal
re-cert conversation, and vice versa.

**Extending the gate** is a policy decision: adding a path to the `grep`
pattern requires buy-in from the engineering lead and the compliance lead (or
the equivalent roles in the licensee's org). The pattern is intentionally
narrow, a broad pattern produces false positives that wear down the gate's
authority.

Paths outside the `rng-change-gate` but listed in §1 above are enforced by
code-review (via CODEOWNERS) rather than by CI. See `.github/CODEOWNERS`.

---

## 3. Procedure for a regated change

### 3.1 Pre-work

1. Open an issue describing the change, its motivation, and its expected
   impact on RTP / audit / operators.
2. Flag in the issue whether the change is pure refactor (no behaviour
   change), a math change, an observability change, or a breaking change.
3. If the change affects math: compute the new theoretical RTP, volatility,
   and probability table **before** writing code, and attach them to the
   issue.

### 3.2 Implementation

1. Branch from `main`. Do not amend existing commits once pushed; use new
   commits so reviewers can see the sequence.
2. Update the regated artefact(s) in §1.4 alongside the code change. A PR
   that changes `packages/rng-core/src/` or a game's `outcome.ts` without
   updating `games/<code>/fixtures/rng-test-vectors.json` (if vectors
   change) or `games/<code>/docs/rng-spec.md` (if the scheme changes) is
   not reviewable.
3. Re-run:

   ```bash
   bun test tests/games                    # per-game RTP regression + vector tests
   bun test tests/plugin-contract          # architectural plugin conformance
   bun scripts/generate-test-vectors.ts <game-code> > /tmp/actual.json
   diff games/<game-code>/fixtures/rng-test-vectors.json /tmp/actual.json
   ```

   Any diff in vectors must be intentional and explained in the PR body.

### 3.3 PR submission

Add the matching `CERT-ATTEST-*:` line to the PR description, in the form:

```
CERT-ATTEST-<SCOPE>: <reviewer name>, <date>, <short justification>
```

Scope is `CORE` for `packages/rng-core/` edits or the upper-cased underscore
form of the game code (`KETAPOLA_DICE`, `CRASH_MINIMAL`, …) for per-game
edits. Example:

```
CERT-ATTEST-KETAPOLA_DICE: J. Smith, compliance lead, 2026-04-23, switch
from threshold floor to rounding-towards-zero; re-ran 10M Ketapola RTP
regression, observed 96.998% against 97.000% theoretical (well inside
±0.5 pp).
```

The CI gate only checks that the line exists. The human review checks that
the justification is real.

### 3.4 Review quorum

| Regated area | Reviewers required |
| --- | --- |
| `packages/rng-core/`, any game `outcome.ts` / `settle.ts`, RNG spec, test vectors | 2 senior engineers + 1 compliance owner |
| Wallet spec, `WalletClient`, `HttpWalletAdapter` | 2 senior engineers |
| Schema migration on money tables | 2 senior engineers + 1 ops/DB owner |
| PAR sheet / weight config | 1 senior engineer + 1 compliance owner |

A merge conflict on a regated file forces re-review, rebase and re-request.

### 3.5 Post-merge

1. On merge to `main`, CI generates and uploads a CycloneDX SBOM as an
   artefact. This is the submission-grade snapshot.
2. Update `CHANGELOG.md` moving the `Unreleased` entry to a tagged version.
3. Tag the commit: `v<semver>` at the repo level, plus
   `<workspace>@<semver>` if a workspace bumped independently.
4. If the change affects math: trigger a re-cert conversation with the lab.
   The repo artefacts the lab needs per game are documented in each
   `games/<code>/docs/rng-spec.md §9 "Artefacts for cert-lab submission"`
   (see `games/ketapola-dice/docs/rng-spec.md` as the canonical example).
   Run `bun scripts/export-cert-packet.ts <game-code>` to assemble a
   self-contained submission zip.

---

## 4. Emergency hotfix flow

A security or correctness incident may require bypassing the normal review
quorum to land a fix quickly. The hotfix flow is:

1. **File the incident.** Open an issue with the `incident` label. Include:
   what broke, what the blast radius is, and what the fix does.
2. **Reduce the patch.** The hotfix branch must contain only the minimum
   diff needed to stop the bleed. Refactors and cleanups live on a follow-up
   PR.
3. **CERT-ATTEST-\* still required.** Even in emergency, the PR description
   must carry the matching per-scope attestation line. The `rng-change-gate`
   CI job does not have an override.
4. **Single senior reviewer can merge** for a hotfix. Second reviewer signs
   off within 24h post-merge.
5. **Post-incident review.** Within 5 business days, write up:
   - root cause,
   - detection gap,
   - what monitor or test would have caught it,
   - a follow-up PR that adds that monitor or test.

If the incident is related to RNG behaviour, the post-incident review must
include a fresh 10M-round RTP regression run for every affected game and
an updated entry in that game's `games/<code>/docs/rng-test-vectors.md`.

---

## 5. De-gating (retiring a regation)

If an asset listed in §1 becomes genuinely no longer sensitive, e.g., a
module is deleted, the de-gating process is symmetric:

1. PR removing the file and its row from this document, in the same commit.
2. `CERT-ATTEST-<SCOPE>:` line explains why the asset no longer carries
   certification weight.
3. Same review quorum as a normal regated change.

Do not silently remove rows from this document. The audit trail that the
asset *used to be* regated is itself a compliance artefact.

---

## 6. Policy version

| Field | Value |
| --- | --- |
| Policy version | 1.0.0 |
| Last reviewed | 2026-04-23 |
| Owning role | Compliance + Engineering lead (joint) |
| Review cadence | Every cert renewal cycle, or any time §1 is edited |
