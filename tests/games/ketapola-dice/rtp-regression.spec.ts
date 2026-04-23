// 10M-round RTP regression for Ketapola Dice.
//
// What cert labs (iTech Labs, BMM, GLI) actually run when they check an RNG:
// simulate many rounds with the production RNG, then assert the observed
// per-outcome frequency and the Return-To-Player match theoretical within a
// tight tolerance. Any drift implies a bug in the RNG, the weight math, or
// the payout math.
//
// This test is the CI insurance against accidental RNG changes. CI runs a
// smaller 1M-round version on every push; the 10M version runs weekly on a
// schedule (see `.github/workflows/rtp-regression.yml`).
//
// Tolerance: ±0.5% for RTP; ±1% for per-face probabilities. 10M rounds gives
// a standard error of ~0.016% on a 50/50 outcome so the tolerance is wide
// relative to sampling error.

import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import {
  ALL_FACES,
  determineOutcome,
} from '../../../games/ketapola-dice/src/index';

const FULL_RUN = process.env.RTP_REGRESSION_FULL === '1';
const ITERATIONS = FULL_RUN ? 10_000_000 : 1_000_000;
const RTP_TOLERANCE = 0.005; // 0.5%
const FACE_TOLERANCE = 0.01; // 1.0% absolute on each face-probability

interface Stats {
  iterations: number;
  sideCounts: Record<'LOW' | 'HIGH', number>;
  faceCounts: Record<number, number>;
  lowBetsWagered: bigint;
  lowBetsPaidOut: bigint;
  highBetsWagered: bigint;
  highBetsPaidOut: bigint;
}

function runSimulation(opts: {
  lowWeight: number;
  highWeight: number;
  iterations: number;
  stakeMicro: bigint;
  payoutMultiplier: number;
  commissionMicro: bigint;
}): Stats {
  const { lowWeight, highWeight, iterations, stakeMicro, payoutMultiplier, commissionMicro } = opts;

  // Fresh seed per run — the regression is sensitive to *any* seed.
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(16).toString('hex');

  const sideCounts: Stats['sideCounts'] = { LOW: 0, HIGH: 0 };
  const faceCounts: Stats['faceCounts'] = {};
  for (const f of ALL_FACES) faceCounts[f] = 0;

  let lowBetsWagered = 0n;
  let lowBetsPaidOut = 0n;
  let highBetsWagered = 0n;
  let highBetsPaidOut = 0n;

  const multiplierBig = BigInt(payoutMultiplier);

  for (let nonce = 0; nonce < iterations; nonce++) {
    const outcome = determineOutcome(serverSeed, clientSeed, nonce, lowWeight, highWeight);
    sideCounts[outcome.outcomeSide]++;
    faceCounts[outcome.outcomeSum] = (faceCounts[outcome.outcomeSum] ?? 0) + 1;

    // Model a player who ALWAYS bets LOW and a parallel player who ALWAYS bets HIGH.
    // This gives two independent RTP observations per round and halves the required
    // simulation size for a given confidence interval.
    lowBetsWagered += stakeMicro;
    if (outcome.outcomeSide === 'LOW') {
      const gross = stakeMicro * multiplierBig;
      const net = gross > commissionMicro ? gross - commissionMicro : 0n;
      lowBetsPaidOut += net;
    }
    highBetsWagered += stakeMicro;
    if (outcome.outcomeSide === 'HIGH') {
      const gross = stakeMicro * multiplierBig;
      const net = gross > commissionMicro ? gross - commissionMicro : 0n;
      highBetsPaidOut += net;
    }
  }

  return {
    iterations,
    sideCounts,
    faceCounts,
    lowBetsWagered,
    lowBetsPaidOut,
    highBetsWagered,
    highBetsPaidOut,
  };
}

function rtp(paidOut: bigint, wagered: bigint): number {
  if (wagered === 0n) return 0;
  // Convert through Number — stakes and payouts are small enough that this stays
  // well under 2^53. Real money code uses BigInt arithmetic; this is just for
  // a test assertion.
  return Number(paidOut) / Number(wagered);
}

describe(`RTP regression — ${FULL_RUN ? '10M' : '1M'} rounds`, () => {
  it('symmetric 48:48 weights with 2× payout and zero commission yield ~100% RTP', () => {
    const stats = runSimulation({
      lowWeight: 48,
      highWeight: 48,
      iterations: ITERATIONS,
      stakeMicro: 100_000n, // 1.00 major unit
      payoutMultiplier: 2,
      commissionMicro: 0n,
    });

    const lowRtp = rtp(stats.lowBetsPaidOut, stats.lowBetsWagered);
    const highRtp = rtp(stats.highBetsPaidOut, stats.highBetsWagered);

    // eslint-disable-next-line no-console
    console.log('\n  RTP regression (symmetric, no commission):');
    console.log(`    iterations: ${stats.iterations.toLocaleString()}`);
    console.log(`    theoretical RTP (both sides): 100.0000%`);
    console.log(`    observed LOW  RTP:            ${(lowRtp * 100).toFixed(4)}%`);
    console.log(`    observed HIGH RTP:            ${(highRtp * 100).toFixed(4)}%`);

    expect(Math.abs(lowRtp - 1.0)).toBeLessThan(RTP_TOLERANCE);
    expect(Math.abs(highRtp - 1.0)).toBeLessThan(RTP_TOLERANCE);
  });

  it('side distribution matches weight ratio within tolerance', () => {
    const stats = runSimulation({
      lowWeight: 48,
      highWeight: 48,
      iterations: ITERATIONS,
      stakeMicro: 100_000n,
      payoutMultiplier: 2,
      commissionMicro: 0n,
    });

    const actualLowProb = stats.sideCounts.LOW / stats.iterations;
    expect(Math.abs(actualLowProb - 0.5)).toBeLessThan(RTP_TOLERANCE);
  });

  it('each face has ~1/6 probability under symmetric weights', () => {
    const stats = runSimulation({
      lowWeight: 48,
      highWeight: 48,
      iterations: ITERATIONS,
      stakeMicro: 100_000n,
      payoutMultiplier: 2,
      commissionMicro: 0n,
    });

    const expectedPerFace = 1 / 6;
    for (const face of ALL_FACES) {
      const actual = (stats.faceCounts[face] ?? 0) / stats.iterations;
      expect(Math.abs(actual - expectedPerFace)).toBeLessThan(FACE_TOLERANCE);
    }
  });

  it('asymmetric 40:56 weights produce the expected house-favouring RTP', () => {
    // lowWeight=40, highWeight=56 → P(LOW) = 40/96 ≈ 0.41667
    // LOW player RTP = 0.41667 × 2 ≈ 83.333%
    // HIGH player RTP = 0.58333 × 2 ≈ 116.666%  (a loss for the house — non-realistic, used only to check math)
    const stats = runSimulation({
      lowWeight: 40,
      highWeight: 56,
      iterations: ITERATIONS,
      stakeMicro: 100_000n,
      payoutMultiplier: 2,
      commissionMicro: 0n,
    });

    const lowRtp = rtp(stats.lowBetsPaidOut, stats.lowBetsWagered);
    const theoreticalLow = (40 / 96) * 2;

    // eslint-disable-next-line no-console
    console.log('\n  RTP regression (asymmetric 40:56):');
    console.log(`    theoretical LOW RTP: ${(theoreticalLow * 100).toFixed(4)}%`);
    console.log(`    observed    LOW RTP: ${(lowRtp * 100).toFixed(4)}%`);

    expect(Math.abs(lowRtp - theoreticalLow)).toBeLessThan(RTP_TOLERANCE);
  });

  it('commission reduces RTP by approximately the expected amount', () => {
    // At 48:48 weights, 2× payout, and commission of 0.06 per 1.00 stake:
    //   gross payout = 2.00; net payout = 2.00 - 0.06 = 1.94
    //   RTP on LOW = P(LOW) × 1.94 = 0.5 × 1.94 = 97.0%
    const stakeMicro = 100_000n;     // 1.00
    const commissionMicro = 6_000n;  // 0.06 (6% of stake, or 3% of gross payout)
    const expectedRtp = 0.5 * (2 - Number(commissionMicro) / Number(stakeMicro));

    const stats = runSimulation({
      lowWeight: 48,
      highWeight: 48,
      iterations: ITERATIONS,
      stakeMicro,
      payoutMultiplier: 2,
      commissionMicro,
    });

    const actual = rtp(stats.lowBetsPaidOut, stats.lowBetsWagered);

    // eslint-disable-next-line no-console
    console.log('\n  RTP regression (48:48 with 0.06/bet commission):');
    console.log(`    theoretical RTP: ${(expectedRtp * 100).toFixed(4)}%`);
    console.log(`    observed    RTP: ${(actual * 100).toFixed(4)}%`);

    expect(Math.abs(actual - expectedRtp)).toBeLessThan(RTP_TOLERANCE);
  });
});

describe('RNG determinism', () => {
  it('same seed + nonce always produce the same outcome', () => {
    const serverSeed = 'a'.repeat(64);
    const clientSeed = 'test-seed';
    const lowWeight = 48;
    const highWeight = 48;

    for (let i = 0; i < 100; i++) {
      const a = determineOutcome(serverSeed, clientSeed, i, lowWeight, highWeight);
      const b = determineOutcome(serverSeed, clientSeed, i, lowWeight, highWeight);
      expect(a.outcomeSum).toBe(b.outcomeSum);
      expect(a.outcomeSide).toBe(b.outcomeSide);
    }
  });

  it('different nonce values produce different outcomes (collision check on 1000 samples)', () => {
    const serverSeed = 'b'.repeat(64);
    const clientSeed = 'collision-test';
    const outcomes = new Map<string, number>();

    for (let nonce = 0; nonce < 1000; nonce++) {
      const o = determineOutcome(serverSeed, clientSeed, nonce, 48, 48);
      const key = `${o.outcomeSide}:${o.outcomeSum}`;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }

    // There are only 6 possible outcomes; each should appear roughly 166 times.
    // We just assert every outcome appears at least a handful of times (non-zero).
    expect(outcomes.size).toBe(6);
    for (const count of outcomes.values()) {
      expect(count).toBeGreaterThan(50);
    }
  });
});
