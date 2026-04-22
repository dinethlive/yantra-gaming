import type { GamePlugin, RngContext } from '@yantra/game-contract';
import {
  defaultKetapolaDiceConfig,
  ketapolaDiceConfigSchema,
  type KetapolaDiceConfig,
} from './config';
import {
  ketapolaDiceSelectionSchema,
  type KetapolaDiceSelection,
} from './selection';
import {
  RNG_VERSION,
  determineOutcome,
  verifyOutcome,
  type RoundOutcome,
} from './outcome';
import { settleKetapolaDiceBet } from './settle';

type DiceWireOutcome = RoundOutcome & { type: 'DICE' };

const plugin: GamePlugin<KetapolaDiceSelection, DiceWireOutcome, KetapolaDiceConfig> = {
  gameCode: 'ketapola-dice',
  displayName: 'Ketapola Dice',
  cert: {
    rngVersion: RNG_VERSION,
    gliCategory: 'GLI-19',
    mathVersion: '0.1.0',
    // Updated when par-sheet.json ships — kept empty during Phase 1 scaffolding.
    parSheetSha256: '',
  },
  selectionSchema: ketapolaDiceSelectionSchema,
  configSchema: ketapolaDiceConfigSchema,
  defaultConfig: defaultKetapolaDiceConfig,
  sampleSelection: { side: 'LOW' },

  computeOutcome(ctx: RngContext, config: KetapolaDiceConfig): DiceWireOutcome {
    const o = determineOutcome(
      ctx.serverSeed,
      ctx.clientSeed,
      ctx.nonce,
      config.lowWeight,
      config.highWeight,
    );
    return { type: 'DICE', ...o };
  },

  verifyOutcome(
    ctx: RngContext,
    config: KetapolaDiceConfig,
    claimed: DiceWireOutcome,
  ): boolean {
    return verifyOutcome(
      ctx.serverSeed,
      ctx.clientSeed,
      ctx.nonce,
      config.lowWeight,
      config.highWeight,
      claimed,
    );
  },

  settleBet({ selection, amountMicro, outcome, commissionMicro }) {
    return settleKetapolaDiceBet({ selection, amountMicro, outcome, commissionMicro });
  },

  outcomeForWire(outcome: DiceWireOutcome) {
    return { outcomeType: 'DICE', outcome };
  },
};

export default plugin;

// Named re-exports of the math/internals. Consumed by the RTP / test-vector
// tests and the scripts/generate-test-vectors.ts harness. The core engine
// uses the default GamePlugin export and never reaches into these directly.
export {
  RNG_VERSION,
  ALL_FACES,
  determineOutcome,
  verifyOutcome,
  type RoundOutcome,
} from './outcome';
