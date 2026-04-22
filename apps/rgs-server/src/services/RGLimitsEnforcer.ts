import {
  checkJurisdictionRules,
  effectiveRGFloor,
  type JurisdictionBreach,
} from '@yantra/jurisdiction-rules';
import { prisma } from '../db.js';

// Responsible-gambling limits enforced per bet.
//
// Limits live on the session JWT (`rgLimits` claim) and are persisted onto
// GameSession.rgLimits for durability. The operator populates them at session
// creation — they represent the operator's policy for THIS player for THIS
// session. The RGS enforces them at bet time; any breach returns an
// RS_ERROR_LIMIT_REACHED-equivalent rejection.
//
// Supported limits (all optional; missing = unlimited):
//
//   dailyLossMicro       — max net loss across all sessions today (UTC)
//   dailyWagerMicro      — max gross wager across all sessions today
//   sessionLossMicro     — max net loss in this session
//   sessionWagerMicro    — max gross wager in this session
//   sessionTimeSeconds   — max session duration (wall clock)

export interface RGLimits {
  dailyLossMicro?: bigint;
  dailyWagerMicro?: bigint;
  sessionLossMicro?: bigint;
  sessionWagerMicro?: bigint;
  sessionTimeSeconds?: number;
}

export type RGLimitBreach =
  | 'daily_loss_exceeded'
  | 'daily_wager_exceeded'
  | 'session_loss_exceeded'
  | 'session_wager_exceeded'
  | 'session_time_exceeded'
  | JurisdictionBreach;

export interface LimitCheckResult {
  allowed: boolean;
  reason?: RGLimitBreach;
  /** Amount under the cap the player still has, before the current bet. */
  remainingMicro?: bigint;
}

export function parseRGLimits(raw: unknown): RGLimits {
  const out: RGLimits = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.dailyLossMicro === 'string') out.dailyLossMicro = safeBigInt(r.dailyLossMicro);
  if (typeof r.dailyWagerMicro === 'string')
    out.dailyWagerMicro = safeBigInt(r.dailyWagerMicro);
  if (typeof r.sessionLossMicro === 'string')
    out.sessionLossMicro = safeBigInt(r.sessionLossMicro);
  if (typeof r.sessionWagerMicro === 'string')
    out.sessionWagerMicro = safeBigInt(r.sessionWagerMicro);
  if (typeof r.sessionTimeSeconds === 'number' && r.sessionTimeSeconds > 0) {
    out.sessionTimeSeconds = Math.floor(r.sessionTimeSeconds);
  }
  return out;
}

function safeBigInt(s: string): bigint | undefined {
  try {
    return BigInt(s);
  } catch {
    return undefined;
  }
}

export interface SessionForCheck {
  id: string;
  operatorId: string;
  playerRef: string;
  rgLimits: unknown;
  createdAt: Date;
  jurisdiction: string;
  currency: string;
  mode: 'REAL' | 'DEMO';
}

export interface BetContext {
  autoplay?: boolean;
  turbo?: boolean;
  timeSincePreviousBetMs?: number;
  playerKycVerified?: boolean;
}

/**
 * Check every configured RG limit against the incoming bet stake.
 *
 * Pessimistic by design: a bet that is ACCEPTED but not yet SETTLED is
 * counted as a full-stake loss (since we don't know the outcome yet). This
 * matches the "at-risk" exposure a player has sitting in an in-flight round.
 */
export async function checkRGLimits(args: {
  session: SessionForCheck;
  stakeMicro: bigint;
  now?: () => number;
  betContext?: BetContext;
}): Promise<LimitCheckResult> {
  const nowMs = args.now ? args.now() : Date.now();

  // 0. Jurisdictional rules — hard regulatory constraints. Checked before
  // operator-configured RG limits because they supersede them. UK autoplay
  // ban, German €1 cap, Spanish demo-KYC, spin-speed floors, etc.
  const jurisdictionResult = checkJurisdictionRules({
    jurisdiction: args.session.jurisdiction,
    stakeMicro: args.stakeMicro,
    currency: args.session.currency,
    timeSincePreviousBetMs: args.betContext?.timeSincePreviousBetMs,
    autoplay: args.betContext?.autoplay,
    turbo: args.betContext?.turbo,
    mode: args.session.mode === 'DEMO' ? 'demo' : 'real',
    playerKycVerified: args.betContext?.playerKycVerified,
  });
  if (!jurisdictionResult.allowed) {
    return {
      allowed: false,
      reason: jurisdictionResult.reason,
      remainingMicro: jurisdictionResult.remainingMicro ?? undefined,
    };
  }

  // Operator session-scoped RG limits overlay on top of the jurisdictional
  // floor; the floor can only tighten, never loosen, what the operator sets.
  const operatorLimits = parseRGLimits(args.session.rgLimits);
  const floor = effectiveRGFloor(args.session.jurisdiction, {
    sessionTimeSeconds: operatorLimits.sessionTimeSeconds,
    sessionLossMicro: operatorLimits.sessionLossMicro,
    dailyLossMicro: operatorLimits.dailyLossMicro,
  });
  const limits: RGLimits = {
    dailyLossMicro: floor.dailyLossMicro ?? operatorLimits.dailyLossMicro,
    dailyWagerMicro: operatorLimits.dailyWagerMicro,
    sessionLossMicro: floor.sessionLossMicro ?? operatorLimits.sessionLossMicro,
    sessionWagerMicro: operatorLimits.sessionWagerMicro,
    sessionTimeSeconds:
      floor.sessionTimeSeconds ?? operatorLimits.sessionTimeSeconds,
  };
  if (!hasAnyLimit(limits)) return { allowed: true };

  // 1. Session time — cheapest check; short-circuit first.
  if (limits.sessionTimeSeconds !== undefined) {
    const elapsedSec = (nowMs - args.session.createdAt.getTime()) / 1000;
    if (elapsedSec >= limits.sessionTimeSeconds) {
      return { allowed: false, reason: 'session_time_exceeded', remainingMicro: 0n };
    }
  }

  // 2. Session-level wager / loss totals.
  if (
    limits.sessionWagerMicro !== undefined ||
    limits.sessionLossMicro !== undefined
  ) {
    const sessionBets = await prisma.bet.findMany({
      where: {
        sessionId: args.session.id,
        status: { in: ['ACCEPTED', 'SETTLED'] },
      },
      select: { amountMicro: true, wonAmountMicro: true, won: true },
    });
    const { wagered, netLoss } = aggregateLoss(sessionBets);

    if (
      limits.sessionWagerMicro !== undefined &&
      wagered + args.stakeMicro > limits.sessionWagerMicro
    ) {
      return {
        allowed: false,
        reason: 'session_wager_exceeded',
        remainingMicro: limits.sessionWagerMicro - wagered,
      };
    }
    if (
      limits.sessionLossMicro !== undefined &&
      netLoss + args.stakeMicro > limits.sessionLossMicro
    ) {
      return {
        allowed: false,
        reason: 'session_loss_exceeded',
        remainingMicro: limits.sessionLossMicro - netLoss,
      };
    }
  }

  // 3. Daily totals across all of this player's sessions today (UTC).
  if (
    limits.dailyWagerMicro !== undefined ||
    limits.dailyLossMicro !== undefined
  ) {
    const dayStart = new Date(
      `${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const dayBets = await prisma.bet.findMany({
      where: {
        operatorId: args.session.operatorId,
        playerRef: args.session.playerRef,
        status: { in: ['ACCEPTED', 'SETTLED'] },
        placedAt: { gte: dayStart },
      },
      select: { amountMicro: true, wonAmountMicro: true, won: true },
    });
    const { wagered, netLoss } = aggregateLoss(dayBets);

    if (
      limits.dailyWagerMicro !== undefined &&
      wagered + args.stakeMicro > limits.dailyWagerMicro
    ) {
      return {
        allowed: false,
        reason: 'daily_wager_exceeded',
        remainingMicro: limits.dailyWagerMicro - wagered,
      };
    }
    if (
      limits.dailyLossMicro !== undefined &&
      netLoss + args.stakeMicro > limits.dailyLossMicro
    ) {
      return {
        allowed: false,
        reason: 'daily_loss_exceeded',
        remainingMicro: limits.dailyLossMicro - netLoss,
      };
    }
  }

  return { allowed: true };
}

function hasAnyLimit(l: RGLimits): boolean {
  return (
    l.dailyLossMicro !== undefined ||
    l.dailyWagerMicro !== undefined ||
    l.sessionLossMicro !== undefined ||
    l.sessionWagerMicro !== undefined ||
    l.sessionTimeSeconds !== undefined
  );
}

function aggregateLoss(
  bets: Array<{ amountMicro: bigint; wonAmountMicro: bigint | null; won: boolean | null }>,
): { wagered: bigint; netLoss: bigint } {
  let wagered = 0n;
  let netLoss = 0n;
  for (const b of bets) {
    wagered += b.amountMicro;
    // If the bet has settled as a win, the won amount reduces the net loss.
    // If it's ACCEPTED (pending), wonAmountMicro is null — treat as a full-stake
    // at-risk loss (pessimistic; matches "how much am I already down" UX).
    const won = b.wonAmountMicro ?? 0n;
    netLoss += b.amountMicro - won;
  }
  return { wagered, netLoss };
}
