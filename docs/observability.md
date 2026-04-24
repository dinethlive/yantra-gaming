# Observability

The RGS is instrumented end to end with OpenTelemetry (metrics + traces) and
structured JSON logging. Everything exports over OTLP; no vendor lock-in. This
document describes what is instrumented, how it is queried, and which alerts are
wired up.

Cross-reference [security.md](./security.md#published-slos) for the SLO targets that
these metrics serve.

---

## OpenTelemetry setup

The RGS uses `@opentelemetry/sdk-node` with auto-instrumentation for HTTP, Express,
and Prisma. A single environment variable switches the export target:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example:4317
OTEL_SERVICE_NAME=yantra-rgs
OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,service.version=1.4.2"
```

Instrumented subsystems out of the box:

- `@opentelemetry/instrumentation-http`: every inbound and outbound HTTP request
  gets a span.
- `@opentelemetry/instrumentation-express`: Express middleware and route spans.
- `@opentelemetry/instrumentation-socket.io`: WebSocket handshakes and event
  handlers.
- `@prisma/instrumentation`: every database query.

Custom instrumentation is layered on top in `apps/rgs-server/src/telemetry/`
(`index.ts` wires the OTel SDK; `metrics.ts` declares the custom counters /
histograms / gauges): game-engine transitions, wallet calls, RNG determinism
hashes.

Prometheus scrape endpoint: `GET /metrics`: exports the OpenMetrics format for any
Prometheus-compatible collector (Prometheus, Grafana Agent, VictoriaMetrics).

---

## Custom metrics

The seven metrics that matter most. Labels are always scoped by `operator_id` so
dashboards and alerts can be per-tenant.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `wallet_call_latency_ms` | Histogram | `operator_id`, `endpoint`, `status` | Outbound wallet-call latency distribution |
| `wallet_call_errors_total` | Counter | `operator_id`, `endpoint`, `rs_status` | Non-OK responses; alert on non-zero rate for `endpoint="win"` |
| `bet_to_settlement_ms` | Histogram | `operator_id`, `game_code` | End-to-end time from bet accepted to settlement confirmed |
| `rtp_actual_rolling_24h` | Gauge | `operator_id`, `game_code`, `currency` | Rolling 24h actual RTP from the ledger |
| `pending_wallet_jobs` | Gauge | `operator_id`, `endpoint` | Count of rows in `PendingWalletJob` not yet completed |
| `session_active` | Gauge | `operator_id` | Concurrent live sessions per operator |
| `round_state_transitions_total` | Counter | `operator_id`, `from_state`, `to_state` | Round lifecycle transitions |

### Supporting metrics (also exported)

| Metric | Purpose |
| --- | --- |
| `wallet_call_total` | Counter; denominator for error-rate queries |
| `http_server_duration_seconds` | Standard OpenTelemetry HTTP duration |
| `db_query_duration_ms` | Prisma query latency per model and operation |
| `circuit_state` | 0=closed, 1=half-open, 2=open, per `(operator, endpoint)` |
| `idempotency_cache_hit_total` | Counter; divides by request total for hit rate |

---

## Example PromQL queries

### Wallet bet outbound p99

```promql
histogram_quantile(
  0.99,
  sum by (le, operator_id) (
    rate(wallet_call_latency_ms_bucket{endpoint="bet"}[5m])
  )
)
```

### Wallet call error rate per operator

```promql
sum by (operator_id, endpoint) (
  rate(wallet_call_errors_total[5m])
)
/
sum by (operator_id, endpoint) (
  rate(wallet_call_total[5m])
)
```

### Bet-to-settlement p99 per game

```promql
histogram_quantile(
  0.99,
  sum by (le, game_code) (
    rate(bet_to_settlement_ms_bucket[5m])
  )
)
```

### RTP drift: absolute deviation from theoretical

```promql
abs(
  rtp_actual_rolling_24h{operator_id="op_abc",game_code="yantra",currency="LKR"}
  - 0.97
)
```

### Stuck retry queue

```promql
max by (operator_id, endpoint) (
  pending_wallet_jobs
)
> 0
and on() (time() - pending_wallet_jobs_oldest_seconds > 300)
```

### Active sessions right now

```promql
sum by (operator_id) (session_active)
```

### Circuit breaker open

```promql
circuit_state{state="open"} == 2
```

---

## RTP drift monitor

A scheduled job computes the rolling 24h actual RTP per `(operator_id, game_code,
currency)` and exports it as `rtp_actual_rolling_24h`. The computation:

```sql
SELECT
  operator_id,
  game_code,
  currency,
  SUM(total_payouts_micro)::numeric / NULLIF(SUM(total_bets_micro), 0)::numeric AS rtp
FROM rounds
WHERE settled = true
  AND settled_at > now() - interval '24 hours'
GROUP BY operator_id, game_code, currency;
```

The alert fires at **±3σ from theoretical**. σ is **per-game**: it depends on
the per-round payout variance declared in the PAR sheet, not a global constant.

For a round whose per-round payout has standard deviation `σ₁` (in RTP units),
the observed 24h RTP over `N` rounds has standard deviation
`σ = σ₁ / sqrt(N)`. The PAR sheet for each game publishes `σ₁`:

| Game | `σ₁` (per-round payout stdev) | `σ` at N=10k rounds | 3σ gate |
| --- | --- | --- | --- |
| Ketapola Dice (2× symmetric, 98% RTP) | ~1.00 | 0.01 (1.0pp) | ±3.0pp |
| Crash Minimal (heavy-tailed, 99% RTP) | ~3.6 (cashout-dependent) | 0.036 (3.6pp) | ±10.8pp |

Slot-style games with jackpot / free-spin features have materially higher `σ₁`
and the gate is derived from the per-game PAR sheet at cert submission, not
hardcoded. Per-operator overrides are read from `OperatorGameConfig.configJson`;
heavy-volume operators typically tighten.

Alert query:

```promql
(
  abs(
    rtp_actual_rolling_24h
    - on(game_code) group_left() rtp_theoretical
  )
) > (3 * on(game_code) group_left() rtp_sigma_24h)
```

(`rtp_theoretical` and `rtp_sigma_24h` are Prometheus recording rules populated
per `(operator_id, game_code, currency)` from `operator_game_configs` and the
per-game PAR sheet, `rtp_sigma_24h = sigma_per_round / sqrt(rounds_24h)`.)

What the alert catches, in decreasing order of frequency:

1. Bot / collusion attacks, large RTP swings from abnormal player win rates.
2. Weight-config errors after a change, someone saves `(lowWeight=50, highWeight=30)`
   with commission unchanged.
3. RNG regressions, rare but catastrophic.
4. Statistical noise, rare at 24h window; fires a warning not a page.

---

## Suggested Grafana dashboard

Single-pane-of-glass layout for an on-call shift. Sections, top to bottom:

### Top row: "is anything on fire"

- Big number: current RGS uptime % (last 30 days).
- Big number: wallet-call error rate (last 5 min).
- Big number: pending retry-queue depth.
- Big number: active sessions across all operators.

### Second row: latency

- Time series: `/wallet/bet` p50 / p95 / p99, stacked by `operator_id`.
- Time series: bet-to-settlement p50 / p95 / p99.
- Time series: `/v1/session` p50 / p95 / p99.

### Third row: error budget

- Burn-down: `/wallet/bet` 30-day error budget remaining (1% - current rate × time).
- Heatmap: errors per operator × endpoint × hour.

### Fourth row: RTP drift

- Time series: `rtp_actual_rolling_24h` per operator × game × currency with a
  horizontal line at theoretical RTP and a band at ±3σ.
- Table: worst-performing operators (largest drift) with links to their wallet-call
  logs.

### Fifth row: round loop

- Counter: `round_state_transitions_total` sankey or stacked-bar.
- Gauge: circuit-breaker states per operator.
- Counter: RNG determinism check pass/fail (should always be 100% pass).

Repo: a dashboard JSON skeleton lives at `ops/grafana/rgs-overview.json` (if present);
otherwise import from the Grafana gallery using these queries.

---

## SIEM integration

SOC 2 Type II and MGA / AGCO / SPA supervisory reviews require audit trails
to flow into a SIEM with a documented retention + retention-integrity story.
The RGS emits every security-relevant event to stdout as structured JSON;
shippers (Vector, Filebeat, Fluent Bit) route to the operator's SIEM.

### What ships to the SIEM

| Event class | Source | Retention guidance | Field mapping |
| --- | --- | --- | --- |
| **Wallet calls (audit ledger)** | `WalletCall` rows → CDC stream via Debezium / Logical replication | **7 years** (GLI-19 minimum; UKGC LCCP requires 5) | `operator_id`, `player_ref`, `endpoint`, `requestUuid`, `transactionUuid`, `amountMicro`, `status`, `latency_ms`, `error`, `http_status`, `ts` |
| **Session lifecycle** | `GameSession` rows on INSERT/UPDATE | 7 years | `session_id`, `operator_id`, `player_ref`, `game_code`, `currency`, `jurisdiction`, `mode`, `created_at`, `terminated_at`, `terminated_reason` |
| **Round settlement** | `Round` rows on settlement | 7 years | `round_id`, `session_id`, `operator_id`, `game_code`, `outcome_type`, `outcome_data`, `total_bets_micro`, `total_payouts_micro`, `server_seed_hash`, `rng_version`, `math_version` |
| **Admin-portal actions** | `OperatorConfigAuditLog` / `AdminAuditLog` | 7 years | `portal_user_id`, `operator_id`, `action`, `target_field`, `old_value`, `new_value`, `ip`, `ts` |
| **Authentication events** | Structured log category `auth` | 1 year | `operator_id`, `kid`, `event` (`login_success`, `login_fail`, `mfa_success`, `mfa_fail`, `ip_rejected`, `signature_invalid`, `replay_window_exceeded`), `ip`, `ts` |
| **RG limit trips** | Structured log category `rg`: also mirrored as a webhook | 7 years | `session_id`, `operator_id`, `player_ref`, `limit_type`, `stake_micro`, `remaining_micro`, `ts` |
| **Circuit breaker transitions** | Structured log category `circuit` | 90 days (operational) | `operator_id`, `state_from`, `state_to`, `failure_count`, `ts` |
| **Kill-switch activations** | `GlobalKillSwitch` rows + log category `killswitch` | 7 years | `operator_id`, `scope`, `activated_by`, `activated_at`, `deactivated_at`, `reason` |

### Field mapping conventions

- **Elastic Common Schema (ECS)**: the JSON logs already follow ECS where
  possible: `@timestamp`, `event.category`, `event.action`, `event.outcome`,
  `user.id`, `client.ip`, `http.request.method`, `http.response.status_code`.
  The Fluent Bit / Vector shipper does not need a custom schema.
- **Splunk CIM**: a Vector `remap` ruleset at `ops/siem/vector-splunk.vrl`
  (shipped per-deployment, not in-repo, operator-specific index / sourcetype)
  projects ECS onto Splunk's Authentication / Change / Network Sessions models.
- **Datadog / Sumo Logic**: ingest ECS JSON directly; no projection needed.

### Retention-integrity

The `WalletCall`, `Round`, `GameSession`, and `OperatorConfigAuditLog` tables
are **append-only**: no `UPDATE` to outcome-bearing columns, no `DELETE`
except via the per-jurisdiction retention purge job (off by default; must be
explicitly enabled per-operator with a documented retention policy).

The `AuditChain` service (`services/AuditChain.ts`) hash-chains every
`WalletCall` row per-operator and signs a daily anchor, so a SIEM that
ingests the `WalletCall` stream can recompute the chain and detect any
upstream tampering. The daily anchor signature is logged to SIEM under
category `auditchain.anchor`.

### What does NOT ship to the SIEM

- `/metrics` Prometheus scrape is separate, that's metrics, not events.
- Player PII, the RGS does not have any. `playerRef` is opaque.
- HMAC secrets, session JWT secrets, master keys, never logged; attempts
  to log them are redacted by `telemetry/logger.ts::redactor`.
- Request bodies beyond the idempotency key and status, bodies can carry
  commercially sensitive config; if a licensee needs full-body logging for
  a specific incident, it's a per-operator opt-in with a 30-day TTL.

---

## SLO burn-rate alerts

Following the multi-window, multi-burn-rate pattern from the Google SRE workbook.
For each SLO, two parallel alerts at different windows fire at different urgency.

### Example: `/wallet/bet` error budget (0.1% over 30 days)

Fast burn (page immediately):

```
Burn rate:  14.4×   (exhausts 2% of budget in 1 hour)
Windows:    1h short × 5m long
Severity:   SEV-1 page
```

Slow burn (ticket for daytime fix):

```
Burn rate:  1×      (would exhaust full budget in 30 days)
Windows:    6h short × 30m long
Severity:   SEV-3 ticket
```

PromQL sketch (fast):

```promql
(
  sum(rate(wallet_call_errors_total{endpoint="bet"}[1h]))
  /
  sum(rate(wallet_call_total{endpoint="bet"}[1h]))
) > (14.4 * 0.001)
AND
(
  sum(rate(wallet_call_errors_total{endpoint="bet"}[5m]))
  /
  sum(rate(wallet_call_total{endpoint="bet"}[5m]))
) > (14.4 * 0.001)
```

Both windows must cross threshold simultaneously, this kills the false-positive
rate on short noisy spikes.

Apply the same pattern to latency SLOs (replace error-rate ratio with
`1 - p99 < target`).

---

## Log structure

All logs are JSON lines. No free-form strings. Every record carries the correlation
fields that let you join logs, traces, and metrics together.

```json
{
  "ts":        "2026-04-23T14:32:05.148Z",
  "level":     "info",
  "msg":       "wallet call committed",
  "operator_id": "op_abc",
  "session_id":  "5bb8...",
  "round_id":    "rnd_8a2c...",
  "bet_id":      "bet_9f3a...",
  "trace_id":    "4bf92f35...",
  "span_id":     "00f067aa...",
  "endpoint":    "bet",
  "rs_status":   "RS_OK",
  "latency_ms":  42
}
```

### Scrubbing

Three classes of field never appear in logs:

1. Raw secrets (`apiSecret`, `walletSecret`, JWT tokens).
2. Signature header values.
3. PII. `playerRef` is logged because it is opaque by definition; real PII never
   reaches the RGS. If an operator accidentally sends a raw email as `playerRef`, the
   log scrubber detects it heuristically and masks it.

### Retention

Application logs: 30 days hot, 1 year cold (S3 / equivalent).
Audit logs (`WalletCall`, `OperatorConfigAuditLog`): 7 years, never purged.

---

## Trace structure

Every request produces a trace. Important spans and their attributes:

| Span name | Attributes | Description |
| --- | --- | --- |
| `HTTP POST /v1/session` | `operator_id`, `http.status_code`, `http.route` | Inbound session creation |
| `session.create` | `operator_id`, `session_id`, `player_ref`, `currency` | Session service layer |
| `socket.handshake` | `operator_id`, `session_id`, `player_ref` | WebSocket auth |
| `round.start` | `operator_id`, `round_id`, `session_id`, `nonce` | Round state machine entry |
| `bet.place` | `operator_id`, `bet_id`, `round_id`, `amount_micro`, `side` | Player bet intake |
| `wallet.call` | `operator_id`, `endpoint`, `attempt`, `rs_status`, `latency_ms` | Outbound wallet HTTP |
| `round.roll` | `round_id`, `outcome_side`, `outcome_sum` | RNG computation |
| `round.settle` | `round_id`, `bets_won`, `bets_lost`, `total_payouts_micro` | Settlement loop |
| `rng.verify` | `round_id`, `match` | Determinism self-check |
| `prisma.query` | `db.statement`, `db.operation`, `db.model` | Every DB query |

### Correlation

`trace_id` is attached to:

- Every log line emitted during the trace.
- Every outbound wallet HTTP call as the `traceparent` header (W3C Trace Context).
- Every Prisma query via the Prisma OTel integration.
- Every metric recorded during the span gets an `exemplar` pointing to the trace.

This means a single trace click from "slow bet latency" metric goes straight to the
Prisma query + wallet HTTP call + application log for that one bet.

---

## See also

- [security.md](./security.md#published-slos), the SLO targets these metrics defend.
- [wallet-api.md](./wallet-api.md#retry-and-rollback-rules), retry semantics that
  drive `pending_wallet_jobs`.
- Per-game PAR sheet (e.g. [games/ketapola-dice/docs/par-sheet.md](../games/ketapola-dice/docs/par-sheet.md#rtp), [games/crash-minimal/docs/par-sheet.md](../games/crash-minimal/docs/par-sheet.md#rtp)), theoretical RTP values used by the
  drift alert.
- `apps/rgs-server/src/telemetry/`: the instrumentation source.
