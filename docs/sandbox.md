# Sandbox Environment

Three ways to exercise the Yantra RGS against a live backend without
talking to a production operator wallet. Listed in order of increasing
realism.

**Contents**

- [Local mock-operator](#local-mock-operator)
- [Headless e2e harness (CI-friendly)](#headless-e2e-harness-ci-friendly)
- [Hosted sandbox (planned v1.1)](#hosted-sandbox-planned-v11)

---

## Local mock-operator

The fastest path. `apps/mock-operator` runs a fake casino + fake wallet on
your machine, driving the real RGS Express + Socket.IO + Prisma stack.

```bash
bun install
bun run db:migrate
bun run dev          # rgs-server + mock-operator + reference frontends

# Or just the backend halves (no frontend UIs):
bun run dev:core
```

Service ports (see [`integration-guide.md`](./integration-guide.md) for the
full map):

| App | Port | URL |
| --- | --- | --- |
| rgs-server | 4500 | http://localhost:4500 |
| mock-operator lobby | 3102 | http://localhost:3102 |
| mock-operator wallet | 4300 | http://localhost:4300/wallet |
| game-client iframe | 3100 | http://localhost:3100 |
| operator-portal | 3101 | http://localhost:3101 |

Swap which game the lobby launches:

```bash
MOCK_OPERATOR_GAME_CODE=crash-minimal bun run dev:core
```

The mock wallet supports toggle-able failure modes you can drive from its
debug endpoint:

| Mode | How to enable | Effect |
| --- | --- | --- |
| `timeout` | `POST http://localhost:4300/wallet/debug/fail?mode=timeout&ttl=30` | Next N seconds of wallet calls hang past timeout |
| `duplicate` | `POST .../debug/fail?mode=duplicate` | Returns `RS_ERROR_DUPLICATE_TRANSACTION` |
| `not_enough_money` | `POST .../debug/fail?mode=not_enough_money` | Returns `RS_ERROR_NOT_ENOUGH_MONEY` |
| `5xx` | `POST .../debug/fail?mode=5xx` | Returns HTTP 502 |
| `network` | `POST .../debug/fail?mode=network` | Closes the TCP connection mid-request |

Clear with `POST http://localhost:4300/wallet/debug/clear`.

Inspect the mock wallet's state:

```bash
curl http://localhost:4300/wallet/debug/balances    # all mock players
curl http://localhost:4300/wallet/debug/tx          # transaction log
```

---

## Headless e2e harness (CI-friendly)

`tests/e2e/mock-operator.spec.ts` drives the full session → bet → settle →
proof loop over real Express + Socket.IO against the real Prisma-backed
Postgres, without opening a browser. Good for integration CI, contract
testing, and load-profiling your own wallet implementation.

```bash
E2E=1 bun test tests/e2e
```

Requires:

- Postgres running (see `docker-compose.yml`: `bun run db:up` if you want a
  helper; otherwise start it however you normally do).
- `DATABASE_URL` set to a throwaway test database. The harness migrates + seeds.

The harness can be pointed at **your** wallet service instead of the mock
operator, configure the `WALLET_BASE_URL`, `WALLET_SECRET`, `WALLET_KEY_ID`
env vars at test time. That's the officially supported path for an operator
integrating for the first time:

1. Stand your wallet implementation up on any URL (localhost or hosted).
2. Seed a throwaway operator row in the test DB with the matching
   credentials.
3. Run `E2E=1 WALLET_BASE_URL=https://your-wallet.example/wallet bun test tests/e2e`.
4. The harness exercises every wallet endpoint and every failure mode
   against your implementation.

---

## Hosted sandbox (planned v1.1)

**Status:** not yet live. Roadmapped for v1.1.

When shipped, `sandbox.yantra.example` will be a live-hosted RGS that
operators can integrate against without standing up any Yantra
infrastructure. Characteristics:

- **No real money.** All mock currencies (`LKR`, `USD`, `TEST_COIN`).
- **Seeded player accounts** with a wide range of balances + RG-limit
  configurations, so operators can test happy-path and every rejection
  scenario without re-seeding.
- **Relaxed rate limits**: raised 10× vs production defaults.
- **API keys issued self-serve** via a portal at
  `sandbox-portal.yantra.example` with a signup flow.
- **Deterministic RNG clientSeed** mode, operators can pin a `clientSeed`
  to replay the same outcome sequence across runs, simplifying snapshot
  tests.
- **Request / response logs** surfaced in the sandbox portal for the last
  7 days so operators can debug signature issues without running tcpdump.
- **Webhook tunnel**: the sandbox portal issues a short-lived ngrok-style
  tunnel so operators on a laptop behind NAT can receive real webhook
  callbacks without deploying anywhere.

Until the hosted sandbox ships, the **mock-operator** path above is the
supported development flow; the **headless e2e harness** is the supported
CI path.

See [`B2B_ROADMAP.md` §17 "Planned for v1.1"](../B2B_ROADMAP.md#17-versioning-and-delivery).
