# Incident Response Playbooks

> One playbook per class of incident. Every playbook follows the same shape:
> **Detect** → **Triage** → **Mitigate** → **RCA template**.
>
> Pair with [runbook.md](./runbook.md) for day-2 ops and
> [observability.md](./observability.md) for the underlying metrics.

**Severity definitions:**

| Sev | Impact | Response |
| --- | --- | --- |
| **SEV1** | Money is moving incorrectly, or player experience is broken for > 5 % of sessions | Page oncall immediately; war-room until mitigated |
| **SEV2** | Single operator affected; money risk quantifiable and bounded | Oncall during business hours; war-room if unresolved > 4 h |
| **SEV3** | Degraded observability or non-player-impacting error rate | Ticket, triage next business day |

Use the oldest applicable playbook; if nothing fits, page the engineering
lead and file a new playbook post-RCA.

---

## 1. Stuck rollbacks ( > 5 min in `PendingWalletJob` )

**Severity:** SEV2 per operator; SEV1 if > 1 % of pending jobs cross-cutting.

### Detect
- Alert: `pending_wallet_jobs{endpoint="ROLLBACK"} > 0 for > 5m`.
- Dashboard: the "Rollback queue depth" panel in the SLO dashboard.
- Operator complaints: players reporting that their stake was debited but
  the round voided / refund never arrived.

### Triage
1. Query: `SELECT operator_id, count(*), max(age(now(), created_at)) FROM pending_wallet_jobs WHERE endpoint='ROLLBACK' AND completed_at IS NULL GROUP BY 1 ORDER BY 2 DESC;`
2. Is the queue growing or stable? `SELECT date_trunc('minute', created_at), count(*) FROM pending_wallet_jobs WHERE endpoint='ROLLBACK' AND completed_at IS NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 30;`
3. What's the `last_error`? `SELECT last_error, count(*) FROM pending_wallet_jobs WHERE endpoint='ROLLBACK' AND completed_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10;`

### Mitigate
- **Common root cause: operator wallet is rejecting the rollback.** Check
  their `WalletCall` error rows: `SELECT created_at, status, response_body FROM wallet_calls WHERE operator_id=<X> AND endpoint='ROLLBACK' AND succeeded=false ORDER BY created_at DESC LIMIT 20;`
  - If `RS_ERROR_TRANSACTION_DOES_NOT_EXIST`: operator has forgotten the
    original bet. Mark the pending job completed with a manual override (the
    stake never actually left their wallet).
  - If `RS_ERROR_TRANSACTION_ALREADY_ROLLED_BACK` / duplicate: same. Mark
    completed.
  - If `5xx` or timeout: the operator wallet is down. Notify them; keep
    retrying.
- **If the RGS circuit breaker has opened** for that operator: see §6.
- **If it's all operators at once**: likely a bug in the retry path. Revert
  to prior version, file SEV1.

### RCA template
- What was the operator's failure mode?
- Did our classifier treat an unknown response as retryable correctly?
- How long did it take to detect? (Alert latency + human response.)
- What monitor would reduce detection time?

---

## 2. RTP drift alert

**Severity:** SEV2 on 24h window > ±3σ; SEV1 if rolling 1h > ±5σ.

### Detect
- Alert: `rtp_actual_rolling_24h{game_code="ketapola-dice"} - <theoretical>` ≥
  ±3σ (see `observability.md`). (Matching labels fire for other `game_code`
  values as new plugins ship.)

### Triage
1. Reproduce: run the per-game 10M-round regression. `bun test tests/games/<code>/rtp-regression.spec.ts` (e.g. `tests/games/ketapola-dice/rtp-regression.spec.ts`). Does it still pass at the current config?
2. Check config audit: `SELECT * FROM operator_config_audit_log WHERE field_name IN ('lowWeight','highWeight','commissionMicro') AND created_at > now() - interval '24h' ORDER BY created_at DESC;`
3. Check round counts per operator, a single outlier operator can move the mean.
4. Sample rounds: pull 50 random rounds in the alert window, re-verify the proof end-to-end (the public-facing verifier). If any fail: stop everything, page SEV1.

### Mitigate
- **Weight config changed unexpectedly**: revert the config via portal
  (audit log shows who). Verify the engine picks up the new weights on the
  next round.
- **Single outlier operator**: quarantine them by setting
  `OperatorGameConfig.enabled = false`. Their in-flight rounds void; bets
  currently held refund.
- **RNG behaviour actually drifted**: this is SEV1. Roll back the deploy.
  Any deploy that touched `rng.ts` without a `CERT-ATTEST` is the CI gate
  failing, investigate how it reached prod.

### RCA template
- Root: config change, operator-induced, statistical variance, or RNG bug?
- Effective RTP observed; player impact in micro-units.
- Was any player overpaid or underpaid? Manual reconciliation required?

---

## 3. Operator credential leak (suspected or confirmed)

**Severity:** SEV1.

### Detect
- Operator notifies us of a leak.
- Anomalous request pattern (requests from new IP; signed with old `kid`
  thought to be retired; high request volume).
- Public disclosure (HIBP, paste site, exposed repo).

### Triage
1. Identify the credential: `SELECT id, kid, created_at, revoked_at FROM operator_credentials WHERE operator_id=<X> AND kid=<Y>;`
2. Has the credential signed anything in the last 24h? `SELECT created_at, count(*) FROM wallet_calls WHERE operator_id=<X> AND created_at > now() - interval '24h' GROUP BY 1 ORDER BY 1 DESC;`
3. Is there evidence of misuse? Anomalous session creation pattern? Unexplained `InboundIdempotency` rows?

### Mitigate
- **Immediate revocation**: `UPDATE operator_credentials SET revoked_at=now() WHERE id=<credential_id>;`: or via the portal.
- **Issue a replacement**: coordinate the new `(kid, secret)` delivery through a secure channel (1Password / Vault / PGP). See [runbook.md §6.1](./runbook.md#61-operator-credentials).
- **Audit**: scan the last 7 days of `WalletCall` and `InboundIdempotency`
  for rows signed by the leaked credential. Any request that wouldn't match
  a known-good session pattern is a finding.
- **Notify the operator's compliance contact.** Every operator has one; if
  not, this is also an RCA finding.
- **Alert players** only if confirmed misuse with player impact.

### RCA template
- Source of leak (internal, external, third-party).
- Dwell time (first misuse → revocation).
- Any transactions to roll back?
- Did MFA / IP allow-list have prevented this? (Gap for future mitigations.)

---

## 4. Clock skew spike ( > 10s sustained )

**Severity:** SEV2 for the affected operator.

### Detect
- Alert: `signature_rejection_reason="clock_skew_outside_window"` count
  rising.
- Operator reports intermittent 401s on otherwise-valid requests.

### Triage
1. Whose clock? Compare the `Timestamp` header in rejected requests against
   our server clock. Is the drift one-sided (operator ahead/behind) or
   bidirectional?
2. Is it a specific host or all? Many operators run multiple pods.
3. Is our own clock drifting? Check host NTP status.

### Mitigate
- **Operator-side drift**: notify their ops; recommend Chrony or native
  cloud NTP. Short-term, widen `SIGNATURE_WINDOW_SECONDS` **per-env** (not
  per-operator; the env var is global). Do not exceed 60s.
- **Our drift**: restart `ntpd`/`chronyd` on the affected host; page infra.
- **Clock tampering by an attacker**: if drift is attacker-influenced (one
  request far in the past/future), treat as replay/spoof attempt; see §3.

### RCA template
- Source of drift (upstream NTP, hypervisor, attacker).
- Duration.
- Any money-path rejections? Did they retry successfully?

---

## 5. Circuit breaker tripped for an operator

**Severity:** SEV2 for that operator.

### Detect
- Log: `circuit_breaker_opened` for `operatorId=<X>`.
- Metric: `circuit_breaker_state{operator="<X>"} = 1`.
- Symptom: new bets for that operator are immediately rejected.

### Triage
1. Why did it open? Check the last N failed `WalletCall` rows for the
   operator: `SELECT created_at, endpoint, response_status, response_body FROM wallet_calls WHERE operator_id=<X> AND succeeded=false ORDER BY created_at DESC LIMIT 20;`
2. Is the operator wallet up? Try a synthetic `balance` call manually.
3. Is it a specific endpoint failing (`/win` only) or all?

### Mitigate
- **Operator wallet is actually down**: leave the breaker open. Notify them.
  When they're healthy, the breaker auto-closes after the cooldown +
  successful probe.
- **Our retry classifier is mis-treating their responses**: if a valid
  operator-side code is being classified as a failure, that's a bug ,
  patch the classifier and ship a hotfix per
  [change-management.md §4](./change-management.md#4-emergency-hotfix-flow).
- **False-positive flap**: adjust the `CircuitBreaker` thresholds in the
  config (this is a regated change, see change-management).

### RCA template
- Dwell time (first failure → breaker open → first recovery).
- Number of bets rejected during the outage.
- Was the operator able to detect the downtime from their side?

---

## 6. Pending job queue growth (non-rollback)

**Severity:** SEV2 if queue depth > 1000 for > 10 min.

### Detect
- Alert: `pending_wallet_jobs > 1000 for > 10m`.
- Dashboard: queue depth panel.

### Triage
1. `SELECT endpoint, operator_id, count(*) FROM pending_wallet_jobs WHERE completed_at IS NULL GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;`
2. Are attempts incrementing? If not, the runner is stopped. Check process
   health.
3. Is any single operator swamping the queue?

### Mitigate
- **Runner stopped**: restart the RGS. Graceful shutdown drains the queue;
  forced kill leaves jobs for the next process (safe, idempotent).
- **Single-operator swamp**: treat as operator outage (§5); circuit breaker
  should kick in and prevent new inflow.
- **Genuine backlog**: scale horizontally (add rgs-server pods) or
  temporarily increase `PendingJobRunner` concurrency.

### RCA template
- Depth-over-time curve.
- Drain rate when mitigation applied.
- What monitor would catch this earlier?

---

## 7. DB connection exhaustion

**Severity:** SEV1 (rgs-server becomes unavailable).

### Detect
- Alert: `prisma_pool_wait_time_ms p99 > 500`.
- Logs: `Error: getaddrinfo ENOTFOUND` / `connection pool timeout`.
- `/readyz` returns 503 across all pods.

### Triage
1. DB-side: `SELECT count(*) FROM pg_stat_activity WHERE datname='yantra';`: is it at `max_connections`?
2. `SELECT state, count(*) FROM pg_stat_activity WHERE datname='yantra' GROUP BY 1;`: idle-in-transaction?
3. App-side: are any pods stuck holding connections (infinite loop, slow query)?

### Mitigate
- **Short-term**: restart the RGS pods (drops connections, forces reconnect
  with a fresh pool).
- **Medium**: raise Postgres `max_connections` or put PgBouncer in front.
- **Long**: identify the query causing idle-in-transaction. Prisma logs at
  debug level.

### RCA template
- Saturation curve (connection count over time).
- Specific query that held transactions open.
- Whether PgBouncer would have absorbed it.

---

## 8. Reconciliation mismatch ( MAJOR_DRIFT status )

**Severity:** SEV2 if one operator; SEV1 if multiple.

### Detect
- Daily reconcile cron exits with code 2 (`MAJOR_DRIFT`).
- Operator reports a settlement discrepancy.

### Triage
1. Run the reconcile CLI manually with verbose output:
   `bun scripts/reconcile.ts --file settlement.csv`.
2. Which direction does the drift go? (Ours high → we processed txns they
   didn't ack. Ours low → they sent settlements we didn't process.)
3. Compare row-by-row: `SELECT transaction_uuid, amount_micro, created_at, succeeded FROM wallet_calls WHERE operator_id=<X> AND currency=<Y> AND created_at >= '<D>' AND created_at < '<D+1>' ORDER BY created_at;` and diff against the operator's file.

### Mitigate
- **Ours high by N transactions**: those are probably stuck in
  `pending_wallet_jobs` (not yet settled on their side). Cross-check.
- **Ours low**: we may have missed settlements, look for `WalletCall` rows
  with `succeeded=false` we did not retry.
- If drift can't be explained: halt new settlements for that operator,
  escalate to their compliance contact.

### RCA template
- Drift value in micro-units and percentage.
- Attribution: which transactions account for the drift?
- Whether they'll reconcile naturally on the next day's close or need a
  manual correction entry.

---

## 9. RNG change landed without re-cert

**Severity:** SEV1.

### Detect
- Post-deploy: RTP regression test fails.
- `rng-change-gate` CI was somehow bypassed (manual force-merge, admin
  override).
- Test-vectors spec fails on a freshly-deployed build.

### Mitigate
- **Immediate**: roll back the deploy. Every second of uptime at a
  post-change RTP is a certification exposure.
- Freeze further deploys until root cause is identified.
- Notify compliance / legal, a re-cert conversation may be necessary.

### RCA template
- How did the change reach main?
- What gate failed? (Reviewer asleep? Admin override? CI bypass?)
- How to prevent: required status checks, branch protection, CODEOWNERS.

---

## 10. Operator wallet down > 10 min

**Severity:** SEV2 per operator.

### Detect
- Circuit breaker open (§5).
- `wallet_call_latency_ms{endpoint="bet", operator="<X>"}` p99 → timeout.

### Triage
1. Synthetic `/wallet/balance` from our side: does it succeed?
2. Check operator's status page if they have one.
3. How many bets currently rejected? How many winners pending?

### Mitigate
- Keep circuit breaker open, no new bets for that operator while down.
- Pending winners accumulate in `pending_wallet_jobs`; they will drain on
  recovery.
- **Communicate**: post a status update to the operator-portal's incident
  banner so support can forward to players.
- If downtime crosses 1h and the operator has not acknowledged, escalate to
  their compliance contact.

### RCA template
- Duration of outage.
- Queue depth at reopen.
- Drain time.
- Any bets void-refunded due to the outage?

---

## 11. Post-incident review

Every SEV1 and every unexpected SEV2 get a written post-mortem within 5
business days. Template:

```
Title: <system> <incident>, <date>
Severity: SEV<N>
Detected at: <UTC>
Mitigated at: <UTC>
Duration: <hh:mm>

Summary:
  Two-sentence synopsis.

Impact:
  - N players affected
  - M micro-units of stakes in uncertain state
  - $ value if quantifiable

Timeline:
  HH:MM UTC, event
  HH:MM UTC, detection
  HH:MM UTC, ...
  HH:MM UTC, resolved

Root cause:
  Where the system failed, and why. No blame, focus on mechanisms.

What worked:
  Monitors / runbooks / people that did their job.

What did not work:
  Gaps, confusion, mis-alerts, missing runbook entries.

Follow-up:
  - [ ] Action item (owner, due date)
  - [ ] Action item
  - [ ] Action item

Artifacts:
  - Link to SEV ticket
  - Link to any code changes
  - Link to any updated monitor / alert / runbook section
```

If the incident touched a regated area (RNG, wallet, schema), the
post-mortem is also shared with the compliance owner per
[change-management.md](./change-management.md).

---

## 12. Playbook version

| Field | Value |
| --- | --- |
| Playbook version | 1.0.0 |
| Last reviewed | 2026-04-23 |
| Next review trigger | After any incident not in the list above |
