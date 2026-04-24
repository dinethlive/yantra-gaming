import { useAuthStore } from '../store/authStore';

const BASE_URL = import.meta.env.VITE_RGS_ADMIN_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = useAuthStore.getState().token;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });

  if (res.status === 401) {
    useAuthStore.getState().logout();
    if (window.location.pathname !== '/login') window.location.replace('/login');
    throw new ApiError(401, 'unauthorized');
  }

  const payload = res.headers.get('content-type')?.includes('application/json')
    ? await res.json().catch(() => null)
    : null;

  if (!res.ok) {
    const msg =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : res.statusText) || 'request_failed';
    throw new ApiError(res.status, msg, payload);
  }

  return payload as T;
}
