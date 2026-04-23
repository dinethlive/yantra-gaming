import { useAuthStore } from '../store/authStore';

// Thin fetch wrapper. All operator-portal requests go through here so we
// have a single place to inject the bearer token, handle 401 redirects,
// and normalise error shapes. Deliberately no react-query — the portal
// is light enough that useEffect+useState is fine (see api/hooks.ts).

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// 404 is treated as "endpoint not implemented" during Phase 0. We surface
// it as a typed sentinel so pages can render mocked data + a "stub" banner
// without duck-typing error messages.
export class EndpointStubError extends ApiError {
  constructor(body: unknown) {
    super(404, 'Endpoint is a stub', body);
  }
}

export interface ApiResponse<T> {
  data: T;
  isStub: boolean;
}

function resolveBaseUrl(): string {
  const envUrl = import.meta.env.VITE_RGS_ADMIN_BASE_URL;
  if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
  // Fall through to same-origin; vite dev server proxies /v1 → rgs-server.
  return '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = resolveBaseUrl();
  const url = new URL(`${base}${path}`, base || window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const { method = 'GET', body, query, signal } = opts;
  const token = useAuthStore.getState().token;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'omit',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Network error', { cause: String(err) });
  }

  // Auth expiry → drop credentials and bounce to login.
  if (response.status === 401) {
    useAuthStore.getState().logout();
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    throw new ApiError(401, 'Unauthorized', null);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (response.status === 404) {
    throw new EndpointStubError(parsed);
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : response.statusText;
    throw new ApiError(response.status, message, parsed);
  }

  const isStub =
    parsed !== null &&
    typeof parsed === 'object' &&
    'stub' in parsed &&
    (parsed as { stub: unknown }).stub === true;

  return { data: parsed as T, isStub };
}
