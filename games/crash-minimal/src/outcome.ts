import { type RngContext, roundHmac } from '@yantra/rng-core';

/**
 * RNG algorithm version stamped on every Round — lets a reviewer prove which
 * rounds used which certified crash math. Bump on any input / byte-slice /
 * mixing change. CI rng-change-gate requires CERT-ATTEST-CRASH_MINIMAL on
 * edits to this file.
 */
export const RNG_VERSION = 'crash-minimal-rng-v1' as const;

export interface CrashOutcomeData {
  crashMultiplier: number;
  /** Uniform[0,1) used to derive the multiplier — surfaced for player-side verification. */
  u: number;
}

export interface CrashConfigInput {
  /** Fraction of the house edge as a pre-roll bust probability. 0.01 = 1% RTP reduction. */
  houseEdge: number;
  /** Hard cap on the emitted multiplier. Industry-typical caps sit at 1000× or 10000×. */
  maxMultiplier: number;
}

/**
 * Provably-fair crash outcome.
 *
 *   hmac = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
 *   u_raw = first 52 bits of hmac / 2^52         — uniform[0, 1)
 *   if u_raw < houseEdge:
 *     crashMultiplier = 1.00                      — house bust (player loses at any cashout > 1.00)
 *   else:
 *     u = (u_raw - houseEdge) / (1 - houseEdge)   — rescale to uniform[0, 1)
 *     crashMultiplier = floor(100 / (1 - u)) / 100
 *
 * RTP(K) = K · (1 − houseEdge) · P(crash ≥ K)
 *        = K · (1 − houseEdge) · 1/K  =  1 − houseEdge   (identical regardless of K).
 *
 * The final multiplier is clamped to [1.00, maxMultiplier] to keep the client
 * animation bounded. The clamp is asymmetric — low clamp to 1.00 absorbs the
 * house-bust branch; high clamp to `maxMultiplier` caps the tail.
 */
export function determineCrashOutcome(
  ctx: RngContext,
  config: CrashConfigInput,
): CrashOutcomeData {
  if (config.houseEdge < 0 || config.houseEdge >= 1) {
    throw new Error(`houseEdge must be in [0, 1), got ${config.houseEdge}`);
  }
  if (config.maxMultiplier < 1.01) {
    throw new Error(`maxMultiplier must be >= 1.01, got ${config.maxMultiplier}`);
  }

  const hmac = roundHmac(ctx);
  // First 52 bits as a uniform in [0, 1). 52 bits fit exactly in Number's
  // safe-integer range (2^53 - 1) so the BigInt → Number conversion is lossless.
  const bits52 = BigInt(`0x${hmac.slice(0, 13)}`);
  const max = 1n << 52n;
  const uRaw = Number(bits52) / Number(max);

  if (uRaw < config.houseEdge) {
    return { crashMultiplier: 1.0, u: uRaw };
  }

  const u = (uRaw - config.houseEdge) / (1 - config.houseEdge);
  // floor(100 / (1 - u)) / 100 → two-decimal multiplier. At u → 1 this blows
  // up; cap with maxMultiplier so the wire never carries Infinity.
  const rawMultiplier = Math.floor(100 / (1 - u)) / 100;
  const crashMultiplier = Math.min(
    Math.max(1.0, rawMultiplier),
    config.maxMultiplier,
  );
  return { crashMultiplier, u: uRaw };
}

export function verifyCrashOutcome(
  ctx: RngContext,
  config: CrashConfigInput,
  claimed: CrashOutcomeData,
): boolean {
  const recomputed = determineCrashOutcome(ctx, config);
  return (
    Math.abs(recomputed.crashMultiplier - claimed.crashMultiplier) < 1e-9 &&
    Math.abs(recomputed.u - claimed.u) < 1e-12
  );
}
