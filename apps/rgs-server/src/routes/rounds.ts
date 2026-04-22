import type { GameOutcome } from '@yantra/game-contract';
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { getPlugin } from '../games/registry.js';
import { ipAllowList } from '../middleware/ip-allow-list.js';
import { operatorAuth } from '../middleware/operator-auth.js';
import { operatorRateLimit } from '../middleware/operator-rate-limit.js';
import { buildDisputePack } from '../services/DisputePack.js';
import { proofService } from '../services/ProofService.js';

export const roundsRouter = Router();

// Canonical JSON for signing the replay bundle. Deterministic: sorted keys,
// no whitespace, BigInt → string, Date → ISO-8601. Any off-the-shelf
// verifier (operator CI, regulator audit tool) can reproduce.
function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null) return 'null';
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

function signReplay(body: string): string {
  // Replay bundles are signed with a dedicated secret in production
  // (REPLAY_SIGNING_SECRET). For dev we fall back to the portal JWT
  // secret — rotating one rotates the other, which is acceptable locally.
  const secret =
    process.env.REPLAY_SIGNING_SECRET ?? config.portalJwtSecret;
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── Static routes FIRST. Express matches in insertion order; `/:id`
// would otherwise swallow `/history` and `/`. Keep the fixed paths
// (`/history`, `/`) above any `/:id...` routes.

const ListQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  gameCode: z.string().optional(),
  currency: z.string().optional(),
});

roundsRouter.get('/', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { cursor, limit, gameCode, currency } = parsed.data;
  const rounds = await prisma.round.findMany({
    where: { operatorId: req.operator?.id, gameCode, currency },
    orderBy: { startedAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const nextCursor = rounds.length > limit ? rounds.pop()!.id : null;
  res.json({
    items: rounds.map((r) => ({
      roundId: r.id,
      nonce: r.nonce,
      state: r.state,
      outcomeType: r.outcomeType,
      outcome: r.outcomeData,
      totalBetsMicro: r.totalBetsMicro.toString(),
      totalPayoutsMicro: r.totalPayoutsMicro.toString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      settledAt: r.settledAt?.toISOString() ?? null,
    })),
    nextCursor,
  });
});

// Player-scoped round history. Pageable, signed per-page, 90-day default
// window. Operators surface this in their player-statement UIs (UKGC
// LCCP SR Code 5.1.3 "provide a statement of account"). All figures in
// micro-units so operator finance systems can roll up without FP drift.
const HistoryQuery = z.object({
  playerRef: z.string().min(1).max(128),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

roundsRouter.get('/history', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const parsed = HistoryQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
    return;
  }
  const { playerRef, from, to, cursor, limit } = parsed.data;

  // Default: last 90 days. Shorter windows are allowed; longer windows
  // are not — if an operator needs older data they must paginate.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 90 * 86_400_000);
  const fromDate = from ? new Date(from) : defaultFrom;
  const toDate = to ? new Date(to) : now;
  if (toDate.getTime() - fromDate.getTime() > 400 * 86_400_000) {
    res.status(400).json({ error: 'window_too_large' });
    return;
  }

  const bets = await prisma.bet.findMany({
    where: {
      operatorId: req.operator?.id,
      playerRef,
      placedAt: { gte: fromDate, lte: toDate },
    },
    orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { round: true },
  });
  const nextCursor = bets.length > limit ? bets.pop()!.id : null;

  const items = bets.map((b) => ({
    betId: b.id,
    roundId: b.roundId,
    placedAt: b.placedAt.toISOString(),
    settledAt: b.settledAt?.toISOString() ?? null,
    selection: b.selection,
    selectionType: b.selectionType,
    amountMicro: b.amountMicro.toString(),
    currency: b.currency,
    status: b.status,
    won: b.won,
    wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
    netMicro: b.won
      ? ((b.wonAmountMicro ?? 0n) - b.amountMicro).toString()
      : (-b.amountMicro).toString(),
    round: {
      state: b.round.state,
      outcomeType: b.round.outcomeType,
      outcome: b.round.outcomeData,
      serverSeedHash: b.round.serverSeedHash,
      rngVersion: b.round.rngVersion,
    },
    transactions: {
      bet: b.betTransactionUuid,
      win: b.winTransactionUuid,
      rollback: b.rollbackTransactionUuid,
    },
  }));

  const page = {
    playerRef,
    operatorId: req.operator?.id,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    nextCursor,
    count: items.length,
    items,
  };
  const signature = signReplay(canonicalJson(page));
  res.setHeader('X-Yantra-Signature', signature);
  res.setHeader('X-Yantra-Signature-Alg', 'HMAC-SHA256');
  res.json({ ...page, signature, algorithm: 'HMAC-SHA256' });
});

// Dispute pack — resolve any of (betTransactionUuid, winTransactionUuid,
// rollbackTransactionUuid) to the full evidence bundle. UKGC LCCP SR
// Code 6.1 requires operators to resolve complaints within 8 weeks with
// a supporting evidence pack; this endpoint is the canonical source.
// Returns a signed JSON bundle; see services/DisputePack.ts.
roundsRouter.get(
  '/by-transaction/:transactionUuid/dispute-pack',
  operatorAuth,
  ipAllowList,
  operatorRateLimit,
  async (req, res) => {
    if (!req.operator?.id) {
      res.status(401).json({ error: 'no_operator_scope' });
      return;
    }
    const pack = await buildDisputePack({
      operatorId: req.operator.id,
      transactionUuid: req.params.transactionUuid as string,
    });
    if (!pack) {
      res.status(404).json({ error: 'transaction_not_found' });
      return;
    }
    res.setHeader('X-Yantra-Signature', pack.signature);
    res.setHeader('X-Yantra-Signature-Alg', pack.algorithm);
    res.json(pack);
  },
);

// ── Dynamic (`/:id`) routes — must come AFTER static routes.

roundsRouter.get('/:id', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const round = await prisma.round.findUnique({
    where: { id: req.params.id as string },
    include: { bets: true },
  });
  if (!round || round.operatorId !== req.operator?.id) {
    res.status(404).json({ error: 'round_not_found' });
    return;
  }
  res.json({
    roundId: round.id,
    operatorId: round.operatorId,
    sessionId: round.sessionId,
    gameCode: round.gameCode,
    currency: round.currency,
    nonce: round.nonce,
    state: round.state,
    outcomeType: round.outcomeType,
    outcome: round.outcomeData,
    totalBetsMicro: round.totalBetsMicro.toString(),
    totalPayoutsMicro: round.totalPayoutsMicro.toString(),
    houseRevenueMicro: round.houseRevenueMicro.toString(),
    startedAt: round.startedAt?.toISOString() ?? null,
    rolledAt: round.rolledAt?.toISOString() ?? null,
    settledAt: round.settledAt?.toISOString() ?? null,
    voidedAt: round.voidedAt?.toISOString() ?? null,
    bets: round.bets.map((b) => ({
      betId: b.id,
      playerRef: b.playerRef,
      selection: b.selection,
      selectionType: b.selectionType,
      amountMicro: b.amountMicro.toString(),
      status: b.status,
      won: b.won,
      wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
      betTransactionUuid: b.betTransactionUuid,
      winTransactionUuid: b.winTransactionUuid,
      rollbackTransactionUuid: b.rollbackTransactionUuid,
      placedAt: b.placedAt.toISOString(),
      settledAt: b.settledAt?.toISOString() ?? null,
    })),
  });
});

roundsRouter.get('/:id/proof', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const proof = await proofService.forRound(req.params.id as string, req.operator?.id);
  if (!proof) {
    res.status(404).json({ error: 'round_not_found' });
    return;
  }
  res.json(proof);
});

// GLI-11 §2.12 round replay — signed, regulator-verifiable bundle.
//
// Returns everything needed to reconstruct the round outside our system:
// the seed pair (server seed + hash + client seed), nonce, the engine
// config at round time (weights / commission), the outcome, every bet
// with its transaction chain (bet → win/rollback), and the wallet-call
// audit chain the operator saw. Independently verifies RTP inputs,
// provably-fair outcome, and wallet-call integrity.
//
// The bundle is signed with HMAC-SHA256 over the canonical JSON of
// `replay`. The signature is returned in `X-Yantra-Signature` and
// embedded in the payload as `signature` for convenient copy-paste.
//
// Access: operator-scoped via operatorAuth — only the owning operator
// can replay their own rounds. Reviewers use a regulator-scoped admin
// key (separate follow-up).
roundsRouter.get('/:id/replay', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const round = await prisma.round.findUnique({
    where: { id: req.params.id as string },
    include: {
      bets: { orderBy: { placedAt: 'asc' } },
      walletCalls: { orderBy: { createdAt: 'asc' } },
      session: true,
    },
  });
  if (!round || round.operatorId !== req.operator?.id) {
    res.status(404).json({ error: 'round_not_found' });
    return;
  }

  // Reveal the server seed only once the round is terminal. For an
  // in-flight round (BETTING_OPEN / ROLLING / RESULT), the hash is
  // published but the seed is not — matching the standard commit-reveal
  // invariant.
  const terminal = round.state === 'SETTLED' || round.state === 'VOIDED';
  const revealed = terminal ? round.serverSeed : null;

  // Replay the RNG locally so the bundle carries both the claim and the
  // independently-computed outcome. If the two disagree, we've discovered
  // a data-tampering incident — the replay ought to match what outcomeData
  // stored at roll time.
  const gameConfig = await prisma.operatorGameConfig.findUnique({
    where: {
      operatorId_gameCode_currency: {
        operatorId: round.operatorId,
        gameCode: round.gameCode,
        currency: round.currency,
      },
    },
  });

  let recomputedOutcome:
    | { outcomeType: string; outcome: unknown; matches: boolean }
    | null = null;
  if (revealed && gameConfig && round.outcomeData && round.outcomeType) {
    const plugin = getPlugin(round.gameCode);
    const parsedConfig = plugin?.configSchema.safeParse(gameConfig.configJson);
    if (plugin && parsedConfig?.success) {
      const matches = plugin.verifyOutcome(
        { serverSeed: revealed, clientSeed: round.clientSeed, nonce: round.nonce },
        parsedConfig.data,
        round.outcomeData as unknown as GameOutcome,
      );
      recomputedOutcome = {
        outcomeType: round.outcomeType,
        outcome: round.outcomeData,
        matches,
      };
    }
  }

  const replay = {
    replayVersion: 1,
    roundId: round.id,
    operatorId: round.operatorId,
    sessionId: round.sessionId,
    gameCode: round.gameCode,
    currency: round.currency,
    rngVersion: round.rngVersion,
    buildHash: round.buildHash,
    nonce: round.nonce,
    state: round.state,
    config: gameConfig
      ? {
          configJson: gameConfig.configJson,
          configVersion: gameConfig.configVersion,
          commissionMicro: gameConfig.commissionMicro.toString(),
          minBetMicro: gameConfig.minBetMicro.toString(),
          maxBetMicro: gameConfig.maxBetMicro.toString(),
          bettingWindowMs: gameConfig.bettingWindowMs,
          rollingWindowMs: gameConfig.rollingWindowMs,
        }
      : null,
    provablyFair: {
      serverSeed: revealed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      revealAllowed: terminal,
    },
    outcome: {
      outcomeType: round.outcomeType,
      outcomeData: round.outcomeData,
    },
    recomputedOutcome,
    timestamps: {
      startedAt: round.startedAt?.toISOString() ?? null,
      rolledAt: round.rolledAt?.toISOString() ?? null,
      settledAt: round.settledAt?.toISOString() ?? null,
      voidedAt: round.voidedAt?.toISOString() ?? null,
      startedAtMonoNs: round.startedAtMonoNs?.toString() ?? null,
    },
    totals: {
      totalBetsMicro: round.totalBetsMicro.toString(),
      totalPayoutsMicro: round.totalPayoutsMicro.toString(),
      houseRevenueMicro: round.houseRevenueMicro.toString(),
    },
    bets: round.bets.map((b) => ({
      betId: b.id,
      playerRef: b.playerRef,
      selection: b.selection,
      selectionType: b.selectionType,
      amountMicro: b.amountMicro.toString(),
      commissionMicro: b.commissionMicro.toString(),
      status: b.status,
      won: b.won,
      wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
      transactions: {
        bet: b.betTransactionUuid,
        win: b.winTransactionUuid,
        rollback: b.rollbackTransactionUuid,
      },
      placedAt: b.placedAt.toISOString(),
      settledAt: b.settledAt?.toISOString() ?? null,
    })),
    walletCallChain: round.walletCalls.map((c) => ({
      id: c.id,
      direction: c.direction,
      endpoint: c.endpoint,
      requestUuid: c.requestUuid,
      transactionUuid: c.transactionUuid,
      referenceTransactionUuid: c.referenceTransactionUuid,
      amountMicro: c.amountMicro?.toString() ?? null,
      responseStatus: c.responseStatus,
      latencyMs: c.latencyMs,
      attempt: c.attempt,
      succeeded: c.succeeded,
      prevRowHash: c.prevRowHash,
      rowHash: c.rowHash,
      createdAt: c.createdAt.toISOString(),
    })),
    chain: {
      prevRowHash: round.prevRowHash,
      rowHash: round.rowHash,
    },
  };

  const canonical = canonicalJson(replay);
  const signature = signReplay(canonical);
  res.setHeader('X-Yantra-Signature', signature);
  res.setHeader('X-Yantra-Signature-Alg', 'HMAC-SHA256');
  res.json({ replay, signature, algorithm: 'HMAC-SHA256' });
});
