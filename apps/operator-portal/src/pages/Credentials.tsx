import { useState } from 'react';
import { ApiError, apiRequest } from '../api/client';
import { type CredentialRow, useCredentials } from '../api/hooks';
import { useUIStore } from '../store/uiStore';
import Card, { ErrorBanner, StubBanner } from '../ui/Card';
import PageHeader from '../ui/PageHeader';

const MOCK: CredentialRow[] = [
  {
    id: 'cred-1',
    kid: 'kid_live_001',
    type: 'API_KEY_INBOUND',
    label: 'Primary operator API key',
    notBefore: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    notAfter: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  },
  {
    id: 'cred-2',
    kid: 'whm_live_001',
    type: 'WALLET_HMAC_OUTBOUND',
    label: 'Wallet HMAC (production)',
    notBefore: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    notAfter: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  },
];

export default function Credentials() {
  const { data, error, isStub, refetch } = useCredentials();
  const rows = data?.items ?? (isStub ? MOCK : []);
  const pushToast = useUIStore((s) => s.pushToast);
  const [rotating, setRotating] = useState(false);
  const [revealed, setRevealed] = useState<{ kid: string; secret: string } | null>(null);

  const rotateWalletHmac = async () => {
    if (!confirm('Rotate the wallet HMAC secret? The old secret remains valid for 15 minutes to allow drain.')) {
      return;
    }
    setRotating(true);
    try {
      const res = await apiRequest<{ kid: string; secret: string }>(
        '/v1/admin/credentials/rotate',
        { method: 'POST', body: { type: 'WALLET_HMAC_OUTBOUND' } },
      );
      setRevealed(res.data);
      pushToast('success', 'Rotated wallet HMAC secret. Store it now — it cannot be shown again.');
      refetch();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Rotation failed';
      pushToast('error', msg);
    } finally {
      setRotating(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Credentials"
        subtitle="API keys and wallet HMAC secrets. Plaintext secrets are shown once at creation and never again."
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={rotateWalletHmac}
            disabled={rotating}
          >
            {rotating ? 'Rotating…' : 'Rotate wallet HMAC secret'}
          </button>
        }
      />

      {isStub ? <StubBanner /> : null}
      {error ? <ErrorBanner message={error.message} /> : null}

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>KID</th>
                <th>Type</th>
                <th>Label</th>
                <th>Status</th>
                <th>Not before</th>
                <th>Not after</th>
                <th>Revoked at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const revoked = c.revokedAt !== null;
                const expired = c.notAfter !== null && new Date(c.notAfter) < new Date();
                const active = !revoked && !expired;
                return (
                  <tr key={c.id}>
                    <td><code className="mono">{c.kid}</code></td>
                    <td><code className="mono">{c.type}</code></td>
                    <td>{c.label ?? '—'}</td>
                    <td>
                      <span
                        className={`chip ${
                          active ? 'chip--success' : revoked ? 'chip--danger' : 'chip--warning'
                        }`}
                      >
                        {active ? 'ACTIVE' : revoked ? 'REVOKED' : 'EXPIRED'}
                      </span>
                    </td>
                    <td>
                      <code className="mono mono--muted">
                        {new Date(c.notBefore).toLocaleString()}
                      </code>
                    </td>
                    <td>
                      <code className="mono mono--muted">
                        {c.notAfter ? new Date(c.notAfter).toLocaleString() : '—'}
                      </code>
                    </td>
                    <td>
                      <code className="mono mono--muted">
                        {c.revokedAt ? new Date(c.revokedAt).toLocaleString() : '—'}
                      </code>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                    No credentials on file.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {revealed ? (
        <div className="modal-backdrop" onClick={() => setRevealed(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New wallet HMAC secret</h2>
            <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              Copy this now. It will never be shown again. Store it in your secrets
              manager and distribute through your usual channels.
            </p>
            <div className="stack">
              <div className="field">
                <label className="field__label">Key ID (kid)</label>
                <code className="mono" style={{ wordBreak: 'break-all' }}>{revealed.kid}</code>
              </div>
              <div className="field">
                <label className="field__label">Secret</label>
                <code className="mono" style={{ wordBreak: 'break-all' }}>{revealed.secret}</code>
              </div>
            </div>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(revealed.secret);
                  pushToast('info', 'Copied secret to clipboard');
                }}
              >
                Copy secret
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setRevealed(null)}
              >
                I have stored it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
