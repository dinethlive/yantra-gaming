import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';

/**
 * Enforce `Operator.ipAllowList` if set.
 *
 * An empty list means "allow all" (opt-in feature). A non-empty list means
 * "allow only these exact IPs". Must run AFTER operatorAuth so `req.operator`
 * is populated.
 *
 * Supports:
 *   • exact IPv4 / IPv6 match
 *   • CIDR notation (`10.0.0.0/8`, `2001:db8::/32`) for subnet allow-listing
 *
 * Behind a trusted reverse proxy, Express populates `req.ip` from the
 * `X-Forwarded-For` header (enabled via `app.set('trust proxy', …)` in
 * `index.ts`). Do NOT use this middleware in front of an untrusted proxy.
 */
export function ipAllowList(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const op = req.operator;
  if (!op) {
    // operatorAuth should have set this — fail closed.
    res.status(401).json({ error: 'no_operator' });
    return;
  }
  const list = op.ipAllowList ?? [];
  if (list.length === 0) {
    next();
    return;
  }

  const clientIp = req.ip;
  if (!clientIp) {
    res.status(403).json({ error: 'client_ip_missing' });
    return;
  }

  const allowed = list.some((pattern) => matchIp(clientIp, pattern));
  if (!allowed) {
    logger.warn('ip_not_allowed', { operatorId: op.id, clientIp });
    res.status(403).json({ error: 'ip_not_allowed' });
    return;
  }
  next();
}

function matchIp(clientIp: string, pattern: string): boolean {
  if (!pattern.includes('/')) {
    // Exact match (normalise IPv6 `::ffff:` IPv4-mapped form).
    return normalise(clientIp) === normalise(pattern);
  }
  return matchCidr(normalise(clientIp), pattern);
}

function normalise(ip: string): string {
  // Node gives IPv4 over IPv6 as `::ffff:1.2.3.4` — normalise to the IPv4 form.
  const v4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4Mapped && v4Mapped[1]) return v4Mapped[1];
  return ip.toLowerCase();
}

function matchCidr(clientIp: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range || !bitsStr) return false;
  const bits = Number.parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0) return false;

  if (range.includes(':')) {
    return matchCidrIPv6(clientIp, range, bits);
  }
  return matchCidrIPv4(clientIp, range, bits);
}

function matchCidrIPv4(ip: string, range: string, bits: number): boolean {
  if (bits > 32) return false;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(range);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number.parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function matchCidrIPv6(ip: string, range: string, bits: number): boolean {
  if (bits > 128) return false;
  const a = ipv6ToBytes(ip);
  const b = ipv6ToBytes(range);
  if (!a || !b) return false;
  let remaining = bits;
  for (let i = 0; i < 16 && remaining > 0; i++) {
    if (remaining >= 8) {
      if (a[i] !== b[i]) return false;
      remaining -= 8;
    } else {
      const mask = (0xff << (8 - remaining)) & 0xff;
      if ((a[i]! & mask) !== (b[i]! & mask)) return false;
      remaining = 0;
    }
  }
  return true;
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  // Minimal RFC 4291 expander. Returns 16 bytes or null on malformed input.
  const hasDoubleColon = ip.includes('::');
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const groupCount = hasDoubleColon ? left.length + right.length : left.length;
  if (!hasDoubleColon && groupCount !== 8) return null;
  if (hasDoubleColon && groupCount > 7) return null;

  const zeros = Array<string>(8 - groupCount).fill('0');
  const groups = hasDoubleColon ? [...left, ...zeros, ...right] : left;
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = Number.parseInt(groups[i] || '0', 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}
