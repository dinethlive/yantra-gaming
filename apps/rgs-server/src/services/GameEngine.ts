import type {
  BetSelection,
  GameMathConfig,
  GameOutcome,
  GamePlugin,
} from '@yantra/game-contract';
import { generateClientSeed, generateSeedPair } from '@yantra/rng-core';
import type { Server as SocketIOServer } from 'socket.io';
import type { Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  betToSettlementMs,
  roundStateTransitions,
} from '../telemetry/index.js';
import { newUuid } from '../utils/uuid.js';
import type { WalletClient } from '../wallet/WalletClient.js';
import { hashRow, latestRoundTip, roundHashInput } from './AuditChain.js';
import { buildAttestation } from './BuildAttestation.js';
import { checkRGLimits } from './RGLimitsEnforcer.js';
import { dispatchEvent } from './WebhookDispatcher.js';
import {
  type BetRequest,
  isRejectStatus,
  isSuccessOrDuplicate,
  RsStatus,
} from '../wallet/types.js';

export type EnginePhase = 'PENDING' | 'BETTING_OPEN' | 'ROLLING' | 'RESULT' | 'SETTLED';

export interface EngineConfig {
  operatorId: string;
  gameCode: string;           // matches plugin.gameCode
  currency: string;
  minBetMicro: bigint;
  maxBetMicro: bigint;
  commissionMicro: bigint;
  bettingWindowMs: number;
  rollingWindowMs: number;
  cooldownMs: number;
  /** Tag of the math config schema used at round creation time. */
  configVersion: string;
}

export interface PlaceBetInput {
  amountMicro: bigint;
  selection: BetSelection;    // already validated by plugin.selectionSchema at the socket layer
  autoplay?: boolean;
  turbo?: boolean;
}

interface ActiveRound {
  id: string;
  nonce: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  phase: EnginePhase;
  phaseStartedAt: number;
  phaseDurationMs: number;
}

export class GameEngine {
  private active: ActiveRound | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopSignal: Promise<void> = Promise.resolve();

  readonly key: string;

  constructor(
    private readonly io: SocketIOServer,
    private readonly walletClient: WalletClient,
    readonly plugin: GamePlugin,
    private cfg: EngineConfig,
    private gameConfig: GameMathConfig,
  ) {
    this.key = `${cfg.operatorId}:${plugin.gameCode}:${cfg.currency}`;
  }

  updateConfig(patch: Partial<EngineConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Swap the plugin math config (e.g. live-updated via portal). */
  updateGameConfig(next: GameMathConfig): void {
    this.gameConfig = next;
  }

  /** Read-only view of the active engine config. */
  get config(): Readonly<EngineConfig> {
    return this.cfg;
  }

  get currentRoundId(): string | null {
    return this.active?.id ?? null;
  }

  get phase(): EnginePhase {
    return this.active?.phase ?? 'PENDING';
  }

  /**
   * Snapshot of the live round for a newly-joined socket. The regular engine
   * emits only on phase transitions, so a player connecting mid-round would
   * otherwise sit with a blank UI until the next transition.
   */
  get currentRoundSnapshot(): {
    roundId: string;
    nonce: number;
    roundNumber: number;
    phase: EnginePhase;
    phaseDurationMs: number;
    phaseRemainingMs: number;
    serverSeedHash: string;
    clientSeed: string;
  } | null {
    if (!this.active) return null;
    const elapsed = Date.now() - this.active.phaseStartedAt;
    const remaining = Math.max(0, this.active.phaseDurationMs - elapsed);
    return {
      roundId: this.active.id,
      nonce: this.active.nonce,
      roundNumber: this.active.nonce + 1,
      phase: this.active.phase,
      phaseDurationMs: this.active.phaseDurationMs,
      phaseRemainingMs: remaining,
      serverSeedHash: this.active.serverSeedHash,
      clientSeed: this.active.clientSeed,
    };
  }

  getWalletClient() {
    return this.walletClient;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.resumeUnsettledRounds();
    this.running = true;
    this.stopSignal = new Promise((r) => {
      this.stopResolve = r;
    });
    logger.info('GameEngine starting', { key: this.key });
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopResolve?.();
    if (this.loop) await this.loop;
    logger.info('GameEngine stopped', { key: this.key });
  }

  private room(): string {
    return `operator:${this.cfg.operatorId}:${this.plugin.gameCode}:${this.cfg.currency}`;
  }

  private emit(event: string, payload: unknown): void {
    this.io.to(this.room()).emit(event, payload);
  }

  /* ── Main loop ─────────────────────────────────────────── */

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.openBetting();
        await this.rollAndReveal();
        await this.settle();
      } catch (err) {
        logger.error('engine loop error', { key: this.key, err: (err as Error).message });
        await this.wait(1000);
      }
      if (!this.running) break;
      await this.wait(this.cfg.cooldownMs);
    }
  }

  private async openBetting(): Promise<void> {
    const round = await this.createRound();
    this.active = {
      id: round.id,
      nonce: round.nonce,
      serverSeed: round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      phase: 'BETTING_OPEN',
      phaseStartedAt: Date.now(),
      phaseDurationMs: this.cfg.bettingWindowMs,
    };
    roundStateTransitions.inc({
      operator: this.cfg.operatorId,
      game: this.plugin.gameCode,
      to_state: 'BETTING_OPEN',
    });
    this.emit('round_state', {
      roundId: round.id,
      nonce: round.nonce,
      roundNumber: round.nonce + 1,
      phase: 'BETTING_OPEN',
      phaseDurationMs: this.cfg.bettingWindowMs,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
    });
    await this.wait(this.cfg.bettingWindowMs);
  }

  private async rollAndReveal(): Promise<void> {
    if (!this.active) return;
    this.active.phase = 'ROLLING';
    this.active.phaseStartedAt = Date.now();
    this.active.phaseDurationMs = this.cfg.rollingWindowMs;
    await prisma.round.update({ where: { id: this.active.id }, data: { state: 'ROLLING' } });
    this.emit('round_state', {
      roundId: this.active.id,
      nonce: this.active.nonce,
      roundNumber: this.active.nonce + 1,
      phase: 'ROLLING',
      phaseDurationMs: this.cfg.rollingWindowMs,
    });
    await this.wait(this.cfg.rollingWindowMs);

    const outcome = this.plugin.computeOutcome(
      {
        serverSeed: this.active.serverSeed,
        clientSeed: this.active.clientSeed,
        nonce: this.active.nonce,
      },
      this.gameConfig,
    );

    await prisma.round.update({
      where: { id: this.active.id },
      data: {
        state: 'RESULT',
        outcomeType: outcome.type,
        outcomeData: outcome as unknown as Prisma.InputJsonValue,
        rolledAt: new Date(),
      },
    });

    this.active.phase = 'RESULT';
    this.active.phaseStartedAt = Date.now();

    const wire = this.plugin.outcomeForWire(outcome);
    this.emit('round_result', {
      roundId: this.active.id,
      nonce: this.active.nonce,
      roundNumber: this.active.nonce + 1,
      outcomeType: wire.outcomeType,
      outcome: wire.outcome,
    });
  }

  private async settle(): Promise<void> {
    if (!this.active) return;
    const roundId = this.active.id;
    const round = await prisma.round.findUnique({ where: { id: roundId } });
    if (!round || !round.outcomeData || !round.outcomeType) return;

    const outcome = round.outcomeData as unknown as GameOutcome;
    const bets = await prisma.bet.findMany({
      where: { roundId, status: 'ACCEPTED' },
      orderBy: { placedAt: 'asc' },
    });

    let totalPayout = 0n;
    for (const bet of bets) {
      const result = this.plugin.settleBet({
        selection: bet.selection as BetSelection,
        amountMicro: bet.amountMicro,
        outcome,
        config: this.gameConfig,
        commissionMicro: this.cfg.commissionMicro,
      });

      if (!result.won) {
        await prisma.bet.update({
          where: { id: bet.id },
          data: { status: 'SETTLED', won: false, wonAmountMicro: 0n, settledAt: new Date() },
        });
        await prisma.pendingRoundBet.updateMany({
          where: { betId: bet.id, state: 'HELD' },
          data: { state: 'RESOLVED', resolvedAt: new Date(), resolutionReason: 'LOSS' },
        });
        continue;
      }

      const payout = result.payoutMicro;
      totalPayout += payout;

      const session = await prisma.gameSession.findUnique({ where: { id: bet.sessionId } });
      if (!session) continue;

      const winTxUuid = newUuid();
      const requestUuid = newUuid();

      const res = await this.walletClient.win(
        {
          requestUuid,
          transactionUuid: winTxUuid,
          referenceTransactionUuid: bet.betTransactionUuid,
          operatorId: bet.operatorId,
          playerRef: bet.playerRef,
          currency: bet.currency,
          gameCode: round.gameCode,
          amountMicro: payout,
          roundId: round.id,
          meta: {
            selection: bet.selection,
            outcomeType: round.outcomeType,
            ...(result.winMeta ?? {}),
          },
        },
        { sessionId: bet.sessionId, roundId: round.id },
      );

      if (isSuccessOrDuplicate(res.status)) {
        await prisma.bet.update({
          where: { id: bet.id },
          data: {
            status: 'SETTLED',
            won: true,
            wonAmountMicro: payout,
            winTransactionUuid: winTxUuid,
            settledAt: new Date(),
          },
        });
        await prisma.pendingRoundBet.updateMany({
          where: { betId: bet.id, state: 'HELD' },
          data: { state: 'RESOLVED', resolvedAt: new Date(), resolutionReason: 'WIN' },
        });
        this.emit('balance_update', {
          playerRef: bet.playerRef,
          balanceMicro: res.balanceMicro?.toString() ?? null,
          currency: bet.currency,
        });
      } else {
        // Critical path: we owe this player money and the operator hasn't confirmed.
        // Enqueue a durable retry; never swallow.
        await prisma.bet.update({
          where: { id: bet.id },
          data: { status: 'FAILED', winTransactionUuid: winTxUuid },
        });
        await prisma.pendingWalletJob.create({
          data: {
            operatorId: bet.operatorId,
            endpoint: 'WIN',
            betId: bet.id,
            roundId: round.id,
            payload: {
              requestUuid,
              transactionUuid: winTxUuid,
              referenceTransactionUuid: bet.betTransactionUuid,
              playerRef: bet.playerRef,
              currency: bet.currency,
              gameCode: round.gameCode,
              amountMicro: payout.toString(),
              roundId: round.id,
            },
            lastError: res.message ?? res.status,
          },
        });
      }
    }

    await prisma.round.update({
      where: { id: roundId },
      data: {
        state: 'SETTLED',
        settled: true,
        settledAt: new Date(),
        totalPayoutsMicro: totalPayout,
      },
    });
    if (this.active) this.active.phase = 'SETTLED';
    roundStateTransitions.inc({
      operator: this.cfg.operatorId,
      game: this.plugin.gameCode,
      to_state: 'SETTLED',
    });

    // Emit round.settled webhook event. Fire-and-forget: failure to queue a
    // webhook MUST NOT block settlement.
    void dispatchEvent({
      operatorId: this.cfg.operatorId,
      eventType: 'round.settled',
      data: {
        roundId,
        sessionId: round.sessionId,
        gameCode: round.gameCode,
        currency: round.currency,
        outcomeType: round.outcomeType,
        outcome: round.outcomeData,
        totalBetsMicro: round.totalBetsMicro.toString(),
        totalPayoutsMicro: totalPayout.toString(),
        settledAt: new Date().toISOString(),
        rngVersion: round.rngVersion,
      },
    }).catch((err) =>
      logger.warn('webhook_dispatch_round_settled_failed', {
        roundId,
        err: (err as Error).message,
      }),
    );
    // bet→settlement latency proxy: settlement completed this many ms after
    // the last bet was placed. Cheap heuristic — does not fan out per bet,
    // just records one sample per round.
    if (bets.length > 0) {
      const lastBetPlacedAt = bets.reduce(
        (acc, b) => (b.placedAt.getTime() > acc ? b.placedAt.getTime() : acc),
        0,
      );
      betToSettlementMs.observe(
        {
          operator: this.cfg.operatorId,
          game: this.plugin.gameCode,
          currency: this.cfg.currency,
        },
        Date.now() - lastBetPlacedAt,
      );
    }
  }

  /* ── place_bet (socket) ────────────────────────────────── */

  async placeBet(
    params: {
      sessionId: string;
      playerRef: string;
      operatorId: string;
      currency: string;
      input: PlaceBetInput;
    },
  ): Promise<{ ok: true; betId: string } | { ok: false; reason: string }> {
    if (!this.active || this.active.phase !== 'BETTING_OPEN') {
      return { ok: false, reason: 'betting_closed' };
    }
    if (params.operatorId !== this.cfg.operatorId || params.currency !== this.cfg.currency) {
      return { ok: false, reason: 'engine_mismatch' };
    }

    const amount = params.input.amountMicro;
    if (amount < this.cfg.minBetMicro || amount > this.cfg.maxBetMicro) {
      this.io.to(`session:${params.sessionId}`).emit('bet_rejected', { reason: 'bet_out_of_range' });
      return { ok: false, reason: 'bet_out_of_range' };
    }

    // Session / RG-limit gating. Cheap reads that run before any wallet call
    // fires, so a limit-breach bet is never debited at the operator.
    const session = await prisma.gameSession.findUnique({
      where: { id: params.sessionId },
    });
    if (!session) {
      this.io.to(`session:${params.sessionId}`).emit('bet_rejected', { reason: 'session_not_found' });
      return { ok: false, reason: 'session_not_found' };
    }
    if (session.terminatedAt) {
      this.io.to(`session:${params.sessionId}`).emit('bet_rejected', {
        reason: 'session_terminated',
        detail: session.terminationReason ?? null,
      });
      return { ok: false, reason: 'session_terminated' };
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      this.io.to(`session:${params.sessionId}`).emit('bet_rejected', { reason: 'session_expired' });
      return { ok: false, reason: 'session_expired' };
    }

    const previousBet = await prisma.bet.findFirst({
      where: { sessionId: params.sessionId, status: { in: ['ACCEPTED', 'SETTLED'] } },
      orderBy: { placedAt: 'desc' },
      select: { placedAt: true },
    });
    const rgCheck = await checkRGLimits({
      session,
      stakeMicro: amount,
      betContext: {
        autoplay: params.input.autoplay,
        turbo: params.input.turbo,
        timeSincePreviousBetMs: previousBet
          ? Date.now() - previousBet.placedAt.getTime()
          : undefined,
      },
    });
    if (!rgCheck.allowed) {
      logger.info('bet_rejected_rg_limit', {
        operatorId: params.operatorId,
        sessionId: params.sessionId,
        playerRef: params.playerRef,
        reason: rgCheck.reason,
        remainingMicro: rgCheck.remainingMicro?.toString() ?? null,
      });
      this.io.to(`session:${params.sessionId}`).emit('bet_rejected', {
        reason: rgCheck.reason ?? 'rg_limit_reached',
        remainingMicro: rgCheck.remainingMicro?.toString() ?? null,
      });
      void dispatchEvent({
        operatorId: params.operatorId,
        eventType: 'session.rg_limit_tripped',
        data: {
          sessionId: params.sessionId,
          playerRef: params.playerRef,
          limitType: rgCheck.reason ?? 'rg_limit_reached',
          remainingMicro: rgCheck.remainingMicro?.toString() ?? null,
          stakeMicro: amount.toString(),
          attemptedAt: new Date().toISOString(),
        },
      }).catch(() => {});
      if (rgCheck.reason === 'session_time_exceeded') {
        await prisma.gameSession.update({
          where: { id: params.sessionId },
          data: {
            terminatedAt: new Date(),
            terminationReason: 'rg_session_time_exceeded',
          },
        });
      }
      return { ok: false, reason: rgCheck.reason ?? 'rg_limit_reached' };
    }

    const txUuid = newUuid();
    const requestUuid = newUuid();
    const round = this.active;

    const bet = await prisma.bet.create({
      data: {
        operatorId: params.operatorId,
        sessionId: params.sessionId,
        roundId: round.id,
        playerRef: params.playerRef,
        selection: params.input.selection as Prisma.InputJsonValue,
        selectionType: this.plugin.gameCode,
        amountMicro: amount,
        commissionMicro: this.cfg.commissionMicro,
        currency: params.currency,
        status: 'PENDING',
        betTransactionUuid: txUuid,
      },
    });

    const betReq: BetRequest = {
      requestUuid,
      transactionUuid: txUuid,
      operatorId: params.operatorId,
      playerRef: params.playerRef,
      currency: params.currency,
      gameCode: this.plugin.gameCode,
      amountMicro: amount,
      roundId: round.id,
      meta: {
        selection: params.input.selection,
        clientSeed: round.clientSeed,
        nonce: round.nonce,
      },
    };

    const res = await this.walletClient.bet(betReq, {
      sessionId: params.sessionId,
      roundId: round.id,
    });

    if (isSuccessOrDuplicate(res.status)) {
      await prisma.bet.update({
        where: { id: bet.id },
        data: { status: 'ACCEPTED' },
      });
      // GLI-19 §3 pending-round-bet register.
      await prisma.pendingRoundBet.create({
        data: {
          operatorId: params.operatorId,
          betId: bet.id,
          roundId: round.id,
          state: 'HELD',
        },
      });
      await prisma.round.update({
        where: { id: round.id },
        data: { totalBetsMicro: { increment: amount } },
      });
      this.io.to(`session:${params.sessionId}`).emit('balance_update', {
        playerRef: params.playerRef,
        balanceMicro: res.balanceMicro?.toString() ?? null,
        currency: params.currency,
      });
      this.emit('bet_placed', {
        roundId: round.id,
        selection: params.input.selection,
        amountMicro: amount.toString(),
      });
      return { ok: true, betId: bet.id };
    }

    if (isRejectStatus(res.status)) {
      await prisma.bet.update({
        where: { id: bet.id },
        data: { status: 'REJECTED' },
      });
      this.io
        .to(`session:${params.sessionId}`)
        .emit('bet_rejected', { reason: res.status });
      return { ok: false, reason: res.status };
    }

    // Uncertain — enqueue rollback, reject bet to player.
    await prisma.bet.update({
      where: { id: bet.id },
      data: { status: 'REJECTED' },
    });
    await prisma.pendingWalletJob.create({
      data: {
        operatorId: params.operatorId,
        endpoint: 'ROLLBACK',
        betId: bet.id,
        roundId: round.id,
        payload: {
          requestUuid: newUuid(),
          transactionUuid: newUuid(),
          referenceTransactionUuid: txUuid,
          playerRef: params.playerRef,
          currency: params.currency,
          gameCode: this.plugin.gameCode,
          roundId: round.id,
        },
        lastError: res.message ?? res.status,
      },
    });
    this.io.to(`session:${params.sessionId}`).emit('bet_rejected', {
      reason: res.status === RsStatus.TIMEOUT ? 'wallet_timeout' : 'wallet_error',
    });
    return { ok: false, reason: res.status };
  }

  /* ── Lifecycle helpers ─────────────────────────────────── */

  private async createRound() {
    const engineSession = await this.getOrCreateEngineSession();

    const buildHash = buildAttestation.currentBuildHash();
    const startedAt = new Date();
    const startedAtMonoNs = process.hrtime.bigint();

    const round = await prisma.round.create({
      data: {
        operatorId: this.cfg.operatorId,
        sessionId: engineSession.id,
        gameCode: this.plugin.gameCode,
        currency: this.cfg.currency,
        nonce: engineSession.nonce,
        state: 'BETTING_OPEN',
        serverSeed: engineSession.serverSeed,
        serverSeedHash: engineSession.serverSeedHash,
        clientSeed: engineSession.clientSeed,
        rngVersion: this.plugin.cert.rngVersion,
        gameConfigVersion: this.cfg.configVersion,
        buildHash,
        startedAt,
        startedAtMonoNs,
      },
    });

    try {
      const prevRowHash = await latestRoundTip(this.cfg.operatorId);
      const rowHash = hashRow(prevRowHash, roundHashInput(round));
      await prisma.round.update({
        where: { id: round.id },
        data: { prevRowHash, rowHash },
      });
    } catch (err) {
      logger.error('round_chain_hash_failed', {
        roundId: round.id,
        err: (err as Error).message,
      });
    }

    await prisma.gameSession.update({
      where: { id: engineSession.id },
      data: { nonce: { increment: 1 } },
    });
    return round;
  }

  private async getOrCreateEngineSession() {
    const playerRef = `__engine__:${this.plugin.gameCode}:${this.cfg.currency}`;
    const existing = await prisma.gameSession.findFirst({
      where: {
        operatorId: this.cfg.operatorId,
        playerRef,
        terminatedAt: null,
      },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) return existing;

    const seeds = generateSeedPair();
    return prisma.gameSession.create({
      data: {
        operatorId: this.cfg.operatorId,
        playerRef,
        gameCode: this.plugin.gameCode,
        currency: this.cfg.currency,
        lang: 'en',
        jurisdiction: 'INTL',
        mode: 'REAL',
        serverSeed: seeds.serverSeed,
        serverSeedHash: seeds.serverSeedHash,
        clientSeed: generateClientSeed(),
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      },
    });
  }

  private async resumeUnsettledRounds(): Promise<void> {
    const stuck = await prisma.round.findMany({
      where: {
        operatorId: this.cfg.operatorId,
        gameCode: this.plugin.gameCode,
        currency: this.cfg.currency,
        settled: false,
      },
    });
    for (const r of stuck) {
      if (r.outcomeData && r.outcomeType) {
        // Outcome known — rehydrate settlement by enqueueing WIN jobs for
        // unresolved winning bets and marking losers as SETTLED.
        logger.warn('resuming round with known outcome', {
          roundId: r.id,
          outcomeType: r.outcomeType,
        });

        const outcome = r.outcomeData as unknown as GameOutcome;
        const unresolved = await prisma.bet.findMany({
          where: {
            roundId: r.id,
            status: { in: ['ACCEPTED', 'FAILED'] },
          },
        });

        let totalPayout = 0n;
        for (const bet of unresolved) {
          const result = this.plugin.settleBet({
            selection: bet.selection as BetSelection,
            amountMicro: bet.amountMicro,
            outcome,
            config: this.gameConfig,
            commissionMicro: this.cfg.commissionMicro,
          });
          if (!result.won) {
            await prisma.bet.update({
              where: { id: bet.id },
              data: {
                status: 'SETTLED',
                won: false,
                wonAmountMicro: 0n,
                settledAt: new Date(),
              },
            });
            await prisma.pendingRoundBet.updateMany({
              where: { betId: bet.id, state: 'HELD' },
              data: {
                state: 'RESOLVED',
                resolvedAt: new Date(),
                resolutionReason: 'LOSS_ON_RESUME',
              },
            });
            continue;
          }

          const payout = result.payoutMicro;
          totalPayout += payout;

          const winTxUuid = bet.winTransactionUuid ?? newUuid();
          const requestUuid = newUuid();

          await prisma.pendingWalletJob.create({
            data: {
              operatorId: bet.operatorId,
              endpoint: 'WIN',
              betId: bet.id,
              roundId: r.id,
              payload: {
                requestUuid,
                transactionUuid: winTxUuid,
                referenceTransactionUuid: bet.betTransactionUuid,
                playerRef: bet.playerRef,
                currency: bet.currency,
                gameCode: r.gameCode,
                amountMicro: payout.toString(),
                roundId: r.id,
              },
              lastError: 'resumed_from_unsettled_round',
            },
          });
          await prisma.bet.update({
            where: { id: bet.id },
            data: { status: 'FAILED', winTransactionUuid: winTxUuid },
          });
        }

        await prisma.round.update({
          where: { id: r.id },
          data: {
            state: 'SETTLED',
            settled: true,
            settledAt: new Date(),
            totalPayoutsMicro: totalPayout,
          },
        });
        continue;
      }

      // Outcome unknown: void the round, roll back every accepted bet, and
      // move the pending register to REFUNDED. Disconnect-refund path for
      // GLI-19 §3.
      logger.warn('voiding incomplete round', { roundId: r.id });
      await prisma.round.update({
        where: { id: r.id },
        data: { state: 'VOIDED', voidedAt: new Date(), settled: true },
      });
      const accepted = await prisma.bet.findMany({
        where: { roundId: r.id, status: 'ACCEPTED' },
      });
      for (const b of accepted) {
        await prisma.bet.update({ where: { id: b.id }, data: { status: 'VOIDED' } });
        await prisma.pendingRoundBet.updateMany({
          where: { betId: b.id, state: 'HELD' },
          data: {
            state: 'REFUNDED',
            refundedAt: new Date(),
            resolutionReason: 'ROUND_VOIDED',
          },
        });
        await prisma.pendingWalletJob.create({
          data: {
            operatorId: b.operatorId,
            endpoint: 'ROLLBACK',
            betId: b.id,
            roundId: r.id,
            payload: {
              requestUuid: newUuid(),
              transactionUuid: newUuid(),
              referenceTransactionUuid: b.betTransactionUuid,
              playerRef: b.playerRef,
              currency: b.currency,
              gameCode: r.gameCode,
              roundId: r.id,
            },
          },
        });
      }
    }
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await Promise.race([
      new Promise<void>((res) => setTimeout(res, ms)),
      this.stopSignal,
    ]);
  }
}
