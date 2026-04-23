// Client-side JWT payload decoder. Does NOT verify the signature — that's
// the server's job. We use this only to surface display-only claims from
// the token we were handed: rgLimits, expiresAt, jurisdiction.
//
// The auth decision for socket/HTTP calls is always server-side.

export interface DecodedClaims {
  sub?: string;
  sessionId?: string;
  operatorId?: string;
  playerRef?: string;
  gameCode?: string;
  currency?: string;
  jurisdiction?: string;
  lang?: string;
  mode?: 'real' | 'demo';
  rgLimits?: {
    dailyLossMicro?: string;
    dailyWagerMicro?: string;
    sessionLossMicro?: string;
    sessionWagerMicro?: string;
    sessionTimeSeconds?: number;
  };
  iat?: number;
  exp?: number;
}

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    const padded2 = pad > 0 ? padded + '='.repeat(4 - pad) : padded;
    if (typeof atob === 'function') return atob(padded2);
    // Fallback for non-browser test runners
    return Buffer.from(padded2, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function decodeJwtPayload(token: string): DecodedClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    return JSON.parse(json) as DecodedClaims;
  } catch {
    return null;
  }
}
