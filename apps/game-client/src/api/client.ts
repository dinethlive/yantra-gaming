import { useSessionStore } from '../session/sessionStore';

// Minimal fetch wrapper for the player iframe. Unlike the B2C client we:
//   - never touch localStorage;
//   - inject the session JWT from memory (sessionStore);
//   - do NOT auto-redirect on 401 — the parent frame owns re-auth; we
//     simply emit a session-ended signal and stop.

const RGS_BASE_URL = (import.meta.env.VITE_RGS_BASE_URL ?? '').replace(/\/+$/, '');

const resolveUrl = (url: string): string =>
  url.startsWith('/') && RGS_BASE_URL ? `${RGS_BASE_URL}${url}` : url;

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

function buildError(status: number, body: unknown): ApiError {
  const err = new Error(
    (typeof body === 'object' && body && 'message' in body
      ? String((body as { message: unknown }).message)
      : null) ?? `Request failed (${status})`,
  ) as ApiError;
  err.status = status;
  err.body = body;
  return err;
}

export interface ApiRequestOptions extends RequestInit {
  /** Request timeout in ms. Defaults to 15s. Pass 0 to disable. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Issues a request against the RGS. Injects the current session JWT from the
 * in-memory session store. On 401 the caller should treat the session as dead
 * and surface that up to the parent frame — we don't redirect.
 */
export async function apiRequest<T>(url: string, options?: ApiRequestOptions): Promise<T> {
  const token = useSessionStore.getState().token;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options?.headers as Record<string, string>) || {}),
  };

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutHandle =
    timeoutMs > 0 && controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(resolveUrl(url), {
      ...options,
      headers,
      signal: controller?.signal ?? options?.signal,
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw buildError(res.status, body);
    }

    return body as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Resolves the URL to open for a round's provably-fair proof. Returned by
 * the ProofLink component — we prefer a real URL over an inline fetch so
 * players can share/verify outside the iframe.
 */
export function proofUrl(roundId: string): string {
  return resolveUrl(`/v1/rounds/${encodeURIComponent(roundId)}/proof`);
}
