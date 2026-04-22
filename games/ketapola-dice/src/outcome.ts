import { type RngContext, roundHmac, uint32At } from '@yantra/rng-core';

/**
 * RNG algorithm version stamped on every Round — lets a reviewer prove which
 * rounds used which certified dice math. Bump when any input, byte-slice, or
 * mixing step changes. The CI rng-change-gate requires a CERT-ATTEST-KETAPOLA_DICE
 * line on PRs that touch this file.
 */
export const RNG_VERSION = 'ketapola-rng-v1' as const;

/** Single die faces: LOW = 3,6,9 / HIGH = 12,15,18. */
const LOW_FACES = [3, 6, 9] as const;
const HIGH_FACES = [12, 15, 18] as const;
export const ALL_FACES = [...LOW_FACES, ...HIGH_FACES] as const;

export interface RoundOutcome {
  diceValues: number[];
  outcomeSum: number;
  outcomeSide: 'LOW' | 'HIGH';
}

export interface WeightedConfig {
  lowWeight: number;
  highWeight: number;
}

/**
 * Provably-fair dice outcome:
 *   hmac = HMAC_SHA256(serverSeed, clientSeed + ':' + nonce)
 *   first 4 bytes  → LOW/HIGH weighted selection
 *   next  4 bytes  → face within side
 *
 * Verification (external): recompute hmac with the revealed serverSeed +
 * known clientSeed + nonce, confirm first 32 hex chars match. Standard
 * Stake / Chainlink commit-reveal pattern.
 */
export function determineOutcome(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  lowWeight: number,
  highWeight: number,
): RoundOutcome {
  if (lowWeight <= 0 || highWeight <= 0) {
    throw new Error(`weights must be positive, got low=${lowWeight} high=${highWeight}`);
  }

  const ctx: RngContext = { serverSeed, clientSeed, nonce };
  const hmacHex = roundHmac(ctx);

  const sideValue = uint32At(hmacHex, 0);
  const totalWeight = lowWeight + highWeight;
  const threshold = (lowWeight / totalWeight) * 0xffffffff;
  const side: 'LOW' | 'HIGH' = sideValue < threshold ? 'LOW' : 'HIGH';

  const faceValue = uint32At(hmacHex, 8);
  const faces = side === 'LOW' ? LOW_FACES : HIGH_FACES;
  const outcomeSum = faces[faceValue % faces.length]!;

  return { diceValues: [outcomeSum], outcomeSum, outcomeSide: side };
}

export function verifyOutcome(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  lowWeight: number,
  highWeight: number,
  claimed: RoundOutcome,
): boolean {
  const recomputed = determineOutcome(serverSeed, clientSeed, nonce, lowWeight, highWeight);
  return (
    recomputed.outcomeSum === claimed.outcomeSum &&
    recomputed.outcomeSide === claimed.outcomeSide
  );
}
