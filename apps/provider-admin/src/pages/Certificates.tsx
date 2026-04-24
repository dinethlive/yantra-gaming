import { useEffect, useMemo, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';

type CertStatus = 'valid' | 'expiring' | 'expired' | 'revoked';
type Coverage = 'covered' | 'expiring' | 'expired' | 'missing';

interface CertRow {
  id: string;
  gameCode: string;
  jurisdiction: string;
  lab: string;
  certId: string;
  buildHash: string;
  version: string | null;
  issuedAt: string;
  validFrom: string;
  expiresAt: string;
  filePath: string | null;
  notes: string | null;
  revokedAt: string | null;
  status: CertStatus;
  daysToExpiry: number;
}

interface CoverageRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  testMode: boolean;
  jurisdiction: string;
  coverage: Coverage;
  games: Array<{
    gameCode: string;
    status: Coverage;
    certificate: {
      id: string;
      lab: string;
      certId: string;
      buildHash: string;
      buildHashMatchesLive: boolean | null;
      expiresAt: string;
      daysToExpiry: number;
    } | null;
  }>;
}

interface CoverageResponse {
  buildHash: string | null;
  totals: Record<Coverage, number>;
  operators: CoverageRow[];
}

const LABS = ['GLI', 'BMM', 'ITECH', 'ECOGRA', 'NMI', 'TRISIGMA', 'OTHER'] as const;

const BLANK_FORM = {
  gameCode: 'yantra',
  jurisdiction: 'LK',
  lab: 'ITECH' as (typeof LABS)[number],
  certId: '',
  buildHash: '',
  version: '',
  issuedAt: '',
  validFrom: '',
  expiresAt: '',
  notes: '',
};

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Certificates() {
  const [certs, setCerts] = useState<CertRow[] | null>(null);
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK_FORM, issuedAt: isoToday(), validFrom: isoToday() });
  const [saving, setSaving] = useState(false);

  async function reload() {
    try {
      const [c, cov] = await Promise.all([
        apiRequest<{ certificates: CertRow[] }>('/v1/platform/certificates'),
        apiRequest<CoverageResponse>('/v1/platform/certificates/coverage'),
      ]);
      setCerts(c.certificates);
      setCoverage(cov);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed_to_load');
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/v1/platform/certificates', { method: 'POST', body: form });
      setForm({ ...BLANK_FORM, issuedAt: isoToday(), validFrom: isoToday() });
      setFormOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create_failed');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string, certId: string) {
    if (!window.confirm(`Revoke certificate ${certId}? Coverage will drop for any operator relying on it.`)) return;
    try {
      await apiRequest(`/v1/platform/certificates/${id}/revoke`, { method: 'POST' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'revoke_failed');
    }
  }

  const expiringSoon = useMemo(
    () => certs?.filter((c) => c.status === 'expiring').length ?? 0,
    [certs],
  );
  const expired = useMemo(
    () => certs?.filter((c) => c.status === 'expired').length ?? 0,
    [certs],
  );

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Certificate registry</h1>
          <p className="page__subtitle">
            Lab-issued certificates (GLI / BMM / iTech / eCOGRA) per game + jurisdiction.
            Live build: <code className="mono">{coverage?.buildHash ?? 'unset'}</code>
          </p>
        </div>
        <div className="feed-actions">
          <button type="button" className="btn btn--small btn--primary" onClick={() => setFormOpen((o) => !o)}>
            {formOpen ? 'Cancel' : 'Add certificate'}
          </button>
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      {coverage ? (
        <section className="kpi-row">
          <Kpi label="Covered" value={String(coverage.totals.covered ?? 0)} tone="success" />
          <Kpi label="Expiring <30d" value={String(coverage.totals.expiring ?? 0)} tone={(coverage.totals.expiring ?? 0) > 0 ? 'warning' : undefined} />
          <Kpi label="Expired" value={String(coverage.totals.expired ?? 0)} tone={(coverage.totals.expired ?? 0) > 0 ? 'danger' : undefined} />
          <Kpi label="Missing" value={String(coverage.totals.missing ?? 0)} tone={(coverage.totals.missing ?? 0) > 0 ? 'danger' : undefined} />
          <Kpi label="Certs expiring" value={String(expiringSoon)} tone={expiringSoon > 0 ? 'warning' : undefined} />
          <Kpi label="Certs expired" value={String(expired)} tone={expired > 0 ? 'danger' : undefined} />
        </section>
      ) : null}

      {formOpen ? (
        <section className="card card--padded">
          <h2 className="card__title">New certificate</h2>
          <div className="form-grid">
            <FormField label="Game code" value={form.gameCode} onChange={(v) => setForm({ ...form, gameCode: v })} />
            <FormField label="Jurisdiction (ISO-2 or MULTI)" value={form.jurisdiction} onChange={(v) => setForm({ ...form, jurisdiction: v.toUpperCase() })} />
            <FormField label="Lab" value={form.lab} as="select" options={LABS} onChange={(v) => setForm({ ...form, lab: v as (typeof LABS)[number] })} />
            <FormField label="Certificate ID" value={form.certId} onChange={(v) => setForm({ ...form, certId: v })} />
            <FormField label="Build hash (git SHA)" value={form.buildHash} onChange={(v) => setForm({ ...form, buildHash: v })} />
            <FormField label="Version" value={form.version} onChange={(v) => setForm({ ...form, version: v })} />
            <FormField label="Issued at" value={form.issuedAt} as="date" onChange={(v) => setForm({ ...form, issuedAt: v })} />
            <FormField label="Valid from" value={form.validFrom} as="date" onChange={(v) => setForm({ ...form, validFrom: v })} />
            <FormField label="Expires at" value={form.expiresAt} as="date" onChange={(v) => setForm({ ...form, expiresAt: v })} />
            <FormField label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn--primary" disabled={saving || !form.certId || !form.buildHash || !form.expiresAt} onClick={submit}>
              {saving ? 'Saving…' : 'Save certificate'}
            </button>
          </div>
        </section>
      ) : null}

      {coverage ? (
        <section className="card">
          <div className="card__header"><h2 className="card__title">Operator coverage</h2></div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Operator</th>
                <th>Jurisdiction</th>
                <th>Game</th>
                <th>Lab</th>
                <th>Cert ID</th>
                <th className="num">Days to expiry</th>
                <th>Build match</th>
              </tr>
            </thead>
            <tbody>
              {coverage.operators.flatMap((op) =>
                op.games.map((g) => (
                  <tr
                    key={`${op.id}:${g.gameCode}`}
                    className={g.status === 'missing' || g.status === 'expired' ? 'row--incident' : g.status === 'expiring' ? 'row--warn' : undefined}
                  >
                    <td><CoverageDot coverage={g.status} /></td>
                    <td>
                      {op.name}
                      {op.testMode ? <span className="chip chip--test chip--inline">TEST</span> : null}
                      <div className="op-slug">{op.slug}</div>
                    </td>
                    <td>{op.jurisdiction}</td>
                    <td><code className="mono">{g.gameCode}</code></td>
                    <td>{g.certificate?.lab ?? <span className="dim">—</span>}</td>
                    <td>{g.certificate ? <code className="mono">{g.certificate.certId}</code> : <span className="dim">—</span>}</td>
                    <td className={`num${g.certificate && g.certificate.daysToExpiry < 30 ? ' num--danger' : ''}`}>
                      {g.certificate ? g.certificate.daysToExpiry : '—'}
                    </td>
                    <td>
                      {g.certificate?.buildHashMatchesLive === null
                        ? <span className="dim">n/a</span>
                        : g.certificate?.buildHashMatchesLive
                          ? <span className="chip chip--active">match</span>
                          : <span className="chip chip--warning">drift</span>}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="card">
        <div className="card__header"><h2 className="card__title">All certificates</h2></div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Game</th>
              <th>Jurisdiction</th>
              <th>Lab</th>
              <th>Cert ID</th>
              <th>Build hash</th>
              <th>Expires</th>
              <th className="num">Days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {certs?.length === 0 ? (
              <tr><td colSpan={9} className="empty">No certificates registered.</td></tr>
            ) : null}
            {certs?.map((c) => (
              <tr key={c.id} className={c.status === 'expired' || c.status === 'revoked' ? 'row--incident' : c.status === 'expiring' ? 'row--warn' : undefined}>
                <td><StatusChip status={c.status} /></td>
                <td><code className="mono">{c.gameCode}</code></td>
                <td>{c.jurisdiction}</td>
                <td>{c.lab}</td>
                <td><code className="mono">{c.certId}</code></td>
                <td><code className="mono">{c.buildHash.slice(0, 10)}</code></td>
                <td>{new Date(c.expiresAt).toLocaleDateString()}</td>
                <td className={`num${c.daysToExpiry < 30 ? ' num--danger' : ''}`}>{c.daysToExpiry}</td>
                <td>
                  {c.filePath ? (
                    <a
                      className="btn btn--small btn--ghost"
                      href={c.filePath}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open file
                    </a>
                  ) : (
                    <span className="dim">no file</span>
                  )}{' '}
                  <ArtifactUploader cert={c} onSaved={reload} />{' '}
                  {c.revokedAt ? (
                    <span className="dim">revoked</span>
                  ) : (
                    <button type="button" className="btn btn--small" onClick={() => revoke(c.id, c.certId)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {!certs && !error ? <tr><td colSpan={9} className="empty">Loading…</td></tr> : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
    </div>
  );
}

function StatusChip({ status }: { status: CertStatus }) {
  const map: Record<CertStatus, 'healthy' | 'warning' | 'incident' | 'neutral'> = {
    valid: 'healthy',
    expiring: 'warning',
    expired: 'incident',
    revoked: 'neutral',
  };
  return <span className={`health-dot health-dot--${map[status]}`}><span className="health-dot__pip" />{status}</span>;
}

function CoverageDot({ coverage }: { coverage: Coverage }) {
  const map: Record<Coverage, 'healthy' | 'warning' | 'incident'> = {
    covered: 'healthy',
    expiring: 'warning',
    expired: 'incident',
    missing: 'incident',
  };
  return <span className={`health-dot health-dot--${map[coverage]}`}><span className="health-dot__pip" />{coverage}</span>;
}

function ArtifactUploader({ cert, onSaved }: { cert: CertRow; onSaved(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sha, setSha] = useState('');
  const [urlFallback, setUrlFallback] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function computeSha(f: File): Promise<string> {
    const buf = await f.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function pickFile(f: File) {
    setFile(f);
    setProgress('hashing…');
    try {
      const hex = await computeSha(f);
      setSha(hex);
      setProgress(null);
    } catch (e) {
      setProgress(null);
      setErr((e as Error).message);
    }
  }

  async function upload() {
    if (!file) return;
    setSaving(true);
    setErr(null);
    try {
      // 1. Ask the server for a presigned upload URL.
      setProgress('requesting token…');
      const minted = await apiRequest<{
        uploadUrl: string;
        token: string;
        expiresAt: string;
      }>(`/v1/platform/certificates/${cert.id}/upload-url`, { method: 'POST' });

      // 2. Stream the bytes to the PUT endpoint. We do a direct fetch
      //    because apiRequest wraps fetch for JSON bodies — the upload
      //    needs a Buffer/ArrayBuffer body + specific headers.
      setProgress(`uploading ${(file.size / 1024).toFixed(0)} KB…`);
      const token = (
        JSON.parse(sessionStorage.getItem('yantra-platform-auth') ?? '{}') as {
          token?: string;
        }
      ).token;
      const res = await fetch(minted.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-content-sha256': sha,
          'x-original-filename': file.name,
          authorization: token ? `Bearer ${token}` : '',
        },
        body: file,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`upload_failed:${res.status}:${text.slice(0, 120)}`);
      }
      setProgress('done');
      setOpen(false);
      setFile(null);
      setSha('');
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'upload_failed');
    } finally {
      setSaving(false);
    }
  }

  async function saveUrlOnly() {
    if (!urlFallback.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      await apiRequest(`/v1/platform/certificates/${cert.id}/artifact`, {
        method: 'POST',
        body: {
          filePath: urlFallback.trim(),
          fileSha256: sha.trim() || undefined,
        },
      });
      setOpen(false);
      setUrlFallback('');
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)}>
        {cert.filePath ? 'Replace' : 'Attach'} file
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0', padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
      <div>
        <label className="field">
          <span>Upload file (direct to storage)</span>
          <input
            type="file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickFile(f);
            }}
          />
        </label>
        {file ? (
          <div className="mono" style={{ fontSize: 11 }}>
            {file.name} · {(file.size / 1024).toFixed(0)} KB
            {sha ? (
              <>
                {' · '}
                <code title={sha}>{sha.slice(0, 16)}…</code>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--small btn--primary"
            disabled={!file || !sha || saving}
            onClick={upload}
          >
            {saving ? progress ?? '…' : 'Upload'}
          </button>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <label className="field">
          <span>Or: record an external URL</span>
          <input
            className="input mono"
            placeholder="s3://bucket/key or https://…"
            value={urlFallback}
            onChange={(e) => setUrlFallback(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--small"
            disabled={!urlFallback.trim() || saving}
            onClick={saveUrlOnly}
          >
            Save URL
          </button>
        </div>
      </div>
      <div>
        <button type="button" className="btn btn--small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {err ? <em className="field__error">{err}</em> : null}
    </div>
  );
}

interface FFProps {
  label: string;
  value: string;
  onChange(v: string): void;
  as?: 'text' | 'date' | 'select';
  options?: readonly string[];
}
function FormField({ label, value, onChange, as = 'text', options }: FFProps) {
  return (
    <label className="field">
      <span>{label}</span>
      {as === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input type={as === 'date' ? 'date' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
