import type { GameOutcome } from '@yantra/game-contract';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { getPlugin } from '../games/registry.js';

// ──────────────────────────────────────────────────────────────────────────
// Dispute pack builder.
//
// Resolves any of (betTransactionUuid, winTransactionUuid,
// rollbackTransactionUuid) to the complete evidence bundle: round,
// every bet in the round, the wallet-call chain in both directions,
// the player's RG-limit state at bet time, and the provably-fair
// proof (server/client seed, nonce, recomputed outcome).
//
// Output is signed with HMAC-SHA256 using DISPUTE_PACK_SIGNING_SECRET
// (falls back to REPLAY_SIGNING_SECRET in dev). A verifier can
// independently reconstruct the same canonical JSON string and check
// the signature — no server round-trip needed.
//
// Scope: operator-scoped (operatorAuth) — an operator can only request
// dispute packs for their own players. Regulator-scoped lookups come
// via a separate staff-auth flow (not in this Tier).

function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'bigint') return `"${v.toString()}"`;
  if (v instanceof Date) return `"${v.toISOString()}"`;
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function signPack(body: string): string {
  const secret =
    process.env.DISPUTE_PACK_SIGNING_SECRET ??
    process.env.REPLAY_SIGNING_SECRET ??
    config.portalJwtSecret;
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export interface DisputePack {
  pack: unknown;
  signature: string;
  algorithm: 'HMAC-SHA256';
}

export async function buildDisputePack(args: {
  operatorId: string;
  transactionUuid: string;
}): Promise<DisputePack | null> {
  // Resolve transactionUuid → bet via any of its three UUID fields.
  const bet = await prisma.bet.findFirst({
    where: {
      operatorId: args.operatorId,
      OR: [
        { betTransactionUuid: args.transactionUuid },
        { winTransactionUuid: args.transactionUuid },
        { rollbackTransactionUuid: args.transactionUuid },
      ],
    },
    include: {
      round: true,
      pendingRoundBet: true,
    },
  });
  if (!bet) return null;

  // Full wallet-call chain for this round + this specific bet lineage.
  const walletCalls = await prisma.walletCall.findMany({
    where: {
      operatorId: args.operatorId,
      OR: [
        { roundId: bet.roundId },
        { transactionUuid: bet.betTransactionUuid },
        ...(bet.winTransactionUuid
          ? [{ transactionUuid: bet.winTransactionUuid }]
          : []),
        ...(bet.rollbackTransactionUuid
          ? [{ transactionUuid: bet.rollbackTransactionUuid }]
          : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  // Session context at bet time — RG limits snapshot, jurisdiction,
  // mode. This is the "what was in force when the player bet" record.
  const session = await prisma.gameSession.findUnique({
    where: { id: bet.sessionId },
    select: {
      id: true,
      playerRef: true,
      currency: true,
      lang: true,
      jurisdiction: true,
      mode: true,
      rgLimits: true,
      serverSeedHash: true,
      createdAt: true,
      expiresAt: true,
      terminatedAt: true,
      terminationReason: true,
    },
  });

  // Game config at bet time (weights, commission). Note: if the admin
  // updated the config mid-round, this reflects the CURRENT config.
  // A stricter implementation would snapshot config per Round; tracked
  // as a Tier-2 follow-up. For disputes within 24h of the round this
  // is near-zero risk.
  const gameConfig = await prisma.operatorGameConfig.findUnique({
    where: {
      operatorId_gameCode_currency: {
        operatorId: args.operatorId,
        gameCode: bet.round.gameCode,
        currency: bet.currency,
      },
    },
    select: {
      configJson: true,
      configVersion: true,
      commissionMicro: true,
      minBetMicro: true,
      maxBetMicro: true,
    },
  });

  // Provably-fair reconstruction. If the round is terminal, recompute the
  // outcome via the game's plugin and assert the stored outcome matches.
  const terminal = bet.round.state === 'SETTLED' || bet.round.state === 'VOIDED';
  let provablyFairCheck:
    | { match: boolean; outcomeType: string | null }
    | null = null;
  if (terminal && gameConfig && bet.round.outcomeData && bet.round.outcomeType) {
    const plugin = getPlugin(bet.round.gameCode);
    const parsedConfig = plugin?.configSchema.safeParse(gameConfig.configJson);
    if (plugin && parsedConfig?.success) {
      const match = plugin.verifyOutcome(
        {
          serverSeed: bet.round.serverSeed,
          clientSeed: bet.round.clientSeed,
          nonce: bet.round.nonce,
        },
        parsedConfig.data,
        bet.round.outcomeData as unknown as GameOutcome,
      );
      provablyFairCheck = { match, outcomeType: bet.round.outcomeType };
    }
  }

  const now = new Date().toISOString();

  const pack = {
    disputePackVersion: 1,
    generatedAt: now,
    lookup: {
      transactionUuid: args.transactionUuid,
      resolvedRole:
        bet.betTransactionUuid === args.transactionUuid
          ? 'bet'
          : bet.winTransactionUuid === args.transactionUuid
            ? 'win'
            : 'rollback',
    },
    operator: {
      id: bet.operatorId,
    },
    player: {
      playerRef: bet.playerRef,
      currency: bet.currency,
    },
    bet: {
      id: bet.id,
      selection: bet.selection,
      selectionType: bet.selectionType,
      amountMicro: bet.amountMicro.toString(),
      commissionMicro: bet.commissionMicro.toString(),
      status: bet.status,
      won: bet.won,
      wonAmountMicro: bet.wonAmountMicro?.toString() ?? null,
      placedAt: bet.placedAt.toISOString(),
      settledAt: bet.settledAt?.toISOString() ?? null,
      transactions: {
        bet: bet.betTransactionUuid,
        win: bet.winTransactionUuid,
        rollback: bet.rollbackTransactionUuid,
      },
      pendingState: bet.pendingRoundBet
        ? {
            state: bet.pendingRoundBet.state,
            heldAt: bet.pendingRoundBet.heldAt.toISOString(),
            resolvedAt: bet.pendingRoundBet.resolvedAt?.toISOString() ?? null,
            refundedAt: bet.pendingRoundBet.refundedAt?.toISOString() ?? null,
            resolutionReason: bet.pendingRoundBet.resolutionReason,
          }
        : null,
    },
    round: {
      id: bet.round.id,
      state: bet.round.state,
      rngVersion: bet.round.rngVersion,
      buildHash: bet.round.buildHash,
      nonce: bet.round.nonce,
      serverSeed: terminal ? bet.round.serverSeed : null,
      serverSeedHash: bet.round.serverSeedHash,
      clientSeed: bet.round.clientSeed,
      outcome: {
        outcomeType: bet.round.outcomeType,
        outcomeData: bet.round.outcomeData,
      },
      totals: {
        totalBetsMicro: bet.round.totalBetsMicro.toString(),
        totalPayoutsMicro: bet.round.totalPayoutsMicro.toString(),
        houseRevenueMicro: bet.round.houseRevenueMicro.toString(),
      },
      timestamps: {
        startedAt: bet.round.startedAt?.toISOString() ?? null,
        rolledAt: bet.round.rolledAt?.toISOString() ?? null,
        settledAt: bet.round.settledAt?.toISOString() ?? null,
        voidedAt: bet.round.voidedAt?.toISOString() ?? null,
      },
      chain: {
        prevRowHash: bet.round.prevRowHash,
        rowHash: bet.round.rowHash,
      },
    },
    session,
    gameConfig: gameConfig
      ? {
          configJson: gameConfig.configJson,
          configVersion: gameConfig.configVersion,
          commissionMicro: gameConfig.commissionMicro.toString(),
          minBetMicro: gameConfig.minBetMicro.toString(),
          maxBetMicro: gameConfig.maxBetMicro.toString(),
        }
      : null,
    provablyFairCheck,
    walletCallChain: walletCalls.map((c) => ({
      id: c.id,
      direction: c.direction,
      endpoint: c.endpoint,
      requestUuid: c.requestUuid,
      transactionUuid: c.transactionUuid,
      referenceTransactionUuid: c.referenceTransactionUuid,
      amountMicro: c.amountMicro?.toString() ?? null,
      responseStatus: c.responseStatus,
      httpStatus: c.httpStatus,
      latencyMs: c.latencyMs,
      attempt: c.attempt,
      succeeded: c.succeeded,
      prevRowHash: c.prevRowHash,
      rowHash: c.rowHash,
      createdAt: c.createdAt.toISOString(),
    })),
  };

  const signature = signPack(canonicalJson(pack));
  return { pack, signature, algorithm: 'HMAC-SHA256' };
}
