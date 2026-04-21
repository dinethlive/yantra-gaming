# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
under the scoping rules described in [Versioning policy](#versioning-policy).

---

## [Unreleased]

### Added
- Production-grade multi-tenant B2B iGaming Remote Gaming Server (RGS) with a
  plugin-based game layer, see `B2B_ROADMAP.md`. First plugin: Ketapola Dice
  (Sri Lankan LOW/HIGH weighted dice). Second plugin: Crash Minimal
  (provably-fair crash, validates the plugin contract against a different
  outcome shape).
- Bun monorepo with apps (`rgs-server`, `game-client`, `operator-portal`,
  `mock-operator`, `provider-admin`), shared packages (`wallet-spec`,
  `operator-sdk`, `game-contract`, `rng-core`, `webhook-spec`,
  `jurisdiction-rules`), and `games/<code>/` per-game plugin workspaces.
- Multi-tenant data model: `Operator`, `OperatorCredential`, `OperatorUser`,
  `OperatorGameConfig`, `OperatorConfigAuditLog`, `GameSession`, `Round`, `Bet`,
  `WalletCall`, `PendingRoundBet`, `PendingWalletJob`, `InboundIdempotency`.
- Seamless-wallet HTTP integration with HMAC-SHA256 signing, ±30s replay
  protection, constant-time signature compare, two-level idempotency
  (`requestUuid` per-HTTP, `transactionUuid` per-money-movement).
- Append-only `WalletCall` audit ledger, every outbound call is journalled
  before the HTTP request fires and updated after.
- Crash-safe `GameEngine` state machine with startup recovery of
  `settled=false` rounds.
- `PendingWalletJob` durable retry queue with exponential backoff for failed
  `win` and `rollback` calls.
- Per-operator `EngineRegistry` for game-engine isolation.
- Per-operator `CircuitBreaker` wrapping `HttpWalletAdapter`.
- Commit-reveal provably-fair RNG (`HMAC_SHA256(serverSeed, clientSeed:nonce)`),
  `/v1/rounds/:id/proof` endpoint, session-scoped seed rotation.
- Operator back-office portal (React + Vite): overview, game config, rounds,
  wallet calls, sessions, reports, credentials.
- `@yantra/operator-sdk` with `createSession` and `verifyWebhookSignature`.
- `@yantra/wallet-spec` canonical wire contract.
- `mock-operator` app with fake wallet backed by SQLite for local E2E demos.
- OpenTelemetry instrumentation + Prometheus `/metrics` endpoint.
- RG-limit enforcement (`RGLimitsEnforcer`) at bet-time from session JWT claims.
- Money-safety integration tests: `wallet-rollback`, `idempotency`,
  `timeout-retry`, `settlement-failure`.
- Per-game 10M-round RTP regression tests (`tests/games/<code>/rtp-regression.spec.ts`).
- CI per-scope `rng-change-gate` job failing PRs that touch
  `packages/rng-core/src/` without a `CERT-ATTEST-CORE:` line, or any
  `games/<code>/src/{outcome,settle,config}.ts` without a matching
  `CERT-ATTEST-<GAMECODE>:` line.
- Documentation suite in `docs/`: `integration-guide`, `wallet-api`,
  `webhook-signature`, `openapi.yaml` (OpenAPI 3.1 machine-readable spec),
  `integration-test-vectors`, `sandbox`, `fx-and-currency`,
  `cert-submission-checklist`, `provably-fair`, `error-codes`, `par-sheet`,
  `security` (STRIDE + LINDDUN + HSM/KMS + CSP bootstrap),
  `observability` (metrics + SLOs + RTP drift + SIEM integration).
- `@yantra/operator-sdk`: `toSnakeCase` / `fromSnakeCase` helpers and
  `snakeToCamelMiddleware()` Express shim for operators migrating a
  Hub88-shaped wallet to Yantra's `camelCase` wire format.
- Wallet-spec extensions: `BonusAttribution` (`isBonus`, `bonusRef`,
  `wageringContributionMicro`), `FxContext` (`walletCurrency`, `fxRate`,
  `fxRateAt`, `fxRateSource`), `jackpotContributionMicro` on `WinRequestWire`.
  All fields are optional, backward-compatible with existing integrations.
- `GamePlugin` outcome union extended with `MultiEventOutcome`: the
  convention for games that emit compound rounds (slot-style free-spins,
  bonus buys, hold-and-spin, cascades, jackpot contributions).
- Brazil (SPA) added as a first-class jurisdiction in
  `packages/jurisdiction-rules` (BRL only, no crypto, 2s spin floor,
  autoplay / turbo prohibited, mandatory reality-check + net-loss display).
- Cert-readiness docs split by cert scope:
  - Platform (GLI-19) under `docs/`: `change-management.md`
    (per-scope `CERT-ATTEST-*` policy), `architecture.md` (9 Mermaid
    diagrams), `provably-fair.md` (shared commit-reveal scheme),
    `threat-model.md`, `security.md`.
  - Per-game (GLI-11) under `games/<code>/docs/`: `game-rules.md`
    (authoritative rules), `rng-spec.md` (game-specific RNG derivation),
    `par-sheet.md` + `par-sheet.json` (math model), `rng-test-vectors.md`
    with canonical JSON at `games/<code>/fixtures/rng-test-vectors.json`.
- Operability docs: `runbook.md` (deploy, env, backup/restore, key rotation),
  `threat-model.md` (STRIDE per component), `incidents.md` (10 playbooks +
  post-mortem template).
- `scripts/reconcile.ts`: CLI for daily settlement reconciliation against
  `ReconciliationJob.reconcileAgainstOperator`; exit code signals match vs drift.
- DCO sign-off requirement for every commit, enforced by
  `.github/workflows/dco.yml`.

### Security
- Operator secrets encrypted at rest with AES-GCM (`utils/secrets.ts`),
  rotatable via `OperatorCredential.notBefore / notAfter / revokedAt`.
- Per-operator IP allow-list middleware.
- Per-operator rate limiting.
- Cloudflare Turnstile hook on `/v1/session` (optional, disabled by default
  for dev).

---

## Versioning policy

This repository is a monorepo. Versions are tracked at the workspace level:

| Workspace | Version source | Breaking = MAJOR |
| --- | --- | --- |
| `packages/wallet-spec` | `packages/wallet-spec/package.json` | Wire-format breaking change (field removed, renamed, retyped; new required field; new status code that callers are forced to handle) |
| `packages/operator-sdk` | `packages/operator-sdk/package.json` | Public API breaking change (exported function signature, named export removed, thrown-error shape) |
| `apps/rgs-server` | `apps/rgs-server/package.json` + `CHANGELOG.md` | `/v1/*` route behavioural breaking change; DB schema migration requiring manual intervention; RNG algorithm change |
| `apps/operator-portal`, `apps/game-client`, `apps/mock-operator` | App package.json | Not independently versioned, follow `rgs-server`. |

### MAJOR bumps: what counts

- Any change that invalidates an in-flight certification (see
  `games/<code>/docs/par-sheet.md` §Change management, each game carries
  its own).
- Any change to the wallet wire contract that a conforming operator
  implementation would have to rewrite to accept.
- Any change to the outbound signing algorithm, header names, or timestamp
  window semantics.
- Removal or renaming of a published `/v1/*` route, a shipped wallet error
  code, or a `wallet-spec` exported type.

### MINOR bumps: what counts

- Additive routes, additive optional fields, new wallet error codes that are
  classified as retryable-unknown by existing rules.
- New operator-portal pages or new SDK exports.
- New metrics, new OTel spans, new log fields.

### PATCH bumps: what counts

- Bug fixes that keep the contract and the math unchanged.
- Observability-only changes, dependency bumps that do not affect behaviour.
- Documentation-only changes.

### Pre-1.0 caveat

While the project is pre-1.0, MINOR bumps may contain breaking changes,
documented in this file. First stable release will set the versioning contract
above into effect.

### Version skew matrix

The RGS, the SDK, and the wallet-spec are versioned independently. Operators
running an older SDK against a newer RGS (or vice versa) are supported within
a documented compatibility window:

| RGS server | `@yantra/operator-sdk` | `@yantra/wallet-spec` | Status |
| --- | --- | --- | --- |
| 1.0.x | 0.9.x | 0.9.x | Supported (current) |
| 1.0.x | 0.8.x | 0.8.x | Supported through 2026-10-01; deprecated, contains legacy `isFree` only, lacks bonus + FX fields |
| 1.0.x | ≤ 0.7.x | ≤ 0.7.x | **EOL**: signing header names predate `X-Yantra-*` rename; upgrade required |
| 1.1.x (planned) | ≥ 0.9.x | ≥ 0.9.x | Supported; 1.1 adds OpenAPI-derived Python/PHP/Java/.NET SDKs at version 1.0.x each |

Rule of thumb: match the SDK **major + minor** to the RGS **minor**. Patch
versions are always compatible within their minor.

When the RGS detects a mismatch outside the support matrix, it emits a
`Deprecation` HTTP header on every response and surfaces the mismatch in
the operator-portal "Integration health" widget. Calls are not rejected on
mismatch during the support window, only after EOL.

### Release process

1. Move items from `[Unreleased]` to a new version section.
2. Pick the version bump per the rules above.
3. Update the version in the relevant workspace `package.json`.
4. Tag the release: `vMAJOR.MINOR.PATCH` at the repo level, plus
   `<workspace>@MAJOR.MINOR.PATCH` if a workspace bumped independently.
5. CI attaches the SBOM artifact to the tag.

---

[Unreleased]: https://github.com/OWNER/yantra-gaming/commits/main
