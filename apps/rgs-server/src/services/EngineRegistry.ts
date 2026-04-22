import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { getPlugin } from '../games/registry.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../utils/secrets.js';
import { HttpWalletAdapter } from '../wallet/HttpWalletAdapter.js';
import { InternalWalletAdapter } from '../wallet/InternalWalletAdapter.js';
import { WalletClient } from '../wallet/WalletClient.js';
import type { WalletAdapter } from '../wallet/WalletAdapter.js';
import { buildAttestation } from './BuildAttestation.js';
import { GameEngine, type EngineConfig } from './GameEngine.js';
import { globalKillSwitch } from './GlobalKillSwitch.js';

export interface EngineSnapshot {
  operatorId: string;
  gameCode: string;
  currency: string;
  phase: string;
  currentRoundId: string | null;
  currentNonce: number | null;
  bettingWindowMs: number;
  breakers: ReturnType<ReturnType<GameEngine['getWalletClient']>['breakerSnapshot']>;
}

export class EngineRegistry {
  private engines = new Map<string, GameEngine>();
  private fallbackInternal = new InternalWalletAdapter();

  constructor(private readonly io: SocketIOServer) {}

  keyFor(operatorId: string, gameCode: string, currency: string): string {
    return `${operatorId}:${gameCode}:${currency}`;
  }

  get(operatorId: string, gameCode: string, currency: string): GameEngine | undefined {
    return this.engines.get(this.keyFor(operatorId, gameCode, currency));
  }

  /** Returns engine for the given session context, starting it on demand. */
  async forSession(session: { operatorId: string; gameCode: string; currency: string }): Promise<GameEngine | null> {
    const existing = this.get(session.operatorId, session.gameCode, session.currency);
    if (existing) return existing;
    return this.ensure(session.operatorId, session.gameCode, session.currency);
  }

  async startAllEnabled(): Promise<void> {
    const configs = await prisma.operatorGameConfig.findMany({
      where: { enabled: true, operator: { status: 'ACTIVE' } },
      include: { operator: true },
    });
    let skipped = 0;
    for (const c of configs) {
      if (!c.micaCompliant) {
        logger.warn('engine_skipped_mica_gate', {
          operatorId: c.operatorId,
          gameCode: c.gameCode,
          currency: c.currency,
        });
        skipped += 1;
        continue;
      }
      await this.ensure(c.operatorId, c.gameCode, c.currency);
    }
    logger.info('EngineRegistry started', {
      count: this.engines.size,
      skippedForMica: skipped,
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.stop()));
    this.engines.clear();
  }

  /**
   * Snapshot of every running engine. Feeds `GET /v1/admin/engines` and the
   * aggregate circuit-breaker view. Engine counts are low (N operators × M
   * currencies) so O(n) is fine.
   */
  snapshot(filter?: { operatorId?: string }): EngineSnapshot[] {
    const out: EngineSnapshot[] = [];
    for (const engine of this.engines.values()) {
      const cfg = engine.config;
      if (filter?.operatorId && cfg.operatorId !== filter.operatorId) continue;
      const round = engine.currentRoundSnapshot;
      out.push({
        operatorId: cfg.operatorId,
        gameCode: cfg.gameCode,
        currency: cfg.currency,
        phase: round?.phase ?? 'PENDING',
        currentRoundId: round?.roundId ?? null,
        currentNonce: round?.nonce ?? null,
        bettingWindowMs: cfg.bettingWindowMs,
        breakers: engine.getWalletClient().breakerSnapshot(),
      });
    }
    return out;
  }

  async ensure(operatorId: string, gameCode: string, currency: string): Promise<GameEngine | null> {
    const key = this.keyFor(operatorId, gameCode, currency);
    const existing = this.engines.get(key);
    if (existing) return existing;

    // Global kill-switch — hard refusal, independent of any tenant
    // state. Engaged by ops during an incident; disengaged by ops.
    if (await globalKillSwitch.isEngaged()) {
      logger.error('engine_ensure_blocked_global_kill_switch', {
        operatorId,
        gameCode,
        currency,
      });
      return null;
    }

    const plugin = getPlugin(gameCode);
    if (!plugin) {
      logger.error('engine_ensure_blocked_unknown_game', { operatorId, gameCode, currency });
      return null;
    }

    const cfg = await prisma.operatorGameConfig.findUnique({
      where: { operatorId_gameCode_currency: { operatorId, gameCode, currency } },
    });
    if (!cfg || !cfg.enabled) return null;
    if (!cfg.micaCompliant) {
      logger.warn('engine_ensure_blocked_mica_gate', {
        operatorId,
        gameCode,
        currency,
      });
      return null;
    }

    const parsedConfig = plugin.configSchema.safeParse(cfg.configJson);
    if (!parsedConfig.success) {
      logger.error('engine_ensure_blocked_invalid_plugin_config', {
        operatorId,
        gameCode,
        currency,
        issues: parsedConfig.error.issues,
      });
      return null;
    }

    // Runtime cert-gate: refuse to start an engine whose live build hash
    // is not certified for this (operator, game, jurisdiction). Non-strict
    // mode logs only; strict mode (RGS_CERT_STRICT=1) blocks.
    const operatorRow = await prisma.operator.findUnique({
      where: { id: operatorId },
      select: { jurisdiction: true, testMode: true },
    });
    if (operatorRow && !operatorRow.testMode) {
      const att = await buildAttestation.check({
        operatorId,
        gameCode,
        jurisdiction: operatorRow.jurisdiction,
      });
      if (!att.allowed) {
        logger.error('engine_ensure_blocked_build_attestation', {
          operatorId,
          gameCode,
          currency,
          reason: att.reason,
          buildHash: att.buildHash,
          certifiedBuildHash: att.certifiedBuildHash,
        });
        return null;
      }
      if (att.reason) {
        logger.warn('engine_ensure_build_attestation_warning', {
          operatorId,
          gameCode,
          currency,
          reason: att.reason,
        });
      }
    }

    const adapter = await this.buildAdapter(operatorId);
    const walletClient = new WalletClient(operatorId, adapter);

    const engineCfg: EngineConfig = {
      operatorId,
      gameCode,
      currency,
      minBetMicro: cfg.minBetMicro,
      maxBetMicro: cfg.maxBetMicro,
      commissionMicro: cfg.commissionMicro,
      bettingWindowMs: cfg.bettingWindowMs,
      rollingWindowMs: cfg.rollingWindowMs,
      cooldownMs: cfg.cooldownMs,
      configVersion: cfg.configVersion,
    };

    const engine = new GameEngine(
      this.io,
      walletClient,
      plugin,
      engineCfg,
      parsedConfig.data,
    );
    this.engines.set(key, engine);
    await engine.start();
    return engine;
  }

  private async buildAdapter(operatorId: string): Promise<WalletAdapter> {
    const operator = await prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator) return this.fallbackInternal;

    const cred = await prisma.operatorCredential.findFirst({
      where: { operatorId, type: 'WALLET_HMAC_OUTBOUND', revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!cred || !operator.walletCallbackUrl) {
      logger.warn('operator has no wallet credentials — falling back to InternalWalletAdapter', {
        operatorId,
      });
      return this.fallbackInternal;
    }

    return new HttpWalletAdapter({
      operatorId,
      kid: cred.kid,
      secret: decryptSecret(Buffer.from(cred.cipherBlob)),
      walletCallbackUrl: operator.walletCallbackUrl,
      timeoutMs: config.walletCallTimeoutMs,
    });
  }
}

let singleton: EngineRegistry | null = null;

export function initEngineRegistry(io: SocketIOServer): EngineRegistry {
  singleton = new EngineRegistry(io);
  return singleton;
}

export function getEngineRegistry(): EngineRegistry {
  if (!singleton) throw new Error('EngineRegistry not initialised');
  return singleton;
}
