import type { SettlementResult } from '@yantra/game-contract';
import type { KetapolaDiceSelection } from './selection';
import type { RoundOutcome } from './outcome';

/**
 * Ketapola Dice payout: 2× on a matching side, minus a flat per-bet commission.
 * Commission is fixed micro-units deducted from the gross payout, not a
 * percentage — matches the current OperatorGameConfig.commissionMicro.
 */
export function settleKetapolaDiceBet(args: {
  selection: KetapolaDiceSelection;
  amountMicro: bigint;
  outcome: RoundOutcome;
  commissionMicro: bigint;
}): SettlementResult {
  const { selection, amountMicro, outcome, commissionMicro } = args;
  const won = selection.side === outcome.outcomeSide;
  if (!won) return { won: false, payoutMicro: 0n };

  const gross = amountMicro * 2n;
  const payoutMicro = gross > commissionMicro ? gross - commissionMicro : 0n;
  return { won: true, payoutMicro, winMeta: { side: selection.side } };
}
