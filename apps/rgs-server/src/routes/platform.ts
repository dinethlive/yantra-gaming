import { createHmac, randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { platformAuth } from '../middleware/platform-auth.js';
import {
  requireYantraAdmin,
  requireYantraCompliance,
} from '../middleware/role-gate.js';
import { adminAuditMiddleware } from '../services/AdminAuditLog.js';
import {
  consumeUploadToken,
  mintUploadUrl,
  resolveForDownload,
} from '../services/CertStorage.js';
import {
  revokeCredentialImmediately,
  rotateCredential,
} from '../services/CredentialRotation.js';
import { globalKillSwitch } from '../services/GlobalKillSwitch.js';
import { encryptSecret } from '../utils/secrets.js';

export const platformRouter = Router();

platformRouter.use(platformAuth);
// Record every write — suspend, kill-switch, cert CRUD, credential
// rotation, etc. Reads skip the middleware's hot-path. See
// services/AdminAuditLog.ts.
platformRouter.use(adminAuditMiddleware);

// Parse ?includeTest=true; default excludes testMode operators from platform
// reports so production totals (GGR, SLA, RTP) are never polluted by pilot /
// sandbox tenants. The operator-list view always shows everything regardless
// — it's the admin surface.
function includeTestFlag(req: { query: Record<string, unknown> }): boolean {
  const v = req.query.includeTest;
  return v === 'true' || v === '1';
}
function testModeWhere(includeTest: boolean): { testMode?: false } {
  return includeTest ? {} : { testMode: false };
}

// Canonical JSON for HMAC signing — stable key ordering, no whitespace, no
// number coercion. Any code (ours or operator's finance system) signing or
// verifying the settlement feed must produce the same byte string.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function signBody(body: string): string {
  // NOTE: reusing portalJwtSecret for dev. In production this should be a
  // dedicated SETTLEMENT_SIGNING_SECRET so the feed key can be rotated
  // independently of portal authentication.
  return createHmac('sha256', config.portalJwtSecret).update(body).digest('hex');
}

function toCsv(rows: Array<Record<string, string | number>>, columns: string[]): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c] ?? '')).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Cross-operator cockpit. Rolls up the same KPIs `/v1/admin/overview` shows
// per tenant, but emits one row per operator. Filtered to each operator's
// default currency — multi-currency breakdown is a later pass.
platformRouter.get('/overview', async (req, res) => {
  const since = new Date(Date.now() - 86_400_000);
  const now = new Date();
  const includeTest = includeTestFlag(req);

  const operators = await prisma.operator.findMany({
    where: { status: { not: 'TERMINATED' }, ...testModeWhere(includeTest) },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      jurisdiction: true,
      defaultCurrency: true,
    },
  });

  const [sessionsByOp, betsByOpCurrency, winsByOpCurrency] = await Promise.all([
    prisma.gameSession.groupBy({
      by: ['operatorId'],
      where: { terminatedAt: null, expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: {
        status: { in: ['ACCEPTED', 'SETTLED'] },
        placedAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: { won: true, settledAt: { gte: since } },
      _count: { _all: true },
      _sum: { wonAmountMicro: true },
    }),
  ]);

  const sessionMap = new Map(sessionsByOp.map((r) => [r.operatorId, r._count._all]));
  const betMap = new Map(
    betsByOpCurrency.map((r) => [`${r.operatorId}:${r.currency}`, r]),
  );
  const winMap = new Map(
    winsByOpCurrency.map((r) => [`${r.operatorId}:${r.currency}`, r]),
  );

  let totalBetsMicro = 0n;
  let totalWinsMicro = 0n;
  let totalActiveSessions = 0;

  const rows = operators.map((op) => {
    const key = `${op.id}:${op.defaultCurrency}`;
    const betAgg = betMap.get(key);
    const winAgg = winMap.get(key);
    const betsVolume = betAgg?._sum.amountMicro ?? 0n;
    const winsVolume = winAgg?._sum.wonAmountMicro ?? 0n;
    const ggrMicro = betsVolume - winsVolume;
    const activeSessions = sessionMap.get(op.id) ?? 0;

    totalBetsMicro += betsVolume;
    totalWinsMicro += winsVolume;
    totalActiveSessions += activeSessions;

    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      status: op.status,
      jurisdiction: op.jurisdiction,
      currency: op.defaultCurrency,
      activeSessions,
      bets: {
        count: betAgg?._count._all ?? 0,
        volumeMicro: betsVolume.toString(),
      },
      wins: {
        count: winAgg?._count._all ?? 0,
        volumeMicro: winsVolume.toString(),
      },
      ggrMicro: ggrMicro.toString(),
    };
  });

  res.json({
    since: since.toISOString(),
    operators: rows,
    totals: {
      operatorCount: operators.length,
      activeSessions: totalActiveSessions,
      betsMicro: totalBetsMicro.toString(),
      winsMicro: totalWinsMicro.toString(),
      ggrMicro: (totalBetsMicro - totalWinsMicro).toString(),
    },
  });
});

// Lightweight operator list — the cockpit sidebar / selector will call this
// when it needs a picker without the 24h aggregates.
platformRouter.get('/operators', async (_req, res) => {
  const operators = await prisma.operator.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      testMode: true,
      jurisdiction: true,
      defaultCurrency: true,
      createdAt: true,
      suspendedAt: true,
    },
  });
  res.json({ operators });
});

// ─── Certificate registry (Tier-2, regulator-facing) ──────────────────────

const CERT_LABS = ['GLI', 'BMM', 'ITECH', 'ECOGRA', 'NMI', 'TRISIGMA', 'OTHER'] as const;
type CertLabLit = (typeof CERT_LABS)[number];

function classifyExpiry(expiresAt: Date, revokedAt: Date | null): 'valid' | 'expiring' | 'expired' | 'revoked' {
  if (revokedAt) return 'revoked';
  const now = Date.now();
  const ms = expiresAt.getTime() - now;
  if (ms <= 0) return 'expired';
  if (ms < 30 * 86_400_000) return 'expiring';
  return 'valid';
}

platformRouter.get('/certificates', async (_req, res) => {
  const rows = await prisma.certificate.findMany({
    orderBy: [{ expiresAt: 'asc' }, { gameCode: 'asc' }],
  });
  const nowIso = new Date().toISOString();
  const formatted = rows.map((c) => ({
    id: c.id,
    gameCode: c.gameCode,
    jurisdiction: c.jurisdiction,
    lab: c.lab,
    certId: c.certId,
    buildHash: c.buildHash,
    version: c.version,
    issuedAt: c.issuedAt.toISOString(),
    validFrom: c.validFrom.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    filePath: c.filePath,
    notes: c.notes,
    revokedAt: c.revokedAt?.toISOString() ?? null,
    status: classifyExpiry(c.expiresAt, c.revokedAt),
    daysToExpiry: Math.floor((c.expiresAt.getTime() - Date.now()) / 86_400_000),
  }));
  res.json({ now: nowIso, certificates: formatted });
});

platformRouter.post('/certificates', requireYantraCompliance, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const required = ['gameCode', 'jurisdiction', 'lab', 'certId', 'buildHash', 'validFrom', 'expiresAt'] as const;
  for (const k of required) {
    if (typeof b?.[k] !== 'string') {
      res.status(400).json({ error: 'missing_field', field: k });
      return;
    }
  }
  if (!CERT_LABS.includes(b.lab as CertLabLit)) {
    res.status(400).json({ error: 'invalid_lab', allowed: CERT_LABS });
    return;
  }
  const validFrom = new Date(b.validFrom as string);
  const expiresAt = new Date(b.expiresAt as string);
  const issuedAt = typeof b.issuedAt === 'string' ? new Date(b.issuedAt) : validFrom;
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(expiresAt.getTime()) || Number.isNaN(issuedAt.getTime())) {
    res.status(400).json({ error: 'invalid_date' });
    return;
  }
  if (expiresAt <= validFrom) {
    res.status(400).json({ error: 'expires_before_valid_from' });
    return;
  }

  try {
    const created = await prisma.certificate.create({
      data: {
        gameCode: String(b.gameCode),
        jurisdiction: String(b.jurisdiction),
        lab: b.lab as CertLabLit,
        certId: String(b.certId),
        buildHash: String(b.buildHash),
        version: typeof b.version === 'string' ? b.version : null,
        issuedAt,
        validFrom,
        expiresAt,
        filePath: typeof b.filePath === 'string' ? b.filePath : null,
        notes: typeof b.notes === 'string' ? b.notes : null,
      },
    });
    res.status(201).json({ certificate: { ...created, issuedAt: created.issuedAt.toISOString(), validFrom: created.validFrom.toISOString(), expiresAt: created.expiresAt.toISOString(), createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString(), revokedAt: created.revokedAt?.toISOString() ?? null } });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      res.status(409).json({ error: 'duplicate_cert', hint: '(gameCode, jurisdiction, lab, certId) must be unique' });
      return;
    }
    throw err;
  }
});

platformRouter.post('/certificates/:id/revoke', requireYantraCompliance, async (req, res) => {
  const { id } = req.params;
  const updated = await prisma.certificate
    .update({ where: { id }, data: { revokedAt: new Date() } })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'certificate_not_found' });
    return;
  }
  res.json({ certificate: { id: updated.id, revokedAt: updated.revokedAt?.toISOString() ?? null } });
});

// Cross-operator coverage: for each active operator's jurisdiction, is there
// a non-revoked, non-expired certificate covering the game code? Accepts
// jurisdiction "MULTI" certificates as a fallback. buildHash match is surfaced
// but not required for "covered" status — a separate Tier-2 follow-up will
// promote build-hash mismatch to a hard block at deploy time.
platformRouter.get('/certificates/coverage', async (_req, res) => {
  const operators = await prisma.operator.findMany({
    where: { status: { not: 'TERMINATED' } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      testMode: true,
      jurisdiction: true,
    },
  });
  const allCerts = await prisma.certificate.findMany({
    where: { revokedAt: null },
  });
  const liveBuildHash = process.env.BUILD_HASH ?? null;
  const nowMs = Date.now();

  const gameCodes = ['yantra']; // currently single-game; roadmap v2 = multi

  const rows = operators.map((op) => {
    const perGame = gameCodes.map((gameCode) => {
      const matching = allCerts
        .filter(
          (c) =>
            c.gameCode === gameCode &&
            (c.jurisdiction === op.jurisdiction || c.jurisdiction === 'MULTI'),
        )
        .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
      const best = matching.find((c) => c.expiresAt.getTime() > nowMs) ?? matching[0] ?? null;
      let status: 'covered' | 'expiring' | 'expired' | 'missing';
      if (!best) status = 'missing';
      else {
        const s = classifyExpiry(best.expiresAt, best.revokedAt);
        if (s === 'expired' || s === 'revoked') status = 'expired';
        else if (s === 'expiring') status = 'expiring';
        else status = 'covered';
      }
      return {
        gameCode,
        status,
        certificate: best
          ? {
              id: best.id,
              lab: best.lab,
              certId: best.certId,
              buildHash: best.buildHash,
              buildHashMatchesLive: liveBuildHash ? best.buildHash === liveBuildHash : null,
              expiresAt: best.expiresAt.toISOString(),
              daysToExpiry: Math.floor((best.expiresAt.getTime() - nowMs) / 86_400_000),
            }
          : null,
      };
    });
    const worst = perGame.reduce<'covered' | 'expiring' | 'expired' | 'missing'>(
      (acc, g) => {
        const rank = { covered: 0, expiring: 1, expired: 2, missing: 3 } as const;
        return rank[g.status] > rank[acc] ? g.status : acc;
      },
      'covered',
    );
    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      status: op.status,
      testMode: op.testMode,
      jurisdiction: op.jurisdiction,
      coverage: worst,
      games: perGame,
    };
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc[r.coverage] = (acc[r.coverage] ?? 0) + 1;
      return acc;
    },
    { covered: 0, expiring: 0, expired: 0, missing: 0 } as Record<string, number>,
  );

  res.json({
    buildHash: liveBuildHash,
    totals,
    operators: rows,
  });
});

// Update Operator.allowedCountries — used by geoAllowlist on session launch.
// Empty list means "no restriction" (default). Each code must be ISO 3166-1
// alpha-2 (two uppercase letters). Deduplicates and uppercases on save.
platformRouter.post('/operators/:id/allowed-countries', requireYantraAdmin, async (req, res) => {
  const { id } = req.params;
  const b = req.body as { countries?: unknown };
  if (!Array.isArray(b?.countries)) {
    res.status(400).json({ error: 'invalid_body', hint: 'expected { countries: string[] }' });
    return;
  }
  const invalid: string[] = [];
  const cleaned: string[] = [];
  for (const raw of b.countries) {
    if (typeof raw !== 'string') {
      invalid.push(String(raw));
      continue;
    }
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      invalid.push(raw);
      continue;
    }
    if (!cleaned.includes(code)) cleaned.push(code);
  }
  if (invalid.length > 0) {
    res.status(400).json({ error: 'invalid_country_code', invalid, hint: 'ISO 3166-1 alpha-2 (e.g. LK, IN, MY)' });
    return;
  }
  cleaned.sort();
  const updated = await prisma.operator
    .update({
      where: { id },
      data: { allowedCountries: cleaned },
      select: { id: true, slug: true, name: true, allowedCountries: true },
    })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  res.json({ operator: updated });
});

// Create a new operator end-to-end: Operator row + initial API-key
// credential (plaintext returned once, cipherBlob stored encrypted) +
// default OperatorGameConfig for yantra at the given currency. All
// three in one transaction so partial creation can't leave a dangling
// operator with no credentials.
platformRouter.post('/operators', requireYantraAdmin, async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const required = ['slug', 'name', 'jurisdiction', 'defaultCurrency', 'walletCallbackUrl'] as const;
  for (const k of required) {
    if (typeof b?.[k] !== 'string' || !(b[k] as string).trim()) {
      res.status(400).json({ error: 'missing_field', field: k });
      return;
    }
  }
  const slug = String(b.slug).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    res.status(400).json({ error: 'invalid_slug', hint: 'lowercase alphanumeric + dash, 2-63 chars' });
    return;
  }
  const jurisdiction = String(b.jurisdiction).toUpperCase();
  if (!/^[A-Z]{2}$|^MULTI$/.test(jurisdiction)) {
    res.status(400).json({ error: 'invalid_jurisdiction', hint: 'ISO 3166-1 alpha-2 or MULTI' });
    return;
  }
  const defaultCurrency = String(b.defaultCurrency).toUpperCase().slice(0, 8);
  const testMode = b.testMode === true;
  const environment = b.environment === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
  // Allowed currencies whitelist. Defaults to [defaultCurrency] so the
  // session-create enforcement has something to match against even on a
  // brand-new operator. Operators expand via dedicated PATCH later.
  const allowedCurrenciesRaw = Array.isArray(b.allowedCurrencies)
    ? (b.allowedCurrencies as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const allowedCurrencies = (allowedCurrenciesRaw.length > 0
    ? allowedCurrenciesRaw
    : [defaultCurrency]
  )
    .map((c) => c.toUpperCase().slice(0, 8))
    .filter((c) => /^[A-Z0-9]{2,8}$/.test(c));
  // Sibling pairing — if set, the sandbox ↔ production twin pointer is
  // written atomically (both sides). If the sibling doesn't exist or
  // doesn't match the expected environment, reject.
  const siblingId = typeof b.siblingOperatorId === 'string' ? b.siblingOperatorId : null;
  if (siblingId) {
    const sibling = await prisma.operator.findUnique({
      where: { id: siblingId },
      select: { id: true, environment: true, siblingOperatorId: true },
    });
    if (!sibling) {
      res.status(400).json({ error: 'sibling_not_found' });
      return;
    }
    if (sibling.environment === environment) {
      res.status(400).json({
        error: 'sibling_same_environment',
        hint: 'sandbox must pair with production and vice-versa',
      });
      return;
    }
    if (sibling.siblingOperatorId) {
      res.status(400).json({ error: 'sibling_already_paired' });
      return;
    }
  }

  // Generate a 256-bit random HMAC secret (the plaintext the operator will
  // sign with) and a KID for routing. Secret is returned in the response
  // body and never persisted in the clear.
  const plaintextSecret = randomBytes(32).toString('hex');
  const kid = `kid_${slug}_${randomBytes(6).toString('hex')}`;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const op = await tx.operator.create({
        data: {
          slug,
          name: String(b.name).trim().slice(0, 200),
          jurisdiction,
          defaultCurrency,
          allowedCurrencies,
          environment,
          siblingOperatorId: siblingId,
          testMode,
          walletCallbackUrl: String(b.walletCallbackUrl).trim(),
          notes: typeof b.notes === 'string' ? b.notes.slice(0, 2048) : null,
        },
      });

      if (siblingId) {
        // Back-reference to keep the pair symmetric.
        await tx.operator.update({
          where: { id: siblingId },
          data: { siblingOperatorId: op.id },
        });
      }

      await tx.operatorCredential.create({
        data: {
          operatorId: op.id,
          type: 'API_KEY_INBOUND',
          kid,
          cipherBlob: encryptSecret(plaintextSecret),
          label: 'initial inbound signing key',
        },
      });

      // Default game-config derived from docs/par-sheet.json §defaultConfig.
      // Min/max bet are conservative defaults; operator admin can tune after.
      await tx.operatorGameConfig.create({
        data: {
          operatorId: op.id,
          gameCode: 'ketapola-dice',
          currency: defaultCurrency,
          enabled: true,
          configJson: { lowWeight: 48, highWeight: 48 },
          configVersion: 'v1',
          minBetMicro: 100_000n,              // 1.00 base units
          maxBetMicro: 1_000_000_000n,         // 10,000 base units
          commissionMicro: 3000n,              // 3% — matches par-sheet default
          bettingWindowMs: 15_000,
          rollingWindowMs: 4_000,
          cooldownMs: 3_000,
        },
      });

      return op;
    });

    res.status(201).json({
      operator: {
        id: created.id,
        slug: created.slug,
        name: created.name,
        status: created.status,
        testMode: created.testMode,
        jurisdiction: created.jurisdiction,
        defaultCurrency: created.defaultCurrency,
        walletCallbackUrl: created.walletCallbackUrl,
        createdAt: created.createdAt.toISOString(),
      },
      credential: {
        kid,
        // CRITICAL: plaintext is returned exactly once here. Operator must
        // save it; we cannot re-emit it on re-fetch.
        secret: plaintextSecret,
        algorithm: 'HMAC-SHA256',
      },
      warning: 'SAVE THE SECRET NOW — it will never be shown again. Rotate via credential-rotation flow (pending) if lost.',
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      res.status(409).json({ error: 'duplicate_slug', hint: 'operator slug already exists' });
      return;
    }
    throw err;
  }
});

// Suspend an operator — reversible pause. Sets status=PAUSED and records
// the audit triple (who/when/why). operatorAuth still verifies signatures
// for in-flight wallet calls (bet/win/rollback settle cleanly), but
// session-create rejects with 403 operator_not_active. Engine lifecycle is
// unchanged: running engines keep handling existing sessions until they
// terminate; on next RGS restart, PAUSED operators' engines don't boot
// (EngineRegistry gates on status === 'ACTIVE').
platformRouter.post('/operators/:id/suspend', requireYantraAdmin, async (req, res) => {
  const { id } = req.params;
  const body = req.body as { reason?: unknown };
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 256) : null;
  const actor = req.portalUser?.email ?? null;
  const updated = await prisma.operator
    .update({
      where: { id },
      data: {
        status: 'PAUSED',
        suspendedAt: new Date(),
        suspendedReason: reason,
        suspendedBy: actor,
      },
      select: { id: true, slug: true, name: true, status: true, suspendedAt: true, suspendedReason: true, suspendedBy: true },
    })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  res.json({
    operator: {
      ...updated,
      suspendedAt: updated.suspendedAt?.toISOString() ?? null,
    },
  });
});

platformRouter.post('/operators/:id/reactivate', requireYantraAdmin, async (req, res) => {
  const { id } = req.params;
  const updated = await prisma.operator
    .update({
      where: { id },
      data: {
        status: 'ACTIVE',
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null,
      },
      select: { id: true, slug: true, name: true, status: true },
    })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  res.json({ operator: updated });
});

// Toggle a game-config kill-switch. Blocks NEW session launches for the
// (operator, gameCode, currency) tuple; in-flight sessions continue. Stores
// the actor (portal user email) and reason for audit. This is the lightest-
// weight incident response lever — use when a specific game shape or
// currency on one operator is misbehaving without impacting their other
// games or other operators.
platformRouter.post('/game-configs/:id/kill-switch', requireYantraCompliance, async (req, res) => {
  const { id } = req.params;
  const body = req.body as { enabled?: unknown; reason?: unknown };
  if (typeof body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'invalid_body', hint: 'expected { enabled: boolean, reason?: string }' });
    return;
  }
  const actor = req.portalUser?.email ?? null;
  const now = new Date();
  const updated = await prisma.operatorGameConfig
    .update({
      where: { id },
      data: body.enabled
        ? {
            killSwitch: true,
            killSwitchReason: typeof body.reason === 'string' ? body.reason.slice(0, 256) : null,
            killSwitchedAt: now,
            killSwitchedBy: actor,
          }
        : {
            killSwitch: false,
            killSwitchReason: null,
            killSwitchedAt: null,
            killSwitchedBy: null,
          },
      select: {
        id: true,
        operatorId: true,
        gameCode: true,
        currency: true,
        killSwitch: true,
        killSwitchReason: true,
        killSwitchedAt: true,
        killSwitchedBy: true,
      },
    })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'game_config_not_found' });
    return;
  }
  res.json({ gameConfig: updated });
});

// Flip the test-mode flag. Lightweight mutation — purely affects platform
// reporting visibility; doesn't touch money or session state, so it's safe
// to expose without the lifecycle-mutation machinery the riskier operations
// (suspend, rotate, create) will need.
platformRouter.post('/operators/:id/test-mode', requireYantraAdmin, async (req, res) => {
  const { id } = req.params;
  const body = req.body as { testMode?: unknown };
  if (typeof body?.testMode !== 'boolean') {
    res.status(400).json({ error: 'invalid_body', hint: 'expected { testMode: boolean }' });
    return;
  }
  const updated = await prisma.operator
    .update({
      where: { id },
      data: { testMode: body.testMode },
      select: { id: true, slug: true, name: true, testMode: true },
    })
    .catch(() => null);
  if (!updated) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  res.json({ operator: updated });
});

// Settlement & integrity cockpit — the iGaming-native tier-0 view.
// Per operator, for the requested day (UTC midnight→midnight, default today):
// GGR/NGR numbers, rollback activity, failed outbound wallet calls, stuck
// held bets (GLI-19 §3 incomplete-games register health), and stuck retry
// jobs. Emits a per-operator health roll-up so the UI can traffic-light it.
// Stuck-held threshold is configurable via ?staleMinutes=N (default 15).
interface SettlementRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  currency: string;
  health: 'healthy' | 'warning' | 'incident';
  bets: { count: number; volumeMicro: string };
  wins: { count: number; volumeMicro: string };
  rollbacks: { count: number; volumeMicro: string };
  ggrMicro: string;
  failedOutboundCalls: number;
  stuckHeldBets: number;
  stuckRetryJobs: number;
}

interface SettlementTotals {
  failedCalls: number;
  stuckHeld: number;
  stuckJobs: number;
  healthy: number;
  warnings: number;
  incidents: number;
}

async function computeSettlement(
  dayStart: Date,
  dayEnd: Date,
  staleMinutes: number,
  includeTest: boolean,
): Promise<{ rows: SettlementRow[]; totals: SettlementTotals }> {
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000);

  const operators = await prisma.operator.findMany({
    where: { status: { not: 'TERMINATED' }, ...testModeWhere(includeTest) },
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, status: true, defaultCurrency: true },
  });

  const [
    betsByOp,
    winsByOp,
    rollbackCallsByOp,
    failedCallsByOp,
    stuckHeldByOp,
    stuckJobsByOp,
  ] = await Promise.all([
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: {
        status: { in: ['ACCEPTED', 'SETTLED'] },
        placedAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: { won: true, settledAt: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
      _sum: { wonAmountMicro: true },
    }),
    prisma.walletCall.groupBy({
      by: ['operatorId', 'currency'],
      where: {
        direction: 'OUTBOUND',
        endpoint: 'ROLLBACK',
        succeeded: true,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.walletCall.groupBy({
      by: ['operatorId'],
      where: {
        direction: 'OUTBOUND',
        succeeded: false,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      _count: { _all: true },
    }),
    prisma.pendingRoundBet.groupBy({
      by: ['operatorId'],
      where: { state: 'HELD', heldAt: { lt: staleBefore } },
      _count: { _all: true },
    }),
    prisma.pendingWalletJob.groupBy({
      by: ['operatorId'],
      where: { completedAt: null, attempts: { gte: 3 } },
      _count: { _all: true },
    }),
  ]);

  const betMap = new Map(betsByOp.map((r) => [`${r.operatorId}:${r.currency}`, r]));
  const winMap = new Map(winsByOp.map((r) => [`${r.operatorId}:${r.currency}`, r]));
  const rollbackMap = new Map(
    rollbackCallsByOp.map((r) => [`${r.operatorId}:${r.currency}`, r]),
  );
  const failedCallMap = new Map(failedCallsByOp.map((r) => [r.operatorId, r._count._all]));
  const stuckHeldMap = new Map(stuckHeldByOp.map((r) => [r.operatorId, r._count._all]));
  const stuckJobsMap = new Map(stuckJobsByOp.map((r) => [r.operatorId, r._count._all]));

  const rows = operators.map((op) => {
    const key = `${op.id}:${op.defaultCurrency}`;
    const bet = betMap.get(key);
    const win = winMap.get(key);
    const rollback = rollbackMap.get(key);
    const betVol = bet?._sum.amountMicro ?? 0n;
    const winVol = win?._sum.wonAmountMicro ?? 0n;
    const rollbackVol = rollback?._sum.amountMicro ?? 0n;
    const stuckHeld = stuckHeldMap.get(op.id) ?? 0;
    const stuckJobs = stuckJobsMap.get(op.id) ?? 0;
    const failedCalls = failedCallMap.get(op.id) ?? 0;

    let health: 'healthy' | 'warning' | 'incident';
    if (stuckHeld > 0 || stuckJobs > 0) health = 'incident';
    else if (failedCalls > 0) health = 'warning';
    else health = 'healthy';

    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      status: op.status,
      currency: op.defaultCurrency,
      health,
      bets: { count: bet?._count._all ?? 0, volumeMicro: betVol.toString() },
      wins: { count: win?._count._all ?? 0, volumeMicro: winVol.toString() },
      rollbacks: { count: rollback?._count._all ?? 0, volumeMicro: rollbackVol.toString() },
      ggrMicro: (betVol - winVol).toString(),
      failedOutboundCalls: failedCalls,
      stuckHeldBets: stuckHeld,
      stuckRetryJobs: stuckJobs,
    };
  });

  const totals: SettlementTotals = rows.reduce(
    (acc, r) => {
      acc.failedCalls += r.failedOutboundCalls;
      acc.stuckHeld += r.stuckHeldBets;
      acc.stuckJobs += r.stuckRetryJobs;
      if (r.health === 'incident') acc.incidents += 1;
      else if (r.health === 'warning') acc.warnings += 1;
      else acc.healthy += 1;
      return acc;
    },
    { failedCalls: 0, stuckHeld: 0, stuckJobs: 0, healthy: 0, warnings: 0, incidents: 0 },
  );

  return { rows, totals };
}

function parseDayParams(
  req: { query: Record<string, unknown> },
): { dayStart: Date; dayEnd: Date; staleMinutes: number } | { error: string } {
  const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
  const staleMinutes = Math.max(1, Number(req.query.staleMinutes ?? 15) || 15);
  const dayStart = dateParam
    ? new Date(`${dateParam}T00:00:00.000Z`)
    : (() => {
        const d = new Date();
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      })();
  if (Number.isNaN(dayStart.getTime())) return { error: 'invalid_date' };
  return { dayStart, dayEnd: new Date(dayStart.getTime() + 86_400_000), staleMinutes };
}

platformRouter.get('/settlement', async (req, res) => {
  const parsed = parseDayParams(req);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error, hint: 'use YYYY-MM-DD (UTC)' });
    return;
  }
  const { dayStart, dayEnd, staleMinutes } = parsed;
  const { rows, totals } = await computeSettlement(dayStart, dayEnd, staleMinutes, includeTestFlag(req));
  res.json({
    date: dayStart.toISOString().slice(0, 10),
    windowStart: dayStart.toISOString(),
    windowEnd: dayEnd.toISOString(),
    staleMinutes,
    totals,
    operators: rows,
  });
});

// Signed settlement feed. Operators' finance systems pull this nightly to
// reconcile against their own wallet ledger. The body is deterministic
// (canonical JSON, sorted keys, no whitespace) so the signature can be
// verified byte-for-byte. CSV variant for spreadsheet / ERP ingestion.
platformRouter.get('/settlement/feed', async (req, res) => {
  const parsed = parseDayParams(req);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error, hint: 'use YYYY-MM-DD (UTC)' });
    return;
  }
  const { dayStart, dayEnd, staleMinutes } = parsed;
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const { rows, totals } = await computeSettlement(dayStart, dayEnd, staleMinutes, includeTestFlag(req));

  if (format === 'csv') {
    const csvRows = rows.map((r) => ({
      operator_id: r.id,
      operator_slug: r.slug,
      operator_name: r.name,
      currency: r.currency,
      health: r.health,
      bet_count: r.bets.count,
      bet_volume_micro: r.bets.volumeMicro,
      win_count: r.wins.count,
      win_volume_micro: r.wins.volumeMicro,
      rollback_count: r.rollbacks.count,
      rollback_volume_micro: r.rollbacks.volumeMicro,
      ggr_micro: r.ggrMicro,
      failed_outbound_calls: r.failedOutboundCalls,
      stuck_held_bets: r.stuckHeldBets,
      stuck_retry_jobs: r.stuckRetryJobs,
    }));
    const body = toCsv(csvRows, [
      'operator_id',
      'operator_slug',
      'operator_name',
      'currency',
      'health',
      'bet_count',
      'bet_volume_micro',
      'win_count',
      'win_volume_micro',
      'rollback_count',
      'rollback_volume_micro',
      'ggr_micro',
      'failed_outbound_calls',
      'stuck_held_bets',
      'stuck_retry_jobs',
    ]);
    const signature = signBody(body);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="settlement-${dayStart.toISOString().slice(0, 10)}.csv"`,
    );
    res.setHeader('X-Signature', `sha256=${signature}`);
    res.setHeader('X-Signature-KeyId', 'platform-v1');
    res.setHeader('X-Signature-Algorithm', 'HMAC-SHA256');
    res.end(body);
    return;
  }

  const payload = {
    date: dayStart.toISOString().slice(0, 10),
    windowStart: dayStart.toISOString(),
    windowEnd: dayEnd.toISOString(),
    staleMinutes,
    operators: rows,
    totals: {
      operatorCount: rows.length,
      failedCalls: totals.failedCalls,
      stuckHeld: totals.stuckHeld,
      stuckJobs: totals.stuckJobs,
    },
  };
  const body = canonicalJson(payload);
  const signature = signBody(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Signature', `sha256=${signature}`);
  res.setHeader('X-Signature-KeyId', 'platform-v1');
  res.setHeader('X-Signature-Algorithm', 'HMAC-SHA256');
  res.setHeader('X-Canonical-Json', '1');
  res.end(body);
});

// Per-operator SLA — outbound wallet-call p50/p95/p99 latency and success
// rate per endpoint, over a rolling window. Percentiles via Postgres raw SQL
// since Prisma's groupBy doesn't support percentile_cont.
platformRouter.get('/sla', async (req, res) => {
  const windowParam = typeof req.query.window === 'string' ? req.query.window : '24h';
  const windowMap: Record<string, number> = {
    '1h': 3_600_000,
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
  };
  const windowMs = windowMap[windowParam];
  if (!windowMs) {
    res.status(400).json({ error: 'invalid_window', allowed: Object.keys(windowMap) });
    return;
  }
  const since = new Date(Date.now() - windowMs);

  const [operators, rawRows] = await Promise.all([
    prisma.operator.findMany({
      where: { status: { not: 'TERMINATED' }, ...testModeWhere(includeTestFlag(req)) },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true, status: true },
    }),
    prisma.$queryRaw<
      Array<{
        operator_id: string;
        endpoint: string;
        total: bigint;
        failed: bigint;
        p50: number | null;
        p95: number | null;
        p99: number | null;
        max: number | null;
      }>
    >`
      SELECT
        operator_id,
        endpoint::text AS endpoint,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE succeeded = false)::bigint AS failed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::float AS p99,
        MAX(latency_ms)::float AS max
      FROM wallet_calls
      WHERE direction = 'OUTBOUND'
        AND created_at >= ${since}
        AND latency_ms IS NOT NULL
      GROUP BY operator_id, endpoint
      ORDER BY operator_id, endpoint
    `,
  ]);

  // Target SLOs from README: wallet-call p99 < 300ms.
  const P99_TARGET_MS = 300;
  const SUCCESS_TARGET = 0.999;

  const byOp = new Map<string, Array<{
    endpoint: string;
    total: number;
    failed: number;
    successRate: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
    status: 'ok' | 'warn' | 'breach';
  }>>();
  for (const r of rawRows) {
    const total = Number(r.total);
    const failed = Number(r.failed);
    const successRate = total > 0 ? 1 - failed / total : 1;
    const p99 = r.p99 ?? 0;
    let status: 'ok' | 'warn' | 'breach' = 'ok';
    if (successRate < SUCCESS_TARGET || p99 >= P99_TARGET_MS) status = 'breach';
    else if (p99 >= P99_TARGET_MS * 0.7) status = 'warn';
    const list = byOp.get(r.operator_id) ?? [];
    list.push({
      endpoint: r.endpoint,
      total,
      failed,
      successRate,
      p50Ms: r.p50,
      p95Ms: r.p95,
      p99Ms: r.p99,
      maxMs: r.max,
      status,
    });
    byOp.set(r.operator_id, list);
  }

  const perOperator = operators.map((op) => {
    const endpoints = byOp.get(op.id) ?? [];
    const worst = endpoints.reduce<'ok' | 'warn' | 'breach'>((acc, e) => {
      if (e.status === 'breach') return 'breach';
      if (e.status === 'warn' && acc === 'ok') return 'warn';
      return acc;
    }, 'ok');
    const totalCalls = endpoints.reduce((s, e) => s + e.total, 0);
    const totalFailed = endpoints.reduce((s, e) => s + e.failed, 0);
    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      status: op.status,
      overall: worst,
      totalCalls,
      totalFailed,
      successRate: totalCalls > 0 ? 1 - totalFailed / totalCalls : 1,
      endpoints,
    };
  });

  res.json({
    window: windowParam,
    windowStart: since.toISOString(),
    targets: { p99Ms: P99_TARGET_MS, successRate: SUCCESS_TARGET },
    operators: perOperator,
  });
});

// Observed RTP vs. declared (theoretical) per operator / currency. Declared
// RTP is derived from OperatorGameConfig.commissionMicro using the par-sheet
// formula: RTP = P(win) × payoutMultiplier × (1 − c), which for symmetric
// dice (default weights 48/48) collapses to (1 − c). Drift flag uses the
// per-round σ = (1 − c) from docs/par-sheet.json §volatility, so the 3σ
// band shrinks as √N. Rounds under 1,000 are flagged low-confidence rather
// than drifting.
platformRouter.get('/rtp', async (req, res) => {
  const windowParam = typeof req.query.window === 'string' ? req.query.window : '7d';
  const windowMap: Record<string, number> = {
    '24h': 86_400_000,
    '7d': 7 * 86_400_000,
    '30d': 30 * 86_400_000,
  };
  const windowMs = windowMap[windowParam];
  if (!windowMs) {
    res.status(400).json({ error: 'invalid_window', allowed: Object.keys(windowMap) });
    return;
  }
  const since = new Date(Date.now() - windowMs);
  const LOW_CONFIDENCE_N = 1000;

  const [operators, bets, wins, configs] = await Promise.all([
    prisma.operator.findMany({
      where: { status: { not: 'TERMINATED' }, ...testModeWhere(includeTestFlag(req)) },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true, defaultCurrency: true },
    }),
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: { status: 'SETTLED', settledAt: { gte: since } },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.bet.groupBy({
      by: ['operatorId', 'currency'],
      where: { won: true, settledAt: { gte: since } },
      _sum: { wonAmountMicro: true },
    }),
    prisma.operatorGameConfig.findMany({
      select: { operatorId: true, currency: true, commissionMicro: true },
    }),
  ]);

  const betMap = new Map(bets.map((r) => [`${r.operatorId}:${r.currency}`, r]));
  const winMap = new Map(wins.map((r) => [`${r.operatorId}:${r.currency}`, r]));
  const configMap = new Map(
    configs.map((c) => [`${c.operatorId}:${c.currency}`, Number(c.commissionMicro) / 100_000]),
  );

  const rows = operators.map((op) => {
    const key = `${op.id}:${op.defaultCurrency}`;
    const bet = betMap.get(key);
    const win = winMap.get(key);
    const commissionFraction = configMap.get(key) ?? 0;
    const betVol = bet?._sum.amountMicro ?? 0n;
    const winVol = win?._sum.wonAmountMicro ?? 0n;
    const roundCount = bet?._count._all ?? 0;

    const betVolN = Number(betVol);
    const winVolN = Number(winVol);
    const observedRtp = betVolN > 0 ? winVolN / betVolN : null;
    const expectedRtp = 1 - commissionFraction;

    let flag: 'ok' | 'watch' | 'drift' | 'low_n';
    let zScore: number | null = null;
    if (roundCount < LOW_CONFIDENCE_N) {
      flag = 'low_n';
    } else if (observedRtp === null) {
      flag = 'low_n';
    } else {
      const sigmaPerRound = 1 - commissionFraction; // from par-sheet §volatility
      const se = sigmaPerRound / Math.sqrt(roundCount);
      zScore = (observedRtp - expectedRtp) / se;
      const absZ = Math.abs(zScore);
      if (absZ > 3) flag = 'drift';
      else if (absZ > 2) flag = 'watch';
      else flag = 'ok';
    }

    return {
      id: op.id,
      slug: op.slug,
      name: op.name,
      currency: op.defaultCurrency,
      roundCount,
      betVolumeMicro: betVol.toString(),
      winVolumeMicro: winVol.toString(),
      observedRtp,
      expectedRtp,
      commissionFraction,
      driftPct: observedRtp !== null ? (observedRtp - expectedRtp) * 100 : null,
      zScore,
      flag,
    };
  });

  res.json({
    window: windowParam,
    windowStart: since.toISOString(),
    lowConfidenceThreshold: LOW_CONFIDENCE_N,
    operators: rows,
  });
});

// Single-operator drill-down. Metadata + last-24h KPIs + the satellite rows
// the cockpit cares about (credentials metadata only — never the secret,
// users, game configs). Credentials list excludes cipherBlob deliberately.
platformRouter.get('/operators/:id', async (req, res) => {
  const { id } = req.params;
  const since = new Date(Date.now() - 86_400_000);
  const now = new Date();

  const operator = await prisma.operator.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      testMode: true,
      environment: true,
      siblingOperatorId: true,
      jurisdiction: true,
      defaultCurrency: true,
      allowedCurrencies: true,
      walletCallbackUrl: true,
      ipAllowList: true,
      allowedCountries: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      suspendedAt: true,
      suspendedReason: true,
      suspendedBy: true,
    },
  });
  if (!operator) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }

  const [activeSessions, betAgg, winAgg, credentials, users, gameConfigs] = await Promise.all([
    prisma.gameSession.count({
      where: { operatorId: id, terminatedAt: null, expiresAt: { gt: now } },
    }),
    prisma.bet.aggregate({
      where: {
        operatorId: id,
        currency: operator.defaultCurrency,
        status: { in: ['ACCEPTED', 'SETTLED'] },
        placedAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.bet.aggregate({
      where: {
        operatorId: id,
        currency: operator.defaultCurrency,
        won: true,
        settledAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { wonAmountMicro: true },
    }),
    prisma.operatorCredential.findMany({
      where: { operatorId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        kid: true,
        type: true,
        label: true,
        notBefore: true,
        notAfter: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
    prisma.operatorUser.findMany({
      where: { operatorId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        role: true,
        displayName: true,
        lastLoginAt: true,
        createdAt: true,
      },
    }),
    prisma.operatorGameConfig.findMany({
      where: { operatorId: id },
      orderBy: [{ gameCode: 'asc' }, { currency: 'asc' }],
      select: {
        id: true,
        gameCode: true,
        currency: true,
        enabled: true,
        configJson: true,
        configVersion: true,
        minBetMicro: true,
        maxBetMicro: true,
        commissionMicro: true,
        bettingWindowMs: true,
        rollingWindowMs: true,
        cooldownMs: true,
        killSwitch: true,
        killSwitchReason: true,
        killSwitchedAt: true,
        killSwitchedBy: true,
        pinnedVersion: true,
      },
    }),
  ]);

  const betsVolume = betAgg._sum.amountMicro ?? 0n;
  const winsVolume = winAgg._sum.wonAmountMicro ?? 0n;

  res.json({
    operator,
    stats: {
      currency: operator.defaultCurrency,
      activeSessions,
      bets: { count: betAgg._count._all, volumeMicro: betsVolume.toString() },
      wins: { count: winAgg._count._all, volumeMicro: winsVolume.toString() },
      ggrMicro: (betsVolume - winsVolume).toString(),
    },
    credentials,
    users,
    gameConfigs: gameConfigs.map((c) => ({
      ...c,
      minBetMicro: c.minBetMicro.toString(),
      maxBetMicro: c.maxBetMicro.toString(),
      commissionMicro: c.commissionMicro.toString(),
    })),
  });
});

// ── Credential rotation (provider-scoped) ─────────────────────
//
// Mints a new credential of the chosen type and sunsets the old one
// with a configurable grace window. Plaintext secret is returned ONCE
// and never persisted in the clear. Operators who can't currently log in
// (password lost, credentials compromised) ask us to rotate on their
// behalf via this endpoint; the operator-self-service equivalent lives
// under /admin/credentials:rotate.

const RotateBody = z.object({
  type: z.enum(['API_KEY_INBOUND', 'WALLET_HMAC_OUTBOUND']),
  graceMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
  label: z.string().max(100).optional(),
});

platformRouter.post('/operators/:id/credentials:rotate', requireYantraAdmin, async (req, res) => {
  const parsed = RotateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const op = await prisma.operator.findUnique({
    where: { id: req.params.id as string },
    select: { id: true, status: true },
  });
  if (!op) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  if (op.status === 'TERMINATED') {
    res.status(409).json({ error: 'operator_terminated' });
    return;
  }
  const actor = req.portalUser;
  if (!actor) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  const result = await rotateCredential({
    operatorId: op.id,
    type: parsed.data.type,
    actorUserId: actor.id,
    actorEmail: actor.email,
    graceMs: parsed.data.graceMs,
    label: parsed.data.label,
  });
  res.status(201).json({
    kid: result.kid,
    secret: result.secret,
    algorithm: 'HMAC-SHA256',
    previousKid: result.previousKid,
    previousCredentialRetiresAt: result.previousCredentialRetiresAt,
    warning: 'SAVE THE SECRET NOW — it will never be shown again.',
  });
});

// Immediate revoke — for incident response. No grace window. The
// operator's in-flight requests will 401 starting immediately.
platformRouter.post('/credentials/:id/revoke', requireYantraAdmin, async (req, res) => {
  const actor = req.portalUser;
  if (!actor) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  try {
    await revokeCredentialImmediately(req.params.id as string, actor.id, actor.email);
    res.json({ ok: true });
  } catch (err) {
    if ((err as Error).message === 'credential_not_found') {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }
    throw err;
  }
});

// ── Global kill-switch ─────────────────────────────────────────────

platformRouter.get('/kill-switch', async (_req, res) => {
  res.json(await globalKillSwitch.snapshot());
});

const EngageBody = z.object({ reason: z.string().min(1).max(256) });
platformRouter.post('/kill-switch/engage', requireYantraCompliance, async (req, res) => {
  const parsed = EngageBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const actor = req.portalUser?.email ?? 'anonymous';
  const snap = await globalKillSwitch.engage(parsed.data.reason, actor);
  res.json(snap);
});

platformRouter.post('/kill-switch/disengage', requireYantraCompliance, async (req, res) => {
  const actor = req.portalUser?.email ?? 'anonymous';
  const snap = await globalKillSwitch.disengage(actor);
  res.json(snap);
});

// ── Admin audit log (read-only) ────────────────────────────────────

const AuditQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  actor: z.string().email().optional(),
  path: z.string().optional(),
  targetId: z.string().optional(),
});
platformRouter.get('/admin-audit', async (req, res) => {
  const parsed = AuditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { cursor, limit, actor, path, targetId } = parsed.data;
  const rows = await prisma.adminAuditEntry.findMany({
    where: {
      ...(actor ? { actorEmail: actor } : {}),
      ...(path ? { path: { startsWith: path } } : {}),
      ...(targetId ? { targetId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > limit ? rows.pop()!.id : null;
  res.json({ items: rows, nextCursor });
});

// ── Cross-operator round finder ───────────────────────────────────
//
// Provider staff resolve disputes / ops issues with either a bet
// transactionUuid (most common — customer quotes it from their statement),
// a round id, or a player ref. We fan out across all operators and
// return the matching round plus bet chain.

const FindByTx = z.object({
  transactionUuid: z.string().uuid(),
});
platformRouter.get('/rounds/by-transaction', async (req, res) => {
  const parsed = FindByTx.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const bet = await prisma.bet.findFirst({
    where: {
      OR: [
        { betTransactionUuid: parsed.data.transactionUuid },
        { winTransactionUuid: parsed.data.transactionUuid },
        { rollbackTransactionUuid: parsed.data.transactionUuid },
      ],
    },
    include: { round: true, operator: true },
  });
  if (!bet) {
    res.status(404).json({ error: 'transaction_not_found' });
    return;
  }
  res.json({
    operator: {
      id: bet.operator.id,
      slug: bet.operator.slug,
      name: bet.operator.name,
      jurisdiction: bet.operator.jurisdiction,
    },
    roundId: bet.round.id,
    bet: {
      id: bet.id,
      selection: bet.selection,
      selectionType: bet.selectionType,
      amountMicro: bet.amountMicro.toString(),
      currency: bet.currency,
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
    },
    round: {
      state: bet.round.state,
      outcomeType: bet.round.outcomeType,
      outcome: bet.round.outcomeData,
      rngVersion: bet.round.rngVersion,
      startedAt: bet.round.startedAt?.toISOString() ?? null,
      settledAt: bet.round.settledAt?.toISOString() ?? null,
    },
  });
});

const PlayerRoundsQuery = z.object({
  operatorId: z.string().uuid(),
  playerRef: z.string().min(1).max(128),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
platformRouter.get('/rounds/by-player', async (req, res) => {
  const parsed = PlayerRoundsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { operatorId, playerRef, from, to, limit } = parsed.data;
  const bets = await prisma.bet.findMany({
    where: {
      operatorId,
      playerRef,
      ...(from || to
        ? {
            placedAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: { round: true },
  });
  res.json({
    items: bets.map((b) => ({
      betId: b.id,
      roundId: b.roundId,
      selection: b.selection,
      selectionType: b.selectionType,
      amountMicro: b.amountMicro.toString(),
      currency: b.currency,
      status: b.status,
      won: b.won,
      wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
      placedAt: b.placedAt.toISOString(),
      transactions: {
        bet: b.betTransactionUuid,
        win: b.winTransactionUuid,
        rollback: b.rollbackTransactionUuid,
      },
      round: {
        state: b.round.state,
        outcomeType: b.round.outcomeType,
        outcome: b.round.outcomeData,
      },
    })),
  });
});

// Full round dump (seed, wallet-call chain) keyed by roundId. Mirrors the
// operator-scoped replay but allows cross-operator access for staff.
platformRouter.get('/rounds/:roundId', async (req, res) => {
  const round = await prisma.round.findUnique({
    where: { id: req.params.roundId as string },
    include: {
      bets: { orderBy: { placedAt: 'asc' } },
      walletCalls: { orderBy: { createdAt: 'asc' } },
      operator: { select: { id: true, slug: true, name: true, jurisdiction: true } },
      session: {
        select: {
          id: true,
          playerRef: true,
          currency: true,
          jurisdiction: true,
          mode: true,
          rgLimits: true,
          createdAt: true,
          terminatedAt: true,
        },
      },
    },
  });
  if (!round) {
    res.status(404).json({ error: 'round_not_found' });
    return;
  }
  const terminal = round.state === 'SETTLED' || round.state === 'VOIDED';
  res.json({
    operator: round.operator,
    round: {
      id: round.id,
      state: round.state,
      nonce: round.nonce,
      rngVersion: round.rngVersion,
      buildHash: round.buildHash,
      gameCode: round.gameCode,
      currency: round.currency,
      outcomeType: round.outcomeType,
      outcome: round.outcomeData,
      serverSeed: terminal ? round.serverSeed : null,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      totalBetsMicro: round.totalBetsMicro.toString(),
      totalPayoutsMicro: round.totalPayoutsMicro.toString(),
      startedAt: round.startedAt?.toISOString() ?? null,
      rolledAt: round.rolledAt?.toISOString() ?? null,
      settledAt: round.settledAt?.toISOString() ?? null,
      voidedAt: round.voidedAt?.toISOString() ?? null,
      prevRowHash: round.prevRowHash,
      rowHash: round.rowHash,
    },
    session: round.session,
    bets: round.bets.map((b) => ({
      id: b.id,
      selection: b.selection,
      selectionType: b.selectionType,
      amountMicro: b.amountMicro.toString(),
      status: b.status,
      won: b.won,
      wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
      placedAt: b.placedAt.toISOString(),
      transactions: {
        bet: b.betTransactionUuid,
        win: b.winTransactionUuid,
        rollback: b.rollbackTransactionUuid,
      },
    })),
    walletCalls: round.walletCalls.map((c) => ({
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
      requestBody: c.requestBody,
      responseBody: c.responseBody,
      prevRowHash: c.prevRowHash,
      rowHash: c.rowHash,
      createdAt: c.createdAt.toISOString(),
    })),
  });
});

// ── Game-config editor ────────────────────────────────────────────
//
// Patch one or more fields of an OperatorGameConfig. Every mutation
// is captured by OperatorConfigAuditLog so a reviewer can replay the
// sequence of changes that led to the current live values.

const GameConfigPatch = z.object({
  enabled: z.boolean().optional(),
  // Plugin-owned math config. Not validated here — the owning plugin's
  // configSchema is applied at engine reload; an invalid patch will persist
  // but the next engine start for this (operator, game, currency) will
  // refuse to boot.
  configJson: z.record(z.unknown()).optional(),
  minBetMicro: z.string().regex(/^\d+$/).optional(),
  maxBetMicro: z.string().regex(/^\d+$/).optional(),
  commissionMicro: z.string().regex(/^\d+$/).optional(),
  bettingWindowMs: z.number().int().min(1000).max(120_000).optional(),
  rollingWindowMs: z.number().int().min(500).max(60_000).optional(),
  cooldownMs: z.number().int().min(0).max(60_000).optional(),
  pinnedVersion: z.string().max(64).nullable().optional(),
});

platformRouter.patch('/game-configs/:id', requireYantraAdmin, async (req, res) => {
  const parsed = GameConfigPatch.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.operatorGameConfig.findUnique({
    where: { id: req.params.id as string },
  });
  if (!existing) {
    res.status(404).json({ error: 'game_config_not_found' });
    return;
  }
  const actor = req.portalUser;
  if (!actor) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }

  const patch = parsed.data;
  const data: Record<string, unknown> = {};
  const changes: Record<string, { before: unknown; after: unknown }> = {};

  const fieldMap: Record<string, keyof typeof existing> = {
    enabled: 'enabled',
    configJson: 'configJson',
    bettingWindowMs: 'bettingWindowMs',
    rollingWindowMs: 'rollingWindowMs',
    cooldownMs: 'cooldownMs',
    pinnedVersion: 'pinnedVersion',
  };
  for (const [k, dbField] of Object.entries(fieldMap)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined) {
      const before = existing[dbField];
      if (before !== v) {
        data[k] = v;
        changes[k] = { before, after: v };
      }
    }
  }
  for (const k of ['minBetMicro', 'maxBetMicro', 'commissionMicro'] as const) {
    const v = patch[k];
    if (v !== undefined) {
      const before = (existing as unknown as Record<string, bigint>)[k]!.toString();
      if (before !== v) {
        data[k] = BigInt(v);
        changes[k] = { before, after: v };
      }
    }
  }

  if (Object.keys(data).length === 0) {
    res.json({ ok: true, changes: 0 });
    return;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.operatorGameConfig.update({
      where: { id: existing.id },
      data,
    });
    await tx.operatorConfigAuditLog.create({
      data: {
        operatorId: existing.operatorId,
        gameCode: existing.gameCode,
        field: 'bulk_patch',
        oldValue: JSON.stringify(
          Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before])),
        ),
        newValue: JSON.stringify(
          Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after])),
        ),
        changedBy: actor.id,
      },
    });
    return u;
  });

  // Kick the EngineRegistry so the change is live without a restart.
  try {
    const { getEngineRegistry } = await import('../services/EngineRegistry.js');
    const eng = getEngineRegistry().get(updated.operatorId, updated.gameCode, updated.currency);
    if (eng) {
      eng.updateConfig({
        minBetMicro: updated.minBetMicro,
        maxBetMicro: updated.maxBetMicro,
        commissionMicro: updated.commissionMicro,
        bettingWindowMs: updated.bettingWindowMs,
        rollingWindowMs: updated.rollingWindowMs,
        cooldownMs: updated.cooldownMs,
        configVersion: updated.configVersion,
      });
      // Plugin math config lives in configJson; push the parsed form so the
      // engine rolls subsequent rounds with the new weights/paytable/etc.
      const parsed = eng.plugin.configSchema.safeParse(updated.configJson);
      if (parsed.success) eng.updateGameConfig(parsed.data);
    }
  } catch {
    // Registry not initialised (e.g. during tests); fall through silently.
  }

  res.json({
    ok: true,
    changes,
    gameConfig: {
      ...updated,
      minBetMicro: updated.minBetMicro.toString(),
      maxBetMicro: updated.maxBetMicro.toString(),
      commissionMicro: updated.commissionMicro.toString(),
    },
  });
});

// ── Operator config audit log (viewer) ─────────────────────────────

const ConfigAuditQuery = z.object({
  operatorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().uuid().optional(),
});
platformRouter.get('/config-audit', async (req, res) => {
  const parsed = ConfigAuditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { operatorId, limit, cursor } = parsed.data;
  const rows = await prisma.operatorConfigAuditLog.findMany({
    where: operatorId ? { operatorId } : {},
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > limit ? rows.pop()!.id : null;
  res.json({ items: rows, nextCursor });
});

// ── Operator IP allow-list editor ──────────────────────────────────

const IpListBody = z.object({ ipAllowList: z.array(z.string().min(1).max(64)).max(64) });
platformRouter.post('/operators/:id/ip-allow-list', requireYantraAdmin, async (req, res) => {
  const parsed = IpListBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  // Each entry must be an IPv4/IPv6/CIDR — we let the caller pass any
  // shape that the runtime ip-allow-list middleware already accepts;
  // enforcement still happens at that middleware. Here we just persist.
  const op = await prisma.operator.findUnique({ where: { id: req.params.id as string } });
  if (!op) {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  await prisma.operator.update({
    where: { id: op.id },
    data: { ipAllowList: parsed.data.ipAllowList },
  });
  res.json({ ipAllowList: parsed.data.ipAllowList });
});

// ── Certificate artefact upload/download ───────────────────────────
//
// Ships a thin local-disk shim when CERT_STORAGE_DIR is set; otherwise
// accepts a URL and records it. Production deployments route object
// storage through whichever bucket the compliance team audits.

const CertUploadBody = z.object({
  filePath: z.string().min(1).max(512),
  fileSize: z.number().int().positive().optional(),
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
// Mint a short-lived upload token. The UI receives { uploadUrl, token }
// and PUTs the raw bytes to that URL within 15 minutes. See
// services/CertStorage.ts.
platformRouter.post(
  '/certificates/:id/upload-url',
  requireYantraCompliance,
  async (req, res) => {
    const actor = req.portalUser;
    if (!actor) {
      res.status(401).json({ error: 'no_actor' });
      return;
    }
    try {
      const minted = await mintUploadUrl({
        certificateId: req.params.id as string,
        createdByUserId: actor.id,
      });
      res.status(201).json(minted);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'certificate_not_found' || msg === 'certificate_revoked') {
        res.status(400).json({ error: msg });
        return;
      }
      throw err;
    }
  },
);

// Raw-body PUT. `express.raw` replaces the global JSON parser for this
// route only; we still benefit from platformAuth, but the payload arrives
// as a Buffer on req.body instead of JSON. 20 MB cap matches most cert-lab
// PDF deliverables.
platformRouter.put(
  '/uploads/:token',
  express.raw({ type: '*/*', limit: '20mb' }),
  async (req, res) => {
    const token = req.params.token as string;
    const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
    if (bytes.length === 0) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }
    const declaredSha256 = req.header('x-content-sha256') ?? undefined;
    const originalName = req.header('x-original-filename') ?? 'artifact.bin';
    try {
      const result = await consumeUploadToken({
        token,
        bytes,
        declaredSha256,
        originalName,
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg === 'token_not_found' ||
        msg === 'token_already_consumed' ||
        msg === 'token_expired' ||
        msg === 'sha256_mismatch'
      ) {
        res.status(400).json({ error: msg });
        return;
      }
      throw err;
    }
  },
);

// Authenticated download — only Yantra staff can read cert artefacts.
platformRouter.get(
  '/uploads/download/:certificateId/:filename',
  async (req, res) => {
    const { absPath, exists } = resolveForDownload(
      req.params.certificateId as string,
      req.params.filename as string,
    );
    if (!exists) {
      res.status(404).json({ error: 'file_not_found' });
      return;
    }
    res.sendFile(absPath);
  },
);

platformRouter.post('/certificates/:id/artifact', requireYantraCompliance, async (req, res) => {
  const parsed = CertUploadBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const existing = await prisma.certificate.findUnique({
    where: { id: req.params.id as string },
  });
  if (!existing) {
    res.status(404).json({ error: 'certificate_not_found' });
    return;
  }
  await prisma.certificate.update({
    where: { id: existing.id },
    data: {
      filePath: parsed.data.filePath,
      fileSize: parsed.data.fileSize ?? null,
      fileSha256: parsed.data.fileSha256?.toLowerCase() ?? null,
    },
  });
  res.json({ ok: true, filePath: parsed.data.filePath });
});
