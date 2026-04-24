import { zodResolver } from '@hookform/resolvers/zod';
import { startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { apiRequest, ApiError } from '../api/client';
import { useAuthStore, type LoginPayload } from '../store/authStore';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().regex(/^\d{6}$/).optional().or(z.literal('')),
});
type FormValues = z.infer<typeof schema>;

export function Login() {
  const navigate = useNavigate();
  const location = useLocation() as { state?: { error?: string } };
  const login = useAuthStore((s) => s.login);
  const [serverError, setServerError] = useState<string | null>(
    location.state?.error === 'staff_only'
      ? 'This panel is for Yantra staff only.'
      : null,
  );
  const [mfaRequired, setMfaRequired] = useState(false);
  const [factors, setFactors] = useState<{ totp: boolean; webauthn: boolean }>(
    { totp: false, webauthn: false },
  );

  const { register, handleSubmit, formState, getValues } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  async function doWebauthn() {
    setServerError(null);
    try {
      const { email, password } = getValues();
      const begin = await apiRequest<{
        options: unknown;
        challengeId: string;
      }>('/v1/admin/auth/webauthn:begin', {
        method: 'POST',
        body: { email, password },
      });
      const assertion = await startAuthentication({
        optionsJSON: begin.options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });
      const res = await apiRequest<LoginPayload>('/v1/admin/auth/webauthn:verify', {
        method: 'POST',
        body: {
          email,
          challengeId: begin.challengeId,
          response: assertion,
        },
      });
      login(res);
      navigate('/', { replace: true });
    } catch (e) {
      setServerError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'webauthn_failed',
      );
    }
  }

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      const body: Record<string, unknown> = {
        email: values.email,
        password: values.password,
      };
      if (values.mfaCode) body.mfaCode = values.mfaCode;
      const res = await apiRequest<LoginPayload>('/v1/admin/auth/login', {
        method: 'POST',
        body,
      });
      const staffRoles = new Set([
        'KETAPOLA_STAFF',
        'KETAPOLA_COMPLIANCE',
        'KETAPOLA_AUDITOR',
        'KETAPOLA_SUPPORT',
      ]);
      if (!staffRoles.has(res.operatorUser.role)) {
        setServerError('This panel is for Yantra staff only.');
        return;
      }
      login(res);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.message === 'mfa_required') {
          setMfaRequired(true);
          const body = err.body as { factors?: { totp: boolean; webauthn: boolean } } | undefined;
          if (body?.factors) setFactors(body.factors);
          setServerError(
            body?.factors?.webauthn && body.factors.totp
              ? 'MFA required — use your security key or enter a TOTP code.'
              : body?.factors?.webauthn
                ? 'MFA required — use your security key.'
                : 'Enter your 6-digit TOTP code.',
          );
          return;
        }
        if (err.status === 401 && err.message === 'invalid_mfa_code') {
          setServerError('Invalid TOTP code.');
          return;
        }
        setServerError(err.status === 401 ? 'Invalid email or password.' : err.message);
      } else {
        setServerError('Sign-in failed. Check the RGS server is running on :4500.');
      }
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={handleSubmit(onSubmit)}>
        <div className="login__brand">
          <span className="sidebar__mark">KP</span>
          <div>
            <div className="sidebar__title">Yantra</div>
            <div className="sidebar__subtitle">Platform admin</div>
          </div>
        </div>

        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" {...register('email')} />
          {formState.errors.email ? (
            <em className="field__error">{formState.errors.email.message}</em>
          ) : null}
        </label>

        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" {...register('password')} />
          {formState.errors.password ? (
            <em className="field__error">{formState.errors.password.message}</em>
          ) : null}
        </label>

        {mfaRequired && factors.totp ? (
          <label className="field">
            <span>TOTP code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              {...register('mfaCode')}
              placeholder="123456"
            />
            {formState.errors.mfaCode ? (
              <em className="field__error">{formState.errors.mfaCode.message}</em>
            ) : null}
          </label>
        ) : null}

        {serverError ? <div className="banner banner--danger">{serverError}</div> : null}

        <button type="submit" className="btn btn--primary" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>

        {mfaRequired && factors.webauthn ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={doWebauthn}
          >
            Use security key instead
          </button>
        ) : null}
      </form>
    </div>
  );
}
