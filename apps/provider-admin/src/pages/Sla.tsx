import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';
import { TestToggle } from '../ui/TestToggle';

type Window = '1h' | '24h' | '7d';
type Status = 'ok' | 'warn' | 'breach';

interface EndpointRow {
  endpoint: string;
  total: number;
  failed: number;
  successRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  status: Status;
}

interface OperatorRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  overall: Status;
  totalCalls: number;
  totalFailed: number;
  successRate: number;
  endpoints: EndpointRow[];
}

interface Response {
  window: Window;
  windowStart: string;
  targets: { p99Ms: number; successRate: number };
  operators: OperatorRow[];
}

function fmtMs(v: number | null): string {
  if (v === null || v === undefined) return '—';
  return v < 10 ? `${v.toFixed(1)}ms` : `${Math.round(v)}ms`;
}
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(v >= 0.9999 ? 4 : v >= 0.99 ? 3 : 2)}%`;
}

export function Sla() {
  const [window, setWindow] = useState<Window>('24h');
  const [includeTest, setIncludeTest] = useState(false);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<Response>(`/v1/platform/sla?window=${window}&includeTest=${includeTest}`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'failed_to_load'); });
    return () => { cancelled = true; };
  }, [window, includeTest]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Wallet-call SLA</h1>
          <p className="page__subtitle">
            Outbound wallet-call latency (p50/p95/p99) and success rate per operator · target p99 &lt;{' '}
            {data?.targets.p99Ms ?? 300}ms, success rate ≥ {data ? fmtPct(data.targets.successRate) : '99.9%'}
          </p>
        </div>
        <div className="window-picker">
          <TestToggle value={includeTest} onChange={setIncludeTest} />
          {(['1h', '24h', '7d'] as Window[]).map((w) => (
            <button
              key={w}
              type="button"
              className={`btn btn--small ${w === window ? 'btn--primary' : ''}`}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}
      {!data && !error ? <div className="empty">Loading…</div> : null}

      {data ? (
        <section className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Operator</th>
                <th>Endpoint</th>
                <th className="num">Calls</th>
                <th className="num">Success</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">p99</th>
                <th className="num">max</th>
              </tr>
            </thead>
            <tbody>
              {data.operators.map((op) => {
                if (op.endpoints.length === 0) {
                  return (
                    <tr key={op.id} className="row--quiet">
                      <td><HealthDot status={op.overall} /></td>
                      <td>
                        <Link to={`/operators/${op.id}`} className="op-link">
                          <div className="op-name">{op.name}</div>
                          <div className="op-slug">{op.slug}</div>
                        </Link>
                      </td>
                      <td colSpan={7} className="empty">No wallet calls in window</td>
                    </tr>
                  );
                }
                return op.endpoints.map((e, i) => (
                  <tr key={`${op.id}:${e.endpoint}`} className={e.status === 'breach' ? 'row--incident' : undefined}>
                    <td>{i === 0 ? <HealthDot status={op.overall} /> : null}</td>
                    <td>
                      {i === 0 ? (
                        <Link to={`/operators/${op.id}`} className="op-link">
                          <div className="op-name">{op.name}</div>
                          <div className="op-slug">{op.slug}</div>
                        </Link>
                      ) : null}
                    </td>
                    <td><code className="mono">{e.endpoint}</code></td>
                    <td className="num">{e.total.toLocaleString()}</td>
                    <td className={e.successRate < (data.targets.successRate) ? 'num num--warn' : 'num'}>
                      {fmtPct(e.successRate)}
                    </td>
                    <td className="num">{fmtMs(e.p50Ms)}</td>
                    <td className="num">{fmtMs(e.p95Ms)}</td>
                    <td className={`num${e.p99Ms !== null && e.p99Ms >= data.targets.p99Ms ? ' num--danger' : ''}`}>
                      {fmtMs(e.p99Ms)}
                    </td>
                    <td className="num">{fmtMs(e.maxMs)}</td>
                  </tr>
                ));
              })}
              {data.operators.length === 0 ? (
                <tr><td colSpan={9} className="empty">No operators.</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function HealthDot({ status }: { status: Status }) {
  const map: Record<Status, 'healthy' | 'warning' | 'incident'> = {
    ok: 'healthy',
    warn: 'warning',
    breach: 'incident',
  };
  return (
    <span className={`health-dot health-dot--${map[status]}`} title={status}>
      <span className="health-dot__pip" />
      {status}
    </span>
  );
}
