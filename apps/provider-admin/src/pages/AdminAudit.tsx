import { Fragment, useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';

// Admin audit trail viewer.
//
// Reads /v1/platform/admin-audit (see services/AdminAuditLog.ts).
// Scope: every write-level request hitting /v1/platform/*. Intentionally
// NOT a live stream — the log is append-only and the page queries
// on-demand plus paginates. Filters: actor email, path prefix, target id.

interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string;
  actorRole: string;
  method: string;
  path: string;
  targetType: string | null;
  targetId: string | null;
  bodySummary: unknown;
  responseStatus: number;
  latencyMs: number;
  createdAt: string;
}

interface AuditResp {
  items: AuditRow[];
  nextCursor: string | null;
}

export function AdminAudit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState({ actor: '', path: '', targetId: '' });
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function reload(nextCursor?: string | null) {
    try {
      const params = new URLSearchParams();
      if (nextCursor) params.set('cursor', nextCursor);
      if (filters.actor) params.set('actor', filters.actor);
      if (filters.path) params.set('path', filters.path);
      if (filters.targetId) params.set('targetId', filters.targetId);
      const r = await apiRequest<AuditResp>(`/v1/platform/admin-audit?${params.toString()}`);
      if (nextCursor) {
        setRows((prev) => [...prev, ...r.items]);
      } else {
        setRows(r.items);
      }
      setCursor(r.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed_to_load');
    }
  }

  useEffect(() => {
    void reload(null);
    // intentionally not reacting to filters — user clicks apply.
  }, []);

  function apply() {
    setRows([]);
    setCursor(null);
    void reload(null);
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Admin audit trail</h1>
          <p className="page__subtitle">
            Every write under <code className="mono">/v1/platform/*</code>. Request
            bodies are scrubbed of secrets (password, token, cipher, …).
          </p>
        </div>
      </header>

      <section className="card card--padded">
        <div className="form-row">
          <input
            className="input"
            placeholder="actor email"
            value={filters.actor}
            onChange={(e) => setFilters({ ...filters, actor: e.target.value })}
          />
          <input
            className="input"
            placeholder="path prefix, e.g. /v1/platform/operators"
            value={filters.path}
            onChange={(e) => setFilters({ ...filters, path: e.target.value })}
            style={{ flex: 2 }}
          />
          <input
            className="input mono"
            placeholder="target id (uuid)"
            value={filters.targetId}
            onChange={(e) => setFilters({ ...filters, targetId: e.target.value })}
          />
          <button type="button" className="btn btn--primary" onClick={apply}>
            Apply
          </button>
        </div>
      </section>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      <section className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Role</th>
              <th>Method</th>
              <th>Path</th>
              <th>Target</th>
              <th>Status</th>
              <th>ms</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty">
                  No audit entries.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr
                  className={r.responseStatus >= 400 ? 'row--warn' : undefined}
                >
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.actorEmail}</td>
                  <td>
                    <span className="chip chip--neutral">{r.actorRole}</span>
                  </td>
                  <td>
                    <code className="mono">{r.method}</code>
                  </td>
                  <td>
                    <code className="mono">{r.path}</code>
                  </td>
                  <td>
                    {r.targetType ? (
                      <>
                        <span className="chip chip--neutral">
                          {r.targetType}
                        </span>
                        <br />
                        <code className="mono" title={r.targetId ?? ''}>
                          {r.targetId?.slice(0, 12) ?? '—'}…
                        </code>
                      </>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`chip chip--${r.responseStatus < 300 ? 'active' : 'warning'}`}
                    >
                      {r.responseStatus}
                    </span>
                  </td>
                  <td className="num">{r.latencyMs}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    >
                      {expanded === r.id ? 'Hide' : 'View'}
                    </button>
                  </td>
                </tr>
                {expanded === r.id ? (
                  <tr>
                    <td colSpan={9}>
                      <pre
                        className="mono"
                        style={{ maxHeight: 220, overflow: 'auto' }}
                      >
                        {JSON.stringify(r.bodySummary ?? {}, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      {cursor ? (
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void reload(cursor)}
          >
            Load older
          </button>
        </div>
      ) : null}
    </div>
  );
}
