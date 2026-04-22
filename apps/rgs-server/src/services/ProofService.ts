import { prisma } from '../db.js';

export interface RoundProof {
  roundId: string;
  state: string;
  nonce: number;
  rngVersion: string;
  buildHash: string | null;
  clientSeed: string;
  serverSeedHash: string;
  serverSeed: string | null;     // only revealed after settlement or void
  outcomeType: string | null;
  outcome: unknown;              // plugin-specific shape; recompute via plugin.verifyOutcome
}

export class ProofService {
  async forRound(roundId: string, operatorId?: string): Promise<RoundProof | null> {
    const round = await prisma.round.findUnique({ where: { id: roundId } });
    if (!round) return null;
    if (operatorId && round.operatorId !== operatorId) return null;

    const revealed = round.state === 'SETTLED' || round.state === 'VOIDED';
    return {
      roundId: round.id,
      state: round.state,
      nonce: round.nonce,
      rngVersion: round.rngVersion,
      buildHash: round.buildHash,
      clientSeed: round.clientSeed,
      serverSeedHash: round.serverSeedHash,
      serverSeed: revealed ? round.serverSeed : null,
      outcomeType: round.outcomeType,
      outcome: round.outcomeData,
    };
  }
}

export const proofService = new ProofService();
