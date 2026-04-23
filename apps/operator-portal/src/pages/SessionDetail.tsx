import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { useSessionDetail } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';
import { useUIStore } from '../store/uiStore';

// Drill-down from the Sessions list. Shows:
//   • Session header (player, currency, mode, seed, RG limits, timestamps)
//   • 4-cell summary (rounds / bets / net / status)
//   • Player bets for this session (click → round detail)
//   • Rounds table for this session
//   • Force-terminate button for non-terminated sessions

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const { data, loading, error, isStub, refetch } = useSessionDetail(id);
  const [busy, setBusy] = useState(false);

  const terminate = useCallback(async () => {
    if (!id) return;
    const reason = prompt(
      'Termination reason (shown in audit log):',
      'Portal admin terminate',
    );
    if (!reason) return;
    setBusy(true);
    try {
      await apiRequest(`/v1/admin/sessions/${id}/terminate`, {
        method: 'POST',
        body: { reason },
      });
      pushToast('success', `Session ${id.slice(0, 8)}… terminated`);
      refetch();
    } catch (err) {
      pushToast('error', `Terminate failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [id, pushToast, refetch]);

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Session" subtitle="Loading…" />
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Session" subtitle="Not found" />
        {error ? <ErrorBanner message={error.message} /> : null}
        <button type="button" className="btn" onClick={() => navigate('/sessions')}>
          Back to sessions
        </button>
      </>
    );
  }

  const { session, summary, rounds, bets } = data;
  const isActive = session.terminatedAt === null;

  return (
    <>
      <PageHeader
        title="Session detail"
        subtitle={`Player: ${session.playerRef} · ${session.gameCode} · ${session.currency}`}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn--ghost" onClick={() => navigate('/sessions')}>
              Back
            </button>
            {isActive && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={terminate}
                disabled={busy}
              >
                {busy ? 'Terminating…' : 'Force terminate'}
              </button>
            )}
          </div>
        }
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi__label">Rounds</div>
          <div className="kpi__value">{summary.roundCount}</div>
          <div className="kpi__foot">This session</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Bets</div>
          <div className="kpi__value">{summary.betCount}</div>
          <div className="kpi__foot">
            <Money micro={summary.betsMicro} currency={session.currency} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Wins paid</div>
          <div className="kpi__value">
            <Money micro={summary.winsMicro} currency={session.currency} />
          </div>
          <div className="kpi__foot">To this player</div>
        </div>
        <div className="kpi">
          <div className="kpi__label">Net position</div>
          <div className="kpi__value">
            <Money micro={summary.netMicro} currency={session.currency} signed />
          </div>
          <div className="kpi__foot">Bets − wins (house view)</div>
        </div>
      </div>

      <Card title="Session facts">
        <dl className="facts">
          <div className="facts__row">
            <dt>Session id</dt>
            <dd>
              <code className="mono">{session.id}</code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Mode</dt>
            <dd>
              <span
                className={`chip ${session.mode === 'REAL' ? 'chip--accent' : 'chip--neutral'}`}
              >
                {session.mode}
              </span>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Lang / jurisdiction</dt>
            <dd>
              <code className="mono">
                {session.lang} · {session.jurisdiction}
              </code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Server seed hash</dt>
            <dd>
              <code className="mono mono--muted">{session.serverSeedHash}</code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Client seed</dt>
            <dd>
              <code className="mono mono--muted">{session.clientSeed}</code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Current nonce</dt>
            <dd>
              <code className="mono">{session.nonce}</code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Created</dt>
            <dd>
              <code className="mono mono--muted">
                {new Date(session.createdAt).toLocaleString()}
              </code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Expires</dt>
            <dd>
              <code className="mono mono--muted">
                {new Date(session.expiresAt).toLocaleString()}
              </code>
            </dd>
          </div>
          <div className="facts__row">
            <dt>Terminated</dt>
            <dd>
              {session.terminatedAt ? (
                <code className="mono mono--muted">
                  {new Date(session.terminatedAt).toLocaleString()}
                  {session.terminationReason ? ` · ${session.terminationReason}` : ''}
                </code>
              ) : (
                <span className="chip chip--success">Active</span>
              )}
            </dd>
          </div>
          {session.rgLimits ? (
            <div className="facts__row">
              <dt>RG limits</dt>
              <dd>
                <code className="mono mono--muted">
                  {JSON.stringify(session.rgLimits)}
                </code>
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      <Card title={`Bets (${bets.length})`} subtitle="Newest first, capped at 50.">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Bet</th>
                <th>Round</th>
                <th>Side</th>
                <th>Stake</th>
                <th>Won</th>
                <th>Status</th>
                <th>Placed</th>
                <th>Settled</th>
              </tr>
            </thead>
            <tbody>
              {bets.map((b) => (
                <tr
                  key={b.id}
                  className="row--clickable"
                  onClick={() => navigate(`/rounds/${b.roundId}`)}
                >
                  <td>
                    <code className="mono">{b.id.slice(0, 8)}…</code>
                  </td>
                  <td>
                    <code className="mono mono--muted">{b.roundId.slice(0, 8)}…</code>
                  </td>
                  <td>
                    <span
                      className={`chip ${b.side === 'LOW' ? 'chip--accent' : 'chip--warning'}`}
                    >
                      {b.side}
                    </span>
                  </td>
                  <td>
                    <Money micro={b.amountMicro} currency={session.currency} />
                  </td>
                  <td>
                    {b.wonAmountMicro ? (
                      <Money micro={b.wonAmountMicro} currency={session.currency} />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`chip chip--${chipForStatus(b.status)}`}>{b.status}</span>
                  </td>
                  <td>
                    <code className="mono mono--muted">
                      {new Date(b.placedAt).toLocaleTimeString()}
                    </code>
                  </td>
                  <td>
                    <code className="mono mono--muted">
                      {b.settledAt ? new Date(b.settledAt).toLocaleTimeString() : '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {bets.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No bets yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Rounds (${rounds.length})`} subtitle="Newest first, capped at 50.">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Round</th>
                <th>Nonce</th>
                <th>State</th>
                <th>Outcome</th>
                <th>Total bets</th>
                <th>Total payouts</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr
                  key={r.id}
                  className="row--clickable"
                  onClick={() => navigate(`/rounds/${r.id}`)}
                >
                  <td>
                    <code className="mono">{r.id.slice(0, 8)}…</code>
                  </td>
                  <td>
                    <code className="mono">{r.nonce}</code>
                  </td>
                  <td>
                    <span
                      className={`chip ${r.state === 'SETTLED' ? 'chip--success' : 'chip--neutral'}`}
                    >
                      {r.state}
                    </span>
                  </td>
                  <td>
                    {r.outcomeSide ? (
                      <span
                        className={`chip ${r.outcomeSide === 'LOW' ? 'chip--accent' : 'chip--warning'}`}
                      >
                        {r.outcomeSide} {r.outcomeSum}
                      </span>
                    ) : (
                      <span className="chip chip--neutral">—</span>
                    )}
                  </td>
                  <td>
                    <Money micro={r.totalBetsMicro} currency={session.currency} />
                  </td>
                  <td>
                    <Money micro={r.totalPayoutsMicro} currency={session.currency} />
                  </td>
                  <td>
                    <code className="mono mono--muted">
                      {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {rounds.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No rounds yet.
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

function chipForStatus(status: string): string {
  switch (status) {
    case 'SETTLED':
      return 'success';
    case 'ACCEPTED':
      return 'accent';
    case 'VOIDED':
      return 'warning';
    case 'REJECTED':
    case 'FAILED':
      return 'warning';
    default:
      return 'neutral';
  }
}
