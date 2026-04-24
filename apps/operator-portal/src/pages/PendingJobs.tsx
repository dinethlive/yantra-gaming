import { useCallback, useState } from 'react';
import { apiRequest } from '../api/client';
import { type PendingJobRow, usePendingJobs } from '../api/hooks';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import PageHeader from '../ui/PageHeader';
import { useUIStore } from '../store/uiStore';

// Operational view of the durable retry queue. A row exists per failed
// wallet call (usually WIN or ROLLBACK) that the PendingJobRunner is
// backing off on. Operators can force an immediate retry or cancel a job
// that has been manually reconciled off-platform.

const MOCK: PendingJobRow[] = [
  {
    id: 'job-mock-1',
    endpoint: 'WIN',
    betId: 'bet-mock-1',
    roundId: 'round-mock-1',
    attempts: 3,
    nextAttemptAt: new Date(Date.now() + 16_000).toISOString(),
    lockedUntil: null,
    lastError: 'RS_ERROR_UNKNOWN',
    completedAt: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    id: 'job-mock-2',
    endpoint: 'ROLLBACK',
    betId: 'bet-mock-2',
    roundId: 'round-mock-2',
    attempts: 1,
    nextAttemptAt: new Date(Date.now() + 4_000).toISOString(),
    lockedUntil: null,
    lastError: 'timeout',
    completedAt: null,
    createdAt: new Date(Date.now() - 30_000).toISOString(),
  },
];

export default function PendingJobs() {
  const [endpoint, setEndpoint] = useState<string>('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pushToast = useUIStore((s) => s.pushToast);
  const { data, loading, error, isStub, refetch } = usePendingJobs({
    endpoint: endpoint || undefined,
    includeCompleted: includeCompleted ? 'true' : undefined,
    cursor,
  });

  const rows = data?.items ?? (isStub ? MOCK : []);

  const retry = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await apiRequest(`/v1/admin/jobs/${id}/retry`, { method: 'POST' });
        pushToast('success', `Retry queued for job ${id.slice(0, 8)}…`);
        refetch();
      } catch (err) {
        pushToast('error', `Retry failed: ${(err as Error).message}`);
      } finally {
        setBusyId(null);
      }
    },
    [pushToast, refetch],
  );

  const cancel = useCallback(
    async (id: string) => {
      const reason = prompt(
        'Cancellation reason (required, shown in audit log):',
        'Manually reconciled off-platform.',
      );
      if (!reason) return;
      setBusyId(id);
      try {
        await apiRequest(`/v1/admin/jobs/${id}/cancel`, {
          method: 'POST',
          body: { reason },
        });
        pushToast('success', `Job ${id.slice(0, 8)}… cancelled`);
        refetch();
      } catch (err) {
        pushToast('error', `Cancel failed: ${(err as Error).message}`);
      } finally {
        setBusyId(null);
      }
    },
    [pushToast, refetch],
  );

  return (
    <>
      <PageHeader
        title="Pending wallet jobs"
        subtitle="Durable retry queue for failed wallet calls. Polls every 10s."
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <div className="filter-bar">
        <div className="field">
          <label className="field__label">Endpoint</label>
          <select
            className="select"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          >
            <option value="">Any</option>
            <option value="WIN">WIN</option>
            <option value="ROLLBACK">ROLLBACK</option>
            <option value="BET">BET</option>
            <option value="BALANCE">BALANCE</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label">Status</label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
            />
            <span>Include completed / cancelled</span>
          </label>
        </div>
        <div className="field field--grow" />
        <button type="button" className="btn" onClick={() => refetch()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Endpoint</th>
                <th>Round</th>
                <th>Attempts</th>
                <th>Next retry</th>
                <th>Last error</th>
                <th>Age</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => {
                const isCompleted = j.completedAt !== null;
                const isLocked = j.lockedUntil && new Date(j.lockedUntil) > new Date();
                return (
                  <tr key={j.id}>
                    <td>
                      <code className="mono">{j.id.slice(0, 8)}…</code>
                    </td>
                    <td>
                      <span
                        className={`chip ${
                          j.endpoint === 'WIN'
                            ? 'chip--success'
                            : j.endpoint === 'ROLLBACK'
                              ? 'chip--warning'
                              : 'chip--neutral'
                        }`}
                      >
                        {j.endpoint}
                      </span>
                    </td>
                    <td>
                      {j.roundId ? (
                        <code className="mono mono--muted">{j.roundId.slice(0, 8)}…</code>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <code className="mono">{j.attempts}</code>
                    </td>
                    <td>
                      <code className="mono mono--muted">
                        {new Date(j.nextAttemptAt).toLocaleTimeString()}
                      </code>
                    </td>
                    <td title={j.lastError ?? undefined}>
                      <span
                        className="text-truncate"
                        style={{ maxWidth: 240, display: 'inline-block' }}
                      >
                        {j.lastError ?? '—'}
                      </span>
                    </td>
                    <td>
                      <code className="mono mono--muted">{ageOf(j.createdAt)}</code>
                    </td>
                    <td>
                      {isCompleted ? (
                        <span className="chip chip--success">done</span>
                      ) : isLocked ? (
                        <span className="chip chip--warning">locked</span>
                      ) : (
                        <span className="chip chip--neutral">pending</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!isCompleted && (
                        <>
                          <button
                            type="button"
                            className="btn btn--small"
                            disabled={busyId === j.id}
                            onClick={() => retry(j.id)}
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            className="btn btn--small btn--ghost"
                            disabled={busyId === j.id}
                            onClick={() => cancel(j.id)}
                            style={{ marginLeft: 6 }}
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No pending jobs.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn"
          disabled={!cursor}
          onClick={() => setCursor(undefined)}
        >
          First page
        </button>
        <button
          type="button"
          className="btn"
          disabled={!data?.nextCursor}
          onClick={() => data?.nextCursor && setCursor(data.nextCursor)}
        >
          Next page
        </button>
      </div>
    </>
  );
}

function ageOf(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
