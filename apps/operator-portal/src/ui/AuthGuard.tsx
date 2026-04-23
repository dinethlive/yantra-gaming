import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

interface Props {
  children: ReactNode;
}

// Blocks protected routes when the auth store has no token. Waits for the
// sessionStorage hydration pass so we don't flash a login redirect on first
// render after a real refresh.
export default function AuthGuard({ children }: Props) {
  const token = useAuthStore((s) => s.token);
  const hydrated = useAuthStore((s) => s.hydrated);
  const location = useLocation();

  if (!hydrated) {
    return <div className="guard-loading">Loading…</div>;
  }

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
