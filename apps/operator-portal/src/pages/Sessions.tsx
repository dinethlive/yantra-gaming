import { useNavigate } from 'react-router-dom';
import { type SessionRow, useSessions } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';

const MOCK: SessionRow[] = Array.from({ length: 9 }, (_, i) => ({
  id: `sess-mock-${i}`,
  playerRef: `op-player-${200 + i}`,
  currency: i % 3 === 0 ? 'USD' : 'LKR',
  mode: i % 5 === 0 ? 'DEMO' : 'REAL',
  betCount: (i + 1) * 4,
  netPositionMicro: String((i % 2 === 0 ? 1 : -1) * (i + 1) * 2_500_000_000),
  createdAt: new Date(Date.now() - i * 5 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + (60 - i * 2) * 60_000).toISOString(),
  terminatedAt: i > 5 ? new Date(Date.now() - i * 60_000).toISOString() : null,
}));

export default function Sessions() {
  const { data, loading, error, isStub } = useSessions();
  const rows = data?.items ?? (isStub ? MOCK : []);

  const active = rows.filter((r) => r.terminatedAt === null);
  const terminated = rows.filter((r) => r.terminatedAt !== null);

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Active players and recently-terminated sessions. Click a row to drill into bets and rounds."
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <Card title={`Active (${active.length})`}>
        <SessionTable rows={active} loading={loading} />
      </Card>

      <Card title={`Recently terminated (${terminated.length})`}>
        <SessionTable rows={terminated} loading={loading} />
      </Card>
    </>
  );
}

function SessionTable({ rows, loading }: { rows: SessionRow[]; loading: boolean }) {
  const navigate = useNavigate();
  if (rows.length === 0 && !loading) {
    return <div className="table-empty">No sessions.</div>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Player</th>
            <th>Mode</th>
            <th>Currency</th>
            <th>Bets</th>
            <th>Net position</th>
            <th>Started</th>
            <th>Expires</th>
            <th>Terminated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className="row--clickable"
              onClick={() => navigate(`/sessions/${s.id}`)}
            >
              <td><code className="mono">{s.id.slice(0, 8)}…</code></td>
              <td><code className="mono">{s.playerRef}</code></td>
              <td>
                <span className={`chip ${s.mode === 'REAL' ? 'chip--accent' : 'chip--neutral'}`}>
                  {s.mode}
                </span>
              </td>
              <td><code className="mono">{s.currency}</code></td>
              <td><code className="mono">{s.betCount}</code></td>
              <td><Money micro={s.netPositionMicro} currency={s.currency} signed /></td>
              <td>
                <code className="mono mono--muted">
                  {new Date(s.createdAt).toLocaleString()}
                </code>
              </td>
              <td>
                <code className="mono mono--muted">
                  {new Date(s.expiresAt).toLocaleTimeString()}
                </code>
              </td>
              <td>
                <code className="mono mono--muted">
                  {s.terminatedAt ? new Date(s.terminatedAt).toLocaleString() : '—'}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
