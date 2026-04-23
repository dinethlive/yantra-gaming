// HMAC-SHA256 verification for inbound RGS → mock-operator wallet calls.
//
// Canonical string matches apps/rgs-server/src/utils/signing.ts — must stay
// in lock-step with it:
//
//   method + "\n" + path + "\n" + timestamp + "\n" + sha256_hex(body)
//
// The signature header carries base64(HMAC-SHA256(secret, canonical)).

import crypto from 'node:crypto';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, KEY_ID_HEADER } from '@yantra/wallet-spec';

export { SIGNATURE_HEADER, TIMESTAMP_HEADER, KEY_ID_HEADER };

function bodyHashHex(raw: string | Buffer): string {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function signPayload(
  secret: string,
  method: string,
  path: string,
  timestamp: number | string,
  body: string | Buffer,
): string {
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHashHex(body)}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64');
}

export interface VerifyArgs {
  secret: string;
  method: string;
  path: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string | Buffer;
  windowSeconds: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' };

export function verifyInboundSignature(args: VerifyArgs): VerifyResult {
  const { secret, method, path, timestamp, signature, body, windowSeconds } = args;
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad_timestamp' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > windowSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = signPayload(secret, method, path, timestamp, body);
  const a = Buffer.from(expected, 'base64');
  let b: Buffer;
  try {
    b = Buffer.from(signature, 'base64');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
