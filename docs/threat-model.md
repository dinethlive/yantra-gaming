# Threat Model: STRIDE

> Formal STRIDE analysis of Yantra Gaming. Complements the narrative threat
> actors in [security.md](./security.md); this document is the structured
> form auditors, SOC 2 assessors, and enterprise procurement ask for.

**Methodology:** STRIDE per component, mitigations traced to code. Each row
is independently reviewable, a reviewer should be able to open the cited
file and see the control in place.

**Scope:**
- `apps/rgs-server` (production artefact)
- `apps/operator-portal` (production artefact)
- `packages/operator-sdk` (ships to operators)
- Schema, money-path tables, and the HMAC wire protocol

Explicitly out of scope:
- `apps/mock-operator`: dev-only, never deployed
- `apps/game-client`: no trust boundary; auth is enforced by rgs-server
- Operator's own KYC/AML/deposit flows

---

## 1. Trust boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│                             Internet                                 │
└─────────────────────────────────────────────────────────────────────┘
        │ TLS 1.3                       │ TLS 1.3                      │ TLS 1.3
        ▼                               ▼                              ▼
┌────────────────┐             ┌────────────────┐            ┌──────────────┐
│   Operator     │◀── HMAC ───▶│  rgs-server    │◀─ Session ─│ Player browser│
│   backend      │             │  (trust boundary│    JWT     │ (low-trust)   │
└────────────────┘             │   center)      │            └──────────────┘
                               └──┬─────────┬───┘
                                  │ SQL     │ HTTPS + HMAC
                                  ▼         ▼
                              ┌──────────┐ operator wallet
                              │ Postgres │ (external)
                              └──────────┘
```

Five trust boundaries:
1. **Internet ↔ rgs-server**: HMAC-signed, TLS-wrapped HTTP.
2. **Player browser ↔ rgs-server**: session JWT on socket handshake.
3. **rgs-server ↔ operator wallet**: HMAC-signed outbound HTTP.
4. **rgs-server ↔ Postgres**: in-VPC network, TLS if crossing regions.
5. **Operator portal ↔ rgs-server admin API**: HS256 portal JWT.

---

## 2. STRIDE: rgs-server ingress (HMAC + TLS)

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Attacker sends a request pretending to be an operator | HMAC-SHA256 on every `/v1/*` request, recomputed server-side and compared constant-time. Reject if missing `X-Yantra-Key-Id`, `X-Yantra-Timestamp`, or `X-Yantra-Signature`. | `middleware/operator-auth.ts` |
| **Tampering** | MitM alters the request body | Body hash is part of the HMAC canonical string (`method \n path \n timestamp \n sha256(body)`). Any body mutation produces a signature mismatch. | `utils/signing.ts::signPayload` |
| **Tampering** | MitM alters the response | TLS 1.3, responses are not HMAC-signed outbound; TLS integrity suffices. | Transport |
| **Repudiation** | Operator claims they never sent a request | Every inbound call creates a `WalletCall`-style audit row (`inbound_idempotency` for session/admin; `WalletCall` for outbound). Signed body + timestamp + `operatorId` make repudiation infeasible. | `prisma/schema.prisma` |
| **Information disclosure** | Attacker reads traffic | TLS 1.3 minimum; HSTS `max-age=63072000; preload`; `helmet()` defaults with strict CSP `default-src 'none'`. | `index.ts`, `docs/security.md` |
| **Denial of service** | Flood of unsigned requests forces signature verification cost | Verification is cheap (one HMAC-SHA256). Upstream: global `express-rate-limit` at 600 req/min/IP; per-operator rate limit; WAF in production fronts all ingress. | `index.ts::rateLimit`, `middleware/operator-rate-limit.ts` |
| **Denial of service** | Replay attacker floods cached `requestUuid`s | `InboundIdempotency` unique index on `(operatorId, endpoint, requestUuid)`; DB-side dedupe. 24 h TTL keeps table size bounded. | `middleware/idempotency.ts` |
| **Elevation of privilege** | Attacker crafts a request that bypasses auth middleware to reach a handler | `/v1/*` router mounts `operatorAuth` before any handler; no route escapes. The only unauthenticated routes are `/healthz`, `/readyz`, `/metrics`. | `routes/index.ts` |

---

## 3. STRIDE: replay and timing

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Replay (spoofing)** | Attacker captures a valid signed request and resends it | Timestamp in canonical string + `±30s` window rejects stale requests. Idempotency cache on `(operatorId, endpoint, requestUuid)` blocks re-execution even inside the window. | `middleware/operator-auth.ts`, `middleware/idempotency.ts` |
| **Clock skew (DoS)** | Operator clock drifts; legitimate requests rejected | `SIGNATURE_WINDOW_SECONDS` tunable (default 30). Production deployments sync against NTP + Chrony. Alert on sustained `>10s` skew (see observability). | `config.ts`, `docs/observability.md` |
| **Timing oracle (info disclosure)** | Attacker measures response time to infer secret bytes | `crypto.timingSafeEqual` for all signature/credential/token compares. Non-constant-time JSON parsing is irrelevant, no secret is in JSON body. | `utils/signing.ts`, `utils/secrets.ts` |

---

## 4. STRIDE: session JWT (player iframe)

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Player forges a session JWT to act as another player | HS256 signature with `SESSION_JWT_SECRET`; reject on any decode/verify failure. Claims are bound: `operatorId + sessionId + playerRef` all cross-checked against the `GameSession` row. | `middleware/session-auth.ts` |
| **Tampering** | Player edits JWT claims (e.g., `operatorId`) | HS256 integrity breaks on any claim mutation. | `jsonwebtoken` library |
| **Repudiation** | Player denies placing a bet | Every bet has a `Bet` row with `playerRef`, signed `transactionUuid`, signed WebSocket connection, and an operator-side `/wallet/bet` record. Three independent attestations. | `Bet` model, `WalletCall` model |
| **Info disclosure** | Another player reads another player's bets | Socket rooms scoped by `session:${sessionId}` and `operator:${operatorId}:${gameCode}:${currency}`. No cross-session reads. | `socket/gameSocket.ts` |
| **DoS** | Player spams place_bet | One bet per player per round (§10.5 of game-rules). Per-operator rate limits on the HTTP surface; socket disconnect on misbehaviour. | `services/GameEngine.ts`, `middleware/operator-rate-limit.ts` |
| **Elevation** | Player tries to access admin routes | Session JWT has a distinct secret and claim shape; admin routes use `portalAuth` with a separate secret. No JWT issued to a player verifies as an admin. | `middleware/portal-auth.ts` |

---

## 5. STRIDE: outbound wallet call (rgs-server → operator)

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Attacker on the operator's ingress pretends to be us | Same HMAC scheme as inbound, reversed credentials (`OperatorCredential.type = WALLET_HMAC_OUTBOUND`). Operator verifies before acting. | `wallet/HttpWalletAdapter.ts` |
| **Tampering** | MitM alters bet/win body in flight | Body hash in HMAC canonical string (same construction). TLS 1.3 on top. | `utils/signing.ts` |
| **Repudiation** | Operator claims we never called their wallet | Every outbound call writes a `WalletCall` row **before** the HTTP request fires, updates after. Request + response preserved. | `wallet/WalletClient.ts` |
| **Info disclosure** | Wallet response body leaks balance of another player | The RGS does not forward wallet responses to other players. The requesting socket only receives `balance_update` for its own `playerRef`. | `socket/gameSocket.ts`, `services/GameEngine.ts` |
| **DoS** | Operator is slow → our sessions hang → upstream cascade | 5s timeout on outbound calls → synthetic rollback. CircuitBreaker opens after N consecutive failures per operator; new bets from that operator rejected until recovery. | `wallet/HttpWalletAdapter.ts`, `wallet/CircuitBreaker.ts` |
| **Elevation** | Operator exploits a bug in our response handler | Response is strictly validated against `wallet-spec` Zod schemas; unknown statuses are treated as retryable-unknown (safe-by-default). | `packages/wallet-spec/src/index.ts` |

---

## 6. STRIDE: stored secrets

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Attacker obtains plaintext from DB dump | `OperatorCredential.cipherBlob` is AES-GCM encrypted with `SECRETS_MASTER_KEY_B64`. Master key injected at runtime, never stored with the DB. | `utils/secrets.ts` |
| **Tampering** | Attacker modifies encrypted blob to corrupt secret | AES-GCM authentication tag detects tampering; decrypt throws. | `utils/secrets.ts` |
| **Repudiation** | n/a | Every credential has `createdAt`, `notBefore`, `notAfter`, `revokedAt`: audit trail of issuance and revocation. | `prisma/schema.prisma::OperatorCredential` |
| **Info disclosure** | Log line contains secret | Secrets never appear in log lines; redaction is enforced by the logger wrapper. Test: grep CI logs for known secret patterns. | `logger.ts` |
| **DoS** | Master key loss | Backed by KMS in production; loss requires restoring from KMS backup or emergency key rotation (§6.2 of runbook). | `docs/runbook.md#62-secrets_master_key_b64` |
| **Elevation** | Low-privilege user reads master key from env | `SECRETS_MASTER_KEY_B64` visible only to the process UID. In Kubernetes, injected via a Secret with RBAC scoped to the rgs-server service account. | Deployment manifest (per-licensee) |

---

## 7. STRIDE: RNG and provably-fair

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing (cheating)** | RGS publishes an outcome not derivable from committed seed | Commit-reveal: `serverSeedHash` published at session start; raw `serverSeed` revealed post-round. Player can recompute `HMAC(serverSeed, clientSeed:nonce)` and prove mismatch. | `packages/rng-core/src/`, `games/<code>/src/outcome.ts`, `services/ProofService.ts` |
| **Tampering** | Developer changes the RNG to favour house | Per-scope change-gate: CI `rng-change-gate` fails PRs touching `packages/rng-core/src/` without `CERT-ATTEST-CORE:` or `games/<code>/src/{outcome,settle,config}.ts` without `CERT-ATTEST-<GAMECODE>:`. Per-game test vectors (`games/<code>/fixtures/rng-test-vectors.json`) break if the algorithm changes. | `.github/workflows/ci.yml`, `tests/games/<code>/rng-test-vectors.spec.ts` |
| **Repudiation** | Operator denies a round outcome | `Round` row captures `serverSeed`, `clientSeed`, `nonce`, `outcomeSide`, `outcomeSum`. `GET /v1/rounds/:id/proof` reveals the seed post-settle. Cryptographically non-repudiable. | `routes/rounds.ts`, `services/ProofService.ts` |
| **Info disclosure** | `serverSeed` revealed before rounds that used it are settled | `ProofService` gates reveal on `round.state ∈ {SETTLED, VOIDED}`. | `services/ProofService.ts` |
| **DoS** | Entropy source exhausted | OS CSPRNG is effectively non-exhaustible; `randomBytes` never blocks post-boot. `/readyz` fails closed during entropy-starved boot. | `packages/rng-core/src/`, `games/<code>/docs/rng-spec.md §3` |
| **Elevation** | Player influences outcome | `serverSeed` is secret until reveal; `nonce` is server-tracked. Player-provided `clientSeed` is public input and the scheme's security does not depend on its unpredictability. | `packages/rng-core/src/` |

---

## 8. STRIDE: multi-tenant isolation

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Operator A reads/writes operator B's data | `forOperator(id)` Prisma wrapper, every read/write scoped to tenant. Any unscoped query fails code review (grep-based check). Per-operator `EngineRegistry` instance. | `db.ts`, `services/EngineRegistry.ts` |
| **Tampering** | Portal user from operator A edits operator B's config | `portalAuth` middleware resolves `operatorId` from the portal JWT; every admin route filters by that `operatorId`. | `middleware/portal-auth.ts` |
| **Info disclosure** | Log/metric line contains another operator's data | Metric labels include `operator` dimension but no PII. Logs key by `operatorId` (opaque slug). | `telemetry/metrics.ts`, `logger.ts` |
| **DoS** | Operator A's circuit-breaker trip starves operator B | CircuitBreaker is per-operator; one trip does not affect others. `EngineRegistry` runs one engine per operator × game × currency. | `wallet/CircuitBreaker.ts`, `services/EngineRegistry.ts` |
| **Elevation** | Portal user for op A becomes a super-admin and sees op B | Super-admin role (`KETAPOLA_STAFF`) is a distinct claim in the portal JWT; granted only via DB-side role assignment. Audited by `OperatorConfigAuditLog`. | `middleware/portal-auth.ts`, `prisma/schema.prisma::OperatorUser` |

---

## 9. STRIDE: operator portal (admin)

| Threat | Vector | Mitigation | Code |
| --- | --- | --- | --- |
| **Spoofing** | Credential stuffing on portal login | `bcrypt` password hash; login rate-limited; MFA recommended (not shipped, operator-specific SSO integration). | `routes/admin-auth.ts` |
| **Tampering** | XSS → session hijack → config change | Admin API is JSON-only; portal is a React SPA with a strict CSP; all config edits write to `OperatorConfigAuditLog` with `portalUserId`. | `index.ts::helmet`, `prisma/schema.prisma` |
| **Repudiation** | Portal user denies a config change | Every change captured in `OperatorConfigAuditLog`: `userId`, `oldValue`, `newValue`, `at`. | `routes/admin.ts` |
| **Info disclosure** | Portal user reads another operator's round audits | Scoped to the portal JWT's `operatorId`. Super-admin gets explicit operator-switch UI with audit. | `middleware/portal-auth.ts`, `routes/admin.ts` |
| **DoS** | Portal user floods the admin API | Per-operator rate limit. Admin-heavy routes (e.g., report export) are debounced at the UI. | `middleware/operator-rate-limit.ts` |
| **Elevation** | SQL injection via config edit | Prisma parameterised queries; Zod validation on every input; no string concatenation into raw SQL except the TRUNCATE in test harness. | `routes/admin.ts`, `prisma/*` |

---

## 10. LINDDUN: privacy threats

STRIDE covers confidentiality, integrity, availability. For GDPR / MGA PPD /
AGCO 2.10 / Brazil SPA purposes, privacy-specific threats are modelled
separately using **LINDDUN** (Linkability, Identifiability, Non-repudiation,
Detectability, Disclosure of information, Unawareness, Non-compliance).

Scope: player-level data flows through the RGS. Operator staff data is
covered by §9 STRIDE-portal.

| LINDDUN category | Threat | Mitigation | Code / policy |
| --- | --- | --- | --- |
| **L, Linkability** | Multiple rounds from the same player can be linked across sessions to build a behavioural profile | Only `playerRef` (operator-opaque id) is stored on the RGS; no PII (name, email, IP beyond session-scoped rate-limit audit). Linkability exists **by design within one operator** (that's the RGS's job), but not across operators, `operatorId` scopes every query. | `prisma/schema.prisma`: no PII columns on `GameSession` / `Round` / `Bet` |
| **L, Linkability** | IP address in rate-limit logs could be linked to `playerRef` | Rate-limit logs expire in Redis at 1-hour TTL; long-term audit rows do not store IP. | `middleware/operator-rate-limit.ts` |
| **I, Identifiability** | `playerRef` is a UUID from the operator, but some operators use email hashes, identifying | Contract: `playerRef` MUST be an opaque identifier. Docs in `integration-guide.md` explicitly forbid reusing email / username as `playerRef`. | `docs/integration-guide.md` |
| **I, Identifiability** | RGS logs contain `playerRef` + outcome + amount, enough to identify a specific player if combined with operator data | `playerRef` is only ever shared with the operator who minted it. Cross-operator reporting aggregates at the `operatorId` level and never emits `playerRef`. | `routes/reports.ts` |
| **N, Non-repudiation** (flip side) | GDPR Article 17 right to erasure vs GLI-19 7-year retention | Resolved by **pseudonymisation**: the RGS only stores `playerRef`. Deletion of the PII → `playerRef` mapping in the **operator wallet** leaves the RGS ledger intact but non-attributable. The RGS never receives, and never needs to delete, identifying information. | `docs/runbook.md`: "Handling Article 17 requests" |
| **D, Detectability** | Existence of a player record could be inferred (timing, error responses) | Session-create and wallet-bet responses are constant-shape and constant-time-ish, same response for "player doesn't exist" as for "player exists but session denied". Timing channels are minimised by the constant-time signature compare. | `routes/session.ts`, `utils/signing.ts` |
| **Di, Disclosure** | Backup / DR replica exfiltration | Postgres backups are encrypted at rest (KMS-managed); inter-region replication uses TLS 1.3; backup retention policy documented in `runbook.md`. | `docs/runbook.md`: "Backup + DR" |
| **Di, Disclosure** | Log aggregation (Loki / ELK) captures structured logs containing `playerRef` + bet amounts | Structured-log sink is tagged with the same GDPR retention policy as the primary DB; `playerRef` is the same opaque id; logs never contain raw PII. | `telemetry/logger.ts` |
| **U, Unawareness** | Player does not know the RGS logs every bet and round | Operator's privacy policy discloses the RGS as a processor; documented in `integration-guide.md` under "Data-processing agreement template"; MGA PPD 2024 + UKGC LCCP require this disclosure on the operator side. | Contractual |
| **Nc, Non-compliance** | Data-residency rule violated (e.g. Germany player data stored in US) | Per-operator `Operator.dataResidencyRegion` column selects the primary DB region at engine-instance creation. Multi-region Postgres (planned v1.1) enforces; single-region deployments default to residency-compliant region per operator. | `services/EngineRegistry.ts`: regional routing (planned v1.1) |
| **Nc, Non-compliance** | RG limits not enforced per regulation | `jurisdiction-rules` ruleset enforces per-jurisdiction floors at bet time; breach of limit is rejected with a specific `RGLimitBreach` reason; rejection is webhook-notified to the operator. | `services/RGLimitsEnforcer.ts`, `packages/jurisdiction-rules/` |

LINDDUN review cadence matches STRIDE: per-release, annual, and on-incident.
A LINDDUN-specific review is triggered by any schema change that touches
`GameSession`, `Round`, `Bet`, `WalletCall`, or any new log field that might
carry player-identifiable information.

---

## 11. Open risks (not mitigated in this repo)

| Risk | Why open | Decision |
| --- | --- | --- |
| No MFA on portal logins | Operator-specific SSO; out of scope | Document as a requirement for licensees |
| HS256 JWTs for operator-launch request | Shared secret; vulnerable if leaked | §9 of B2B_ROADMAP documents RS256+JWKS migration path |
| No rate limit on `/metrics` | Prometheus scrape needs unauth access | Scope via network ACL, `/metrics` should only be reachable from the monitoring VPC |
| No bot-challenge on player socket connect | Socket.IO connection requires a valid session JWT, already gated upstream | Challenge would be at session-creation; Cloudflare Turnstile optional via env |
| No formal pen-test artefacts in-repo | Pen-testing is an operational programme, not an engineering deliverable. Annual third-party pen-test + rolling bug bounty are tracked in `B2B_ROADMAP.md §16` | Commissioned per deployment; reports held under NDA outside the repo |

---

## 12. Review cadence

- Per-release: review §2–§9 STRIDE tables and §10 LINDDUN table for new attack surface.
- Annual: full re-walk with a fresh reviewer.
- On incident: if an incident exposes a gap, add the row to the relevant
  §2–§10 table as part of post-incident review (per [incidents.md](./incidents.md)).

---

## 13. Version

| Field | Value |
| --- | --- |
| Model version | 1.1.0 |
| Methodology | STRIDE-per-component + LINDDUN (privacy) |
| Last reviewed | 2026-04-24 |
| Owner | Security lead (joint with compliance for SOC 2 + GDPR scope) |
