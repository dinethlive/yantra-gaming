import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRoundDetail } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money from '../ui/Money';
import PageHeader from '../ui/PageHeader';
import { determineOutcomeBrowser, verifyServerSeed } from '../utils/proof';

const MOCK = {
  round: {
    id: 'round-mock-0',
    gameCode: 'yantra',
    currency: 'LKR',
    nonce: 100,
    state: 'SETTLED',
    outcomeSum: 9,
    outcomeSide: 'LOW' as const,
    totalBetsMicro: '50000000000',
    totalPayoutsMicro: '32000000000',
    settled: true,
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    serverSeed: 'a'.repeat(64),
    serverSeedHash: 'unknown-mock-hash',
    clientSeed: 'demo-client-seed',
    diceValues: [9],
    lowWeight: 5000,
    highWeight: 5000,
  },
  bets: [],
  walletCalls: [],
};

type VerifyState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; seedMatch: boolean; outcomeMatch: boolean; computedSum: number; computedSide: string }
  | { status: 'error'; message: string };

export default function RoundDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, isStub } = useRoundDetail(id);
  const detail = data ?? (isStub ? MOCK : null);
  const [verify, setVerify] = useState<VerifyState>({ status: 'idle' });

  useEffect(() => {
    setVerify({ status: 'idle' });
  }, [id]);

  const runVerify = async () => {
    if (!detail) return;
    setVerify({ status: 'checking' });
    try {
      const r = detail.round;
      const [seedMatch, computed] = await Promise.all([
        verifyServerSeed(r.serverSeed, r.serverSeedHash),
        determineOutcomeBrowser(
          r.serverSeed,
          r.clientSeed,
          r.nonce,
          r.lowWeight,
          r.highWeight,
        ),
      ]);
      const outcomeMatch =
        computed.outcomeSum === r.outcomeSum && computed.outcomeSide === r.outcomeSide;
      setVerify({
        status: 'ok',
        seedMatch,
        outcomeMatch,
        computedSum: computed.outcomeSum,
        computedSide: computed.outcomeSide,
      });
    } catch (err) {
      setVerify({
        status: 'error',
        message: err instanceof Error ? err.message : 'Verification failed',
      });
    }
  };

  return (
    <>
      <PageHeader
        title="Round detail"
        subtitle={id}
        actions={
          <Link to="/rounds" className="btn btn--ghost">
            Back to rounds
          </Link>
        }
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}
      {loading && !detail ? <div className="table-empty">Loading round…</div> : null}

      {detail ? (
        <>
          <Card title="Outcome">
            <dl className="def-list">
              <dt>Round ID</dt>
              <dd>{detail.round.id}</dd>
              <dt>Nonce</dt>
              <dd>{detail.round.nonce}</dd>
              <dt>State</dt>
              <dd>{detail.round.state}</dd>
              <dt>Outcome</dt>
              <dd>
                {detail.round.outcomeSide} {detail.round.outcomeSum}
              </dd>
              <dt>Total bets</dt>
              <dd>
                <Money micro={detail.round.totalBetsMicro} currency={detail.round.currency} />
              </dd>
              <dt>Total payouts</dt>
              <dd>
                <Money micro={detail.round.totalPayoutsMicro} currency={detail.round.currency} />
              </dd>
            </dl>
          </Card>

          <Card
            title="Provably-fair proof"
            subtitle="Recomputed in-browser with SubtleCrypto. No server round-trip."
            actions={
              <button
                type="button"
                className="btn btn--primary"
                onClick={runVerify}
                disabled={verify.status === 'checking'}
              >
                {verify.status === 'checking' ? 'Verifying…' : 'Verify'}
              </button>
            }
          >
            <dl className="def-list">
              <dt>Server seed</dt>
              <dd>{detail.round.serverSeed}</dd>
              <dt>Server seed hash</dt>
              <dd>{detail.round.serverSeedHash}</dd>
              <dt>Client seed</dt>
              <dd>{detail.round.clientSeed}</dd>
              <dt>Weights</dt>
              <dd>
                low={detail.round.lowWeight} · high={detail.round.highWeight}
              </dd>
            </dl>
            {verify.status === 'ok' ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <div className={`chip ${verify.seedMatch ? 'chip--success' : 'chip--danger'}`}>
                  Seed hash {verify.seedMatch ? 'matches' : 'MISMATCH'}
                </div>
                <div className={`chip ${verify.outcomeMatch ? 'chip--success' : 'chip--danger'}`}>
                  Outcome {verify.outcomeMatch ? 'matches' : 'MISMATCH'} (computed{' '}
                  {verify.computedSide} {verify.computedSum})
                </div>
              </div>
            ) : null}
            {verify.status === 'error' ? <ErrorBanner message={verify.message} /> : null}
          </Card>

          <Card title={`Bets (${detail.bets.length})`}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Bet</th>
                    <th>Player</th>
                    <th>Side</th>
                    <th>Amount</th>
                    <th>Won</th>
                    <th>Status</th>
                    <th>Bet txn</th>
                    <th>Win txn</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.bets.map((b) => (
                    <tr key={b.id}>
                      <td><code className="mono">{b.id.slice(0, 8)}…</code></td>
                      <td><code className="mono">{b.playerRef}</code></td>
                      <td>
                        <span className={`chip ${b.side === 'LOW' ? 'chip--accent' : 'chip--warning'}`}>
                          {b.side}
                        </span>
                      </td>
                      <td><Money micro={b.amountMicro} currency={detail.round.currency} /></td>
                      <td><Money micro={b.wonAmountMicro} currency={detail.round.currency} /></td>
                      <td><span className="chip chip--neutral">{b.status}</span></td>
                      <td><code className="mono mono--muted">{b.betTransactionUuid.slice(0, 8)}…</code></td>
                      <td>
                        <code className="mono mono--muted">
                          {b.winTransactionUuid ? `${b.winTransactionUuid.slice(0, 8)}…` : '—'}
                        </code>
                      </td>
                    </tr>
                  ))}
                  {detail.bets.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                        No bets in this round.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={`Wallet calls (${detail.walletCalls.length})`}>
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
                    <th>Txn</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.walletCalls.map((w) => (
                    <tr key={w.id} className={w.succeeded ? undefined : 'row--failed'}>
                      <td>
                        <code className="mono mono--muted">
                          {new Date(w.createdAt).toLocaleTimeString()}
                        </code>
                      </td>
                      <td><code className="mono">{w.endpoint}</code></td>
                      <td><code className="mono">{w.direction}</code></td>
                      <td>
                        <span className={`chip ${w.succeeded ? 'chip--success' : 'chip--danger'}`}>
                          {w.responseStatus ?? w.httpStatus ?? 'PENDING'}
                        </span>
                      </td>
                      <td><code className="mono">{w.latencyMs ?? '—'}ms</code></td>
                      <td><code className="mono">{w.attempt}</code></td>
                      <td>
                        <code className="mono mono--muted">
                          {w.transactionUuid ? `${w.transactionUuid.slice(0, 8)}…` : '—'}
                        </code>
                      </td>
                    </tr>
                  ))}
                  {detail.walletCalls.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                        No wallet calls logged for this round.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}
