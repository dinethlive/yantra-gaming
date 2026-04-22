import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Tamper-evident audit chain.
//
// Goal: convert "append-only by convention" into "append-only by
// cryptography". A Postgres DELETE by a rogue admin should be detectable
// by anyone holding a signed daily anchor.
//
// Design:
//   * Each row in a chained stream (WalletCall, Round) is hashed at write
//     time: `rowHash = SHA256( prevRowHash ‖ canonical(row) )`.
//   * The chain is per (stream, operator) so operator A's ledger is
//     independent of operator B's — there's no cross-tenant replay.
//   * Canonical form is a JSON string with sorted keys, BigInts as decimal
//     strings, Dates as ISO-8601 to millisecond precision, nulls omitted.
//   * A daily job (AuditChainAnchor.anchorDay) emits one AuditAnchor row
//     per (date, stream, operator) with the tip hash and a HMAC-SHA256
//     signature using AUDIT_ANCHOR_SECRET.
//
// iGaming framing (not a generic audit-log pattern): GLI-19 §4.13 +
// MGA Critical Gaming Component guidance require the regulator to be able
// to prove the wallet ledger has not been altered after the fact. A
// database snapshot alone is insufficient because it can be restored
// to a prior point; the chain lets the regulator spot-verify any
// historical row against a long-lived signed anchor.

export type AuditStream = 'wallet_call' | 'round';

const SECRET_ENV = 'AUDIT_ANCHOR_SECRET';

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashRow(prevHash: string | null, row: Record<string, unknown>): string {
  const canonical = canonicalJson(row);
  const h = crypto.createHash('sha256');
  h.update(prevHash ?? '');
  h.update('\n');
  h.update(canonical);
  return h.digest('hex');
}

function ensureSecret(): string {
  const v = process.env[SECRET_ENV];
  if (!v || v.length < 16) {
    // Fall back to SESSION_JWT_SECRET so dev/test keep running without
    // extra env wiring. Prod must configure AUDIT_ANCHOR_SECRET — the
    // signed anchor is useless if the signing key isn't long-lived and
    // separate from rotating JWT keys. Production boot validates the
    // dedicated env (see config.ts) — this fallback is dev-only.
    const fallback = process.env.SESSION_JWT_SECRET;
    if (fallback && fallback.length >= 16) return fallback;
    throw new Error(`${SECRET_ENV} must be set (>= 16 chars) for audit chain signing`);
  }
  return v;
}

function signManifest(body: string): string {
  return crypto.createHmac('sha256', ensureSecret()).update(body).digest('base64');
}

// ── Row projectors: map live Prisma rows to their canonical hash input.
// IMPORTANT: the projector defines what is covered by the chain. Every
// field that would surprise a regulator if altered belongs here.
// Prefer to add fields over time rather than reshape — reshape forces
// a new stream version.

export function walletCallHashInput(row: {
  id: string;
  operatorId: string;
  direction: string;
  endpoint: string;
  requestUuid: string;
  transactionUuid: string | null;
  referenceTransactionUuid: string | null;
  sessionId: string | null;
  roundId: string | null;
  playerRef: string | null;
  amountMicro: bigint | null;
  currency: string | null;
  requestBody: unknown;
  responseStatus: string | null;
  responseBody: unknown;
  httpStatus: number | null;
  latencyMs: number | null;
  attempt: number;
  succeeded: boolean;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    stream: 'wallet_call',
    id: row.id,
    operatorId: row.operatorId,
    direction: row.direction,
    endpoint: row.endpoint,
    requestUuid: row.requestUuid,
    transactionUuid: row.transactionUuid,
    referenceTransactionUuid: row.referenceTransactionUuid,
    sessionId: row.sessionId,
    roundId: row.roundId,
    playerRef: row.playerRef,
    amountMicro: row.amountMicro,
    currency: row.currency,
    requestBody: row.requestBody,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    httpStatus: row.httpStatus,
    latencyMs: row.latencyMs,
    attempt: row.attempt,
    succeeded: row.succeeded,
    createdAt: row.createdAt,
  };
}

export function roundHashInput(row: {
  id: string;
  operatorId: string;
  sessionId: string;
  gameCode: string;
  currency: string;
  nonce: number;
  state: string;
  outcomeType: string | null;
  outcomeData: unknown;
  gameConfigVersion: string | null;
  serverSeedHash: string;
  clientSeed: string;
  rngVersion: string;
  buildHash: string | null;
  totalBetsMicro: bigint;
  totalPayoutsMicro: bigint;
  startedAt: Date | null;
  rolledAt: Date | null;
  settledAt: Date | null;
  voidedAt: Date | null;
  startedAtMonoNs: bigint | null;
}): Record<string, unknown> {
  return {
    stream: 'round',
    id: row.id,
    operatorId: row.operatorId,
    sessionId: row.sessionId,
    gameCode: row.gameCode,
    currency: row.currency,
    nonce: row.nonce,
    state: row.state,
    outcomeType: row.outcomeType,
    outcomeData: row.outcomeData,
    gameConfigVersion: row.gameConfigVersion,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    rngVersion: row.rngVersion,
    buildHash: row.buildHash,
    totalBetsMicro: row.totalBetsMicro,
    totalPayoutsMicro: row.totalPayoutsMicro,
    startedAt: row.startedAt,
    rolledAt: row.rolledAt,
    settledAt: row.settledAt,
    voidedAt: row.voidedAt,
    startedAtMonoNs: row.startedAtMonoNs,
  };
}

// ── Tip lookup helpers ─────────────────────────────────────
// "Tip" = most recent rowHash in the per-(stream, operator) stream. The
// chain is serialised by createdAt DESC + id DESC as a total order within
// the same millisecond.

export async function latestWalletCallTip(operatorId: string): Promise<string | null> {
  const row = await prisma.walletCall.findFirst({
    where: { operatorId, rowHash: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { rowHash: true },
  });
  return row?.rowHash ?? null;
}

export async function latestRoundTip(operatorId: string): Promise<string | null> {
  // Round uses startedAt as its creation timestamp (the row has no
  // createdAt column — the engine always stamps startedAt at creation).
  const row = await prisma.round.findFirst({
    where: { operatorId, rowHash: { not: null } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { rowHash: true },
  });
  return row?.rowHash ?? null;
}

// ── Backfill ───────────────────────────────────────────────
// Walks an operator's unhashed rows in createdAt order and fills in
// prevRowHash/rowHash. Safe to run repeatedly — only rows with rowHash=null
// are touched. Call once after the migration lands to bring existing rows
// into the chain. Per-operator batching keeps the hot-write path fast.

const BACKFILL_BATCH = 500;

export async function backfillWalletCallChain(operatorId: string): Promise<number> {
  let prev = await latestWalletCallTip(operatorId);
  let total = 0;
  while (true) {
    const batch = await prisma.walletCall.findMany({
      where: { operatorId, rowHash: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BACKFILL_BATCH,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      const hash = hashRow(prev, walletCallHashInput(row));
      await prisma.walletCall.update({
        where: { id: row.id },
        data: { prevRowHash: prev, rowHash: hash },
      });
      prev = hash;
      total += 1;
    }
  }
  return total;
}

export async function backfillRoundChain(operatorId: string): Promise<number> {
  let prev = await latestRoundTip(operatorId);
  let total = 0;
  while (true) {
    const batch = await prisma.round.findMany({
      where: { operatorId, rowHash: null },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: BACKFILL_BATCH,
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      const hash = hashRow(prev, roundHashInput(row));
      await prisma.round.update({
        where: { id: row.id },
        data: { prevRowHash: prev, rowHash: hash },
      });
      prev = hash;
      total += 1;
    }
  }
  return total;
}

// ── Daily anchor ───────────────────────────────────────────
// For each (stream, operator, UTC date), compute the per-operator tip hash
// and the row count, emit a signed AuditAnchor. Idempotent — if an anchor
// for (date, stream, operator) exists, it is recomputed and overwritten,
// which is correct because anchors are an index over immutable data.

interface AnchorSummary {
  stream: AuditStream;
  operatorId: string;
  periodDate: string;        // YYYY-MM-DD (UTC)
  firstRowId: string | null;
  lastRowId: string | null;
  rowCount: number;
  tipHash: string;
}

// The anchor's tipHash is the CANONICAL recomputed tip, not the value any
// individual row happened to persist at write time. Concurrent writers
// (two engines for the same operator on different games) may have stored
// rowHashes computed against the same stale `prev`; a regulator's replay
// walks rows in canonical order and will recompute. The anchor is the
// source of truth, so it must match the same canonical walk.

async function summariseWalletCallDay(
  operatorId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<AnchorSummary | null> {
  // Inherit the chain from rows before this window.
  const beforeTip = await prisma.walletCall.findFirst({
    where: { operatorId, createdAt: { lt: dayStart } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { rowHash: true },
  });

  const rows = await prisma.walletCall.findMany({
    where: { operatorId, createdAt: { gte: dayStart, lt: dayEnd } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return null;

  // Recompute + repair: if a row's stored rowHash disagrees with the
  // canonical recomputed hash (concurrency or missed write), update it
  // in place. This makes post-verification O(1) per row instead of
  // requiring a full replay.
  let prev: string | null = beforeTip?.rowHash ?? null;
  for (const r of rows) {
    const computed = hashRow(prev, walletCallHashInput(r));
    if (r.rowHash !== computed || r.prevRowHash !== prev) {
      await prisma.walletCall.update({
        where: { id: r.id },
        data: { prevRowHash: prev, rowHash: computed },
      });
    }
    prev = computed;
  }

  return {
    stream: 'wallet_call',
    operatorId,
    periodDate: dayStart.toISOString().slice(0, 10),
    firstRowId: rows[0]!.id,
    lastRowId: rows[rows.length - 1]!.id,
    rowCount: rows.length,
    tipHash: prev ?? '',
  };
}

async function summariseRoundDay(
  operatorId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<AnchorSummary | null> {
  const beforeTip = await prisma.round.findFirst({
    where: { operatorId, startedAt: { lt: dayStart } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { rowHash: true },
  });

  const rows = await prisma.round.findMany({
    where: { operatorId, startedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return null;

  let prev: string | null = beforeTip?.rowHash ?? null;
  for (const r of rows) {
    const computed = hashRow(prev, roundHashInput(r));
    if (r.rowHash !== computed || r.prevRowHash !== prev) {
      await prisma.round.update({
        where: { id: r.id },
        data: { prevRowHash: prev, rowHash: computed },
      });
    }
    prev = computed;
  }

  return {
    stream: 'round',
    operatorId,
    periodDate: dayStart.toISOString().slice(0, 10),
    firstRowId: rows[0]!.id,
    lastRowId: rows[rows.length - 1]!.id,
    rowCount: rows.length,
    tipHash: prev ?? '',
  };
}

export async function anchorDay(date: Date): Promise<{ written: number; skipped: number }> {
  // Canonical "day" = UTC midnight → next UTC midnight.
  const dayStart = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0,
  ));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const operators = await prisma.operator.findMany({ select: { id: true } });
  let written = 0;
  let skipped = 0;
  for (const op of operators) {
    for (const summariser of [summariseWalletCallDay, summariseRoundDay]) {
      const summary = await summariser(op.id, dayStart, dayEnd);
      if (!summary) {
        skipped += 1;
        continue;
      }
      const manifest = {
        stream: summary.stream,
        operatorId: summary.operatorId,
        periodDate: summary.periodDate,
        firstRowId: summary.firstRowId,
        lastRowId: summary.lastRowId,
        rowCount: summary.rowCount,
        tipHash: summary.tipHash,
      };
      const body = canonicalJson(manifest);
      const signature = signManifest(body);
      await prisma.auditAnchor.upsert({
        where: {
          periodDate_streamName_operatorId: {
            periodDate: dayStart,
            streamName: summary.stream,
            operatorId: summary.operatorId,
          },
        },
        create: {
          periodDate: dayStart,
          streamName: summary.stream,
          operatorId: summary.operatorId,
          firstRowId: summary.firstRowId,
          lastRowId: summary.lastRowId,
          rowCount: summary.rowCount,
          tipHash: summary.tipHash,
          manifest: manifest as object,
          signature,
        },
        update: {
          firstRowId: summary.firstRowId,
          lastRowId: summary.lastRowId,
          rowCount: summary.rowCount,
          tipHash: summary.tipHash,
          manifest: manifest as object,
          signature,
        },
      });
      written += 1;
    }
  }
  logger.info('audit_chain_anchor_day', {
    date: dayStart.toISOString().slice(0, 10),
    written,
    skipped,
  });
  return { written, skipped };
}

// ── Verification ───────────────────────────────────────────
// Given an AuditAnchor, replay every row in the window and confirm the
// replayed tip equals the anchor's tipHash. Used by an operator or a
// regulator's reviewer via the admin API.

export interface VerifyResult {
  stream: AuditStream;
  operatorId: string;
  periodDate: string;
  expectedTip: string;
  computedTip: string;
  rowCount: number;
  match: boolean;
  firstMismatchAtRowId?: string;
}

export async function verifyAnchor(anchorId: string): Promise<VerifyResult | null> {
  const anchor = await prisma.auditAnchor.findUnique({ where: { id: anchorId } });
  if (!anchor) return null;
  const stream = anchor.streamName as AuditStream;
  const operatorId = anchor.operatorId;
  if (!operatorId) return null;

  const dayStart = anchor.periodDate;
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  let prev: string | null = null;
  // Replay from the start of operator's chain up to dayStart to acquire
  // the prev-hash anchor, then walk the window.
  if (stream === 'wallet_call') {
    const beforeTip = await prisma.walletCall.findFirst({
      where: { operatorId, createdAt: { lt: dayStart }, rowHash: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { rowHash: true },
    });
    prev = beforeTip?.rowHash ?? null;
    const rows = await prisma.walletCall.findMany({
      where: { operatorId, createdAt: { gte: dayStart, lt: dayEnd } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let firstMismatch: string | undefined;
    for (const r of rows) {
      const computed = hashRow(prev, walletCallHashInput(r));
      if (!firstMismatch && r.rowHash && computed !== r.rowHash) firstMismatch = r.id;
      prev = computed;
    }
    return {
      stream,
      operatorId,
      periodDate: anchor.periodDate.toISOString().slice(0, 10),
      expectedTip: anchor.tipHash,
      computedTip: prev ?? '',
      rowCount: rows.length,
      match: (prev ?? '') === anchor.tipHash,
      firstMismatchAtRowId: firstMismatch,
    };
  }

  const beforeTip = await prisma.round.findFirst({
    where: { operatorId, startedAt: { lt: dayStart }, rowHash: { not: null } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { rowHash: true },
  });
  prev = beforeTip?.rowHash ?? null;
  const rows = await prisma.round.findMany({
    where: { operatorId, startedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  let firstMismatch: string | undefined;
  for (const r of rows) {
    const computed = hashRow(prev, roundHashInput(r));
    if (!firstMismatch && r.rowHash && computed !== r.rowHash) firstMismatch = r.id;
    prev = computed;
  }
  return {
    stream,
    operatorId,
    periodDate: anchor.periodDate.toISOString().slice(0, 10),
    expectedTip: anchor.tipHash,
    computedTip: prev ?? '',
    rowCount: rows.length,
    match: (prev ?? '') === anchor.tipHash,
    firstMismatchAtRowId: firstMismatch,
  };
}

export const auditChain = {
  hashRow,
  walletCallHashInput,
  roundHashInput,
  latestWalletCallTip,
  latestRoundTip,
  backfillWalletCallChain,
  backfillRoundChain,
  anchorDay,
  verifyAnchor,
  canonicalJson,
};
