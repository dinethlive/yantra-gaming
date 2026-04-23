import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useRoundDetail } from '../api/hooks';
import { ErrorBanner, StubBanner } from './Card';
import Money from './Money';

// Lightweight preview of a round, opened from the Rounds list. The full page
// (/rounds/:id) remains the canonical view for deep-linking + the in-browser
// proof verifier. This modal is a fast glance: state, outcome, money, bet
// count, and the commit-reveal snapshot. "Open full page" links out.

interface Props {
  roundId: string | null;
  onClose: () => void;
}

export default function RoundDetailModal({ roundId, onClose }: Props) {
  const { data, loading, error, isStub } = useRoundDetail(roundId ?? undefined);

  useEffect(() => {
    if (!roundId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [roundId, onClose]);

  useEffect(() => {
    if (!roundId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [roundId]);

  if (!roundId) return null;

  const r = data?.round;
  const bets = data?.bets ?? [];
  const currency = r?.currency ?? 'LKR';

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Round ${roundId.slice(0, 8)} preview`}
      >
        <header className="modal__header">
          <div>
            <div className="modal__eyebrow">Round preview</div>
            <h2 className="modal__title">
              <code className="mono">{roundId.slice(0, 8)}…</code>
            </h2>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link to={`/rounds/${roundId}`} className="btn btn--ghost" onClick={onClose}>
              Open full page →
            </Link>
            <button
              type="button"
              className="btn btn--icon"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="modal__body">
          {loading && !data ? <div className="table-empty">Loading…</div> : null}
          {isStub ? <StubBanner /> : null}
          {error ? <ErrorBanner message={error.message} /> : null}

          {r ? (
            <>
              <div className="kpi-grid kpi-grid--compact">
                <div className="kpi">
                  <div className="kpi__label">State</div>
                  <div className="kpi__value">
                    <span
                      className={`chip ${
                        r.state === 'SETTLED' ? 'chip--success' : 'chip--neutral'
                      }`}
                    >
                      {r.state}
                    </span>
                  </div>
                  <div className="kpi__foot">Nonce {r.nonce}</div>
                </div>
                <div className="kpi">
                  <div className="kpi__label">Outcome</div>
                  <div className="kpi__value">
                    {r.outcomeSide ? (
                      <span
                        className={`chip ${
                          r.outcomeSide === 'LOW' ? 'chip--accent' : 'chip--warning'
                        }`}
                      >
                        {r.outcomeSide} · {r.outcomeSum}
                      </span>
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="kpi__foot">
                    Weights {r.lowWeight} / {r.highWeight}
                  </div>
                </div>
                <div className="kpi">
                  <div className="kpi__label">Total bets</div>
                  <div className="kpi__value">
                    <Money micro={r.totalBetsMicro} currency={currency} />
                  </div>
                  <div className="kpi__foot">{bets.length} bet(s)</div>
                </div>
                <div className="kpi">
                  <div className="kpi__label">Total payouts</div>
                  <div className="kpi__value">
                    <Money micro={r.totalPayoutsMicro} currency={currency} />
                  </div>
                  <div className="kpi__foot">
                    {r.settled ? 'Settled' : 'Pending'}
                  </div>
                </div>
              </div>

              <dl className="facts">
                <div className="facts__row">
                  <dt>Started</dt>
                  <dd>
                    <code className="mono mono--muted">
                      {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                    </code>
                  </dd>
                </div>
                <div className="facts__row">
                  <dt>Settled</dt>
                  <dd>
                    <code className="mono mono--muted">
                      {r.settledAt ? new Date(r.settledAt).toLocaleString() : '—'}
                    </code>
                  </dd>
                </div>
                <div className="facts__row">
                  <dt>Client seed</dt>
                  <dd>
                    <code className="mono mono--muted">{r.clientSeed}</code>
                  </dd>
                </div>
                <div className="facts__row">
                  <dt>Server seed hash</dt>
                  <dd>
                    <code className="mono mono--muted">{r.serverSeedHash}</code>
                  </dd>
                </div>
                <div className="facts__row">
                  <dt>Server seed</dt>
                  <dd>
                    {r.serverSeed ? (
                      <code className="mono mono--muted">{r.serverSeed}</code>
                    ) : (
                      <span className="chip chip--neutral">not yet revealed</span>
                    )}
                  </dd>
                </div>
              </dl>

              {bets.length > 0 ? (
                <div className="table-wrap" style={{ marginTop: 16 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Side</th>
                        <th>Stake</th>
                        <th>Won</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bets.slice(0, 10).map((b) => (
                        <tr key={b.id}>
                          <td>
                            <code className="mono">{b.playerRef}</code>
                          </td>
                          <td>
                            <span
                              className={`chip ${
                                b.side === 'LOW' ? 'chip--accent' : 'chip--warning'
                              }`}
                            >
                              {b.side}
                            </span>
                          </td>
                          <td>
                            <Money micro={b.amountMicro} currency={currency} />
                          </td>
                          <td>
                            {b.wonAmountMicro ? (
                              <Money micro={b.wonAmountMicro} currency={currency} />
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <code className="mono mono--muted">{b.status}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {bets.length > 10 ? (
                    <div className="table-empty">
                      + {bets.length - 10} more · open full page for all
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
