import crypto from 'node:crypto';
import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@yantra/wallet-spec';

export { KEY_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER };

function bodyHash(body: string | Buffer): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Canonical string:   method \n path \n timestamp \n sha256(body)
 * Signature:          base64(HMAC-SHA256(secret, canonical))
 */
export function signPayload(
  secret: string,
  method: string,
  path: string,
  timestamp: number | string,
  body: string | Buffer,
): string {
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash(body)}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64');
}

export function verifySignature(
  secret: string,
  method: string,
  path: string,
  timestamp: number | string,
  body: string | Buffer,
  signature: string,
  windowSeconds: number,
): boolean {
  const tsNum = typeof timestamp === 'number' ? timestamp : Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > windowSeconds) return false;

  const expected = signPayload(secret, method, path, timestamp, body);
  const a = Buffer.from(expected, 'base64');
  const b = Buffer.from(signature, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
