import { useState } from 'react';
import { type WalletCallRow, useWalletCalls } from '../api/hooks';
import { useUIStore } from '../store/uiStore';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';

const MOCK: WalletCallRow[] = Array.from({ length: 18 }, (_, i) => ({
  id: `wc-mock-${i}`,
  direction: i % 7 === 0 ? 'INBOUND' : 'OUTBOUND',
  endpoint: (['BET', 'WIN', 'ROLLBACK', 'BALANCE'] as const)[i % 4] ?? 'BET',
  requestUuid: crypto.randomUUID(),
  transactionUuid: crypto.randomUUID(),
  roundId: `round-${i % 5}`,
  playerRef: `player-${100 + (i % 8)}`,
  amountMicro: String((i + 1) * 1_000_000_000),
  currency: 'LKR',
  httpStatus: i % 5 === 0 ? 500 : 200,
  responseStatus: i % 5 === 0 ? 'RS_ERROR_TIMEOUT' : 'RS_OK',
  latencyMs: 40 + (i * 11) % 300,
  attempt: i % 5 === 0 ? 2 : 1,
  succeeded: i % 5 !== 0,
  createdAt: new Date(Date.now() - i * 30_000).toISOString(),
}));

export default function WalletCalls() {
  const dateRange = useUIStore((s) => s.dateRange);
  const setDateRange = useUIStore((s) => s.setDateRange);
  const [endpoint, setEndpoint] = useState('');
  const [succeeded, setSucceeded] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();

  const { data, loading, error, isStub } = useWalletCalls({
    cursor,
    from: dateRange.from,
    to: dateRange.to,
    endpoint: endpoint || undefined,
    succeeded: succeeded || undefined,
  });

  const rows = data?.items ?? (isStub ? MOCK : []);

  return (
    <>
      <PageHeader
        title="Wallet calls"
        subtitle="Every bet/win/rollback/balance roundtrip. Red rows failed."
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
          <label className="field__label">Endpoint</label>
          <select className="select" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
            <option value="">Any</option>
            <option value="BALANCE">balance</option>
            <option value="BET">bet</option>
            <option value="WIN">win</option>
            <option value="ROLLBACK">rollback</option>
            <option value="END_ROUND">end-round</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label">Result</label>
          <select className="select" value={succeeded} onChange={(e) => setSucceeded(e.target.value)}>
            <option value="">Any</option>
            <option value="true">Succeeded</option>
            <option value="false">Failed</option>
          </select>
        </div>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Endpoint</th>
                <th>Direction</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Attempt</th>
                <th>Amount</th>
                <th>Player</th>
                <th>Round</th>
                <th>Txn</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className={w.succeeded ? undefined : 'row--failed'}>
                  <td>
                    <code className="mono mono--muted">
                      {new Date(w.createdAt).toLocaleString()}
                    </code>
                  </td>
                  <td><code className="mono">{w.endpoint}</code></td>
                  <td><code className="mono">{w.direction}</code></td>
                  <td>
                    <span className={`chip ${w.succeeded ? 'chip--success' : 'chip--danger'}`}>
                      {w.responseStatus ?? w.httpStatus ?? '—'}
                    </span>
                  </td>
                  <td><code className="mono">{w.latencyMs ?? '—'}ms</code></td>
                  <td><code className="mono">{w.attempt}</code></td>
                  <td><Money micro={w.amountMicro} currency={w.currency ?? ''} /></td>
                  <td><code className="mono">{w.playerRef ?? '—'}</code></td>
                  <td>
                    <code className="mono mono--muted">
                      {w.roundId ? `${w.roundId.slice(0, 8)}…` : '—'}
                    </code>
                  </td>
                  <td>
                    <code className="mono mono--muted">
                      {w.transactionUuid ? `${w.transactionUuid.slice(0, 8)}…` : '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No wallet calls match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" disabled={!cursor} onClick={() => setCursor(undefined)}>
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
    </>
  );
}
