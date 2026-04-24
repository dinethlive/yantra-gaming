import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';
import { TestToggle } from '../ui/TestToggle';

interface OperatorRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  jurisdiction: string;
  currency: string;
  activeSessions: number;
  bets: { count: number; volumeMicro: string };
  wins: { count: number; volumeMicro: string };
  ggrMicro: string;
}

interface OverviewResponse {
  since: string;
  operators: OperatorRow[];
  totals: {
    operatorCount: number;
    activeSessions: number;
    betsMicro: string;
    winsMicro: string;
    ggrMicro: string;
  };
}

function formatMicro(s: string, currency: string): string {
  const v = BigInt(s);
  const whole = Number(v / 100_000n);
  const frac = Number(v % 100_000n) / 100_000;
  return `${(whole + frac).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

export function Overview() {
  const [includeTest, setIncludeTest] = useState(false);
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<OverviewResponse>(`/v1/platform/overview?includeTest=${includeTest}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed_to_load');
      });
    return () => {
      cancelled = true;
    };
  }, [includeTest]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Cross-operator overview</h1>
          <p className="page__subtitle">Last 24 hours · each row uses the operator's default currency</p>
        </div>
        <TestToggle value={includeTest} onChange={setIncludeTest} />
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      {data ? (
        <>
          <section className="kpi-row">
            <Kpi label="Operators" value={String(data.totals.operatorCount)} />
            <Kpi label="Active sessions" value={String(data.totals.activeSessions)} />
            <Kpi label="Bets (micro)" value={data.totals.betsMicro} mono />
            <Kpi label="Wins (micro)" value={data.totals.winsMicro} mono />
            <Kpi label="GGR (micro)" value={data.totals.ggrMicro} mono />
          </section>

          <section className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Operator</th>
                  <th>Jurisdiction</th>
                  <th>Status</th>
                  <th className="num">Sessions</th>
                  <th className="num">Bets</th>
                  <th className="num">Bet vol</th>
                  <th className="num">Wins</th>
                  <th className="num">Win vol</th>
                  <th className="num">GGR</th>
                </tr>
              </thead>
              <tbody>
                {data.operators.map((op) => (
                  <tr key={op.id}>
                    <td>
                      <div className="op-name">{op.name}</div>
                      <div className="op-slug">{op.slug}</div>
                    </td>
                    <td>{op.jurisdiction}</td>
                    <td>
                      <span className={`chip chip--${op.status.toLowerCase()}`}>{op.status}</span>
                    </td>
                    <td className="num">{op.activeSessions}</td>
                    <td className="num">{op.bets.count}</td>
                    <td className="num">{formatMicro(op.bets.volumeMicro, op.currency)}</td>
                    <td className="num">{op.wins.count}</td>
                    <td className="num">{formatMicro(op.wins.volumeMicro, op.currency)}</td>
                    <td className="num">{formatMicro(op.ggrMicro, op.currency)}</td>
                  </tr>
                ))}
                {data.operators.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      No operators found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : !error ? (
        <div className="empty">Loading…</div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className={mono ? 'kpi__value mono' : 'kpi__value'}>{value}</div>
    </div>
  );
}
