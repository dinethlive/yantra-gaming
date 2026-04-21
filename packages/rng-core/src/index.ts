import crypto from 'node:crypto';

/**
 * Shared provably-fair RNG primitives. Game-agnostic — each game plugin
 * composes these with its own outcome mapping in games/<code>/src/outcome.ts.
 *
 * Commit-reveal scheme (session-scoped):
 *   - serverSeed is committed at session creation (SHA-256 hash published)
 *   - clientSeed is supplied by the operator or player
 *   - per-round outcome = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
 *   - serverSeed is revealed on seed rotation / session end → verifiable ex-post
 *
 * Changes to these primitives invalidate every game's RNG certification. The
 * CI rng-change-gate enforces this by requiring a CERT-ATTEST-CORE line on
 * PRs that touch packages/rng-core/src.
 */

export interface SeedPair {
  serverSeed: string;
  serverSeedHash: string;
}

export interface RngContext {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export function generateSeedPair(): SeedPair {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  return { serverSeed, serverSeedHash };
}

export function generateClientSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function verifyServerSeed(serverSeed: string, expectedHash: string): boolean {
  const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** HMAC-SHA256(serverSeed, clientSeed:nonce) as lowercase hex. */
export function roundHmac(ctx: RngContext): string {
  if (!Number.isInteger(ctx.nonce) || ctx.nonce < 0) {
    throw new Error(`nonce must be a non-negative integer, got ${ctx.nonce}`);
  }
  const message = `${ctx.clientSeed}:${ctx.nonce}`;
  return crypto.createHmac('sha256', ctx.serverSeed).update(message).digest('hex');
}

/** Read 32 bits from the HMAC hex string starting at the given hex-char offset. */
export function uint32At(hmacHex: string, hexOffset: number): number {
  return parseInt(hmacHex.slice(hexOffset, hexOffset + 8), 16);
}
