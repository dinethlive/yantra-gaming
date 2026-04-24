import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiRequest, ApiError } from '../api/client';

interface CreatedResponse {
  operator: {
    id: string;
    slug: string;
    name: string;
    status: string;
    jurisdiction: string;
    defaultCurrency: string;
  };
  credential: {
    kid: string;
    secret: string;
    algorithm: string;
  };
  warning: string;
}

const BLANK = {
  slug: '',
  name: '',
  jurisdiction: 'LK',
  defaultCurrency: 'LKR',
  walletCallbackUrl: 'https://operator.example.com/wallet',
  testMode: true,
  notes: '',
};

export function NewOperator() {
  const navigate = useNavigate();
  const [form, setForm] = useState(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResponse | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiRequest<CreatedResponse>('/v1/platform/operators', {
        method: 'POST',
        body: form,
      });
      setCreated(res);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : 'create_failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <div className="page">
        <header className="page__header">
          <div>
            <Link to="/operators" className="breadcrumb">&larr; Operators</Link>
            <h1 className="page__title">
              Operator created
              <span className="chip chip--active chip--inline">{created.operator.status}</span>
            </h1>
            <p className="page__subtitle">{created.operator.name} · <code className="mono">{created.operator.slug}</code></p>
          </div>
        </header>

        <div className="banner banner--warning">
          <strong>Save the secret below now.</strong> It is shown exactly once. There is no way
          to retrieve it later — only rotation, which invalidates the old secret.
        </div>

        <section className="card card--padded">
          <h2 className="card__title">Initial API credential</h2>
          <dl className="meta-grid">
            <dt>KID</dt>
            <dd><code className="mono">{created.credential.kid}</code></dd>
            <dt>Secret</dt>
            <dd>
              <code className="mono secret-reveal">{created.credential.secret}</code>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  navigator.clipboard.writeText(created.credential.secret).catch(() => {});
                }}
                style={{ marginLeft: 8 }}
              >
                Copy
              </button>
            </dd>
            <dt>Algorithm</dt>
            <dd>{created.credential.algorithm}</dd>
          </dl>
          <p className="page__subtitle">
            The operator signs every inbound request with HMAC-SHA256 over the canonical
            <code className="mono"> method + path + timestamp + body</code>, and sends it in the
            signature header. See <code className="mono">docs/wallet-api.md</code>.
          </p>
        </section>

        <div className="form-actions">
          <button type="button" className="btn" onClick={() => navigate('/operators')}>
            Back to operators
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => navigate(`/operators/${created.operator.id}`)}
          >
            Open operator
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <Link to="/operators" className="breadcrumb">&larr; Operators</Link>
          <h1 className="page__title">New operator</h1>
          <p className="page__subtitle">
            Creates the operator row, an initial API credential, and a default yantra game
            config in a single transaction. The plaintext secret is returned once.
          </p>
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      <section className="card card--padded">
        <h2 className="card__title">Operator details</h2>
        <div className="form-grid">
          <label className="field">
            <span>Slug (URL-safe, unique)</span>
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="acme-casino" />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Casino Ltd." />
          </label>
          <label className="field">
            <span>Jurisdiction (ISO-2 or MULTI)</span>
            <input value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value.toUpperCase() })} />
          </label>
          <label className="field">
            <span>Default currency</span>
            <input value={form.defaultCurrency} onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value.toUpperCase() })} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Wallet callback URL (HTTPS in production)</span>
            <input value={form.walletCallbackUrl} onChange={(e) => setForm({ ...form, walletCallbackUrl: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Notes (optional)</span>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <label className="test-toggle" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={form.testMode} onChange={(e) => setForm({ ...form, testMode: e.target.checked })} />
            <span>Create as test operator (excluded from production reports)</span>
          </label>
        </div>
        <div className="form-actions">
          <Link to="/operators" className="btn">Cancel</Link>
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting || !form.slug || !form.name || !form.jurisdiction || !form.defaultCurrency || !form.walletCallbackUrl}
            onClick={submit}
          >
            {submitting ? 'Creating…' : 'Create operator'}
          </button>
        </div>
      </section>
    </div>
  );
}
