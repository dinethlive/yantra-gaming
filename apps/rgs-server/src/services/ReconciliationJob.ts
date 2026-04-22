import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { auditChainAnchorsTotal } from '../telemetry/index.js';
import { anchorDay } from './AuditChain.js';

// Scheduling ----------------------------------------------------------------
// We run an aggregation sweep every hour. Real daily reconciliation (against
// an operator-supplied settlement file) is triggered per-request via
// `reconcileAgainstOperator`; the hourly tick just keeps the aggregate metrics
// fresh and surfaces any stuck pending jobs / failed wallet calls.

const TICK_MS = 60 * 60 * 1000; // 1 hour
const DAY_MS = 24 * TICK_MS;
const MINOR_DRIFT_THRESHOLD = 0.001; // 0.1 %
const MAJOR_DRIFT_ALERT_THRESHOLD = 0.01; // 1 %

// ── Aggregation: our-side daily totals ─────────────────────────────────────

export interface OperatorDailyTotals {
  operatorId: string;
  /** YYYY-MM-DD, UTC. */
  date: string;
  currency: string;

  betsCount: number;
  betsAmountMicro: bigint;
  winsCount: number;
  winsAmountMicro: bigint;
  rollbacksCount: number;
  rollbacksAmountMicro: bigint;

  /** bets − wins − rollbacks. Ours side of the ledger. */
  netRevenueMicro: bigint;

  /** WalletCall rows with succeeded=false within the window. */
  failedCallsCount: number;
  /** PendingWalletJob rows still uncompleted within the window. */
  pendingJobsCount: number;
}

/**
 * Aggregate a single operator × currency's OUTBOUND wallet-call totals for a
 * single UTC day. Sums only `succeeded=true` rows — failures are counted
 * separately and do NOT contribute to the bet/win totals.
 */
export async function computeDailyTotals(
  operatorId: string,
  currency: string,
  date: Date,
): Promise<OperatorDailyTotals> {
  const dayStart = startOfUtcDay(date);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const window = { gte: dayStart, lt: dayEnd };

  const [bets, wins, rollbacks, failed, pending] = await Promise.all([
    prisma.walletCall.aggregate({
      _count: true,
      _sum: { amountMicro: true },
      where: {
        operatorId,
        direction: 'OUTBOUND',
        endpoint: 'BET',
        succeeded: true,
        currency,
        createdAt: window,
      },
    }),
    prisma.walletCall.aggregate({
      _count: true,
      _sum: { amountMicro: true },
      where: {
        operatorId,
        direction: 'OUTBOUND',
        endpoint: 'WIN',
        succeeded: true,
        currency,
        createdAt: window,
      },
    }),
    prisma.walletCall.aggregate({
      _count: true,
      _sum: { amountMicro: true },
      where: {
        operatorId,
        direction: 'OUTBOUND',
        endpoint: 'ROLLBACK',
        succeeded: true,
        currency,
        createdAt: window,
      },
    }),
    prisma.walletCall.count({
      where: {
        operatorId,
        direction: 'OUTBOUND',
        succeeded: false,
        currency,
        createdAt: window,
      },
    }),
    prisma.pendingWalletJob.count({
      where: {
        operatorId,
        completedAt: null,
        createdAt: window,
      },
    }),
  ]);

  const betsAmount = bets._sum.amountMicro ?? 0n;
  const winsAmount = wins._sum.amountMicro ?? 0n;
  const rollbacksAmount = rollbacks._sum.amountMicro ?? 0n;

  return {
    operatorId,
    date: dayStart.toISOString().slice(0, 10),
    currency,
    betsCount: bets._count,
    betsAmountMicro: betsAmount,
    winsCount: wins._count,
    winsAmountMicro: winsAmount,
    rollbacksCount: rollbacks._count,
    rollbacksAmountMicro: rollbacksAmount,
    netRevenueMicro: betsAmount - winsAmount - rollbacksAmount,
    failedCallsCount: failed,
    pendingJobsCount: pending,
  };
}

// ── Three-way reconciliation against operator settlement ──────────────────

export interface OperatorSettlementInput {
  operatorId: string;
  /** YYYY-MM-DD, UTC. */
  date: string;
  currency: string;
  betsAmountMicro: bigint;
  winsAmountMicro: bigint;
  rollbacksAmountMicro: bigint;
}

export type ReconciliationStatus = 'MATCH' | 'MINOR_DRIFT' | 'MAJOR_DRIFT';

export interface ReconciliationDiff {
  totalsOurs: OperatorDailyTotals;
  totalsTheirs: OperatorSettlementInput;
  driftMicro: {
    bets: bigint;
    wins: bigint;
    rollbacks: bigint;
    net: bigint;
  };
  /** Max |drift| / |our_total| across bets/wins/rollbacks. 0 if everything matches. */
  maxDriftPct: number;
  status: ReconciliationStatus;
}

export async function reconcileAgainstOperator(
  settlement: OperatorSettlementInput,
): Promise<ReconciliationDiff> {
  const day = new Date(`${settlement.date}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) {
    throw new Error(`invalid date ${settlement.date}, expected YYYY-MM-DD`);
  }

  const ours = await computeDailyTotals(
    settlement.operatorId,
    settlement.currency,
    day,
  );

  const drift = {
    bets: settlement.betsAmountMicro - ours.betsAmountMicro,
    wins: settlement.winsAmountMicro - ours.winsAmountMicro,
    rollbacks: settlement.rollbacksAmountMicro - ours.rollbacksAmountMicro,
    net:
      settlement.betsAmountMicro -
      settlement.winsAmountMicro -
      settlement.rollbacksAmountMicro -
      ours.netRevenueMicro,
  };

  const maxDriftPct = Math.max(
    pctDrift(drift.bets, ours.betsAmountMicro),
    pctDrift(drift.wins, ours.winsAmountMicro),
    pctDrift(drift.rollbacks, ours.rollbacksAmountMicro),
  );

  const status: ReconciliationStatus =
    maxDriftPct === 0
      ? 'MATCH'
      : maxDriftPct < MINOR_DRIFT_THRESHOLD
        ? 'MINOR_DRIFT'
        : 'MAJOR_DRIFT';

  if (status === 'MAJOR_DRIFT') {
    logger.error('reconciliation_major_drift', {
      operatorId: settlement.operatorId,
      currency: settlement.currency,
      date: settlement.date,
      maxDriftPct,
      drift: serializeBigIntMap(drift),
    });
  } else if (status === 'MINOR_DRIFT') {
    logger.warn('reconciliation_minor_drift', {
      operatorId: settlement.operatorId,
      currency: settlement.currency,
      date: settlement.date,
      maxDriftPct,
    });
  }

  return {
    totalsOurs: ours,
    totalsTheirs: settlement,
    driftMicro: drift,
    maxDriftPct,
    status,
  };
}

// ── CSV export of our-side daily totals ────────────────────────────────────

/**
 * Render `computeDailyTotals` as a CSV row. Header is emitted by the caller
 * so multiple operator/currency rows can concat into one report.
 */
export function totalsToCsvRow(t: OperatorDailyTotals): string {
  return [
    t.date,
    t.operatorId,
    t.currency,
    t.betsCount,
    t.betsAmountMicro.toString(),
    t.winsCount,
    t.winsAmountMicro.toString(),
    t.rollbacksCount,
    t.rollbacksAmountMicro.toString(),
    t.netRevenueMicro.toString(),
    t.failedCallsCount,
    t.pendingJobsCount,
  ].join(',');
}

export const CSV_HEADER =
  'date,operator_id,currency,bets_count,bets_amount_micro,wins_count,wins_amount_micro,rollbacks_count,rollbacks_amount_micro,net_revenue_micro,failed_calls,pending_jobs';

// ── Scheduled hourly tick ──────────────────────────────────────────────────

export class ReconciliationJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('ReconciliationJob started');
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) =>
          logger.error('ReconciliationJob tick error', { err: err.message }),
        )
        .finally(() => this.schedule());
    }, TICK_MS);
  }

  private async tick(): Promise<void> {
    const yesterday = new Date(Date.now() - DAY_MS);

    // Daily audit-chain anchor. Signed tip-of-chain per (stream, operator)
    // for "yesterday". Idempotent — safe to run every hour because we
    // upsert on (periodDate, streamName, operatorId). See AuditChain.ts.
    try {
      const anchorResult = await anchorDay(yesterday);
      auditChainAnchorsTotal.inc({ stream: 'all' }, anchorResult.written);
    } catch (err) {
      logger.error('audit_chain_anchor_tick_failed', {
        err: (err as Error).message,
      });
    }

    const operators = await prisma.operator.findMany({
      where: { status: 'ACTIVE' },
    });

    for (const op of operators) {
      const currencyRows = await prisma.operatorGameConfig.findMany({
        where: { operatorId: op.id, enabled: true },
        select: { currency: true },
      });
      const currencies = new Set(currencyRows.map((c) => c.currency));

      for (const currency of currencies) {
        const totals = await computeDailyTotals(op.id, currency, yesterday);

        logger.info('reconciliation_daily', {
          operatorId: op.id,
          currency,
          date: totals.date,
          betsCount: totals.betsCount,
          betsAmountMicro: totals.betsAmountMicro.toString(),
          winsCount: totals.winsCount,
          winsAmountMicro: totals.winsAmountMicro.toString(),
          rollbacksCount: totals.rollbacksCount,
          rollbacksAmountMicro: totals.rollbacksAmountMicro.toString(),
          netRevenueMicro: totals.netRevenueMicro.toString(),
          failedCallsCount: totals.failedCallsCount,
          pendingJobsCount: totals.pendingJobsCount,
        });

        if (totals.pendingJobsCount > 0) {
          logger.warn('reconciliation_pending_jobs', {
            operatorId: op.id,
            currency,
            date: totals.date,
            pendingJobsCount: totals.pendingJobsCount,
          });
        }
        if (totals.failedCallsCount > 0) {
          logger.warn('reconciliation_failed_calls', {
            operatorId: op.id,
            currency,
            date: totals.date,
            failedCallsCount: totals.failedCallsCount,
          });
        }
      }
    }
  }
}

export const reconciliationJob = new ReconciliationJob();

// ── Helpers ────────────────────────────────────────────────────────────────

function startOfUtcDay(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function pctDrift(drift: bigint, base: bigint): number {
  if (drift === 0n) return 0;
  if (base === 0n) return Number.POSITIVE_INFINITY;
  const absDrift = drift < 0n ? -drift : drift;
  const absBase = base < 0n ? -base : base;
  // Amounts are micro-units, fitting well within Number precision (≤ 2^53 ≈ 9e15
  // micro-units = 9e10 major units per day — bigger than any real operator).
  return Number(absDrift) / Number(absBase);
}

function serializeBigIntMap(m: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) out[k] = v.toString();
  return out;
}

// Used by the _RG_MAJOR_DRIFT_ALERT threshold. Exposed for tests.
export const _thresholds = {
  minor: MINOR_DRIFT_THRESHOLD,
  major: MAJOR_DRIFT_ALERT_THRESHOLD,
};
