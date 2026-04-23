// Tier-2 global kill-switch — emergency halt of every engine.
//
// Verifies:
//   * engage() flips the singleton row.
//   * isEngaged reflects the new state immediately (cache invalidation).
//   * disengage() reverts + records disengagedAt.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { prisma } from '../../apps/rgs-server/src/db.js';
import { globalKillSwitch } from '../../apps/rgs-server/src/services/GlobalKillSwitch.js';
import { cleanDb } from './harness.js';

async function resetKillSwitch() {
  await prisma.globalKillSwitch.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', engaged: false },
    update: {
      engaged: false,
      reason: null,
      engagedAt: null,
      engagedBy: null,
      disengagedAt: null,
      disengagedBy: null,
    },
  });
}

describe('GlobalKillSwitch', () => {
  beforeEach(async () => {
    await cleanDb();
    await resetKillSwitch();
  });

  afterAll(async () => {
    await resetKillSwitch();
    await prisma.$disconnect();
  });

  test('begins disengaged', async () => {
    expect(await globalKillSwitch.isEngaged()).toBe(false);
  });

  test('engage and immediate isEngaged=true', async () => {
    const snap = await globalKillSwitch.engage('rng_compromise_suspected', 'ops@yantra.test');
    expect(snap.engaged).toBe(true);
    expect(snap.reason).toBe('rng_compromise_suspected');
    expect(snap.engagedBy).toBe('ops@yantra.test');
    // Cache is invalidated on engage — the next call must see the truth.
    expect(await globalKillSwitch.isEngaged()).toBe(true);
  });

  test('disengage reverts', async () => {
    await globalKillSwitch.engage('test', 'a@b.test');
    const after = await globalKillSwitch.disengage('a@b.test');
    expect(after.engaged).toBe(false);
    expect(after.disengagedBy).toBe('a@b.test');
    expect(after.disengagedAt).not.toBeNull();
    expect(await globalKillSwitch.isEngaged()).toBe(false);
  });
});
