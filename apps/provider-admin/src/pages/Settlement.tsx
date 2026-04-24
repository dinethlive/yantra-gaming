import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';
import { TestToggle } from '../ui/TestToggle';

type Health = 'healthy' | 'warning' | 'incident';

interface Row {
  id: string;
  slug: string;
  name: string;
  status: string;
  currency: string;
  health: Health;
  bets: { count: number; volumeMicro: string };
  wins: { count: number; volumeMicro: string };
  rollbacks: { count: number; volumeMicro: string };
  ggrMicro: string;
  failedOutboundCalls: number;
  stuckHeldBets: number;
  stuckRetryJobs: number;
}

interface Response {
  date: string;
  windowStart: string;
  windowEnd: string;
  staleMinutes: number;
  totals: {
    failedCalls: number;
    stuckHeld: number;
    stuckJobs: number;
    healthy: number;
    warnings: number;
    incidents: number;
  };
  operators: Row[];
}

function fmtMicro(s: string, currency: string): string {
  const v = BigInt(s);
  const whole = Number(v / 100_000n);
  const frac = Number(v % 100_000n) / 100_000;
  return `${(whole + frac).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function Settlement() {
  const [date, setDate] = useState<string>(todayUtc());
  const [includeTest, setIncludeTest] = useState(false);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiRequest<Response>(`/v1/platform/settlement?date=${date}&includeTest=${includeTest}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed_to_load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, includeTest]);

  const sortedOperators = useMemo(() => {
    if (!data) return [];
    const rank: Record<Health, number> = { incident: 0, warning: 1, healthy: 2 };
    return [...data.operators].sort((a, b) => rank[a.health] - rank[b.health] || a.name.localeCompare(b.name));
  }, [data]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Settlement &amp; integrity</h1>
          <p className="page__subtitle">
            GLI-19 §3 incomplete-games register health, rollback activity, and outbound wallet-call failures.
            Window is {data?.windowStart?.slice(0, 10) ?? date} UTC · stuck-held threshold {data?.staleMinutes ?? '15'} min.
          </p>
        </div>
        <div className="feed-actions">
          <TestToggle value={includeTest} onChange={setIncludeTest} />
          <label className="field field--inline">
            <span>Date (UTC)</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <a
            className="btn btn--small"
            href={`/v1/platform/settlement/feed?date=${date}&includeTest=${includeTest}&format=csv`}
            title="HMAC-SHA256 signature in X-Signature response header"
          >
            Download signed CSV
          </a>
          <a
            className="btn btn--small"
            href={`/v1/platform/settlement/feed?date=${date}&includeTest=${includeTest}&format=json`}
            target="_blank"
            rel="noreferrer"
            title="Canonical JSON; HMAC-SHA256 signature in X-Signature response header"
          >
            Signed JSON
          </a>
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      {data ? (
        <>
          <section className="kpi-row">
            <Kpi label="Healthy" value={String(data.totals.healthy)} tone="success" />
            <Kpi label="Warnings" value={String(data.totals.warnings)} tone="warning" />
            <Kpi label="Incidents" value={String(data.totals.incidents)} tone="danger" />
            <Kpi label="Stuck held bets" value={String(data.totals.stuckHeld)} tone={data.totals.stuckHeld > 0 ? 'danger' : undefined} />
            <Kpi label="Stuck retry jobs" value={String(data.totals.stuckJobs)} tone={data.totals.stuckJobs > 0 ? 'danger' : undefined} />
            <Kpi label="Failed outbound calls" value={String(data.totals.failedCalls)} tone={data.totals.failedCalls > 0 ? 'warning' : undefined} />
          </section>

          <section className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Health</th>
                  <th>Operator</th>
                  <th className="num">Bets</th>
                  <th className="num">Bet volume</th>
                  <th className="num">Wins</th>
                  <th className="num">Win volume</th>
                  <th className="num">Rollbacks</th>
                  <th className="num">GGR</th>
                  <th className="num">Failed calls</th>
                  <th className="num">Stuck held</th>
                  <th className="num">Stuck jobs</th>
                </tr>
              </thead>
              <tbody>
                {sortedOperators.map((op) => (
                  <tr key={op.id} className={op.health === 'incident' ? 'row--incident' : undefined}>
                    <td><HealthDot health={op.health} /></td>
                    <td>
                      <Link to={`/operators/${op.id}`} className="op-link">
                        <div className="op-name">{op.name}</div>
                        <div className="op-slug">{op.slug}</div>
                      </Link>
                    </td>
                    <td className="num">{op.bets.count}</td>
                    <td className="num">{fmtMicro(op.bets.volumeMicro, op.currency)}</td>
                    <td className="num">{op.wins.count}</td>
                    <td className="num">{fmtMicro(op.wins.volumeMicro, op.currency)}</td>
                    <td className="num">{op.rollbacks.count}</td>
                    <td className="num">{fmtMicro(op.ggrMicro, op.currency)}</td>
                    <td className={op.failedOutboundCalls > 0 ? 'num num--warn' : 'num'}>{op.failedOutboundCalls}</td>
                    <td className={op.stuckHeldBets > 0 ? 'num num--danger' : 'num'}>{op.stuckHeldBets}</td>
                    <td className={op.stuckRetryJobs > 0 ? 'num num--danger' : 'num'}>{op.stuckRetryJobs}</td>
                  </tr>
                ))}
                {sortedOperators.length === 0 ? (
                  <tr><td colSpan={11} className="empty">No operators.</td></tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
    </div>
  );
}

function HealthDot({ health }: { health: Health }) {
  return (
    <span className={`health-dot health-dot--${health}`} title={health}>
      <span className="health-dot__pip" />
      {health}
    </span>
  );
}
