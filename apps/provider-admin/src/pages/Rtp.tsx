import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';
import { TestToggle } from '../ui/TestToggle';

type Window = '24h' | '7d' | '30d';
type Flag = 'ok' | 'watch' | 'drift' | 'low_n';

interface Row {
  id: string;
  slug: string;
  name: string;
  currency: string;
  roundCount: number;
  betVolumeMicro: string;
  winVolumeMicro: string;
  observedRtp: number | null;
  expectedRtp: number;
  commissionFraction: number;
  driftPct: number | null;
  zScore: number | null;
  flag: Flag;
}

interface Response {
  window: Window;
  windowStart: string;
  lowConfidenceThreshold: number;
  operators: Row[];
}

function fmtPct(v: number | null, digits = 2): string {
  if (v === null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtSigned(v: number | null, digits = 3): string {
  if (v === null) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export function Rtp() {
  const [window, setWindow] = useState<Window>('7d');
  const [includeTest, setIncludeTest] = useState(false);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<Response>(`/v1/platform/rtp?window=${window}&includeTest=${includeTest}`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'failed_to_load'); });
    return () => { cancelled = true; };
  }, [window, includeTest]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">RTP drift</h1>
          <p className="page__subtitle">
            Observed vs declared RTP per operator · declared = 1 − commission · drift flagged at &gt; 3σ,
            watch at &gt; 2σ · &lt; {data?.lowConfidenceThreshold ?? 1000} rounds = low confidence
          </p>
        </div>
        <div className="window-picker">
          <TestToggle value={includeTest} onChange={setIncludeTest} />
          {(['24h', '7d', '30d'] as Window[]).map((w) => (
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
                <th>Flag</th>
                <th>Operator</th>
                <th className="num">Rounds</th>
                <th className="num">Observed RTP</th>
                <th className="num">Declared RTP</th>
                <th className="num">Δ (pp)</th>
                <th className="num">z-score</th>
              </tr>
            </thead>
            <tbody>
              {data.operators.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.flag === 'drift' ? 'row--incident' :
                    r.flag === 'watch' ? 'row--warn' : undefined
                  }
                >
                  <td><FlagChip flag={r.flag} /></td>
                  <td>
                    <Link to={`/operators/${r.id}`} className="op-link">
                      <div className="op-name">{r.name}</div>
                      <div className="op-slug">{r.slug} · {r.currency}</div>
                    </Link>
                  </td>
                  <td className="num">{r.roundCount.toLocaleString()}</td>
                  <td className="num">{fmtPct(r.observedRtp, 3)}</td>
                  <td className="num">{fmtPct(r.expectedRtp, 3)}</td>
                  <td className={`num${r.flag === 'drift' ? ' num--danger' : r.flag === 'watch' ? ' num--warn' : ''}`}>
                    {r.driftPct !== null ? `${r.driftPct > 0 ? '+' : ''}${r.driftPct.toFixed(2)}` : '—'}
                  </td>
                  <td className={`num${r.flag === 'drift' ? ' num--danger' : r.flag === 'watch' ? ' num--warn' : ''}`}>
                    {fmtSigned(r.zScore, 2)}
                  </td>
                </tr>
              ))}
              {data.operators.length === 0 ? (
                <tr><td colSpan={7} className="empty">No operators.</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function FlagChip({ flag }: { flag: Flag }) {
  const label = flag === 'low_n' ? 'low-n' : flag;
  const map: Record<Flag, 'healthy' | 'warning' | 'incident' | 'neutral'> = {
    ok: 'healthy',
    watch: 'warning',
    drift: 'incident',
    low_n: 'neutral',
  };
  return <span className={`health-dot health-dot--${map[flag]}`}><span className="health-dot__pip" />{label}</span>;
}
