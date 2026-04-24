# Architecture Diagrams

> Renders natively in GitHub via Mermaid. For PDF/PNG export (cert-lab
> submissions, printed runbooks) pipe through `mmdc` (Mermaid CLI):
>
> ```bash
> npx @mermaid-js/mermaid-cli -i docs/architecture.md -o docs/architecture.pdf
> ```

**Companions:**

- [B2B_ROADMAP.md §4](../B2B_ROADMAP.md#4-reference-architecture), narrative architecture context.
- Per-game `games/<code>/docs/game-rules.md`: round lifecycle behaviour (e.g. [games/ketapola-dice/docs/game-rules.md](../games/ketapola-dice/docs/game-rules.md)).
- Per-game `games/<code>/docs/rng-spec.md`: outcome derivation (e.g. [games/ketapola-dice/docs/rng-spec.md](../games/ketapola-dice/docs/rng-spec.md)).
- [security.md](./security.md), signing, threat boundaries.

---

## 1. System context (C4 level 1)

Yantra Gaming sits as a game provider between operators and players.

```mermaid
flowchart LR
    player(["Player<br/>(browser)"])
    operator["<b>Operator</b> (B2C casino)<br/>• Wallet (source of truth for money)<br/>• KYC, deposits, bonuses<br/>• Responsible gambling<br/>• Player identity"]
    rgs["<b>Yantra Gaming RGS</b><br/>• Game launch API<br/>• Round lifecycle engine<br/>• Provably-fair RNG<br/>• Wallet adapter<br/>• Audit ledger"]
    cert[("Cert lab<br/>(GLI / iTech / BMM)")]
    obs[("Observability backend<br/>(Prometheus / OTel)")]

    player -- "iframe + WebSocket" --> rgs
    player -- "game lobby" --> operator
    operator -- "POST /v1/session<br/>(HMAC-signed)" --> rgs
    rgs -- "POST /wallet/bet | win | rollback<br/>(HMAC-signed)" --> operator
    rgs -- "OTLP / Prom scrape" --> obs
    rgs -. "cert submission<br/>(artefacts only)" .-> cert
```

**Trust boundaries:**

- The RGS trusts HMAC-signed inbound operator calls (±30s timestamp window,
  constant-time compare).
- The operator trusts HMAC-signed outbound wallet calls (same scheme, reversed
  credentials).
- The player trusts the RGS for game state *and* trusts the commit-reveal
  scheme to verify any disputed outcome.

---

## 2. Container view (C4 level 2)

> All components shown, backend, mock-operator, SDK, spec, and the
> reference `game-client` / `operator-portal` frontends, ship in this
> repository. The backend wire contract is the only surface bound by the
> SLA; the frontends are reference implementations operators can run,
> white-label, or replace. See
> [B2B_ROADMAP.md §1 "Product surfaces"](../B2B_ROADMAP.md#1-what-this-is).

```mermaid
flowchart TB
    subgraph player["Player browser"]
        gc["game-client<br/>(Vite + React + PixiJS)<br/>iframe :3100"]
    end

    subgraph operator["Operator side"]
        opwallet["Wallet API<br/>(operator-owned)"]
        oplobby["Lobby / Launcher"]
    end

    subgraph rgs["Yantra Gaming (this repo)"]
        rgssrv["rgs-server<br/>(Express + Socket.IO + Prisma)<br/>:4500"]
        portal["operator-portal<br/>(Vite + React)<br/>:3101"]
        mock["mock-operator<br/>(Vite + Express)<br/>:3102 lobby / :4300 wallet"]
        sdk["operator-sdk<br/>(npm package operators install)"]
        spec["wallet-spec<br/>(shared types)"]
    end

    db[("Postgres 16<br/>:5434")]
    otel[("OTel collector")]

    oplobby -->|"launch redirect"| gc
    gc -->|"WebSocket<br/>place_bet / round_state"| rgssrv
    rgssrv -->|"/wallet/bet | win | rollback"| opwallet
    rgssrv <-->|"SQL (Prisma)"| db
    portal -->|"signed admin API"| rgssrv
    mock -->|"POST /v1/session"| rgssrv
    mock <-->|"/wallet/*"| rgssrv
    rgssrv -->|"OTLP traces + metrics"| otel
    oplobby -.->|"import"| sdk
    rgssrv -.->|"import"| spec
    sdk -.->|"import"| spec
    mock -.->|"import"| spec
```

---

## 3. Round lifecycle state machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: engine tick
    PENDING --> BETTING_OPEN: seed snapshot,<br/>round row created
    BETTING_OPEN --> ROLLING: betting window expires
    ROLLING --> RESULT: rng.determineOutcome<br/>outcome persisted
    RESULT --> SETTLED: Round.settled=true;<br/>failed /wallet/win calls<br/>handed off to PendingWalletJob
    BETTING_OPEN --> VOIDED: operator /terminate<br/>OR crash recovery<br/>(outcome unknown)
    ROLLING --> VOIDED: unrecoverable RNG error<br/>(defensive; should not occur)
    VOIDED --> [*]: all bets rolled back
    SETTLED --> [*]
```

State labels align 1:1 with `Round.state` values in the Prisma schema.
See each game's `games/<code>/docs/game-rules.md §2` (e.g. [games/ketapola-dice/docs/game-rules.md](../games/ketapola-dice/docs/game-rules.md#2-round-lifecycle)) for timing.

---

## 4. Bet-to-settlement sequence

The full happy path, one bet, one round, one settlement, with the
idempotency keys called out.

```mermaid
sequenceDiagram
    autonumber
    participant P as Player iframe
    participant R as rgs-server
    participant DB as Postgres
    participant W as Operator wallet

    P->>R: place_bet(side, amountMicro)
    R->>DB: INSERT WalletCall<br/>(BET, requestUuid, txUuid, attempt=1)<br/>[before HTTP]
    R->>W: POST /wallet/bet<br/>{requestUuid, transactionUuid=txUuid,<br/>amountMicro, roundId}
    W-->>R: 200 {status: RS_OK, balanceMicro}
    R->>DB: UPDATE WalletCall set response
    R->>DB: INSERT Bet (status=ACCEPTED, txUuid)<br/>INSERT PendingRoundBet (state=HELD)
    R-->>P: bet_placed
    R-->>P: balance_update

    Note over R: betting window expires

    R->>R: outcome = determineOutcome(<br/>serverSeed, clientSeed, nonce, weights)
    R->>DB: UPDATE Round set outcome
    R-->>P: round_result {side, sum}

    alt bet is a winner
        R->>DB: INSERT WalletCall<br/>(WIN, newTxUuid, refTxUuid=bet.txUuid)
        R->>W: POST /wallet/win<br/>{referenceTransactionUuid=bet.txUuid}
        W-->>R: 200 {RS_OK, balanceMicro}
        R->>DB: UPDATE Bet set status=SETTLED<br/>UPDATE PendingRoundBet state=RESOLVED
        R-->>P: balance_update
    else bet is a loser
        R->>DB: UPDATE Bet set status=SETTLED<br/>(no /win call; stake already lost)
    end

    R->>DB: UPDATE Round set settled=true
```

**Notes on the shape:**

- Every outbound wallet call is journalled **before** the HTTP request fires
  (step 2, step N). On process death mid-call the row exists on restart, so
  crash recovery (§6) can resolve it.
- The `transactionUuid` on `/wallet/win` references the originating bet's
  `transactionUuid`. Operators use this to match credits to debits.
- A duplicate `requestUuid` from the operator retrying the same HTTP request
  hits the `InboundIdempotency` cache and returns the cached response,
  without re-invoking the handler.

---

## 5. Wallet-call retry + rollback decision

```mermaid
flowchart TD
    start["wallet.bet(txUuid)"] --> call["POST /wallet/bet"]
    call --> resp{"response?"}
    resp -- "RS_OK" --> ok["accept bet<br/>INSERT Bet, PendingRoundBet"]
    resp -- "RS_ERROR_DUPLICATE_TRANSACTION" --> dup["treat as RS_OK<br/>(operator already processed)"]
    resp -- "RS_ERROR_NOT_ENOUGH_MONEY<br/>RS_ERROR_LIMIT_REACHED<br/>RS_ERROR_USER_DISABLED" --> reject["clean reject<br/>emit bet_rejected<br/>(no rollback, no retry)"]
    resp -- "timeout<br/>5xx<br/>network error<br/>unknown RS_*" --> uncertain["uncertain outcome<br/>enqueue rollback(txUuid)<br/>emit bet_rejected"]
    uncertain --> retry[("PendingWalletJob<br/>exponential backoff<br/>attempts logged in WalletCall")]
    retry --> rbcall["POST /wallet/rollback<br/>(same txUuid)"]
    rbcall --> rbresp{"response?"}
    rbresp -- "RS_OK<br/>RS_ERROR_DUPLICATE_TRANSACTION<br/>RS_ERROR_TRANSACTION_DOES_NOT_EXIST" --> rbok["mark completed<br/>(operator cleaned / never had it)"]
    rbresp -- "other" --> rbretry["increment attempts<br/>alert if > 5min stuck"]
    rbretry --> retry
```

Classifier rules are tabulated in
[wallet-api.md](./wallet-api.md) and
[error-codes.md](./error-codes.md).

---

## 6. Crash recovery

On startup, the engine scans `Round` rows with `settled=false`:

```mermaid
flowchart TD
    start["rgs-server boot"] --> scan["SELECT Round<br/>WHERE settled=false"]
    scan --> iter{"for each round"}
    iter --> outcome{"outcome recorded?"}
    outcome -- "yes" --> winners["for each ACCEPTED Bet<br/>on winning side"]
    winners --> enqueuewin["enqueue PendingWalletJob(WIN)<br/>referenceTransactionUuid=bet.txUuid"]
    enqueuewin --> markR["UPDATE Round settled=true"]
    outcome -- "no" --> void["transition Round to VOIDED"]
    void --> rollbet["for each ACCEPTED Bet:<br/>UPDATE status=VOIDED<br/>enqueue PendingWalletJob(ROLLBACK)"]
    rollbet --> markV["UPDATE PendingRoundBet<br/>state=REFUNDED<br/>resolutionReason=ROUND_VOIDED"]
    markR --> done["pending job runner<br/>drains in background"]
    markV --> done
```

**Invariants preserved:**

- No bet is settled twice (dedupe by `winTransactionUuid` unique constraint).
- No winner is dropped (every ACCEPTED bet either settles or refunds).
- No stake is kept on a voided round (every voided bet has a ROLLBACK
  enqueued).

See `tests/integration/settlement-failure.spec.ts` for the regression test
that exercises this path.

---

## 7. Multi-tenant isolation

One process. N operators. No global state crosses tenant lines.

```mermaid
flowchart TB
    req["incoming HTTP / socket"] --> auth["operator-auth<br/>middleware"]
    auth --> opid{"resolve<br/>operatorId"}
    opid --> reg["EngineRegistry"]
    reg --> eng1["GameEngine<br/>(op_A, yantra, LKR)"]
    reg --> eng2["GameEngine<br/>(op_A, yantra, USD)"]
    reg --> eng3["GameEngine<br/>(op_B, yantra, LKR)"]
    eng1 --> wc1["WalletClient<br/>(op_A credentials)<br/>+ CircuitBreaker"]
    eng2 --> wc2["WalletClient<br/>(op_A credentials)"]
    eng3 --> wc3["WalletClient<br/>(op_B credentials)"]
    wc1 --> db[("Postgres<br/>rows filtered by<br/>forOperator(id) wrapper")]
    wc2 --> db
    wc3 --> db
```

**Isolation levers:**

1. `forOperator(id)` Prisma wrapper, every read and write is scoped to the
   tenant. Centralised so no query can forget it.
2. Per-operator `GameEngine` instance keyed on `(operatorId, gameCode, currency)`.
3. Per-operator `WalletClient` with its own `CircuitBreaker`: one
   misbehaving operator cannot drag down rounds for another.
4. Per-operator rate-limit middleware.
5. Per-operator IP allow-list (optional).
6. Per-operator session JWT `operatorId` claim, enforced in socket middleware.

---

## 8. Provably-fair commit-reveal (seed lifecycle)

```mermaid
sequenceDiagram
    autonumber
    participant Op as Operator
    participant R as rgs-server
    participant DB as Postgres
    participant P as Player iframe

    Op->>R: POST /v1/session (signed)
    R->>R: serverSeed = randomBytes(32)<br/>serverSeedHash = SHA256(serverSeed)
    R->>DB: INSERT GameSession<br/>(serverSeed [encrypted], serverSeedHash,<br/>clientSeed, nonce=0)
    R-->>Op: { sessionId, sessionToken, launchUrl,<br/>serverSeedHash }
    Op-->>P: iframe src=launchUrl

    P->>R: socket connect (sessionToken)
    R-->>P: connected {serverSeedHash, clientSeed}<br/>(commit is public)

    loop every round
        R->>R: h = HMAC(serverSeed, clientSeed:nonce)<br/>side,sum = parse(h)
        R-->>P: round_result {side, sum}
        R->>R: nonce += 1
    end

    Note over P,R: player requests seed rotation or session ends

    R->>DB: mark GameSession terminatedAt / rotate
    Op->>R: GET /v1/rounds/:id/proof
    R-->>Op: { serverSeed, clientSeed, nonce, outcome } (reveal)
    Op->>Op: verify: SHA256(serverSeed) == serverSeedHash?<br/>HMAC == h? outcome == parse(h)?
```

See each game's RNG spec (e.g. [games/ketapola-dice/docs/rng-spec.md](../games/ketapola-dice/docs/rng-spec.md)) and
[provably-fair.md](./provably-fair.md).

---

## 9. Data model: the money-path tables

```mermaid
erDiagram
    Operator ||--o{ OperatorGameConfig : "has"
    Operator ||--o{ OperatorCredential : "has"
    Operator ||--o{ GameSession : "owns"
    GameSession ||--o{ Round : "contains"
    Round ||--o{ Bet : "accepts"
    Bet ||--|| PendingRoundBet : "mirrors"
    Operator ||--o{ WalletCall : "audit rows"
    Operator ||--o{ PendingWalletJob : "retry queue"
    Operator ||--o{ InboundIdempotency : "dedupe cache"

    Operator {
        uuid id PK
        string slug
        string status
        string defaultCurrency
        string walletCallbackUrl
    }
    GameSession {
        uuid id PK
        uuid operatorId FK
        string playerRef
        string serverSeed "encrypted"
        string serverSeedHash
        string clientSeed
        int nonce
        timestamp expiresAt
        timestamp terminatedAt
    }
    Round {
        uuid id PK
        uuid sessionId FK
        uuid operatorId FK
        int nonce
        string state
        bool settled
        string outcomeSide
        int outcomeSum
        int lowWeight
        int highWeight
    }
    Bet {
        uuid id PK
        uuid roundId FK
        string status
        bigint amountMicro
        string betTransactionUuid UK
        string winTransactionUuid UK "nullable"
        string rollbackTransactionUuid UK "nullable"
    }
    WalletCall {
        uuid id PK
        uuid operatorId FK
        string direction
        string endpoint
        string requestUuid "unique per (op,dir,endpoint)"
        string transactionUuid
        int attempt
        int latencyMs
        string status
    }
    PendingWalletJob {
        uuid id PK
        string endpoint
        json payload
        int attempts
        timestamp nextAttemptAt
        timestamp completedAt
        string lastError
    }
    PendingRoundBet {
        uuid id PK
        uuid betId FK
        string state
        string resolutionReason
    }
    InboundIdempotency {
        string key PK
        json cachedResponse
        timestamp expiresAt
    }
```

Full schema in `apps/rgs-server/prisma/schema.prisma`.

---

## 10. Exporting to PDF / PNG

For cert-lab submissions that require non-interactive diagrams:

```bash
# One-off PDF export of this entire doc
bunx @mermaid-js/mermaid-cli -i docs/architecture.md -o /tmp/architecture.pdf

# Per-diagram PNG (extract each ```mermaid block first)
# Example: extract §3 state machine into a standalone .mmd, then:
bunx @mermaid-js/mermaid-cli -i /tmp/round-state.mmd -o /tmp/round-state.png -w 1600
```

The licensee may prefer a design tool (draw.io, Excalidraw) for submission
copies, this document remains the source of truth, and those copies should
re-render the diagrams from the Mermaid source to avoid drift.
