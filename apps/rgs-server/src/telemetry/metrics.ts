// Minimal Prometheus-compatible metrics registry.
//
// Design: match the shape of `@opentelemetry/exporter-prometheus` + `prom-client`
// closely enough that swapping the implementation for OpenTelemetry is a single
// import change. Counters, Gauges, and Histograms cover every metric we emit;
// text format on `GET /metrics` is parseable by Prometheus and compatible with
// Grafana Alloy / OTel collector.
//
// Why a minimal registry instead of the OpenTelemetry metrics SDK?
//   1. The SDK drags ~20 transitive deps and adds boot-time cost; we don't
//      need its richer semantic conventions for the single metric surface
//      this service exposes.
//   2. The call-site API here is intentionally isomorphic to `prom-client`
//      and the OTel metrics API: `metric.inc(labels, n)` /
//      `metric.observe(labels, ms)` / `metric.set(labels, n)`. Swapping the
//      implementation behind the same call-site is a single-import change.
//   3. Drop-in paths and their costs are documented in `docs/observability.md`.

type Labels = Record<string, string | number>;

const DEFAULT_BUCKETS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
];

function serialiseLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => {
    const v = String(labels[k])
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `${k}="${v}"`;
  });
  return `{${parts.join(',')}}`;
}

interface Metric {
  readonly name: string;
  readonly help: string;
  toText(): string;
}

export class Counter implements Metric {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, delta = 1): void {
    const k = serialiseLabels(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + delta);
  }

  toText(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [k, v] of this.values) {
      lines.push(`${this.name}${k} ${v}`);
    }
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(labels: Labels, value: number): void {
    this.values.set(serialiseLabels(labels), value);
  }
  inc(labels: Labels, delta = 1): void {
    const k = serialiseLabels(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + delta);
  }
  dec(labels: Labels, delta = 1): void {
    this.inc(labels, -delta);
  }

  toText(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [k, v] of this.values) {
      lines.push(`${this.name}${k} ${v}`);
    }
    return lines.join('\n');
  }
}

export class Histogram implements Metric {
  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[] = DEFAULT_BUCKETS_MS,
  ) {}

  observe(labels: Labels, value: number): void {
    const k = serialiseLabels(labels);
    let buckets = this.counts.get(k);
    if (!buckets) {
      buckets = new Array<number>(this.buckets.length).fill(0);
      this.counts.set(k, buckets);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) buckets[i] = (buckets[i] ?? 0) + 1;
    }
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.totals.set(k, (this.totals.get(k) ?? 0) + 1);
  }

  toText(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [k, counts] of this.counts) {
      const baseLabels = k.length > 0 ? k.slice(1, -1) : '';
      const prefix = baseLabels.length > 0 ? `${baseLabels},` : '';
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${counts[i]}`,
        );
      }
      const total = this.totals.get(k) ?? 0;
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${total}`);
      lines.push(`${this.name}_sum${k} ${this.sums.get(k) ?? 0}`);
      lines.push(`${this.name}_count${k} ${total}`);
    }
    return lines.join('\n');
  }
}

class Registry {
  private metrics: Metric[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  toText(): string {
    return `${this.metrics.map((m) => m.toText()).join('\n\n')}\n`;
  }
}

export const registry = new Registry();

// ─── Canonical RGS metrics ─────────────────────────────────────────────────

export const walletCallLatencyMs = registry.register(
  new Histogram(
    'wallet_call_latency_ms',
    'Latency of outbound wallet calls in milliseconds',
    [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
  ),
);

export const walletCallErrorsTotal = registry.register(
  new Counter(
    'wallet_call_errors_total',
    'Count of non-OK wallet responses. Alert at non-zero rate on endpoint="WIN".',
  ),
);

export const walletCallTotal = registry.register(
  new Counter(
    'wallet_call_total',
    'Count of outbound wallet calls, bucketed by endpoint and status.',
  ),
);

export const betToSettlementMs = registry.register(
  new Histogram(
    'bet_to_settlement_ms',
    'Time from bet acceptance to win-call completion (settlement latency).',
    [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
  ),
);

export const pendingWalletJobs = registry.register(
  new Gauge(
    'pending_wallet_jobs',
    'Outstanding PendingWalletJob rows per operator/endpoint. Alert if any > 5 min old.',
  ),
);

export const sessionActive = registry.register(
  new Gauge(
    'session_active',
    'Number of live sessions per operator (updated every minute).',
  ),
);

export const roundStateTransitions = registry.register(
  new Counter(
    'round_state_transitions_total',
    'Round state-machine transitions (PENDING→BETTING_OPEN→ROLLING→RESULT→SETTLED|VOIDED).',
  ),
);

export const rtpActualPpm = registry.register(
  new Gauge(
    'rtp_actual_ppm',
    'Rolling 24h actual RTP per operator/currency, in parts-per-million (1_000_000 = 100%). Alert at ±3σ from theoretical.',
  ),
);

export const circuitBreakerState = registry.register(
  new Gauge(
    'circuit_breaker_state',
    'Circuit breaker state per operator/endpoint. 0=CLOSED, 1=HALF_OPEN, 2=OPEN.',
  ),
);

export const walletAuditWriteFailures = registry.register(
  new Counter(
    'wallet_audit_write_failures_total',
    'WalletCall audit row write failures (pre-call or post-call). Any non-zero rate is a reconciliation risk — the ledger is meant to be append-only and unconditional. Alert.',
  ),
);

export const turnstileVerifications = registry.register(
  new Counter(
    'turnstile_verifications_total',
    'Outcomes of Cloudflare Turnstile verification on session-create. Labels: status=ok|fail|skip|error.',
  ),
);

export const clockSkewMs = registry.register(
  new Gauge(
    'clock_skew_ms',
    'Local wall-clock offset from NTP reference in milliseconds. +ve = local is ahead. Alert if |value| > 250 ms.',
  ),
);

export const auditChainAnchorsTotal = registry.register(
  new Counter(
    'audit_chain_anchors_total',
    'AuditAnchor rows written by the daily audit-chain anchor job. Label: stream=wallet_call|round.',
  ),
);

export const auditChainVerifications = registry.register(
  new Counter(
    'audit_chain_verifications_total',
    'AuditAnchor replay-verification outcomes. Label: result=match|mismatch|error.',
  ),
);
