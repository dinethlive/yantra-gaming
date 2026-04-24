import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';

interface OperatorMeta {
  id: string;
  slug: string;
  name: string;
  status: string;
  testMode: boolean;
  environment?: 'SANDBOX' | 'PRODUCTION';
  siblingOperatorId?: string | null;
  jurisdiction: string;
  defaultCurrency: string;
  allowedCurrencies?: string[];
  walletCallbackUrl: string;
  ipAllowList: string[];
  allowedCountries: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  suspendedReason?: string | null;
  suspendedBy?: string | null;
}

interface DetailResponse {
  operator: OperatorMeta;
  stats: {
    currency: string;
    activeSessions: number;
    bets: { count: number; volumeMicro: string };
    wins: { count: number; volumeMicro: string };
    ggrMicro: string;
  };
  credentials: Array<{
    id: string;
    kid: string;
    type: string;
    label: string | null;
    notBefore: string;
    notAfter: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>;
  users: Array<{
    id: string;
    email: string;
    role: string;
    displayName: string;
    lastLoginAt: string | null;
    createdAt: string;
  }>;
  gameConfigs: Array<{
    id: string;
    gameCode: string;
    currency: string;
    enabled: boolean;
    lowWeight: number;
    highWeight: number;
    minBetMicro: string;
    maxBetMicro: string;
    commissionMicro: string;
    bettingWindowMs: number;
    rollingWindowMs: number;
    cooldownMs: number;
    killSwitch: boolean;
    killSwitchReason: string | null;
    killSwitchedAt: string | null;
    killSwitchedBy: string | null;
    pinnedVersion: string | null;
  }>;
}

function fmtMicro(s: string, currency: string): string {
  const v = BigInt(s);
  const whole = Number(v / 100_000n);
  const frac = Number(v % 100_000n) / 100_000;
  return `${(whole + frac).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
}

function credentialStatus(c: DetailResponse['credentials'][number]): string {
  if (c.revokedAt) return 'revoked';
  if (c.notAfter && new Date(c.notAfter) < new Date()) return 'expired';
  if (new Date(c.notBefore) > new Date()) return 'pending';
  return 'active';
}

export function OperatorDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    apiRequest<DetailResponse>(`/v1/platform/operators/${id}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed_to_load');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function toggleTestMode() {
    if (!data || !id) return;
    const next = !data.operator.testMode;
    setSaving(true);
    try {
      await apiRequest<{ operator: { testMode: boolean } }>(
        `/v1/platform/operators/${id}/test-mode`,
        { method: 'POST', body: { testMode: next } },
      );
      setData({ ...data, operator: { ...data.operator, testMode: next } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed_to_toggle');
    } finally {
      setSaving(false);
    }
  }

  async function suspendOperator() {
    if (!data || !id) return;
    const reason = window.prompt(
      `Suspend ${data.operator.name}?\n\nBlocks NEW sessions. In-flight wallet calls continue so settlement completes.\n\nReason (shown in audit log):`,
    );
    if (reason === null) return;
    try {
      const res = await apiRequest<{ operator: OperatorMeta }>(
        `/v1/platform/operators/${id}/suspend`,
        { method: 'POST', body: { reason: reason.trim() || 'no_reason_given' } },
      );
      setData({ ...data, operator: { ...data.operator, ...res.operator } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'suspend_failed');
    }
  }

  async function reactivateOperator() {
    if (!data || !id) return;
    if (!window.confirm(`Re-activate ${data.operator.name}? Session launches resume immediately.`)) return;
    try {
      const res = await apiRequest<{ operator: { status: string } }>(
        `/v1/platform/operators/${id}/reactivate`,
        { method: 'POST' },
      );
      setData({
        ...data,
        operator: {
          ...data.operator,
          status: res.operator.status,
          suspendedAt: null,
          suspendedReason: null,
          suspendedBy: null,
        },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'reactivate_failed');
    }
  }

  async function toggleKillSwitch(configId: string, nextEnabled: boolean, current: DetailResponse['gameConfigs'][number]) {
    if (!data) return;
    let reason: string | null = current.killSwitchReason ?? null;
    if (nextEnabled) {
      const input = window.prompt(
        `Kill-switch: block NEW ${current.gameCode} (${current.currency}) sessions.\nIn-flight sessions will finish.\n\nReason (shown in audit log):`,
        reason ?? '',
      );
      if (input === null) return; // cancelled
      reason = input.trim() || 'no_reason_given';
    } else {
      if (!window.confirm(`Re-enable ${current.gameCode} (${current.currency}) sessions?`)) return;
      reason = null;
    }
    try {
      const res = await apiRequest<{ gameConfig: {
        killSwitch: boolean;
        killSwitchReason: string | null;
        killSwitchedAt: string | null;
        killSwitchedBy: string | null;
      } }>(`/v1/platform/game-configs/${configId}/kill-switch`, {
        method: 'POST',
        body: { enabled: nextEnabled, reason },
      });
      setData({
        ...data,
        gameConfigs: data.gameConfigs.map((g) =>
          g.id === configId ? { ...g, ...res.gameConfig } : g,
        ),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'kill_switch_failed');
    }
  }

  async function saveAllowedCountries(countries: string[]) {
    if (!data || !id) return;
    try {
      const res = await apiRequest<{ operator: { allowedCountries: string[] } }>(
        `/v1/platform/operators/${id}/allowed-countries`,
        { method: 'POST', body: { countries } },
      );
      setData({ ...data, operator: { ...data.operator, allowedCountries: res.operator.allowedCountries } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed_to_save_countries');
      throw err;
    }
  }

  if (error) {
    return (
      <div className="page">
        <Link to="/operators" className="btn btn--ghost btn--small">&larr; Back</Link>
        <div className="banner banner--danger">{error}</div>
      </div>
    );
  }
  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const { operator, stats, credentials, users, gameConfigs } = data;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <Link to="/operators" className="breadcrumb">&larr; Operators</Link>
          <h1 className="page__title">
            {operator.name}
            <span className={`chip chip--${operator.status === 'PAUSED' ? 'suspended' : operator.status.toLowerCase()} chip--inline`}>
              {operator.status}
            </span>
            {operator.testMode ? <span className="chip chip--test chip--inline">TEST</span> : null}
          </h1>
          <p className="page__subtitle">
            <code className="mono">{operator.slug}</code> · {operator.jurisdiction} ·{' '}
            {operator.defaultCurrency}
          </p>
        </div>
        <div className="feed-actions">
          {operator.status === 'PAUSED' ? (
            <button
              type="button"
              className="btn btn--small btn--primary"
              onClick={reactivateOperator}
              title="Re-activate this operator — session launches resume"
            >
              Re-activate
            </button>
          ) : operator.status === 'ACTIVE' ? (
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={suspendOperator}
              title="Block new session launches. In-flight calls continue so settlement completes."
            >
              Suspend
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--small"
            onClick={toggleTestMode}
            disabled={saving}
            title={
              operator.testMode
                ? 'Promote this operator — will appear in production reports'
                : 'Demote this operator to test — excluded from production reports and billing'
            }
          >
            {saving ? 'Saving…' : operator.testMode ? 'Promote to production' : 'Mark as test'}
          </button>
        </div>
      </header>

      {operator.status === 'PAUSED' ? (
        <div className="banner banner--warning">
          <strong>Suspended</strong>
          {operator.suspendedAt ? ` at ${new Date(operator.suspendedAt).toLocaleString()}` : null}
          {operator.suspendedBy ? ` by ${operator.suspendedBy}` : null}
          {operator.suspendedReason ? ` — ${operator.suspendedReason}` : null}
          . New session launches rejected with <code className="mono">403 operator_not_active</code>.
          In-flight wallet calls continue so held bets can settle.
        </div>
      ) : null}

      <section className="kpi-row">
        <Kpi label="Active sessions" value={String(stats.activeSessions)} />
        <Kpi label="Bets (24h)" value={String(stats.bets.count)} />
        <Kpi label="Bet volume" value={fmtMicro(stats.bets.volumeMicro, stats.currency)} mono />
        <Kpi label="Wins (24h)" value={String(stats.wins.count)} />
        <Kpi label="Win volume" value={fmtMicro(stats.wins.volumeMicro, stats.currency)} mono />
        <Kpi label="GGR (24h)" value={fmtMicro(stats.ggrMicro, stats.currency)} mono />
      </section>

      <AllowedCountriesEditor
        value={operator.allowedCountries}
        onSave={saveAllowedCountries}
      />

      <section className="card card--padded">
        <h2 className="card__title">Metadata</h2>
        <dl className="meta-grid">
          <dt>Environment</dt>
          <dd>
            <span
              className={`chip chip--${operator.environment === 'SANDBOX' ? 'neutral' : 'active'}`}
            >
              {operator.environment ?? 'PRODUCTION'}
            </span>
            {operator.siblingOperatorId ? (
              <Link
                to={`/operators/${operator.siblingOperatorId}`}
                className="btn btn--small"
                style={{ marginLeft: 8 }}
              >
                Open sibling →
              </Link>
            ) : null}
          </dd>
          <dt>Wallet callback</dt>
          <dd><code className="mono">{operator.walletCallbackUrl}</code></dd>
          <dt>Allowed currencies</dt>
          <dd>
            {operator.allowedCurrencies && operator.allowedCurrencies.length > 0
              ? operator.allowedCurrencies.map((c) => (
                  <code key={c} className="mono chip--tag">{c}</code>
                ))
              : <span className="dim">default only ({operator.defaultCurrency})</span>}
          </dd>
          <dt>Created</dt>
          <dd>{new Date(operator.createdAt).toLocaleString()}</dd>
          <dt>Updated</dt>
          <dd>{new Date(operator.updatedAt).toLocaleString()}</dd>
          {operator.suspendedAt ? (
            <>
              <dt>Suspended at</dt>
              <dd>{new Date(operator.suspendedAt).toLocaleString()}</dd>
            </>
          ) : null}
          {operator.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{operator.notes}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <IpAllowListEditor
        operatorId={operator.id}
        value={operator.ipAllowList}
        onSaved={(next) => setData({ ...data, operator: { ...operator, ipAllowList: next } })}
      />

      <CredentialsPanel
        operatorId={operator.id}
        credentials={credentials}
        onRefresh={() =>
          apiRequest<DetailResponse>(`/v1/platform/operators/${operator.id}`).then(setData)
        }
      />

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">Portal users</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Display</th>
              <th>Role</th>
              <th>Last login</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.length ? users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.displayName}</td>
                <td><span className="chip chip--neutral">{u.role}</span></td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : <span className="dim">never</span>}</td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
              </tr>
            )) : (
              <tr><td colSpan={5} className="empty">No users.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <ConfigAuditPanel operatorId={operator.id} />

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">Game configs</h2>
        </div>
        {gameConfigs.length ? gameConfigs.map((g) => (
          <GameConfigEditor
            key={g.id}
            config={g}
            onKill={() => toggleKillSwitch(g.id, true, g)}
            onUnkill={() => toggleKillSwitch(g.id, false, g)}
            onSaved={(updated) =>
              setData({
                ...data,
                gameConfigs: data.gameConfigs.map((x) =>
                  x.id === updated.id ? { ...x, ...updated } : x,
                ),
              })
            }
          />
        )) : (
          <div className="empty">No game configs.</div>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className={mono ? 'kpi__value mono' : 'kpi__value'}>{value}</div>
    </div>
  );
}

interface ConfigAuditRow {
  id: string;
  operatorId: string;
  gameCode: string;
  field: string;
  oldValue: string | null;
  newValue: string;
  changedBy: string;
  changedAt: string;
}

function ConfigAuditPanel({ operatorId }: { operatorId: string }) {
  const [rows, setRows] = useState<ConfigAuditRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ items: ConfigAuditRow[] }>(
      `/v1/platform/config-audit?operatorId=${operatorId}&limit=50`,
    )
      .then((r) => {
        if (!cancelled) setRows(r.items);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, [operatorId]);

  function safeParse(v: string | null | undefined): Record<string, unknown> | string | null {
    if (v == null || v === '') return null;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  function renderDiff(row: ConfigAuditRow) {
    const before = safeParse(row.oldValue);
    const after = safeParse(row.newValue);
    // If both parsed to objects, render a key-by-key side-by-side table.
    if (
      before &&
      after &&
      typeof before === 'object' &&
      typeof after === 'object' &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      const keys = Array.from(
        new Set([
          ...Object.keys(before as Record<string, unknown>),
          ...Object.keys(after as Record<string, unknown>),
        ]),
      ).sort();
      return (
        <table className="data-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const b = (before as Record<string, unknown>)[k];
              const a = (after as Record<string, unknown>)[k];
              const changed = JSON.stringify(b) !== JSON.stringify(a);
              return (
                <tr key={k} className={changed ? 'row--warn' : undefined}>
                  <td>
                    <code className="mono">{k}</code>
                  </td>
                  <td>
                    <code className="mono">{b === undefined ? '—' : JSON.stringify(b)}</code>
                  </td>
                  <td>
                    <code className="mono">{a === undefined ? '—' : JSON.stringify(a)}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    }
    return (
      <pre className="mono" style={{ maxHeight: 220, overflow: 'auto' }}>
        {`- ${row.oldValue ?? '(null)'}\n+ ${row.newValue}`}
      </pre>
    );
  }

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">Config change history</h2>
      </div>
      {err ? <div className="banner banner--danger">{err}</div> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Field</th>
            <th>Game</th>
            <th>Changed by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows?.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                No config changes recorded.
              </td>
            </tr>
          ) : null}
          {rows?.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{new Date(r.changedAt).toLocaleString()}</td>
                <td>
                  <code className="mono">{r.field}</code>
                </td>
                <td>
                  <code className="mono">{r.gameCode}</code>
                </td>
                <td>
                  <code className="mono" title={r.changedBy}>
                    {r.changedBy.slice(0, 8)}…
                  </code>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  >
                    {expanded === r.id ? 'Hide diff' : 'Diff'}
                  </button>
                </td>
              </tr>
              {expanded === r.id ? (
                <tr>
                  <td colSpan={5}>{renderDiff(r)}</td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {!rows && !err ? (
            <tr>
              <td colSpan={5} className="empty">
                Loading…
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

type GameConfig = DetailResponse['gameConfigs'][number];

interface GCEProps {
  config: GameConfig;
  onKill(): void;
  onUnkill(): void;
  onSaved(next: GameConfig): void;
}
function GameConfigEditor({ config, onKill, onUnkill, onSaved }: GCEProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    lowWeight: config.lowWeight,
    highWeight: config.highWeight,
    minBetMicro: config.minBetMicro,
    maxBetMicro: config.maxBetMicro,
    commissionMicro: config.commissionMicro,
    bettingWindowMs: config.bettingWindowMs,
    rollingWindowMs: config.rollingWindowMs,
    cooldownMs: config.cooldownMs,
    enabled: config.enabled,
    pinnedVersion: config.pinnedVersion ?? '',
  });

  function patch(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (form.lowWeight !== config.lowWeight) out.lowWeight = form.lowWeight;
    if (form.highWeight !== config.highWeight) out.highWeight = form.highWeight;
    if (form.minBetMicro !== config.minBetMicro) out.minBetMicro = form.minBetMicro;
    if (form.maxBetMicro !== config.maxBetMicro) out.maxBetMicro = form.maxBetMicro;
    if (form.commissionMicro !== config.commissionMicro) out.commissionMicro = form.commissionMicro;
    if (form.bettingWindowMs !== config.bettingWindowMs) out.bettingWindowMs = form.bettingWindowMs;
    if (form.rollingWindowMs !== config.rollingWindowMs) out.rollingWindowMs = form.rollingWindowMs;
    if (form.cooldownMs !== config.cooldownMs) out.cooldownMs = form.cooldownMs;
    if (form.enabled !== config.enabled) out.enabled = form.enabled;
    const pinned = form.pinnedVersion.trim() || null;
    if (pinned !== (config.pinnedVersion ?? null)) out.pinnedVersion = pinned;
    return out;
  }

  async function save() {
    const body = patch();
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiRequest<{ gameConfig: GameConfig }>(
        `/v1/platform/game-configs/${config.id}`,
        { method: 'PATCH', body },
      );
      onSaved(res.gameConfig);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  const rtpPct = useMemo(() => {
    // Straight 2× payout, commission deducted from gross.
    // House edge = 1 − (2 − c) × P(win). P(win) = weight[side] / total.
    const total = form.lowWeight + form.highWeight;
    const minWinProb = Math.min(form.lowWeight, form.highWeight) / total;
    const maxWinProb = Math.max(form.lowWeight, form.highWeight) / total;
    const avgWinProb = (form.lowWeight + form.highWeight) / (2 * total); // always 0.5
    const commissionRatio = (() => {
      try {
        const c = BigInt(form.commissionMicro);
        const b = BigInt(form.minBetMicro);
        if (b === 0n) return 0;
        return Number(c) / Number(b * 2n);
      } catch {
        return 0;
      }
    })();
    const rtp = (2 - commissionRatio * 2) * avgWinProb;
    return { rtp, minWinProb, maxWinProb };
  }, [form]);

  return (
    <div className={`card__nested${config.killSwitch ? ' row--incident' : ''}`}>
      <div className="card__header">
        <h3 className="card__title">
          <code className="mono">{config.gameCode}</code> · {config.currency}
          {config.killSwitch ? (
            <span
              className="chip chip--terminated chip--inline"
              title={`Killed by ${config.killSwitchedBy ?? '?'} · ${config.killSwitchReason ?? ''}`}
            >
              KILL-SWITCH ON
            </span>
          ) : (
            <span
              className={`chip chip--${config.enabled ? 'active' : 'neutral'} chip--inline`}
            >
              {config.enabled ? 'enabled' : 'disabled'}
            </span>
          )}
        </h3>
        <div className="feed-actions">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Edit'}
          </button>
          {config.killSwitch ? (
            <button type="button" className="btn btn--small" onClick={onUnkill}>
              Re-enable
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              onClick={onKill}
            >
              Kill-switch
            </button>
          )}
        </div>
      </div>
      <dl className="meta-grid">
        <dt>Weights</dt>
        <dd>
          LOW {config.lowWeight} / HIGH {config.highWeight} ·{' '}
          <em>theoretical RTP ≈ {(rtpPct.rtp * 100).toFixed(3)}%</em>
        </dd>
        <dt>Bet limits</dt>
        <dd>
          min {fmtMicro(config.minBetMicro, config.currency)} · max{' '}
          {fmtMicro(config.maxBetMicro, config.currency)}
        </dd>
        <dt>Commission</dt>
        <dd>{fmtMicro(config.commissionMicro, config.currency)}</dd>
        <dt>Windows (ms)</dt>
        <dd>
          bet {config.bettingWindowMs} · roll {config.rollingWindowMs} · cooldown{' '}
          {config.cooldownMs}
        </dd>
        {config.pinnedVersion ? (
          <>
            <dt>Pinned version</dt>
            <dd>
              <code className="mono">{config.pinnedVersion}</code>
            </dd>
          </>
        ) : null}
      </dl>

      {open ? (
        <div className="form-grid">
          <NumField label="Low weight" value={form.lowWeight} onChange={(v) => setForm({ ...form, lowWeight: v })} />
          <NumField label="High weight" value={form.highWeight} onChange={(v) => setForm({ ...form, highWeight: v })} />
          <TextField label="Min bet (micro)" value={form.minBetMicro} onChange={(v) => setForm({ ...form, minBetMicro: v })} />
          <TextField label="Max bet (micro)" value={form.maxBetMicro} onChange={(v) => setForm({ ...form, maxBetMicro: v })} />
          <TextField label="Commission (micro)" value={form.commissionMicro} onChange={(v) => setForm({ ...form, commissionMicro: v })} />
          <NumField label="Betting window ms" value={form.bettingWindowMs} onChange={(v) => setForm({ ...form, bettingWindowMs: v })} />
          <NumField label="Rolling window ms" value={form.rollingWindowMs} onChange={(v) => setForm({ ...form, rollingWindowMs: v })} />
          <NumField label="Cooldown ms" value={form.cooldownMs} onChange={(v) => setForm({ ...form, cooldownMs: v })} />
          <TextField
            label="Pinned version"
            value={form.pinnedVersion}
            onChange={(v) => setForm({ ...form, pinnedVersion: v })}
          />
          <label className="field">
            <span>Enabled</span>
            <select
              className="input"
              value={form.enabled ? 'true' : 'false'}
              onChange={(e) => setForm({ ...form, enabled: e.target.value === 'true' })}
            >
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </label>
          {error ? <div className="banner banner--danger">{error}</div> : null}
          <div className="form-actions" style={{ gridColumn: '1 / -1' }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving || Object.keys(patch()).length === 0}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        className="input"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

interface IpProps {
  operatorId: string;
  value: string[];
  onSaved(next: string[]): void;
}
function IpAllowListEditor({ operatorId, value, onSaved }: IpProps) {
  const [draft, setDraft] = useState(value.join('\n'));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value.join('\n'));
  }, [value]);

  async function save() {
    const ipAllowList = draft
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    setErr(null);
    try {
      const res = await apiRequest<{ ipAllowList: string[] }>(
        `/v1/platform/operators/${operatorId}/ip-allow-list`,
        { method: 'POST', body: { ipAllowList } },
      );
      onSaved(res.ipAllowList);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card card--padded">
      <h2 className="card__title">
        IP allow-list{' '}
        <span className="card__title-hint">
          ({value.length === 0 ? 'none — open' : `${value.length} entries`})
        </span>
      </h2>
      <p className="page__subtitle">
        Enforced on every inbound HMAC-signed request. Comma or newline-separated. IPv4, IPv6, or CIDR.
      </p>
      <label className="field">
        <textarea
          className="country-editor"
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="203.0.113.42&#10;198.51.100.0/24"
        />
      </label>
      {err ? <div className="banner banner--danger">{err}</div> : null}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={save}
          disabled={saving || draft === value.join('\n')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

interface CredentialsProps {
  operatorId: string;
  credentials: DetailResponse['credentials'];
  onRefresh(): Promise<unknown>;
}
function CredentialsPanel({ operatorId, credentials, onRefresh }: CredentialsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<
    | { kid: string; secret: string; algorithm: string; type: string }
    | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  async function rotate(type: 'API_KEY_INBOUND' | 'WALLET_HMAC_OUTBOUND') {
    if (
      !window.confirm(
        `Rotate ${type}? A new secret will be minted and shown ONCE. The old secret stays valid for 1 hour to allow zero-downtime cut-over.`,
      )
    )
      return;
    setBusy(type);
    setErr(null);
    try {
      const r = await apiRequest<{
        kid: string;
        secret: string;
        algorithm: string;
        previousKid: string | null;
      }>(`/v1/platform/operators/${operatorId}/credentials:rotate`, {
        method: 'POST',
        body: { type },
      });
      setReveal({ kid: r.kid, secret: r.secret, algorithm: r.algorithm, type });
      await onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'rotate_failed');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(credId: string, kid: string) {
    if (
      !window.confirm(
        `Revoke ${kid} IMMEDIATELY? No grace — in-flight requests will 401 immediately. Use only for compromised keys.`,
      )
    )
      return;
    setBusy(credId);
    setErr(null);
    try {
      await apiRequest(`/v1/platform/credentials/${credId}/revoke`, { method: 'POST' });
      await onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'revoke_failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">Credentials</h2>
        <div className="feed-actions">
          <button
            type="button"
            className="btn btn--small"
            disabled={busy !== null}
            onClick={() => rotate('API_KEY_INBOUND')}
          >
            Rotate inbound API key
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy !== null}
            onClick={() => rotate('WALLET_HMAC_OUTBOUND')}
          >
            Rotate outbound HMAC secret
          </button>
        </div>
      </div>

      {err ? <div className="banner banner--danger">{err}</div> : null}
      {reveal ? (
        <div className="banner banner--warning">
          <strong>New {reveal.type} secret</strong>
          <div>
            KID: <code className="mono">{reveal.kid}</code>
          </div>
          <div>
            Algorithm: <code className="mono">{reveal.algorithm}</code>
          </div>
          <div>
            Secret:{' '}
            <code className="mono" style={{ wordBreak: 'break-all' }}>
              {reveal.secret}
            </code>
          </div>
          <div>
            <em>
              SAVE THIS NOW. It will never be shown again. Use{' '}
              <kbd>Cmd/Ctrl</kbd>+<kbd>C</kbd> to copy.
            </em>
          </div>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setReveal(null)}
          >
            I've saved it
          </button>
        </div>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th>KID</th>
            <th>Type</th>
            <th>Label</th>
            <th>Status</th>
            <th>Valid from</th>
            <th>Valid until</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {credentials.length ? (
            credentials.map((c) => (
              <tr key={c.id}>
                <td>
                  <code className="mono">{c.kid}</code>
                </td>
                <td>{c.type}</td>
                <td>{c.label ?? <span className="dim">—</span>}</td>
                <td>
                  <span className={`chip chip--${credentialStatus(c)}`}>
                    {credentialStatus(c)}
                  </span>
                </td>
                <td>{new Date(c.notBefore).toLocaleDateString()}</td>
                <td>
                  {c.notAfter ? (
                    new Date(c.notAfter).toLocaleDateString()
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  {!c.revokedAt ? (
                    <button
                      type="button"
                      className="btn btn--small btn--danger-ghost"
                      disabled={busy !== null}
                      onClick={() => revoke(c.id, c.kid)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="dim">revoked</span>
                  )}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={7} className="empty">
                No credentials.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

interface ACEProps {
  value: string[];
  onSave(countries: string[]): Promise<void>;
}
function AllowedCountriesEditor({ value, onSave }: ACEProps) {
  const [draft, setDraft] = useState(value.join(', '));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value.join(', '));
  }, [value]);

  function parse(s: string): { ok: string[]; bad: string[] } {
    const ok: string[] = [];
    const bad: string[] = [];
    for (const raw of s.split(/[,\n\s]+/).map((t) => t.trim()).filter(Boolean)) {
      const up = raw.toUpperCase();
      if (/^[A-Z]{2}$/.test(up)) {
        if (!ok.includes(up)) ok.push(up);
      } else bad.push(raw);
    }
    return { ok, bad };
  }

  async function save() {
    const { ok, bad } = parse(draft);
    if (bad.length > 0) {
      setErr(`Invalid codes: ${bad.join(', ')}. Use ISO 3166-1 alpha-2 (e.g. LK, IN, MY).`);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(ok);
    } catch {
      // parent sets error; local state stays as-is so user can retry
    } finally {
      setSaving(false);
    }
  }

  function clear() {
    setDraft('');
  }

  const { ok: previewTags } = parse(draft);
  const unchanged = previewTags.join(',') === value.join(',');

  return (
    <section className="card card--padded">
      <h2 className="card__title">
        Allowed countries
        <span className="card__title-hint">
          ({value.length === 0 ? 'no restriction' : `${value.length} allow-listed`})
        </span>
      </h2>
      <p className="page__subtitle">
        Session launch is rejected when the player's country is set and not in this list.
        Leave empty to disable the check. ISO 3166-1 alpha-2 codes, comma or space separated.
      </p>
      <label className="field">
        <textarea
          className="country-editor"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="LK, IN, MY, SG"
        />
      </label>
      {previewTags.length > 0 ? (
        <div className="tag-row">
          {previewTags.map((t) => <code key={t} className="mono chip--tag">{t}</code>)}
        </div>
      ) : null}
      {err ? <div className="banner banner--danger">{err}</div> : null}
      <div className="form-actions">
        <button type="button" className="btn btn--small" onClick={clear} disabled={saving || draft === ''}>
          Clear all
        </button>
        <button type="button" className="btn btn--small btn--primary" onClick={save} disabled={saving || unchanged}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
