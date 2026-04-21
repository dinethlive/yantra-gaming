# Security policy

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub
issue for suspected vulnerabilities.

- Email: `security@example.com` *(update when pushing to GitHub)*
- Include: a reproduction, the affected component, and the potential impact.
- You will receive an acknowledgment within 5 business days.

PGP encryption is optional but welcome. A key will be published in this
document once the repo is pushed.

## Scope

In scope:

- `apps/rgs-server`: game launch API, wallet adapter, signing, idempotency.
- `apps/operator-portal`: back-office auth, session management, config edits.
- `packages/operator-sdk`: SDK operators would embed.
- `packages/rng-core/src/`: shared commit-reveal primitives (seed generation, HMAC derivation, seed verification).
- `games/<code>/src/outcome.ts`: per-game outcome mapping that composes the rng-core primitives.
- `apps/rgs-server/src/services/ProofService.ts`: the proof-reveal gating on `/v1/rounds/:id/proof`.
- Schema, migrations, and the `WalletCall` audit ledger.

Out of scope:

- `apps/mock-operator`: development-only fake casino + fake wallet, not a
  production artifact.
- `apps/game-client`: PixiJS iframe with no auth surface; all sensitive
  state lives server-side.
- Issues requiring physical access, stolen operator credentials, or
  social-engineering that bypasses signed-request verification.

## Safe harbour

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction,
  and service disruption.
- Only interact with accounts they own or have explicit permission to test.
- Do not exploit a vulnerability beyond what is necessary to confirm it.
- Give us reasonable time to remediate before public disclosure.

## Disclosure timeline

- Day 0: report received, acknowledgment sent.
- Day 0-7: triage, severity assessment, fix scoping.
- Day 7-60: remediation.
- Day 90: coordinated public disclosure, regardless of fix status, unless
  an extension is mutually agreed.

## Acknowledgments

*(No disclosures yet. Reporters listed here with permission.)*

## Further reading

- [`B2B_ROADMAP.md` §15, Risk register](./B2B_ROADMAP.md#15-risk-register)
- [`docs/security.md`](./docs/security.md), signing, replay protection,
  rate limits, SLOs.
