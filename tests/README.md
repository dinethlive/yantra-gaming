# Yantra Gaming tests

This directory holds the long-running integration + math tests that sit above
the co-located unit specs under `apps/rgs-server/src/**/*.spec.ts`.

## Prerequisites

1. Postgres 16 running. The dev `docker-compose.yml` at the repo root does this on port `5434`:

   ```bash
   docker compose up -d
   ```

2. A dedicated test database is recommended, so the integration tests can truncate
   tables between each `it()` without stepping on dev data:

   ```bash
   # one-time
   createdb -h localhost -p 5434 -U yantra_gaming yantra_gaming_test

   # apply schema
   DATABASE_URL=postgresql://yantra_gaming:yantra_gaming_dev@localhost:5434/yantra_gaming_test \
     bun run db:migrate
   ```

3. The same env vars the server expects at boot (see `apps/rgs-server/src/config.ts`).
   The integration tests inherit the current process env, so export them once:

   ```bash
   export DATABASE_URL=postgresql://yantra_gaming:yantra_gaming_dev@localhost:5434/yantra_gaming_test
   export SESSION_JWT_SECRET=$(openssl rand -hex 32)
   export PORTAL_JWT_SECRET=$(openssl rand -hex 32)
   export SECRETS_MASTER_KEY_B64=$(openssl rand -base64 32)
   export NODE_ENV=test
   ```

## Running

```bash
# integration suite
bun test tests/integration

# plugin-contract harness (six architectural checks per registered plugin)
bun test tests/plugin-contract

# per-game math regression (10M rounds, ~5min per game)
bun test tests/games/ketapola-dice/rtp-regression.spec.ts
bun test tests/games/crash-minimal/rtp-regression.spec.ts
```

## What each spec covers

- **`integration/wallet-rollback.spec.ts`**: rollback idempotency. Repeating the same
  `requestUuid` returns the cached response with no second effect; rolling back a
  non-existent transaction returns `RS_ERROR_TRANSACTION_DOES_NOT_EXIST`; a
  bet+rollback pair leaves the operator balance whole; every `WalletCall` row is
  written before the HTTP call and updated after (persisted even on failure).

- **`integration/idempotency.spec.ts`**: inbound request deduplication via
  `InboundIdempotency`. Two POSTs to `/v1/session` with the same `requestUuid`
  return byte-identical responses and create only one `GameSession` row, even
  when the bodies differ. Entries expire after their TTL. Cache is scoped per
  operator.

- **`integration/timeout-retry.spec.ts`**: `PendingWalletJob` lifecycle. A
  settlement call that times out is enqueued and eventually succeeds after the
  fake wallet recovers. Retries follow exponential backoff (`PendingJobRunner`:
  `1000 * 2^min(attempts, 8)`, capped at 5min). `WalletCall.attempt` is
  monotonically increasing for the same `transactionUuid`. A duplicate-tx
  response from the wallet is treated as success.

- **`integration/settlement-failure.spec.ts`**: crash recovery via
  `GameEngine.resumeUnsettledRounds()`. A kill mid-settlement produces exactly
  the right number of `/wallet/win` calls across restarts. A crash before any
  outcome is determined voids the round and rolls back every accepted bet.
  `Round.settled` is only ever true once every `ACCEPTED` bet has been settled
  or voided.

## Adjacent test suites (not written here)

- **`tests/games/<code>/rtp-regression.spec.ts`**: per-game 10M-round RTP
  regression. Asserts the observed RTP is within ±0.5% of theoretical for the
  declared config. Re-runs on any edit to `packages/rng-core/src/` (all games)
  or `games/<code>/src/{outcome,settle,config}.ts` (that game only). Owned by
  the math workstream.

- **`tests/plugin-contract/plugin-conformance.spec.ts`**: six architectural
  checks against every plugin registered in `apps/rgs-server/src/games/registry.ts`.
  Enforces the `GamePlugin` contract at CI time, not runtime.

- **`packages/wallet-spec/test/`**: contract tests for `toMicro` / `fromMicro`
  roundtripping and the status-code classifier helpers.
