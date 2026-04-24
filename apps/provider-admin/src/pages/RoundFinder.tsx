import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';

// Round finder + full-round viewer.
//
// Two entry modes:
//   - by transactionUuid (any of bet/win/rollback UUID) — resolves to
//     a single round and opens it.
//   - by operator + playerRef — lists recent rounds for that player.
//
// Once a round is opened, we fetch the full dump (seed, wallet-call
// chain, hash chain) from /v1/platform/rounds/:roundId and display
// the provably-fair trace side-by-side with the outcome.

interface TxLookupResp {
  operator: { id: string; slug: string; name: string; jurisdiction: string };
  roundId: string;
  bet: {
    id: string;
    side: 'LOW' | 'HIGH';
    amountMicro: string;
    currency: string;
    status: string;
    won: boolean | null;
    wonAmountMicro: string | null;
    placedAt: string;
    settledAt: string | null;
    transactions: {
      bet: string;
      win: string | null;
      rollback: string | null;
    };
  };
  round: {
    state: string;
    outcomeSide: string | null;
    outcomeSum: number | null;
    rngVersion: string;
    startedAt: string | null;
    settledAt: string | null;
  };
}

interface RoundDump {
  operator: { id: string; slug: string; name: string; jurisdiction: string };
  round: {
    id: string;
    state: string;
    nonce: number;
    rngVersion: string;
    buildHash: string | null;
    gameCode: string;
    currency: string;
    diceValues: number[];
    outcomeSum: number | null;
    outcomeSide: string | null;
    serverSeed: string | null;
    serverSeedHash: string;
    clientSeed: string;
    totalBetsMicro: string;
    totalPayoutsMicro: string;
    startedAt: string | null;
    rolledAt: string | null;
    settledAt: string | null;
    voidedAt: string | null;
    prevRowHash: string | null;
    rowHash: string | null;
  };
  session: {
    id: string;
    playerRef: string;
    currency: string;
    jurisdiction: string;
    mode: string;
    rgLimits: Record<string, unknown> | null;
    createdAt: string;
    terminatedAt: string | null;
  } | null;
  bets: Array<{
    id: string;
    side: 'LOW' | 'HIGH';
    amountMicro: string;
    status: string;
    won: boolean | null;
    wonAmountMicro: string | null;
    placedAt: string;
    transactions: { bet: string; win: string | null; rollback: string | null };
  }>;
  walletCalls: Array<{
    id: string;
    direction: 'INBOUND' | 'OUTBOUND';
    endpoint: string;
    requestUuid: string;
    transactionUuid: string | null;
    referenceTransactionUuid: string | null;
    amountMicro: string | null;
    responseStatus: string | null;
    httpStatus: number | null;
    latencyMs: number | null;
    attempt: number;
    succeeded: boolean;
    requestBody: unknown;
    responseBody: unknown;
    prevRowHash: string | null;
    rowHash: string | null;
    createdAt: string;
  }>;
}

type Operator = { id: string; slug: string; name: string; jurisdiction: string };

interface PlayerRound {
  betId: string;
  roundId: string;
  side: 'LOW' | 'HIGH';
  amountMicro: string;
  currency: string;
  status: string;
  won: boolean | null;
  wonAmountMicro: string | null;
  placedAt: string;
  transactions: { bet: string; win: string | null; rollback: string | null };
  round: { state: string; outcomeSide: string | null; outcomeSum: number | null };
}

export function RoundFinder() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [tx, setTx] = useState(params.get('tx') ?? '');
  const [operatorId, setOperatorId] = useState(params.get('operatorId') ?? '');
  const [playerRef, setPlayerRef] = useState(params.get('playerRef') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [dump, setDump] = useState<RoundDump | null>(null);
  const [loadingDump, setLoadingDump] = useState(false);
  const [playerRows, setPlayerRows] = useState<PlayerRound[] | null>(null);

  useEffect(() => {
    apiRequest<{ operators: Operator[] }>('/v1/platform/operators')
      .then((r) => setOperators(r.operators))
      .catch(() => {
        /* operators list is optional — the form still works with manual ids */
      });
  }, []);

  const roundIdFromUrl = params.get('roundId');

  useEffect(() => {
    if (!roundIdFromUrl) {
      setDump(null);
      return;
    }
    let cancelled = false;
    setLoadingDump(true);
    setError(null);
    apiRequest<RoundDump>(`/v1/platform/rounds/${roundIdFromUrl}`)
      .then((r) => {
        if (cancelled) return;
        setDump(r);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed_to_load_round');
      })
      .finally(() => !cancelled && setLoadingDump(false));
    return () => {
      cancelled = true;
    };
  }, [roundIdFromUrl]);

  async function lookupByTx() {
    setError(null);
    if (!tx.trim()) return;
    try {
      const r = await apiRequest<TxLookupResp>(
        `/v1/platform/rounds/by-transaction?transactionUuid=${encodeURIComponent(tx.trim())}`,
      );
      setParams({ roundId: r.roundId, tx: tx.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'lookup_failed');
      setPlayerRows(null);
    }
  }

  async function lookupByPlayer() {
    setError(null);
    if (!operatorId || !playerRef.trim()) return;
    try {
      const r = await apiRequest<{ items: PlayerRound[] }>(
        `/v1/platform/rounds/by-player?operatorId=${operatorId}&playerRef=${encodeURIComponent(playerRef.trim())}`,
      );
      setPlayerRows(r.items);
      setParams({ operatorId, playerRef: playerRef.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'lookup_failed');
      setPlayerRows(null);
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Round finder</h1>
          <p className="page__subtitle">
            Look up a round by transaction UUID (fast disputes) or enumerate a
            player's bets (KYC / regulator requests).
          </p>
        </div>
      </header>

      <section className="card card--padded">
        <h2 className="card__title">By transaction UUID</h2>
        <p className="page__subtitle">
          Accepts a bet, win, or rollback UUID. Resolves to the exact round
          regardless of which leg the customer quotes.
        </p>
        <div className="form-row">
          <input
            className="input"
            placeholder="11111111-2222-4333-8444-555555555555"
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookupByTx()}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!tx.trim()}
            onClick={lookupByTx}
          >
            Look up
          </button>
        </div>
      </section>

      <section className="card card--padded">
        <h2 className="card__title">By operator + player ref</h2>
        <div className="form-row">
          <select
            className="input"
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
          >
            <option value="">Select operator…</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.slug})
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="player-ref"
            value={playerRef}
            onChange={(e) => setPlayerRef(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!operatorId || !playerRef.trim()}
            onClick={lookupByPlayer}
          >
            Find bets
          </button>
        </div>
      </section>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      {playerRows ? (
        <section className="card">
          <div className="card__header">
            <h2 className="card__title">Player bets · {playerRef}</h2>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Placed</th>
                <th>Side</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>Tx</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {playerRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No bets for this player.
                  </td>
                </tr>
              ) : null}
              {playerRows.map((r) => (
                <tr key={r.betId}>
                  <td>{new Date(r.placedAt).toLocaleString()}</td>
                  <td>{r.side}</td>
                  <td className="num mono">
                    {fmtMicro(r.amountMicro, r.currency)}
                  </td>
                  <td>
                    <span className="chip chip--neutral">{r.status}</span>
                  </td>
                  <td>
                    {r.won === null ? (
                      <span className="dim">pending</span>
                    ) : r.won ? (
                      <span className="chip chip--active">WIN</span>
                    ) : (
                      <span className="chip chip--neutral">loss</span>
                    )}
                  </td>
                  <td>
                    <code className="mono" title={r.transactions.bet}>
                      {r.transactions.bet.slice(0, 8)}…
                    </code>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() =>
                        navigate(`/rounds?roundId=${r.roundId}`, { replace: false })
                      }
                    >
                      Open round
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {roundIdFromUrl ? (
        loadingDump ? (
          <div className="empty">Loading round…</div>
        ) : dump ? (
          <RoundView dump={dump} />
        ) : null
      ) : null}
    </div>
  );
}

function RoundView({ dump }: { dump: RoundDump }) {
  const { round, operator, walletCalls, bets } = dump;
  const terminal = round.state === 'SETTLED' || round.state === 'VOIDED';

  const chains = useMemo(() => {
    // Group wallet calls by transactionUuid or referenceTransactionUuid to
    // render the BET → WIN / ROLLBACK lineage.
    const byTx = new Map<string, typeof walletCalls>();
    for (const c of walletCalls) {
      const key = c.referenceTransactionUuid ?? c.transactionUuid ?? c.id;
      if (!byTx.has(key)) byTx.set(key, []);
      byTx.get(key)!.push(c);
    }
    return [...byTx.values()];
  }, [walletCalls]);

  return (
    <>
      <section className="card card--padded">
        <h2 className="card__title">
          Round {round.id.slice(0, 8)}…{' '}
          <span className={`chip chip--${round.state.toLowerCase()} chip--inline`}>
            {round.state}
          </span>
        </h2>
        <dl className="meta-grid">
          <dt>Operator</dt>
          <dd>
            {operator.name} <code className="mono">{operator.slug}</code>
          </dd>
          <dt>Game / currency</dt>
          <dd>
            <code className="mono">{round.gameCode}</code> · {round.currency}
          </dd>
          <dt>Nonce (cert-protected)</dt>
          <dd>
            <code className="mono">{round.nonce}</code>
          </dd>
          <dt>RNG version</dt>
          <dd>
            <code className="mono">{round.rngVersion}</code>
          </dd>
          <dt>Build hash</dt>
          <dd>
            {round.buildHash ? (
              <code className="mono">{round.buildHash}</code>
            ) : (
              <span className="dim">unset</span>
            )}
          </dd>
          <dt>Outcome</dt>
          <dd>
            {round.outcomeSide ? (
              <>
                <span
                  className={`chip chip--${round.outcomeSide === 'LOW' ? 'suspended' : 'active'}`}
                >
                  {round.outcomeSide}
                </span>{' '}
                = <strong>{round.outcomeSum}</strong>
              </>
            ) : (
              <span className="dim">not rolled</span>
            )}
          </dd>
          <dt>Started / settled</dt>
          <dd>
            {round.startedAt ? new Date(round.startedAt).toLocaleString() : '—'} →{' '}
            {round.settledAt
              ? new Date(round.settledAt).toLocaleString()
              : round.voidedAt
                ? `VOIDED at ${new Date(round.voidedAt).toLocaleString()}`
                : '—'}
          </dd>
          <dt>Chain hash</dt>
          <dd>
            <code className="mono" title={round.rowHash ?? ''}>
              {round.rowHash?.slice(0, 16) ?? 'pending'}
              {round.rowHash ? '…' : ''}
            </code>
          </dd>
        </dl>
      </section>

      <section className="card card--padded">
        <h2 className="card__title">Provably-fair proof</h2>
        <dl className="meta-grid">
          <dt>Server seed (hash)</dt>
          <dd>
            <code className="mono">{round.serverSeedHash}</code>
          </dd>
          <dt>Server seed (revealed)</dt>
          <dd>
            {round.serverSeed ? (
              <code className="mono">{round.serverSeed}</code>
            ) : (
              <span className="dim">hidden until round is terminal</span>
            )}
          </dd>
          <dt>Client seed</dt>
          <dd>
            <code className="mono">{round.clientSeed}</code>
          </dd>
          <dt>Independent verifier</dt>
          <dd>
            {terminal && round.serverSeed ? (
              <a
                className="btn btn--small"
                href={`/pf?serverSeed=${round.serverSeed}&clientSeed=${round.clientSeed}&nonce=${round.nonce}`}
              >
                Open in proof viewer →
              </a>
            ) : (
              <span className="dim">pending</span>
            )}
          </dd>
        </dl>
      </section>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">Bets</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Placed</th>
              <th>Side</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Won</th>
              <th>Bet tx</th>
              <th>Win tx</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((b) => (
              <tr key={b.id}>
                <td>{new Date(b.placedAt).toLocaleString()}</td>
                <td>{b.side}</td>
                <td className="num mono">
                  {fmtMicro(b.amountMicro, round.currency)}
                </td>
                <td>
                  <span className="chip chip--neutral">{b.status}</span>
                </td>
                <td>
                  {b.wonAmountMicro
                    ? fmtMicro(b.wonAmountMicro, round.currency)
                    : '—'}
                </td>
                <td>
                  <code className="mono" title={b.transactions.bet}>
                    {b.transactions.bet.slice(0, 8)}…
                  </code>
                </td>
                <td>
                  {b.transactions.win ? (
                    <code className="mono" title={b.transactions.win}>
                      {b.transactions.win.slice(0, 8)}…
                    </code>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">
            Wallet-call chain
            <span className="card__title-hint">
              {' '}
              ({walletCalls.length} calls across {chains.length} lineages)
            </span>
          </h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>At</th>
              <th>Direction</th>
              <th>Endpoint</th>
              <th>Tx</th>
              <th>→ Ref</th>
              <th>Amount</th>
              <th>Status</th>
              <th>ms</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {walletCalls.map((c) => (
              <tr
                key={c.id}
                className={!c.succeeded ? 'row--warn' : undefined}
              >
                <td>{new Date(c.createdAt).toLocaleString()}</td>
                <td>
                  <span
                    className={`chip chip--${c.direction === 'INBOUND' ? 'neutral' : 'active'}`}
                  >
                    {c.direction}
                  </span>
                </td>
                <td>
                  <code className="mono">{c.endpoint}</code>
                </td>
                <td>
                  {c.transactionUuid ? (
                    <code
                      className="mono"
                      title={c.transactionUuid}
                    >
                      {c.transactionUuid.slice(0, 8)}…
                    </code>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {c.referenceTransactionUuid ? (
                    <code
                      className="mono"
                      title={c.referenceTransactionUuid}
                    >
                      {c.referenceTransactionUuid.slice(0, 8)}…
                    </code>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num mono">
                  {c.amountMicro
                    ? fmtMicro(c.amountMicro, round.currency)
                    : '—'}
                </td>
                <td>
                  <span
                    className={`chip chip--${c.succeeded ? 'active' : 'warning'}`}
                  >
                    {c.responseStatus ?? '—'}
                  </span>
                </td>
                <td className="num">{c.latencyMs ?? '—'}</td>
                <td>
                  <code className="mono" title={c.rowHash ?? ''}>
                    {c.rowHash?.slice(0, 10) ?? '—'}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function fmtMicro(s: string, currency: string): string {
  const v = BigInt(s);
  const whole = v / 100_000n;
  const frac = Number(v % 100_000n) / 100_000;
  const num = Number(whole) + frac;
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 5 })} ${currency}`;
}
