import { useState } from 'react';
import { ApiError, apiRequest } from '../api/client';
import { type GameConfigRow, useGameConfigs } from '../api/hooks';
import { useUIStore } from '../store/uiStore';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import Money, { microToDecimal } from '../ui/Money';
import PageHeader from '../ui/PageHeader';

const MOCK: GameConfigRow[] = [
  {
    id: 'mock-lkr',
    gameCode: 'yantra',
    currency: 'LKR',
    enabled: true,
    lowWeight: 5000,
    highWeight: 5000,
    minBetMicro: '10000000',
    maxBetMicro: '10000000000000',
    bettingWindowMs: 15000,
    rollingWindowMs: 4000,
    cooldownMs: 3000,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'mock-usd',
    gameCode: 'yantra',
    currency: 'USD',
    enabled: true,
    lowWeight: 5000,
    highWeight: 5000,
    minBetMicro: '100000',
    maxBetMicro: '10000000000',
    bettingWindowMs: 15000,
    rollingWindowMs: 4000,
    cooldownMs: 3000,
    updatedAt: new Date().toISOString(),
  },
];

interface EditForm {
  minBetMicro: string;
  maxBetMicro: string;
  bettingWindowMs: number;
  enabled: boolean;
}

export default function GameConfig() {
  const { data, loading, error, isStub, refetch } = useGameConfigs();
  const rows = data?.items ?? (isStub ? MOCK : []);
  const pushToast = useUIStore((s) => s.pushToast);
  const [editing, setEditing] = useState<GameConfigRow | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const openEdit = (row: GameConfigRow) => {
    setEditing(row);
    setForm({
      minBetMicro: microToDecimal(row.minBetMicro, 2),
      maxBetMicro: microToDecimal(row.maxBetMicro, 2),
      bettingWindowMs: row.bettingWindowMs,
      enabled: row.enabled,
    });
  };

  const closeEdit = () => {
    setEditing(null);
    setForm(null);
  };

  const save = async () => {
    if (!editing || !form) return;
    setSaving(true);
    try {
      const minBetMicro = BigInt(Math.round(Number(form.minBetMicro) * 100_000)).toString();
      const maxBetMicro = BigInt(Math.round(Number(form.maxBetMicro) * 100_000)).toString();
      await apiRequest(`/v1/admin/game-config/${editing.currency}`, {
        method: 'PATCH',
        body: {
          minBetMicro,
          maxBetMicro,
          bettingWindowMs: form.bettingWindowMs,
          enabled: form.enabled,
        },
      });
      pushToast('success', `Updated ${editing.currency} config`);
      closeEdit();
      refetch();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Save failed';
      pushToast('error', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Game config"
        subtitle="Per-currency operational settings. RTP weights are certified and read-only."
      />

      <div className="cert-lock-banner">
        RTP-affecting fields (dice weights, payout multipliers) are locked and
        require re-certification. Contact Yantra support to schedule a
        cert-bounded change.
      </div>

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Currency</th>
                <th>Enabled</th>
                <th>Min bet</th>
                <th>Max bet</th>
                <th>Low / High weight</th>
                <th>Betting window</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><code className="mono">{r.gameCode}</code></td>
                  <td><code className="mono">{r.currency}</code></td>
                  <td>
                    <span className={`chip ${r.enabled ? 'chip--success' : 'chip--neutral'}`}>
                      {r.enabled ? 'ON' : 'OFF'}
                    </span>
                  </td>
                  <td><Money micro={r.minBetMicro} currency={r.currency} /></td>
                  <td><Money micro={r.maxBetMicro} currency={r.currency} /></td>
                  <td>
                    <code className="mono">
                      {r.lowWeight} / {r.highWeight}
                    </code>
                  </td>
                  <td><code className="mono">{r.bettingWindowMs}ms</code></td>
                  <td>
                    <code className="mono mono--muted">
                      {new Date(r.updatedAt).toLocaleString()}
                    </code>
                  </td>
                  <td>
                    <button type="button" className="btn" onClick={() => openEdit(r)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No game configurations.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {editing && form ? (
        <div className="modal-backdrop" onClick={closeEdit}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit {editing.currency} config</h2>
            <div className="stack">
              <div className="field">
                <label className="field__label">Min bet ({editing.currency})</label>
                <input
                  className="input"
                  value={form.minBetMicro}
                  onChange={(e) => setForm({ ...form, minBetMicro: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label">Max bet ({editing.currency})</label>
                <input
                  className="input"
                  value={form.maxBetMicro}
                  onChange={(e) => setForm({ ...form, maxBetMicro: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="field__label">Betting window (ms)</label>
                <input
                  className="input"
                  type="number"
                  value={form.bettingWindowMs}
                  onChange={(e) =>
                    setForm({ ...form, bettingWindowMs: Number(e.target.value) })
                  }
                />
              </div>
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn--ghost" onClick={closeEdit}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={save}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
