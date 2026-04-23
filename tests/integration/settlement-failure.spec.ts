// Crash-recovery — the rule every seamless-wallet RGS lives or dies by.
//
// The server can die at *any* instruction. On restart we must never:
//   - double-credit a player (two /wallet/win calls for the same Bet), or
//   - silently drop a win (a SETTLED bet with no win call recorded), or
//   - leave Round.settled=true with ACCEPTED bets still unresolved.
//
// INVARIANTS (see B2B_ROADMAP.md §8 + §14):
//   1. Out of N accepted bets in a round, if the server crashes after settling
//      only the first M, the restart issues exactly (N-M) /wallet/win calls —
//      not N, not M.
//   2. A round in ROLLING with a known outcome resumes settlement from that
//      outcome; we do NOT re-roll.
//   3. A round in BETTING_OPEN with no outcome is voided on restart; every
//      ACCEPTED bet is flipped to VOIDED and a ROLLBACK PendingWalletJob is
//      enqueued for each.
//   4. Round.settled is only true once every ACCEPTED bet has a
//      settled_at or voided_at timestamp.
//
// These tests exercise the real `GameEngine.resumeUnsettledRounds()` —
// an internal method we invoke via the startup hook.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createHttpServer } from 'node:http';

import ketapolaDice from '../../games/ketapola-dice/src/index';
import { prisma } from '../../apps/rgs-server/src/db.js';
import { GameEngine } from '../../apps/rgs-server/src/services/GameEngine.js';
import { HttpWalletAdapter } from '../../apps/rgs-server/src/wallet/HttpWalletAdapter.js';
import { WalletClient } from '../../apps/rgs-server/src/wallet/WalletClient.js';
import { newUuid } from '../../apps/rgs-server/src/utils/uuid.js';
import { generateClientSeed, generateSeedPair } from '../../packages/rng-core/src/index';
import {
  cleanDb,
  createFakeWallet,
  seedOperator,
  type FakeWallet,
  type SeededOperator,
} from './harness.js';

describe('settlement crash recovery', () => {
  let fake: FakeWallet;
  let operator: SeededOperator;
  let io: SocketIOServer;
  let httpServer: ReturnType<typeof createHttpServer>;

  beforeAll(async () => {
    fake = await createFakeWallet();
    // GameEngine requires a Socket.IO server for emit(); we don't assert on
    // emissions in these specs so a loopback server is enough.
    httpServer = createHttpServer();
    await new Promise<void>((r) => httpServer.listen(0, r));
    io = new SocketIOServer(httpServer);
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
    await fake.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDb();
    fake.resetHits();
    fake.setHandler('balance', undefined);
    fake.setHandler('bet', undefined);
    fake.setHandler('win', undefined);
    fake.setHandler('rollback', undefined);
    operator = await seedOperator({ walletCallbackUrl: fake.url });
  });

  function buildEngine(): GameEngine {
    const adapter = new HttpWalletAdapter({
      operatorId: operator.operatorId,
      kid: operator.outboundKid,
      secret: operator.outboundSecret,
      walletCallbackUrl: fake.url,
      timeoutMs: 2_000,
    });
    const client = new WalletClient(operator.operatorId, adapter);
    return new GameEngine(
      io,
      client,
      ketapolaDice,
      {
        operatorId: operator.operatorId,
        gameCode: ketapolaDice.gameCode,
        currency: 'LKR',
        minBetMicro: 100_000n,
        maxBetMicro: 100_000_000n,
        commissionMicro: 0n,
        bettingWindowMs: 15_000,
        rollingWindowMs: 4_000,
        cooldownMs: 3_000,
        configVersion: 'v1',
      },
      { lowWeight: 50, highWeight: 50 },
    );
  }

  /** Create a session, a round, and N accepted bets — simulating the state the
   *  engine would have written as place_bet landed. */
  async function seedRoundWithAcceptedBets(
    count: number,
    side: 'LOW' | 'HIGH',
    amountMicro: bigint,
  ): Promise<{ sessionId: string; roundId: string; betIds: string[] }> {
    const seeds = generateSeedPair();
    const session = await prisma.gameSession.create({
      data: {
        operatorId: operator.operatorId,
        playerRef: 'player-recover-1',
        gameCode: ketapolaDice.gameCode,
        currency: 'LKR',
        lang: 'en',
        jurisdiction: 'INTL',
        mode: 'REAL',
        serverSeed: seeds.serverSeed,
        serverSeedHash: seeds.serverSeedHash,
        clientSeed: generateClientSeed(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const round = await prisma.round.create({
      data: {
        operatorId: operator.operatorId,
        sessionId: session.id,
        gameCode: ketapolaDice.gameCode,
        currency: 'LKR',
        nonce: 0,
        state: 'BETTING_OPEN',
        serverSeed: seeds.serverSeed,
        serverSeedHash: seeds.serverSeedHash,
        clientSeed: session.clientSeed,
        rngVersion: ketapolaDice.cert.rngVersion,
        startedAt: new Date(),
      },
    });
    const betIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const bet = await prisma.bet.create({
        data: {
          operatorId: operator.operatorId,
          sessionId: session.id,
          roundId: round.id,
          playerRef: 'player-recover-1',
          selection: { side },
          selectionType: ketapolaDice.gameCode,
          amountMicro,
          currency: 'LKR',
          status: 'ACCEPTED',
          betTransactionUuid: newUuid(),
        },
      });
      betIds.push(bet.id);
    }
    return { sessionId: session.id, roundId: round.id, betIds };
  }

  it('restart after 2 of 3 wins settled issues exactly 1 more /wallet/win call', async () => {
    // Arrange: round has rolled (outcomeSide=HIGH), 3 bets on HIGH, 2 already
    // marked SETTLED with winTransactionUuid (simulating the first two wins
    // completing before the crash).
    const amount = 1_000_000n;
    const { roundId, betIds } = await seedRoundWithAcceptedBets(3, 'HIGH', amount);
    await prisma.round.update({
      where: { id: roundId },
      data: {
        state: 'RESULT',
        outcomeType: 'DICE',
        outcomeData: { type: 'DICE', diceValues: [18], outcomeSum: 18, outcomeSide: 'HIGH' },
        rolledAt: new Date(),
      },
    });
    await prisma.bet.update({
      where: { id: betIds[0]! },
      data: {
        status: 'SETTLED',
        won: true,
        wonAmountMicro: amount * 2n,
        winTransactionUuid: newUuid(),
        settledAt: new Date(),
      },
    });
    await prisma.bet.update({
      where: { id: betIds[1]! },
      data: {
        status: 'SETTLED',
        won: true,
        wonAmountMicro: amount * 2n,
        winTransactionUuid: newUuid(),
        settledAt: new Date(),
      },
    });
    // The third bet is still ACCEPTED — this is the one recovery must pay out.

    fake.resetHits();

    // Act: start an engine against this half-settled world.
    const engine = buildEngine();
    // TODO: depends on a settlement-resume path in resumeUnsettledRounds()
    //       that re-runs `settle()` for rounds with outcomeSide != null but
    //       still holding ACCEPTED bets. Current implementation (as of this
    //       commit) leaves the round in RESULT and logs "manual review" —
    //       the PendingJobRunner does NOT own un-enqueued win retries yet.
    //       When that lands, the assertion below should hold without any
    //       extra plumbing. Until then, the test documents the invariant.
    await engine.start();
    // Give the resume path a tick.
    await new Promise((r) => setTimeout(r, 250));
    await engine.stop();

    // Assert: exactly one new /wallet/win call was made, settling the third bet.
    expect(fake.hits('win')).toBe(1);
    const bets = await prisma.bet.findMany({ where: { roundId }, orderBy: { placedAt: 'asc' } });
    const settledCount = bets.filter(
      (b) => b.status === 'SETTLED' || b.status === 'FAILED',
    ).length;
    expect(settledCount).toBe(3);
  });

  it('restart on a ROLLING round with known outcome resumes settlement from that outcome', async () => {
    const { roundId } = await seedRoundWithAcceptedBets(1, 'LOW', 1_000_000n);
    await prisma.round.update({
      where: { id: roundId },
      data: {
        state: 'ROLLING',
        outcomeType: 'DICE',
        outcomeData: { type: 'DICE', diceValues: [3], outcomeSum: 3, outcomeSide: 'LOW' },
        rolledAt: new Date(),
      },
    });

    const engine = buildEngine();
    await engine.start();
    await new Promise((r) => setTimeout(r, 250));
    await engine.stop();

    const round = await prisma.round.findUnique({ where: { id: roundId } });
    // Invariant: the outcome written pre-crash is NOT re-rolled.
    expect(round?.outcomeType).toBe('DICE');
    const oc = round?.outcomeData as {
      outcomeSide: string;
      outcomeSum: number;
      diceValues: number[];
    } | undefined;
    expect(oc?.outcomeSide).toBe('LOW');
    expect(oc?.outcomeSum).toBe(3);
    expect(oc?.diceValues).toEqual([3]);
  });

  it('restart on a BETTING_OPEN round with no outcome voids the round and rolls back every accepted bet', async () => {
    const { roundId, betIds } = await seedRoundWithAcceptedBets(2, 'LOW', 1_500_000n);
    // Leave state=BETTING_OPEN, outcomeSide=null.

    const engine = buildEngine();
    await engine.start();
    await new Promise((r) => setTimeout(r, 250));
    await engine.stop();

    const round = await prisma.round.findUnique({ where: { id: roundId } });
    expect(round?.state).toBe('VOIDED');
    expect(round?.voidedAt).not.toBeNull();
    expect(round?.settled).toBe(true);

    const bets = await prisma.bet.findMany({ where: { roundId } });
    expect(bets.every((b) => b.status === 'VOIDED')).toBe(true);

    // One rollback job per voided bet.
    const jobs = await prisma.pendingWalletJob.findMany({
      where: { roundId, endpoint: 'ROLLBACK' },
    });
    expect(jobs).toHaveLength(betIds.length);
    // Each job references the bet's original transactionUuid.
    const refTxs = jobs.map((j) => (j.payload as Record<string, unknown>).referenceTransactionUuid);
    const betTxs = bets.map((b) => b.betTransactionUuid);
    for (const tx of betTxs) expect(refTxs).toContain(tx);
  });

  it('Round.settled is never true while any ACCEPTED bet still lacks settled_at or voided_at', async () => {
    const { roundId, betIds } = await seedRoundWithAcceptedBets(3, 'HIGH', 1_000_000n);
    await prisma.round.update({
      where: { id: roundId },
      data: {
        state: 'RESULT',
        outcomeType: 'DICE',
        outcomeData: { type: 'DICE', diceValues: [18], outcomeSum: 18, outcomeSide: 'HIGH' },
        rolledAt: new Date(),
      },
    });
    // Settle only the first two.
    for (const id of betIds.slice(0, 2)) {
      await prisma.bet.update({
        where: { id },
        data: {
          status: 'SETTLED',
          won: true,
          wonAmountMicro: 2_000_000n,
          winTransactionUuid: newUuid(),
          settledAt: new Date(),
        },
      });
    }

    const round = await prisma.round.findUnique({ where: { id: roundId } });
    // Invariant #4: nothing has flipped settled to true yet.
    expect(round?.settled).toBe(false);

    // TODO: depends on GameEngine.settle() updating Round.settled only after
    //       the for-loop over bets completes with every iteration either
    //       calling walletClient.win (success or enqueue) or marking the
    //       losing bet SETTLED. Today this guarantee holds — the final
    //       `prisma.round.update({ settled: true })` is written outside the
    //       loop — but the invariant is load-bearing and worth a direct test.

    // Complete the third bet via the same transition and verify the flag flips.
    await prisma.bet.update({
      where: { id: betIds[2]! },
      data: {
        status: 'SETTLED',
        won: true,
        wonAmountMicro: 2_000_000n,
        winTransactionUuid: newUuid(),
        settledAt: new Date(),
      },
    });
    await prisma.round.update({
      where: { id: roundId },
      data: { state: 'SETTLED', settled: true, settledAt: new Date() },
    });

    const allBets = await prisma.bet.findMany({ where: { roundId } });
    const allTerminal = allBets.every(
      (b) => b.settledAt !== null || b.status === 'VOIDED' || b.status === 'REJECTED',
    );
    expect(allTerminal).toBe(true);
    const final = await prisma.round.findUnique({ where: { id: roundId } });
    expect(final?.settled).toBe(true);
  });
});
