import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';

// Staff Settings — MFA self-enrollment.
//
// Two factors supported:
//   * TOTP  — shows an otpauth:// URI the user pastes into any authenticator
//             app. They then post back a 6-digit code to confirm enrollment.
//             (QR image rendering is intentionally left to the authenticator
//             since a lightweight QR-lib dependency isn't worth the bundle.)
//   * WebAuthn — navigator.credentials.create() / .get(). Supports YubiKeys,
//             platform keys (Touch ID / Windows Hello), and passkeys.

interface CredentialRow {
  id: string;
  credentialId: string;
  deviceName: string | null;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TotpBeginResp {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
  warning: string;
}

export function Settings() {
  const user = useAuthStore((s) => s.user);

  // ── TOTP state ──────────────────────────────────────────────
  const [totpStep, setTotpStep] = useState<'idle' | 'begun' | 'enrolled'>('idle');
  const [totpPayload, setTotpPayload] = useState<TotpBeginResp | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);

  // ── WebAuthn state ──────────────────────────────────────────
  const [creds, setCreds] = useState<CredentialRow[] | null>(null);
  const [webauthnBusy, setWebauthnBusy] = useState(false);
  const [webauthnError, setWebauthnError] = useState<string | null>(null);
  const [newDeviceName, setNewDeviceName] = useState('');

  async function loadCreds() {
    try {
      const r = await apiRequest<{ credentials: CredentialRow[] }>(
        '/v1/admin/webauthn/credentials',
      );
      setCreds(r.credentials);
    } catch (e) {
      setWebauthnError(e instanceof ApiError ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void loadCreds();
  }, []);

  async function totpBegin() {
    setTotpBusy(true);
    setTotpError(null);
    try {
      const r = await apiRequest<TotpBeginResp>('/v1/admin/mfa:begin', {
        method: 'POST',
      });
      setTotpPayload(r);
      setTotpStep('begun');
    } catch (e) {
      if (e instanceof ApiError && e.message === 'mfa_already_enrolled') {
        setTotpStep('enrolled');
      } else {
        setTotpError(e instanceof ApiError ? e.message : 'begin_failed');
      }
    } finally {
      setTotpBusy(false);
    }
  }

  async function totpConfirm() {
    setTotpBusy(true);
    setTotpError(null);
    try {
      await apiRequest('/v1/admin/mfa:confirm', {
        method: 'POST',
        body: { code: totpCode },
      });
      setTotpStep('enrolled');
      setTotpCode('');
      setTotpPayload(null);
    } catch (e) {
      setTotpError(
        e instanceof ApiError
          ? e.message === 'invalid_code'
            ? 'Code did not match. Try a fresh one from your authenticator.'
            : e.message
          : 'confirm_failed',
      );
    } finally {
      setTotpBusy(false);
    }
  }

  async function totpDisable() {
    if (
      !window.confirm(
        'Disable TOTP on your own account? You will be prompted to re-enrol on next login if an admin has also configured a WebAuthn key.',
      )
    )
      return;
    setTotpBusy(true);
    try {
      await apiRequest('/v1/admin/mfa:disable', { method: 'POST' });
      setTotpStep('idle');
      setTotpPayload(null);
    } catch (e) {
      setTotpError(e instanceof ApiError ? e.message : 'disable_failed');
    } finally {
      setTotpBusy(false);
    }
  }

  async function enrollWebauthn() {
    setWebauthnBusy(true);
    setWebauthnError(null);
    try {
      const begin = await apiRequest<{
        options: unknown;
        challengeId: string;
      }>('/v1/admin/webauthn/register:begin', { method: 'POST' });
      const attestation = await startRegistration({
        optionsJSON: begin.options as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });
      await apiRequest('/v1/admin/webauthn/register:confirm', {
        method: 'POST',
        body: {
          challengeId: begin.challengeId,
          response: attestation,
          deviceName: newDeviceName.trim() || undefined,
        },
      });
      setNewDeviceName('');
      await loadCreds();
    } catch (e) {
      setWebauthnError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'enroll_failed',
      );
    } finally {
      setWebauthnBusy(false);
    }
  }

  async function removeCredential(row: CredentialRow) {
    if (
      !window.confirm(
        `Remove ${row.deviceName ?? 'this key'}? You cannot log in with it again; if it's your only factor, set up another first.`,
      )
    )
      return;
    setWebauthnBusy(true);
    try {
      await apiRequest(`/v1/admin/webauthn/credentials/${row.id}`, {
        method: 'DELETE',
      });
      await loadCreds();
    } finally {
      setWebauthnBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Account settings</h1>
          <p className="page__subtitle">
            Signed in as <strong>{user?.email}</strong> — {user?.role}
          </p>
        </div>
      </header>

      {/* ── TOTP ────────────────────────────────────────────── */}
      <section className="card card--padded">
        <h2 className="card__title">
          TOTP authenticator{' '}
          {totpStep === 'enrolled' ? (
            <span className="chip chip--active chip--inline">enrolled</span>
          ) : (
            <span className="chip chip--neutral chip--inline">not enrolled</span>
          )}
        </h2>
        <p className="page__subtitle">
          RFC 6238 6-digit codes. Works with any authenticator app (Google,
          1Password, Authy, …).
        </p>
        {totpError ? <div className="banner banner--danger">{totpError}</div> : null}
        {totpStep === 'idle' ? (
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={totpBusy}
              onClick={totpBegin}
            >
              {totpBusy ? '…' : 'Enable TOTP'}
            </button>
          </div>
        ) : null}
        {totpStep === 'begun' && totpPayload ? (
          <>
            <dl className="meta-grid">
              <dt>Secret</dt>
              <dd>
                <code className="mono" style={{ wordBreak: 'break-all' }}>
                  {totpPayload.secret}
                </code>
              </dd>
              <dt>otpauth URI</dt>
              <dd>
                <code className="mono" style={{ wordBreak: 'break-all' }}>
                  {totpPayload.otpauthUrl}
                </code>
              </dd>
              <dt>Recovery codes</dt>
              <dd>
                <pre className="mono" style={{ padding: 8 }}>
                  {totpPayload.recoveryCodes.join('\n')}
                </pre>
                <em className="field__hint">
                  Save these NOW. They are shown once and never again.
                </em>
              </dd>
            </dl>
            <div className="form-row">
              <input
                className="input mono"
                placeholder="123456"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                maxLength={6}
                inputMode="numeric"
                style={{ maxWidth: 140 }}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={totpBusy || totpCode.length !== 6}
                onClick={totpConfirm}
              >
                Confirm
              </button>
            </div>
          </>
        ) : null}
        {totpStep === 'enrolled' ? (
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--small btn--danger-ghost"
              disabled={totpBusy}
              onClick={totpDisable}
            >
              Disable TOTP
            </button>
          </div>
        ) : null}
      </section>

      {/* ── WebAuthn ──────────────────────────────────────── */}
      <section className="card card--padded">
        <h2 className="card__title">Security keys (WebAuthn / FIDO2)</h2>
        <p className="page__subtitle">
          YubiKeys, platform authenticators (Touch ID, Windows Hello), passkeys.
          Multiple keys may be enrolled — the login flow accepts any enrolled
          authenticator.
        </p>
        {webauthnError ? (
          <div className="banner banner--danger">{webauthnError}</div>
        ) : null}
        <div className="form-row">
          <input
            className="input"
            placeholder="device nickname (e.g. yubikey-office)"
            value={newDeviceName}
            onChange={(e) => setNewDeviceName(e.target.value)}
            maxLength={100}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={webauthnBusy}
            onClick={enrollWebauthn}
          >
            {webauthnBusy ? '…' : 'Add security key'}
          </button>
        </div>

        <table className="data-table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Transports</th>
              <th>Backed up</th>
              <th>Added</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {creds?.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No security keys enrolled.
                </td>
              </tr>
            ) : null}
            {creds?.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.deviceName ?? <span className="dim">—</span>}
                  <div className="op-slug">
                    <code className="mono" title={c.credentialId}>
                      {c.credentialId.slice(0, 16)}…
                    </code>
                  </div>
                </td>
                <td>
                  {c.transports.length ? (
                    c.transports.map((t) => (
                      <code key={t} className="mono chip--tag">
                        {t}
                      </code>
                    ))
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  {c.backedUp ? (
                    <span className="chip chip--active">yes</span>
                  ) : (
                    <span className="chip chip--neutral">no</span>
                  )}
                </td>
                <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                <td>
                  {c.lastUsedAt ? (
                    new Date(c.lastUsedAt).toLocaleDateString()
                  ) : (
                    <span className="dim">never</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn--small btn--danger-ghost"
                    disabled={webauthnBusy}
                    onClick={() => removeCredential(c)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!creds ? (
              <tr>
                <td colSpan={6} className="empty">
                  Loading…
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// helper to satisfy the startAuthentication import (referenced in Login.tsx
// patch below). Keep the import symbol live so Vite doesn't tree-shake it.
void startAuthentication;
