import type { SettlementResult } from '@yantra/game-contract';
import type { CrashMinimalSelection } from './selection';
import type { CrashOutcomeData } from './outcome';

/**
 * Settlement:
 *   won = (crashMultiplier >= cashoutMultiplier)
 *   gross payout = amountMicro * cashoutMultiplier (rounded down in micro-units)
 *   net payout   = max(0, gross - commissionMicro)
 *
 * Multiplier has two decimal places, so we scale by 100 and divide to preserve
 * BigInt arithmetic. commissionMicro is a flat per-bet fee matching the
 * OperatorGameConfig shape — same as Ketapola Dice.
 */
export function settleCrashMinimalBet(args: {
  selection: CrashMinimalSelection;
  amountMicro: bigint;
  outcome: CrashOutcomeData;
  commissionMicro: bigint;
}): SettlementResult {
  const { selection, amountMicro, outcome, commissionMicro } = args;
  const won = outcome.crashMultiplier >= selection.cashoutMultiplier;
  if (!won) return { won: false, payoutMicro: 0n };

  const cashoutHundredths = BigInt(Math.round(selection.cashoutMultiplier * 100));
  const gross = (amountMicro * cashoutHundredths) / 100n;
  const payoutMicro = gross > commissionMicro ? gross - commissionMicro : 0n;
  return {
    won: true,
    payoutMicro,
    winMeta: {
      cashoutMultiplier: selection.cashoutMultiplier,
      crashMultiplier: outcome.crashMultiplier,
    },
  };
}
