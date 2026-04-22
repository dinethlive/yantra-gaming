import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Global kill-switch.
//
// Emergency stop that halts every new session launch and refuses to
// start any engine until disengaged. In-flight rounds finish settlement
// — GLI-19 §3 forbids mid-round termination.
//
// State is a singleton Postgres row (id = "singleton"). The seed
// migration inserts it so UPDATE never hits an empty row.
//
// Cached in-process for 5s so the hot-path engine check doesn't round-
// trip to the DB on every round. The cache is invalidated immediately
// on engage/disengage.

const CACHE_TTL_MS = 5_000;

interface SnapshotState {
  engaged: boolean;
  reason: string | null;
  engagedAt: string | null;
  engagedBy: string | null;
  disengagedAt: string | null;
  disengagedBy: string | null;
}

class GlobalKillSwitchService {
  private cached: { value: SnapshotState; expiresAt: number } | null = null;

  async snapshot(): Promise<SnapshotState> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const row = await prisma.globalKillSwitch.findUnique({
      where: { id: 'singleton' },
    });
    const value: SnapshotState = row
      ? {
          engaged: row.engaged,
          reason: row.reason ?? null,
          engagedAt: row.engagedAt?.toISOString() ?? null,
          engagedBy: row.engagedBy ?? null,
          disengagedAt: row.disengagedAt?.toISOString() ?? null,
          disengagedBy: row.disengagedBy ?? null,
        }
      : {
          engaged: false,
          reason: null,
          engagedAt: null,
          engagedBy: null,
          disengagedAt: null,
          disengagedBy: null,
        };
    this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  async isEngaged(): Promise<boolean> {
    return (await this.snapshot()).engaged;
  }

  async engage(reason: string, actorEmail: string): Promise<SnapshotState> {
    await prisma.globalKillSwitch.upsert({
      where: { id: 'singleton' },
      update: {
        engaged: true,
        reason: reason.slice(0, 256),
        engagedAt: new Date(),
        engagedBy: actorEmail.slice(0, 254),
      },
      create: {
        id: 'singleton',
        engaged: true,
        reason: reason.slice(0, 256),
        engagedAt: new Date(),
        engagedBy: actorEmail.slice(0, 254),
      },
    });
    this.cached = null;
    logger.error('global_kill_switch_engaged', {
      actor: actorEmail,
      reason,
    });
    return this.snapshot();
  }

  async disengage(actorEmail: string): Promise<SnapshotState> {
    await prisma.globalKillSwitch.upsert({
      where: { id: 'singleton' },
      update: {
        engaged: false,
        disengagedAt: new Date(),
        disengagedBy: actorEmail.slice(0, 254),
      },
      create: {
        id: 'singleton',
        engaged: false,
      },
    });
    this.cached = null;
    logger.info('global_kill_switch_disengaged', { actor: actorEmail });
    return this.snapshot();
  }
}

export const globalKillSwitch = new GlobalKillSwitchService();
