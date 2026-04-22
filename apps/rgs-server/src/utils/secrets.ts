import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM with a 12-byte IV. Layout of the cipher blob:
//   [12 IV][16 AUTH_TAG][N CIPHERTEXT]
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(): Buffer {
  const buf = Buffer.from(config.secretsMasterKeyB64, 'base64');
  if (buf.length !== 32) throw new Error('SECRETS_MASTER_KEY_B64 must decode to exactly 32 bytes');
  return buf;
}

const key = loadKey();

export function encryptSecret(plain: string): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('cipher blob too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
