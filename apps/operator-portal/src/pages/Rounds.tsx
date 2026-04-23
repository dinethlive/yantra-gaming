import { useState } from 'react';
import { type RoundSummary, useRounds } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';
import RoundDetailModal from '../ui/RoundDetailModal';
import { useUIStore } from '../store/uiStore';

const MOCK: RoundSummary[] = Array.from({ length: 12 }, (_, i) => ({
  id: `round-mock-${i}`,
  gameCode: 'yantra',
  currency: 'LKR',
  nonce: 100 + i,
  state: i % 6 === 0 ? 'ROLLING' : 'SETTLED',
  outcomeSum: i % 6 === 0 ? null : [3, 6, 9, 12, 15, 18][i % 6] ?? 9,
  outcomeSide: i % 6 === 0 ? null : i % 2 === 0 ? 'LOW' : 'HIGH',
  totalBetsMicro: String((i + 1) * 50_000_000_000),
  totalPayoutsMicro: String((i + 1) * 32_000_000_000),
  settled: i % 6 !== 0,
  startedAt: new Date(Date.now() - i * 60_000).toISOString(),
  settledAt: i % 6 === 0 ? null : new Date(Date.now() - i * 60_000 + 7000).toISOString(),
}));

export default function Rounds() {
  const dateRange = useUIStore((s) => s.dateRange);
  const setDateRange = useUIStore((s) => s.setDateRange);
  const [state, setState] = useState('');
  const [currency, setCurrency] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data, loading, error, isStub } = useRounds({
    cursor,
    from: dateRange.from,
    to: dateRange.to,
    state: state || undefined,
    currency: currency || undefined,
  });

  const rows = data?.items ?? (isStub ? MOCK : []);

  return (
    <>
      <PageHeader
        title="Rounds"
        subtitle="Click a row to preview the audit record. Open the full page to verify the proof."
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="filter-bar">
        <div className="field">
          <label className="field__label">From</label>
          <input
            type="date"
            className="input"
            value={dateRange.from}
            onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label">To</label>
          <input
            type="date"
            className="input"
            value={dateRange.to}
            onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label">State</label>
          <select
            className="select"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">Any</option>
            <option value="BETTING_OPEN">Betting open</option>
            <option value="ROLLING">Rolling</option>
            <option value="RESULT">Result</option>
            <option value="SETTLED">Settled</option>
            <option value="VOIDED">Voided</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label">Currency</label>
          <input
            className="input"
            placeholder="LKR, USD, …"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </div>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Round</th>
                <th>Nonce</th>
                <th>Currency</th>
                <th>State</th>
                <th>Outcome</th>
                <th>Bets</th>
                <th>Payouts</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="row--clickable"
                  onClick={() => setPreviewId(r.id)}
                >
                  <td><code className="mono">{r.id.slice(0, 8)}…</code></td>
                  <td><code className="mono">{r.nonce}</code></td>
                  <td><code className="mono">{r.currency}</code></td>
                  <td>
                    <span className={`chip ${r.state === 'SETTLED' ? 'chip--success' : 'chip--neutral'}`}>
                      {r.state}
                    </span>
                  </td>
                  <td>
                    {r.outcomeSide ? (
                      <span className={`chip ${r.outcomeSide === 'LOW' ? 'chip--accent' : 'chip--warning'}`}>
                        {r.outcomeSide} {r.outcomeSum}
                      </span>
                    ) : (
                      <span className="chip chip--neutral">—</span>
                    )}
                  </td>
                  <td><Money micro={r.totalBetsMicro} currency={r.currency} /></td>
                  <td><Money micro={r.totalPayoutsMicro} currency={r.currency} /></td>
                  <td>
                    <code className="mono mono--muted">
                      {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No rounds match the filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn"
          disabled={!cursor}
          onClick={() => setCursor(undefined)}
        >
          First page
        </button>
        <button
          type="button"
          className="btn"
          disabled={!data?.nextCursor}
          onClick={() => data?.nextCursor && setCursor(data.nextCursor)}
        >
          Next page
        </button>
      </div>

      <RoundDetailModal roundId={previewId} onClose={() => setPreviewId(null)} />
    </>
  );
}
