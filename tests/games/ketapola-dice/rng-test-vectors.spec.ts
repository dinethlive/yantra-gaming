// Regression test for games/ketapola-dice/fixtures/rng-test-vectors.json.
//
// Every vector in the JSON must be reproducible bit-for-bit from the current
// dice math. A diff here means the game's RNG mapping changed, which triggers
// the rng-change-gate CI rule and requires a CERT-ATTEST-KETAPOLA_DICE line.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { determineOutcome } from '../../../games/ketapola-dice/src/index';

interface Vector {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  lowWeight: number;
  highWeight: number;
  expected: { outcomeSide: 'LOW' | 'HIGH'; outcomeSum: number };
}

const vectorsPath = join(
  __dirname,
  '..',
  '..',
  '..',
  'games',
  'ketapola-dice',
  'fixtures',
  'rng-test-vectors.json',
);
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vector[];

describe('RNG test vectors (games/ketapola-dice/fixtures/rng-test-vectors.json)', () => {
  it('has at least 12 vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(12);
  });

  for (const [i, v] of vectors.entries()) {
    it(`vector #${i + 1}: (${v.clientSeed}:${v.nonce}) @ (${v.lowWeight},${v.highWeight}) → ${v.expected.outcomeSide}/${v.expected.outcomeSum}`, () => {
      const out = determineOutcome(
        v.serverSeed,
        v.clientSeed,
        v.nonce,
        v.lowWeight,
        v.highWeight,
      );
      expect(out.outcomeSide).toBe(v.expected.outcomeSide);
      expect(out.outcomeSum).toBe(v.expected.outcomeSum);
    });
  }
});
