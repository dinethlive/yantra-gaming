# Cert-Lab Submission Checklist

Concrete file-by-file inventory of what goes in a **GLI-11** (per-game RNG)
and a **GLI-19** (platform) submission packet. The same inventory applies
with minor relabelling for BMM, iTech Labs, Trisigma, Quinel, and eCOGRA ,
the underlying expectations are aligned.

The `scripts/export-cert-packet.ts` CLI assembles and zips the per-game
packet automatically; this document is the source of truth for **what** the
script bundles, and for the platform-wide artefacts submitted separately.

---

## GLI-11: per-game RNG packet

One packet per `(game_code, math_version)` combination submitted to a lab.
Scope: the game's outcome math, RNG derivation, and the PAR sheet.

Assembled from `games/<code>/` by `bun scripts/export-cert-packet.ts <game-code>`.

| Artefact | Path | Notes |
| --- | --- | --- |
| Game rules | `games/<code>/docs/game-rules.md` | Authoritative, every rule lab might ask about, including edge cases (push, no-bet, rollover). |
| PAR sheet | `games/<code>/docs/par-sheet.md` + `games/<code>/docs/par-sheet.json` | Theoretical RTP, hit frequency, hold %, volatility, tail distribution. JSON is machine-readable and SHA-256'd into `cert.parSheetSha256`. |
| RNG spec | `games/<code>/docs/rng-spec.md` | HMAC derivation, byte extraction, mapping to faces / multipliers, bias analysis. |
| RNG test vectors | `games/<code>/docs/rng-test-vectors.md` + `games/<code>/fixtures/rng-test-vectors.json` | 100–1000 hand-computed `(serverSeed, clientSeed, nonce) → outcome` tuples. Canonical JSON file is the same data the CI tests consume. |
| RTP regression | `tests/games/<code>/rtp-regression.spec.ts` + latest CI run output | 10M-round simulation, p-value assertion on observed RTP vs theoretical. |
| Math source code | `games/<code>/src/{outcome,settle,config}.ts` | The actual code the outcome derivation runs. Lab reads this line-by-line. |
| Cert attestation | `games/<code>/src/index.ts::cert` | `CertAttestation { rngVersion, gliCategory, mathVersion, parSheetSha256 }`: stamped on every `Round` row, included in every `/proof` response. |
| Change log | `CHANGELOG.md` filtered by the scope tag | Every past `CERT-ATTEST-<GAMECODE>:` commit with its rationale. |
| SBOM | Latest CI artifact from `.github/workflows/ci.yml` | CycloneDX, signed. Lab confirms supply-chain provenance. |

### Required evidence the lab produces (not shipped by us)

- Statistical testing report (Diehard / NIST SP 800-22 / TestU01 on the
  HMAC output mapped to raw bytes, the lab runs these against fixtures we
  provide).
- Source-code review notes.
- Signed cert attestation (the lab's own doc, not ours).

---

## GLI-19: platform packet

One packet per platform-scoped submission (a `CERT-ATTEST-CORE:` change bumps
this). Scope: wallet contract, round lifecycle, multi-tenancy, audit,
monitoring, RG enforcement, incident response.

| Artefact | Path | Notes |
| --- | --- | --- |
| Architecture | `docs/architecture.md` | C4 container + component diagrams, state machines, sequences, ER. |
| Wallet API | `docs/wallet-api.md` + `packages/wallet-spec/src/index.ts` | Canonical request/response shapes, idempotency, retry, error codes. |
| Webhook signature spec | `docs/webhook-signature.md` + `packages/webhook-spec/src/index.ts` | Outbound event signing. |
| Provably fair | `docs/provably-fair.md` + `packages/rng-core/src/index.ts` | Shared commit-reveal scheme; lab validates scheme design once, all games inherit. |
| Error codes | `docs/error-codes.md` | Every `RS_*` status, when it fires, what the operator should do. |
| Change management | `docs/change-management.md` | Per-scope `CERT-ATTEST-*` policy. Lab confirms in-repo gate is functional. |
| Threat model | `docs/threat-model.md` | STRIDE + LINDDUN per component, mitigations traced to code. |
| Security | `docs/security.md` | Signing + replay + CSP + HSM/KMS + responsible disclosure. |
| Runbook | `docs/runbook.md` | Day-2 ops, deploy, env, key rotation, backup/restore, DR. |
| Incidents | `docs/incidents.md` | 10 playbooks + post-mortem template. |
| Observability | `docs/observability.md` | Metrics, traces, SLOs, RTP drift monitor, SIEM integration. |
| Integration guide | `docs/integration-guide.md` | Zero-to-working-session walkthrough for operators. |
| Integration test vectors | `docs/integration-test-vectors.md` | Hand-computed signature / session / proof fixtures. |
| Data model | `apps/rgs-server/prisma/schema.prisma` + migrations | Multi-tenant schema. Outcomes as JSONB, per-game config as JSONB. Audit-chain + incomplete-games tables. |
| Round lifecycle code | `apps/rgs-server/src/services/GameEngine.ts`, `EngineRegistry.ts`, `SessionService.ts`, `AuditChain.ts`, `RGLimitsEnforcer.ts` | State machine + crash recovery + tenant isolation + audit chain. |
| Wallet layer | `apps/rgs-server/src/wallet/*.ts` | Adapter, client, circuit breaker, HMAC signing. |
| CI evidence | `.github/workflows/ci.yml` + `rtp-regression.yml` + last 90 days of runs | Per-scope RNG change-gate enforcement proof. |
| SBOM | Latest CI artifact | CycloneDX, signed. |
| Jurisdiction rules | `packages/jurisdiction-rules/src/index.ts` | Per-jurisdiction stake caps, spin floors, autoplay bans, self-exclusion registries. |

---

## Per-deployment addenda

These are shipped by the **operator**, not by us, and are not in this repo.
Listed here so operators onboarding to Yantra know what their submission
side looks like:

- **Infrastructure attestation**: ISO 27001 certificate of the hosting provider, data-residency declaration.
- **Pen-test report**: annual third-party pen-test, summary + remediation.
- **SOC 2 Type II**: if the operator requires it (US enterprise market).
- **Business continuity plan**: operator-specific DR targets, escalation contacts.
- **Responsible-gambling policy**: operator-side programmatic RG tools (deposit limits enforced on the wallet, self-exclusion registry integration).
- **KYC / AML programme**: operator-owned.
- **Bug bounty programme**: scope letter, disclosure policy.

---

## Submission cadence

- **Initial submission** for a new game: full GLI-11 packet.
- **Initial submission** for a platform release: full GLI-19 packet.
- **Re-certification** per cert-lab standard policy, typically triggered by
  a `CERT-ATTEST-*` change in CI (see [change-management.md](./change-management.md)).
  Incremental re-cert submissions typically cover only the changed artefacts
  plus a statistical re-run.
- **Annual review**: regulators in some jurisdictions (UKGC, MGA) require
  an annual re-attestation even if nothing has changed. Driven from the CI
  SBOM + last run of the RTP regression.

---

## Lab-specific notes

| Lab | Idiosyncrasies |
| --- | --- |
| **GLI** | Standard PDF deliverables; strong SBOM preference; accepts canonical JSON test vectors. |
| **BMM Testlabs** | Shorter review cycle; expects `par-sheet.json` (machine-readable) alongside the narrative. |
| **iTech Labs** | Heavy on observed-vs-theoretical chi-square tests; our 10M-round RTP regression + per-face chi-square is the template they accept. |
| **eCOGRA** | Focus on player protection / RG enforcement, the LINDDUN section of `docs/threat-model.md` and the `RGLimitsEnforcer` code are typically what they audit most. |
| **Trisigma** | Brazil-first; expects Portuguese-language summary of the `game-rules.md` (operator supplies translation). |
| **Quinel** | Brazil and LatAm; accepts English directly. |

The `export-cert-packet.ts` output is lab-agnostic; per-lab cover letters
and translations are composed by the operator's compliance team.
