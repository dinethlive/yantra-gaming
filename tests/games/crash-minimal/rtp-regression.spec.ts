// RTP regression for Crash Minimal.
//
// Closed-form RTP for the crash formula with pre-roll bust:
//   RTP(K) = K · (1 − houseEdge) · P(crash ≥ K)
//          = K · (1 − houseEdge) · 1/K
//          = 1 − houseEdge     (independent of cashout multiplier K)
//
// This test simulates N rounds with a fixed cashout K, records wagered +
// paid-out, and asserts the observed RTP is within tolerance of (1 − houseEdge).
// Runs at three cashout multipliers (2×, 5×, 20×) to demonstrate the
// RTP-invariance property — the signal that matters to a cert lab.

import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';

import { determineCrashOutcome } from '../../../games/crash-minimal/src/outcome';

const FULL_RUN = process.env.RTP_REGRESSION_FULL === '1';
const ITERATIONS = FULL_RUN ? 5_000_000 : 500_000;
const RTP_TOLERANCE = 0.01; // 1% — crash has a long right tail, needs wider tol than dice

function simulate(opts: {
  cashoutMultiplier: number;
  iterations: number;
  houseEdge: number;
  maxMultiplier: number;
}): { wagered: bigint; paidOut: bigint } {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(16).toString('hex');
  const stake = 100_000n; // 1.00 base units
  const cashoutHundredths = BigInt(Math.round(opts.cashoutMultiplier * 100));

  let wagered = 0n;
  let paidOut = 0n;
  for (let nonce = 0; nonce < opts.iterations; nonce++) {
    const outcome = determineCrashOutcome(
      { serverSeed, clientSeed, nonce },
      { houseEdge: opts.houseEdge, maxMultiplier: opts.maxMultiplier },
    );
    wagered += stake;
    if (outcome.crashMultiplier >= opts.cashoutMultiplier) {
      // Gross payout at cashout — no commission in the RTP baseline.
      paidOut += (stake * cashoutHundredths) / 100n;
    }
  }
  return { wagered, paidOut };
}

function rtp(paidOut: bigint, wagered: bigint): number {
  return Number(paidOut) / Number(wagered);
}

describe(`Crash Minimal — RTP regression (${FULL_RUN ? '5M' : '500K'} rounds)`, () => {
  const houseEdge = 0.01;
  const expected = 1 - houseEdge;
  const maxMultiplier = 1000;

  for (const K of [2.0, 5.0, 20.0]) {
    it(`cashout ${K}× converges to ${(expected * 100).toFixed(2)}% RTP`, () => {
      const stats = simulate({
        cashoutMultiplier: K,
        iterations: ITERATIONS,
        houseEdge,
        maxMultiplier,
      });
      const actual = rtp(stats.paidOut, stats.wagered);
      // eslint-disable-next-line no-console
      console.log(
        `\n  Crash cashout ${K}×: theoretical ${(expected * 100).toFixed(4)}% — observed ${(actual * 100).toFixed(4)}%`,
      );
      expect(Math.abs(actual - expected)).toBeLessThan(RTP_TOLERANCE);
    });
  }
});

describe('Crash Minimal — determinism', () => {
  it('same (seed, nonce, config) always produces the same outcome', () => {
    const ctx = {
      serverSeed: 'a'.repeat(64),
      clientSeed: 'determinism-seed',
      nonce: 42,
    };
    const config = { houseEdge: 0.01, maxMultiplier: 1000 };
    for (let i = 0; i < 50; i++) {
      const a = determineCrashOutcome(ctx, config);
      const b = determineCrashOutcome(ctx, config);
      expect(a.crashMultiplier).toBe(b.crashMultiplier);
      expect(a.u).toBe(b.u);
    }
  });

  it('uniform u is distributed correctly (pre-bust branch rate ≈ houseEdge)', () => {
    // `u` on the returned outcome is the uniform[0,1) derived from HMAC — NOT
    // the post-bust rescaled variable. P(u < houseEdge) is exactly the
    // house-bust branch probability. We test that directly instead of
    // counting `crashMultiplier === 1.0`, which also includes the bottom-clamp
    // of the non-bust branch (rawMultiplier < 1.01 when rescaled-u < 1/101).
    const serverSeed = 'b'.repeat(64);
    const clientSeed = 'bust-rate';
    const houseEdge = 0.05;
    let preBust = 0;
    const N = 50_000;
    for (let nonce = 0; nonce < N; nonce++) {
      const o = determineCrashOutcome(
        { serverSeed, clientSeed, nonce },
        { houseEdge, maxMultiplier: 1000 },
      );
      if (o.u < houseEdge) preBust += 1;
    }
    const actualRate = preBust / N;
    expect(Math.abs(actualRate - houseEdge)).toBeLessThan(0.005);
  });

  it('crashMultiplier never exceeds maxMultiplier', () => {
    const serverSeed = 'c'.repeat(64);
    const clientSeed = 'max-mult-cap';
    const maxMultiplier = 100; // tight cap to force clamp hits
    for (let nonce = 0; nonce < 10_000; nonce++) {
      const o = determineCrashOutcome(
        { serverSeed, clientSeed, nonce },
        { houseEdge: 0.01, maxMultiplier },
      );
      expect(o.crashMultiplier).toBeLessThanOrEqual(maxMultiplier);
      expect(o.crashMultiplier).toBeGreaterThanOrEqual(1.0);
    }
  });
});
