import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';

interface OperatorRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  testMode: boolean;
  jurisdiction: string;
  defaultCurrency: string;
  createdAt: string;
  suspendedAt: string | null;
}

interface OperatorsResponse {
  operators: OperatorRow[];
}

export function Operators() {
  const [rows, setRows] = useState<OperatorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<OperatorsResponse>('/v1/platform/operators')
      .then((res) => {
        if (!cancelled) setRows(res.operators);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed_to_load');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Operators</h1>
          <p className="page__subtitle">All tenants on this RGS instance</p>
        </div>
        <div className="feed-actions">
          <Link to="/operators/new" className="btn btn--small btn--primary">+ New operator</Link>
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      <section className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Jurisdiction</th>
              <th>Currency</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((op) => (
              <tr key={op.id}>
                <td>
                  {op.name}
                  {op.testMode ? <span className="chip chip--test chip--inline">TEST</span> : null}
                </td>
                <td><code className="mono">{op.slug}</code></td>
                <td>{op.jurisdiction}</td>
                <td>{op.defaultCurrency}</td>
                <td>
                  <span className={`chip chip--${op.status.toLowerCase()}`}>{op.status}</span>
                </td>
                <td>{new Date(op.createdAt).toLocaleDateString()}</td>
                <td><Link to={`/operators/${op.id}`} className="btn btn--ghost btn--small">View</Link></td>
              </tr>
            ))}
            {rows && rows.length === 0 ? (
              <tr><td colSpan={7} className="empty">No operators.</td></tr>
            ) : null}
            {!rows && !error ? (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
