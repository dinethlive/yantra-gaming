import type { GamePlugin, RngContext } from '@yantra/game-contract';
import {
  crashMinimalConfigSchema,
  defaultCrashMinimalConfig,
  type CrashMinimalConfig,
} from './config';
import {
  crashMinimalSelectionSchema,
  type CrashMinimalSelection,
} from './selection';
import {
  RNG_VERSION,
  determineCrashOutcome,
  verifyCrashOutcome,
  type CrashOutcomeData,
} from './outcome';
import { settleCrashMinimalBet } from './settle';

type CrashWireOutcome = CrashOutcomeData & { type: 'CRASH' };

const plugin: GamePlugin<CrashMinimalSelection, CrashWireOutcome, CrashMinimalConfig> = {
  gameCode: 'crash-minimal',
  displayName: 'Crash Minimal',
  cert: {
    rngVersion: RNG_VERSION,
    gliCategory: 'GLI-19',
    mathVersion: '0.1.0',
    parSheetSha256: '',
  },
  selectionSchema: crashMinimalSelectionSchema,
  configSchema: crashMinimalConfigSchema,
  defaultConfig: defaultCrashMinimalConfig,
  sampleSelection: { cashoutMultiplier: 2.0 },

  computeOutcome(ctx: RngContext, config: CrashMinimalConfig): CrashWireOutcome {
    const o = determineCrashOutcome(ctx, config);
    return { type: 'CRASH', ...o };
  },

  verifyOutcome(
    ctx: RngContext,
    config: CrashMinimalConfig,
    claimed: CrashWireOutcome,
  ): boolean {
    return verifyCrashOutcome(ctx, config, claimed);
  },

  settleBet({ selection, amountMicro, outcome, commissionMicro }) {
    return settleCrashMinimalBet({ selection, amountMicro, outcome, commissionMicro });
  },

  outcomeForWire(outcome: CrashWireOutcome) {
    return { outcomeType: 'CRASH', outcome };
  },
};

export default plugin;
export {
  RNG_VERSION,
  determineCrashOutcome,
  verifyCrashOutcome,
  type CrashOutcomeData,
} from './outcome';
