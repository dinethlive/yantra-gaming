// Thin postMessage bridge between the iframe and its parent frame
// (the operator's casino page). The contract is intentionally tiny:
//
//   Inbound (parent → iframe):
//     { type: 'terminate', reason: string }      operator forced close
//     { type: 'refreshToken', token: string }    operator rotated session JWT
//
//   Outbound (iframe → parent):
//     { type: 'ready' }                          sent once on mount
//     { type: 'session_ended', reason?: string } sent once on termination
//
// We deliberately do NOT validate `event.origin` here — the operator's
// parent origin is not known at build time and varies per deploy. If
// operators need strong origin pinning we can add it per-tenant later
// (a jurisdiction-specific allow-list from the session token, for ex.).

export interface InboundTerminate {
  type: 'terminate';
  reason?: string;
}

export interface InboundRefreshToken {
  type: 'refreshToken';
  token: string;
}

export type InboundMessage = InboundTerminate | InboundRefreshToken;

export interface ParentMessagingHandlers {
  onTerminate?: (reason: string | undefined) => void;
  onRefreshToken?: (token: string) => void;
}

/**
 * Installs a window `message` listener for the documented inbound types.
 * Returns a cleanup function that detaches the listener.
 */
export function installParentMessaging(handlers: ParentMessagingHandlers): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as unknown;
    if (!data || typeof data !== 'object') return;

    const msg = data as { type?: unknown };
    if (typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'terminate': {
        const reason = (data as InboundTerminate).reason;
        handlers.onTerminate?.(typeof reason === 'string' ? reason : undefined);
        return;
      }
      case 'refreshToken': {
        const token = (data as InboundRefreshToken).token;
        if (typeof token === 'string' && token.length > 0) {
          handlers.onRefreshToken?.(token);
        }
        return;
      }
      default:
        return;
    }
  };

  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Notifies the parent frame that the game canvas has mounted. */
export function sendReady(): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'ready' }, '*');
  }
}

/** Notifies the parent frame that the session has ended — expired, terminated, or error. */
export function sendSessionEnded(reason?: string): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'session_ended', reason }, '*');
  }
}
