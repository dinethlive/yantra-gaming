import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

interface Props {
  children: ReactNode;
}

const STAFF_ROLES = new Set([
  'KETAPOLA_STAFF',
  'KETAPOLA_COMPLIANCE',
  'KETAPOLA_AUDITOR',
  'KETAPOLA_SUPPORT',
]);

export function AuthGuard({ children }: Props) {
  const { token, user, hydrated } = useAuthStore();
  const location = useLocation();

  if (!hydrated) return <div className="app-boot">loading…</div>;
  if (!token || !user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!STAFF_ROLES.has(user.role)) {
    return <Navigate to="/login" replace state={{ error: 'staff_only' }} />;
  }

  return <>{children}</>;
}
