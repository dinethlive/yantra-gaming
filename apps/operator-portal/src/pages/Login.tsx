import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApiError, apiRequest } from '../api/client';
import { type OperatorSummary, type OperatorUser, useAuthStore } from '../store/authStore';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

interface LoginResponse {
  token: string;
  operatorUser: OperatorUser;
  operator: OperatorSummary;
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const from =
    (location.state as { from?: string } | null)?.from ?? '/';

  const onSubmit = async (values: FormValues) => {
    setSubmitError(null);
    try {
      const res = await apiRequest<LoginResponse>('/v1/admin/auth/login', {
        method: 'POST',
        body: values,
      });
      login(res.data);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setSubmitError(
            'Auth endpoint not implemented yet on rgs-server. Check the backend scaffold.',
          );
        } else if (err.status === 401) {
          setSubmitError('Invalid credentials.');
        } else {
          setSubmitError(err.message || 'Login failed.');
        }
      } else {
        setSubmitError('Unexpected error during login.');
      }
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <div className="login-card__brand-mark">K</div>
          <div className="login-card__title">Yantra</div>
          <div className="login-card__sub">Operator portal</div>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className="input"
              placeholder="you@operator.com"
              {...register('email')}
            />
            {errors.email ? (
              <span style={{ color: 'var(--danger)', fontSize: 11 }}>
                {errors.email.message}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              {...register('password')}
            />
            {errors.password ? (
              <span style={{ color: 'var(--danger)', fontSize: 11 }}>
                {errors.password.message}
              </span>
            ) : null}
          </div>

          {submitError ? <div className="error-banner">{submitError}</div> : null}

          <button type="submit" className="btn btn--primary" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p style={{ marginTop: 18, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Operators only. Session ends when you close this tab.
        </p>
      </div>
    </div>
  );
}
