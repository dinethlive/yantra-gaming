import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ipAllowList } from '../middleware/ip-allow-list.js';
import { operatorAuth } from '../middleware/operator-auth.js';
import { operatorRateLimit } from '../middleware/operator-rate-limit.js';
import {
  CSV_HEADER,
  computeDailyTotals,
  reconcileAgainstOperator,
  totalsToCsvRow,
} from '../services/ReconciliationJob.js';

export const reportsRouter = Router();

const DailyQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gameCode: z.string().optional(),
  currency: z.string().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

// ─── GET /v1/reports/daily ─────────────────────────────────────────────────
//
// Operator's own-day summary as we see it. Real money numbers (betsMicro, etc.)
// are derived from WalletCall.succeeded=true via ReconciliationJob — same
// substrate the nightly log tick uses, so this matches any later reconciliation
// diff byte-for-byte.
//
// Legacy Round-aggregate fields (totalBetsMicro, totalPayoutsMicro, etc.) are
// still reported for back-compat; they should equal the WalletCall aggregates
// in a healthy system and any drift between the two is itself a signal.

reportsRouter.get('/daily', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const parsed = DailyQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
    return;
  }
  const operatorId = req.operator?.id;
  if (!operatorId) {
    res.status(401).json({ error: 'no_operator' });
    return;
  }
  const { date, gameCode, currency, format = 'json' } = parsed.data;

  // If currency is given, report just that currency; otherwise enumerate all
  // configured currencies for this operator.
  const currencies: string[] = currency
    ? [currency]
    : (
        await prisma.operatorGameConfig.findMany({
          where: {
            operatorId,
            enabled: true,
            ...(gameCode ? { gameCode } : {}),
          },
          select: { currency: true },
        })
      ).map((r) => r.currency);

  const distinct = Array.from(new Set(currencies));
  const day = new Date(`${date}T00:00:00.000Z`);

  const totalsPerCurrency = await Promise.all(
    distinct.map((c) => computeDailyTotals(operatorId, c, day)),
  );

  if (format === 'csv') {
    const rows = [CSV_HEADER, ...totalsPerCurrency.map(totalsToCsvRow)];
    res.type('text/csv').send(rows.join('\n') + '\n');
    return;
  }

  const perCurrency = totalsPerCurrency.map((t) => ({
    currency: t.currency,
    counts: {
      bets: t.betsCount,
      wins: t.winsCount,
      rollbacks: t.rollbacksCount,
      failedCalls: t.failedCallsCount,
      pendingJobs: t.pendingJobsCount,
    },
    amountsMicro: {
      bets: t.betsAmountMicro.toString(),
      wins: t.winsAmountMicro.toString(),
      rollbacks: t.rollbacksAmountMicro.toString(),
      ggr: t.netRevenueMicro.toString(),
      ngr: t.netRevenueMicro.toString(), // no bonus/tax deductions at this layer
    },
  }));

  res.json({
    operatorId,
    date,
    gameCode: gameCode ?? null,
    perCurrency,
  });
});

// ─── POST /v1/reports/reconciliation ───────────────────────────────────────
//
// Operator posts their own-side daily totals. We compute our-side totals,
// diff, and return the three-way match:
//
//   { totalsOurs, totalsTheirs, driftMicro, maxDriftPct, status }
//
// `status` is MATCH | MINOR_DRIFT (< 0.1 %) | MAJOR_DRIFT (≥ 0.1 %).
// Any MAJOR_DRIFT result logs at error level and would page oncall in a
// real deployment.

const ReconcileBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().min(1),
  betsAmountMicro: z.string().regex(/^-?\d+$/),
  winsAmountMicro: z.string().regex(/^-?\d+$/),
  rollbacksAmountMicro: z.string().regex(/^-?\d+$/),
});

reportsRouter.post('/reconciliation', operatorAuth, ipAllowList, operatorRateLimit, async (req, res) => {
  const parsed = ReconcileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const operatorId = req.operator?.id;
  if (!operatorId) {
    res.status(401).json({ error: 'no_operator' });
    return;
  }

  try {
    const diff = await reconcileAgainstOperator({
      operatorId,
      date: parsed.data.date,
      currency: parsed.data.currency,
      betsAmountMicro: BigInt(parsed.data.betsAmountMicro),
      winsAmountMicro: BigInt(parsed.data.winsAmountMicro),
      rollbacksAmountMicro: BigInt(parsed.data.rollbacksAmountMicro),
    });

    res.json({
      status: diff.status,
      maxDriftPct: diff.maxDriftPct,
      totalsOurs: serializeTotals(diff.totalsOurs),
      totalsTheirs: {
        ...diff.totalsTheirs,
        betsAmountMicro: diff.totalsTheirs.betsAmountMicro.toString(),
        winsAmountMicro: diff.totalsTheirs.winsAmountMicro.toString(),
        rollbacksAmountMicro: diff.totalsTheirs.rollbacksAmountMicro.toString(),
      },
      driftMicro: {
        bets: diff.driftMicro.bets.toString(),
        wins: diff.driftMicro.wins.toString(),
        rollbacks: diff.driftMicro.rollbacks.toString(),
        net: diff.driftMicro.net.toString(),
      },
    });
  } catch (err) {
    res.status(400).json({ error: 'reconciliation_failed', message: (err as Error).message });
  }
});

function serializeTotals(t: import('../services/ReconciliationJob.js').OperatorDailyTotals) {
  return {
    date: t.date,
    currency: t.currency,
    counts: {
      bets: t.betsCount,
      wins: t.winsCount,
      rollbacks: t.rollbacksCount,
      failedCalls: t.failedCallsCount,
      pendingJobs: t.pendingJobsCount,
    },
    amountsMicro: {
      bets: t.betsAmountMicro.toString(),
      wins: t.winsAmountMicro.toString(),
      rollbacks: t.rollbacksAmountMicro.toString(),
      net: t.netRevenueMicro.toString(),
    },
  };
}
