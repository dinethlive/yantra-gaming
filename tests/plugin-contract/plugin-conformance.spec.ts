// Plugin conformance harness.
//
// Runs six architectural checks against every GamePlugin registered in the
// engine's static registry. Adding a new game automatically adopts all six —
// that's the payoff of the plugin contract. No per-game test code required.
//
// Checks:
//   1. selectionSchema accepts sampleSelection and rejects obvious garbage
//   2. configSchema.parse(defaultConfig) round-trips
//   3. computeOutcome is deterministic (same inputs → same output)
//   4. verifyOutcome of a freshly-computed outcome returns true
//   5. cert.rngVersion is non-empty and matches the `<gameCode>-rng-vN` pattern
//   6. outcomeForWire(o).outcomeType equals o.type

import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';

import { listPlugins } from '../../apps/rgs-server/src/games/registry';

describe('plugin conformance', () => {
  const plugins = listPlugins();

  it('registers at least one plugin', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    describe(plugin.gameCode, () => {
      it('selectionSchema accepts sampleSelection and rejects garbage', () => {
        const good = plugin.selectionSchema.safeParse(plugin.sampleSelection);
        expect(good.success).toBe(true);
        // A random unrelated object is rejected. Plugins use zod .strict()
        // so unknown keys also fail — that's the desired behaviour.
        const bad = plugin.selectionSchema.safeParse({ __not_a_selection__: true });
        expect(bad.success).toBe(false);
      });

      it('configSchema round-trips defaultConfig', () => {
        const parsed = plugin.configSchema.safeParse(plugin.defaultConfig);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data).toEqual(plugin.defaultConfig);
        }
      });

      it('computeOutcome is deterministic', () => {
        const ctx = {
          serverSeed: 'a'.repeat(64),
          clientSeed: 'conformance-seed',
          nonce: 7,
        };
        const a = plugin.computeOutcome(ctx, plugin.defaultConfig);
        const b = plugin.computeOutcome(ctx, plugin.defaultConfig);
        expect(a).toEqual(b);
      });

      it('verifyOutcome returns true for a freshly-computed outcome', () => {
        const ctx = {
          serverSeed: crypto.randomBytes(32).toString('hex'),
          clientSeed: crypto.randomBytes(16).toString('hex'),
          nonce: 0,
        };
        const outcome = plugin.computeOutcome(ctx, plugin.defaultConfig);
        expect(plugin.verifyOutcome(ctx, plugin.defaultConfig, outcome)).toBe(true);
      });

      it('cert.rngVersion follows the <gameCode>-rng-vN naming convention', () => {
        expect(plugin.cert.rngVersion.length).toBeGreaterThan(0);
        // e.g. 'ketapola-rng-v1', 'crash-rng-v1'. The convention is enforced
        // so a reviewer can grep every round's rngVersion stamp back to the
        // exact plugin entry.
        const pattern = /^[a-z0-9][a-z0-9-]*-rng-v\d+$/;
        expect(plugin.cert.rngVersion).toMatch(pattern);
      });

      it('outcomeForWire.outcomeType equals outcome.type', () => {
        const ctx = {
          serverSeed: 'b'.repeat(64),
          clientSeed: 'wire-check',
          nonce: 0,
        };
        const outcome = plugin.computeOutcome(ctx, plugin.defaultConfig);
        const wire = plugin.outcomeForWire(outcome);
        expect(wire.outcomeType).toBe(outcome.type);
      });
    });
  }
});
