// Browser-compatible recomputation of the provably-fair dice outcome.
// Mirrors apps/rgs-server/src/utils/rng.ts exactly — any divergence here
// breaks the "Verify" button and must be caught in tests once we add them.
//
// Construction:
//   hmac = HMAC_SHA256(serverSeed, clientSeed + ":" + nonce)
//   first 4 bytes (8 hex chars) → LOW/HIGH weighted side
//   next  4 bytes (8 hex chars) → face within side
//
// LOW faces = [3, 6, 9]; HIGH faces = [12, 15, 18].

const LOW_FACES = [3, 6, 9] as const;
const HIGH_FACES = [12, 15, 18] as const;

export interface VerifyOutcome {
  outcomeSum: number;
  outcomeSide: 'LOW' | 'HIGH';
}

const textEncoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('SubtleCrypto not available — this browser cannot verify proofs');
  }
  const cryptoKey = await subtle.importKey(
    'raw',
    textEncoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', cryptoKey, textEncoder.encode(message));
  return toHex(signature);
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('SubtleCrypto not available');
  }
  return toHex(await subtle.digest('SHA-256', textEncoder.encode(input)));
}

export async function determineOutcomeBrowser(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  lowWeight: number,
  highWeight: number,
): Promise<VerifyOutcome> {
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`nonce must be a non-negative integer, got ${nonce}`);
  }
  if (lowWeight <= 0 || highWeight <= 0) {
    throw new Error(`weights must be positive, got low=${lowWeight} high=${highWeight}`);
  }

  const hex = await hmacSha256Hex(serverSeed, `${clientSeed}:${nonce}`);
  const sideValue = parseInt(hex.slice(0, 8), 16);
  const totalWeight = lowWeight + highWeight;
  const threshold = (lowWeight / totalWeight) * 0xffffffff;
  const side: 'LOW' | 'HIGH' = sideValue < threshold ? 'LOW' : 'HIGH';

  const faceValue = parseInt(hex.slice(8, 16), 16);
  const faces = side === 'LOW' ? LOW_FACES : HIGH_FACES;
  const outcomeSum = faces[faceValue % faces.length]!;

  return { outcomeSum, outcomeSide: side };
}

export async function verifyServerSeed(serverSeed: string, expectedHash: string): Promise<boolean> {
  const hash = await sha256Hex(serverSeed);
  // Constant-time-ish compare (the lengths check + iteration avoids early
  // exit on first mismatch; adequate for client-side verification).
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}
