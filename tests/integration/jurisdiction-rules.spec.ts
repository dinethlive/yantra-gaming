// Jurisdiction rules — Tier-0 cert-readiness.
//
// Verifies the per-jurisdiction ruleset package correctly rejects:
//   • stake above UK £2 slot cap
//   • German 5s spin-speed floor
//   • UK autoplay ban
//   • Currency/jurisdiction mismatch
// and lets permissive INTL sessions through.

import { describe, expect, test } from 'bun:test';
import {
  checkJurisdictionRules,
  effectiveRGFloor,
  getJurisdiction,
} from '@yantra/jurisdiction-rules';

describe('jurisdiction-rules', () => {
  test('unknown jurisdiction falls back to INTL', () => {
    const r = getJurisdiction('ZZ');
    expect(r.code).toBe('INTL');
    expect(r.regulator).toBe('none');
  });

  test('UK blocks autoplay', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'GB',
      stakeMicro: 50_000n,
      currency: 'GBP',
      autoplay: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('autoplay_not_permitted');
  });

  test('UK rejects stake over £2 slot cap', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'GB',
      stakeMicro: 300_000n, // £3
      currency: 'GBP',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('stake_above_jurisdiction_max');
  });

  test('UK rejects EUR on a GB session', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'GB',
      stakeMicro: 100_000n,
      currency: 'EUR',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('currency_not_permitted');
  });

  test('DE rejects spin faster than 5s', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'DE',
      stakeMicro: 100_000n,
      currency: 'EUR',
      timeSincePreviousBetMs: 2_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('spin_too_fast');
  });

  test('DE allows a 6s spin', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'DE',
      stakeMicro: 50_000n,
      currency: 'EUR',
      timeSincePreviousBetMs: 6_000,
    });
    expect(result.allowed).toBe(true);
  });

  test('INTL is permissive', () => {
    const result = checkJurisdictionRules({
      jurisdiction: 'INTL',
      stakeMicro: 1_000_000n,
      currency: 'BTC',
      autoplay: true,
      turbo: true,
    });
    expect(result.allowed).toBe(true);
  });

  test('effectiveRGFloor picks the tighter of operator and jurisdiction', () => {
    // Operator sets session loss of 10_000_000 (100 units). Jurisdiction (UK)
    // does not mandate a loss cap; operator's value wins.
    const gb = effectiveRGFloor('GB', {
      sessionLossMicro: 10_000_000n,
    });
    expect(gb.sessionLossMicro).toBe(10_000_000n);
    // UK mandates 60-min reality check even without operator config.
    expect(gb.realityCheckIntervalMs).toBe(60 * 60_000);
  });
});
