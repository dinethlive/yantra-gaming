import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { type DailyReport, useReportsDaily } from '../api/hooks';
import { useAuthStore } from '../store/authStore';
import { useUIStore } from '../store/uiStore';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money, { microToDecimal } from '../ui/Money';
import PageHeader from '../ui/PageHeader';

const MOCK: DailyReport[] = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.now() - (6 - i) * 24 * 3600_000);
  return {
    date: d.toISOString().slice(0, 10),
    currency: 'LKR',
    bets: { count: 1200 + i * 30, volumeMicro: String((40 + i * 3) * 1_000_000_000_000) },
    wins: { count: 580 + i * 15, volumeMicro: String((38 + i * 3) * 1_000_000_000_000) },
    ggrMicro: String(2 * 1_000_000_000_000 + i * 100_000_000_000),
    ngrMicro: String(18 * 100_000_000_000 + i * 90_000_000_000),
    rtpPct: 95 + (i % 3) * 0.3,
  };
});

function reportUrl(period: 'daily' | 'weekly' | 'monthly', from: string, to: string): string {
  const base = import.meta.env.VITE_RGS_ADMIN_BASE_URL ?? '';
  const token = useAuthStore.getState().token ?? '';
  const params = new URLSearchParams({ from, to, format: 'csv', token });
  return `${base}/v1/admin/reports/${period}?${params.toString()}`;
}

export default function Reports() {
  const range = useUIStore((s) => s.dateRange);
  const setRange = useUIStore((s) => s.setDateRange);
  const { data, error, isStub } = useReportsDaily(range);
  const rows = data?.items ?? (isStub ? MOCK : []);

  const chart = rows.map((r) => ({
    date: r.date,
    ggr: Number(microToDecimal(r.ggrMicro, 2)),
  }));

  return (
    <>
      <PageHeader title="Reports" subtitle="Daily/weekly/monthly settlement reports and GGR trend." />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="filter-bar">
        <div className="field">
          <label className="field__label">From</label>
          <input
            type="date"
            className="input"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label">To</label>
          <input
            type="date"
            className="input"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label">CSV download</label>
          <div className="row">
            <a className="btn" href={reportUrl('daily', range.from, range.to)}>Daily</a>
            <a className="btn" href={reportUrl('weekly', range.from, range.to)}>Weekly</a>
            <a className="btn" href={reportUrl('monthly', range.from, range.to)}>Monthly</a>
          </div>
        </div>
      </div>

      <Card title="GGR — selected range">
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <AreaChart data={chart} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ggr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b8def" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#5b8def" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#222936" vertical={false} />
              <XAxis dataKey="date" stroke="#6b7280" fontSize={11} tickLine={false} />
              <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: '#11151d',
                  border: '1px solid #2f3746',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area type="monotone" dataKey="ggr" stroke="#5b8def" fill="url(#ggr)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Daily summary">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Currency</th>
                <th>Bets</th>
                <th>Wins</th>
                <th>GGR</th>
                <th>NGR</th>
                <th>RTP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.date + r.currency}>
                  <td><code className="mono">{r.date}</code></td>
                  <td><code className="mono">{r.currency}</code></td>
                  <td>
                    <Money micro={r.bets.volumeMicro} currency={r.currency} />
                    <span className="mono mono--muted"> · {r.bets.count}</span>
                  </td>
                  <td>
                    <Money micro={r.wins.volumeMicro} currency={r.currency} />
                    <span className="mono mono--muted"> · {r.wins.count}</span>
                  </td>
                  <td><Money micro={r.ggrMicro} currency={r.currency} /></td>
                  <td><Money micro={r.ngrMicro} currency={r.currency} /></td>
                  <td><code className="mono">{r.rtpPct.toFixed(2)}%</code></td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No data for the selected range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
