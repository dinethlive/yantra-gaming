---
hide:
  - navigation
---

# Yantra Gaming

Multi-tenant B2B iGaming Remote Gaming Server (RGS) with a plugin-based
game layer. The engine is game-agnostic; each game ships as a
`games/<code>/` workspace implementing the shared `GamePlugin` contract.

Two plugins in this distribution:

- **[Ketapola Dice](games/ketapola-dice/docs/game-rules.md)**: Sri Lankan LOW/HIGH weighted dice, 2× symmetric payout.
- **[Crash Minimal](games/crash-minimal/docs/game-rules.md)**: provably-fair crash (pre-cert, validates the plugin seam against a continuous-outcome game).

---

## How the docs are organized

Split by **certification scope**: matching how GLI / BMM / iTech Labs
submission packets are actually structured in the industry.

<div class="grid cards" markdown>

-   :material-server-network: **Platform (GLI-19 scope)**

    ---

    One copy for the whole RGS. Wallet wire contract, session auth, commit-reveal scheme, operational runbooks. [`docs/`](docs/integration-guide.md)

-   :material-dice-multiple: **Per-game cert packets (GLI-11 scope)**

    ---

    One set per plugin, co-located with the plugin source. Game rules, PAR sheet, RNG spec, test vectors. [`games/<code>/docs/`](games/ketapola-dice/docs/game-rules.md)

</div>

---

## Start here

- **New to the system?** Read the [Integration guide](docs/integration-guide.md), 30 minutes to a working session.
- **Implementing the wallet callback?** [Wallet API](docs/wallet-api.md), [Webhook signature](docs/webhook-signature.md), [Error codes](docs/error-codes.md). Pin your tests against [integration test vectors](docs/integration-test-vectors.md). Machine-readable [OpenAPI 3.1 spec](docs/openapi.yaml).
- **Trying it out first?** [Sandbox environment guide](docs/sandbox.md), three ways to exercise the RGS without a production operator wallet.
- **Multi-currency or crypto wallet?** [Currency + FX](docs/fx-and-currency.md) covers session currency, FX at bet time, stablecoin handling, Brazil SPA constraints.
- **Verifying a round offline?** [Provably fair](docs/provably-fair.md) has a 20-line JS snippet.
- **Reviewing the math of a specific game?** Jump to that game's PAR sheet, [Ketapola](games/ketapola-dice/docs/par-sheet.md), [Crash](games/crash-minimal/docs/par-sheet.md).
- **Thinking about production?** [Architecture](docs/architecture.md), [Security](docs/security.md), [Threat model](docs/threat-model.md), [Runbook](docs/runbook.md), [Observability](docs/observability.md).
- **Submitting for certification?** [Cert submission checklist](docs/cert-submission-checklist.md) enumerates what goes in GLI-11 / GLI-19 packets.
- **Writing a new game plugin?** See the full engineering plan in [B2B_ROADMAP.md](B2B_ROADMAP.md).

---

## Principles

| Principle | Why |
| --- | --- |
| Seamless wallet, operator owns balance | RGS never mutates money locally; every bet/win/rollback is a signed call. |
| Idempotency at two levels | `requestUuid` (HTTP dedupe) + `transactionUuid` (ledger dedupe). |
| Append-only `WalletCall` audit ledger | Every outbound call journalled before the HTTP request, updated after. |
| Plugin seam between engine and games | `packages/game-contract` defines `GamePlugin`; engine is game-agnostic. |
| Commit-reveal provably fair | Shared primitives in `packages/rng-core`; per-game outcome mapping. |
| Per-scope RNG change-gate | `CERT-ATTEST-CORE` for `rng-core`, `CERT-ATTEST-<GAMECODE>` per game. |
| Integer money throughout | BigInt micro-units (×100,000). No floats in money code. |

Full narrative in [B2B_ROADMAP.md §3](B2B_ROADMAP.md).
