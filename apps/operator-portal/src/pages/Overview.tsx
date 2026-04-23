import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useOverview } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import CircuitBreakerPanel from '../ui/CircuitBreakerPanel';
import Money, { microToDecimal } from '../ui/Money';
import PageHeader from '../ui/PageHeader';

// Default currency fallback — real value comes from auth store once we
// have the operator summary wired in; for Phase 0 we use the KPI payload's
// own `currency` field when present.

const MOCK_OVERVIEW = {
  bets: { count: 1284, volumeMicro: '45820000000000' },
  wins: { count: 612, volumeMicro: '43200000000000' },
  ggrMicro: '2620000000000',
  ngrMicro: '2310000000000',
  activeSessions: 37,
  currency: 'LKR',
  trend24h: Array.from({ length: 24 }, (_, i) => ({
    t: `${String(i).padStart(2, '0')}:00`,
    betsMicro: String(Math.round(400_000_000_000 + Math.random() * 1_400_000_000_000)),
    winsMicro: String(Math.round(350_000_000_000 + Math.random() * 1_300_000_000_000)),
  })),
};

export default function Overview() {
  const { data, loading, error, isStub } = useOverview();
  const kpi = data ?? MOCK_OVERVIEW;
  const currency = kpi.currency ?? 'LKR';

  const chartData = kpi.trend24h.map((p) => ({
    t: p.t,
    bets: Number(microToDecimal(p.betsMicro, 2)),
    wins: Number(microToDecimal(p.winsMicro, 2)),
  }));

  return (
    <>
      <PageHeader title="Overview" subtitle="Live KPIs — polls every 10 seconds" />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi__label">Bets (today)</div>
          <div className="kpi__value">{kpi.bets.count.toLocaleString()}</div>
          <div className="kpi__foot">
            <Money micro={kpi.bets.volumeMicro} currency={currency} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Wins (today)</div>
          <div className="kpi__value">{kpi.wins.count.toLocaleString()}</div>
          <div className="kpi__foot">
            <Money micro={kpi.wins.volumeMicro} currency={currency} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi__label">GGR</div>
          <div className="kpi__value">
            <Money micro={kpi.ggrMicro} currency={currency} />
          </div>
          <div className="kpi__foot">Bets − Wins</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">NGR</div>
          <div className="kpi__value">
            <Money micro={kpi.ngrMicro} currency={currency} />
          </div>
          <div className="kpi__foot">After fees and bonuses</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Active sessions</div>
          <div className="kpi__value">{kpi.activeSessions}</div>
          <div className="kpi__foot">{loading ? 'Refreshing…' : 'Live'}</div>
        </div>
      </div>

      <Card title="Bets vs wins — last 24 hours" subtitle={currency}>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <AreaChart data={chartData} margin={{ top: 8, right: 18, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="bets" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b8def" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#5b8def" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="wins" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#222936" vertical={false} />
              <XAxis dataKey="t" stroke="#6b7280" fontSize={11} tickLine={false} />
              <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: '#11151d',
                  border: '1px solid #2f3746',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area type="monotone" dataKey="bets" stroke="#5b8def" fill="url(#bets)" />
              <Area type="monotone" dataKey="wins" stroke="#22c55e" fill="url(#wins)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <CircuitBreakerPanel />
    </>
  );
}
