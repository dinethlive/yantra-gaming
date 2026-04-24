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
    player(["Player
    (browser)"])
    operator["<b>Operator</b> (B2C casino)
    • Wallet (source of truth for money)
    • KYC, deposits, bonuses
    • Responsible gambling
    • Player identity"]
    rgs["<b>Yantra Gaming RGS</b>
    • Game launch API
    • Round lifecycle engine
    • Provably-fair RNG
    • Wallet adapter
    • Audit ledger"]
    cert[("Cert lab
    (GLI / iTech / BMM)")]
    obs[("Observability
    backend
    (Prometheus / OTel)")]

    player -- "iframe + WebSocket" --> rgs
    player -- "game lobby" --> operator
    operator -- "POST /v1/session
    (HMAC-signed)" --> rgs
    rgs -- "POST /wallet/bet | win | rollback
    (HMAC-signed)" --> operator
    rgs -- "OTLP / Prom scrape" --> obs
    rgs -. "cert submission
    (artefacts only)" .-> cert

    classDef ext fill:#f5f5f5,stroke:#666;
    classDef sys fill:#cde8ff,stroke:#1f6feb,stroke-width:2px;
    class operator,player,cert,obs ext;
    class rgs sys;
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
        gc["game-client
        (Vite + React + PixiJS)
        iframe :3100"]
    end

    subgraph operator["Operator side"]
        opwallet["Wallet API
        (operator-owned)"]
        oplobby["Lobby / Launcher"]
    end

    subgraph rgs["Yantra Gaming (this repo)"]
        rgssrv["rgs-server
        (Express + Socket.IO + Prisma)
        :4500"]
        portal["operator-portal
        (Vite + React)
        :3101"]
        mock["mock-operator
        (Vite + Express)
        :3102 lobby / :4300 wallet"]
        sdk["operator-sdk
        (npm package operators install)"]
        spec["wallet-spec
        (shared types)"]
    end

    db[("Postgres 16
    :5434")]
    otel[("OTel collector")]

    oplobby -->|"launch redirect"| gc
    gc -->|"WebSocket
    place_bet / round_state"| rgssrv
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

    classDef box fill:#cde8ff,stroke:#1f6feb;
    classDef ext fill:#f5f5f5,stroke:#666;
    classDef ds fill:#ffe9b3,stroke:#b88700;
    class rgssrv,gc,portal,mock,sdk,spec box;
    class opwallet,oplobby ext;
    class db,otel ds;
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

    Note over R: … betting window expires …

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
  (step 2, step N). On process death mid-call the row exists on restart ,
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
    resp -- "RS_OK" --> ok["accept bet
    → INSERT Bet, PendingRoundBet"]
    resp -- "RS_ERROR_DUPLICATE_TRANSACTION" --> dup["treat as RS_OK
    (operator already processed)"]
    resp -- "RS_ERROR_NOT_ENOUGH_MONEY
    RS_ERROR_LIMIT_REACHED
    RS_ERROR_USER_DISABLED" --> reject["clean reject
    → emit bet_rejected
    (no rollback, no retry)"]
    resp -- "timeout
    5xx
    network error
    unknown RS_*" --> uncertain["uncertain outcome
    → enqueue rollback(txUuid)
    → emit bet_rejected"]
    uncertain --> retry[("PendingWalletJob
    exponential backoff
    attempts logged in WalletCall")]
    retry --> rbcall["POST /wallet/rollback
    (same txUuid)"]
    rbcall --> rbresp{"response?"}
    rbresp -- "RS_OK
    RS_ERROR_DUPLICATE_TRANSACTION
    RS_ERROR_TRANSACTION_DOES_NOT_EXIST" --> rbok["mark completed
    (operator cleaned / never had it)"]
    rbresp -- "other" --> rbretry["increment attempts
    alert if > 5min stuck"]
    rbretry --> retry

    classDef ok fill:#ccf2d4,stroke:#2d7a4b;
    classDef err fill:#ffd7d7,stroke:#a32a2a;
    classDef retry fill:#ffe9b3,stroke:#b88700;
    class ok,dup,rbok ok;
    class reject err;
    class uncertain,retry,rbcall,rbretry retry;
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
    outcome -- "no" --> void["transition Round → VOIDED"]
    void --> rollbet["for each ACCEPTED Bet:<br/>UPDATE status=VOIDED<br/>enqueue PendingWalletJob(ROLLBACK)"]
    rollbet --> markV["UPDATE PendingRoundBet<br/>state=REFUNDED<br/>resolutionReason=ROUND_VOIDED"]
    markR --> done["pending job runner<br/>drains in background"]
    markV --> done

    classDef decide fill:#ffe9b3,stroke:#b88700;
    classDef act fill:#cde8ff,stroke:#1f6feb;
    class outcome decide;
    class winners,enqueuewin,void,rollbet,markR,markV,done act;
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

    classDef op1 fill:#d6e5ff,stroke:#1f6feb;
    classDef op2 fill:#ffe1d6,stroke:#cc3300;
    class eng1,eng2,wc1,wc2 op1;
    class eng3,wc3 op2;
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

    Op->>R: POST /v1/session<br/>(signed)
    R->>R: serverSeed = randomBytes(32)<br/>serverSeedHash = SHA256(serverSeed)
    R->>DB: INSERT GameSession<br/>(serverSeed [encrypted], serverSeedHash, clientSeed, nonce=0)
    R-->>Op: { sessionId, sessionToken, launchUrl, serverSeedHash }
    Op-->>P: iframe src=launchUrl

    P->>R: socket connect (sessionToken)
    R-->>P: connected {serverSeedHash, clientSeed}<br/>(commit is public)

    loop every round
        R->>R: h = HMAC(serverSeed, clientSeed:nonce)<br/>side,sum = parse(h)
        R-->>P: round_result {side, sum}
        R->>R: nonce += 1
    end

    Note over P,R: player requests seed rotation<br/>or session ends

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
        string key PK "(operatorId, endpoint, requestUuid)"
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
