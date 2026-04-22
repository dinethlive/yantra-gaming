import { z } from 'zod';

/**
 * BetSelection for Crash Minimal: the player commits to an auto-cashout
 * multiplier before the round rolls. If `crashMultiplier >= cashoutMultiplier`
 * the player wins `stake × cashoutMultiplier`; otherwise the stake is lost.
 *
 * The minimum is 1.01 — a cashout of 1.00 would be a riskless bet and is
 * disallowed.
 */
export const crashMinimalSelectionSchema = z
  .object({
    cashoutMultiplier: z.number().min(1.01).max(10_000),
  })
  .strict();

export type CrashMinimalSelection = z.infer<typeof crashMinimalSelectionSchema>;
