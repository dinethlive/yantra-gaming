import { type CircuitBreakerRow, type CircuitState, useCircuitBreakers, useEngines } from '../api/hooks';
import Card from './Card';

// Compact operational health panel. Shows one row per engine with its
// circuit-breaker state per wallet endpoint. Colour:
//   • CLOSED    → green "ok"
//   • HALF_OPEN → amber "probing"
//   • OPEN      → red "tripped"

const STATE_STYLE: Record<CircuitState, string> = {
  CLOSED: 'chip--success',
  HALF_OPEN: 'chip--warning',
  OPEN: 'chip--danger',
};

const STATE_LABEL: Record<CircuitState, string> = {
  CLOSED: 'ok',
  HALF_OPEN: 'probing',
  OPEN: 'tripped',
};

interface EnginePanelRow extends CircuitBreakerRow {
  phase: string;
  currentRoundId: string | null;
}

export default function CircuitBreakerPanel() {
  const breakersQ = useCircuitBreakers();
  const enginesQ = useEngines();

  const loading = breakersQ.loading || enginesQ.loading;
  const breakerItems = breakersQ.data?.items ?? [];
  const engineItems = enginesQ.data?.items ?? [];

  // Merge by key. Engines is the canonical list (breakers only exist for
  // running engines). If an engine has no breaker entries yet, show a
  // single neutral chip so the row doesn't look missing.
  const merged: EnginePanelRow[] = engineItems.map((e) => {
    const cb = breakerItems.find(
      (b) =>
        b.operatorId === e.operatorId &&
        b.gameCode === e.gameCode &&
        b.currency === e.currency,
    );
    return {
      operatorId: e.operatorId,
      gameCode: e.gameCode,
      currency: e.currency,
      breakers: cb?.breakers ?? {},
      phase: e.phase,
      currentRoundId: e.currentRoundId,
    };
  });

  return (
    <Card
      title="Engine health"
      subtitle="Game-engine phase and per-endpoint wallet circuit-breaker state. Polls every 15s."
    >
      {loading && merged.length === 0 ? (
        <div className="table-empty">Loading…</div>
      ) : merged.length === 0 ? (
        <div className="table-empty">
          No engines running. Check that an operator game config is enabled and
          MiCA-compliant.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Game · Currency</th>
                <th>Phase</th>
                <th>Current round</th>
                <th>Wallet breakers</th>
              </tr>
            </thead>
            <tbody>
              {merged.map((row) => (
                <tr key={`${row.gameCode}-${row.currency}`}>
                  <td>
                    <code className="mono">
                      {row.gameCode} · {row.currency}
                    </code>
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        row.phase === 'BETTING_OPEN'
                          ? 'chip--success'
                          : row.phase === 'ROLLING' || row.phase === 'RESULT'
                            ? 'chip--accent'
                            : 'chip--neutral'
                      }`}
                    >
                      {row.phase}
                    </span>
                  </td>
                  <td>
                    {row.currentRoundId ? (
                      <code className="mono mono--muted">
                        {row.currentRoundId.slice(0, 8)}…
                      </code>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                      {Object.keys(row.breakers).length === 0 ? (
                        <span className="chip chip--neutral">no traffic yet</span>
                      ) : (
                        Object.entries(row.breakers).map(([key, b]) => {
                          const endpoint = key.split(':').pop() ?? key;
                          return (
                            <span
                              key={key}
                              className={`chip ${STATE_STYLE[b.state]}`}
                              title={`failures: ${b.consecutiveFailures}${
                                b.openedAt > 0
                                  ? `, opened at ${new Date(b.openedAt).toLocaleTimeString()}`
                                  : ''
                              }`}
                            >
                              {endpoint} · {STATE_LABEL[b.state]}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
