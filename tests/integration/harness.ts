// Shared harness for the money-safety integration suite.
//
// Everything in this file is intentionally self-contained: no test framework
// imports, no mocking libraries. The goal is that a reviewer can read each
// spec top-to-bottom without chasing into vendor code.
//
// The harness exposes:
//   - seedOperator()          — create an Operator + both inbound/outbound credentials
//   - cleanDb()               — truncate tables between tests, FK-safe
//   - createFakeWallet()      — an in-process Express-less fake operator wallet
//   - mintSessionToken()      — sign a session JWT
//   - buildBetRequest()       — a fully-populated BetRequest
//   - awaitJobCompletion()    — poll PendingWalletJob until completedAt is set

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

import { prisma } from '../../apps/rgs-server/src/db.js';
import { encryptSecret } from '../../apps/rgs-server/src/utils/secrets.js';
import {
  signPayload,
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../../apps/rgs-server/src/utils/signing.js';
import { newUuid } from '../../apps/rgs-server/src/utils/uuid.js';
import type { BetRequest } from '../../apps/rgs-server/src/wallet/types.js';

// ── Operator seeding ────────────────────────────────────────

export interface SeededOperator {
  operatorId: string;
  slug: string;
  /** Public key-id presented on OUTBOUND calls (us → operator wallet). */
  outboundKid: string;
  outboundSecret: string;
  /** Public key-id operators present on INBOUND calls (operator → us). */
  inboundKid: string;
  inboundSecret: string;
  walletCallbackUrl: string;
}

export interface SeedOperatorOptions {
  slug?: string;
  walletCallbackUrl: string;
  currency?: string;
}

export async function seedOperator(opts: SeedOperatorOptions): Promise<SeededOperator> {
  const slug = opts.slug ?? `op-${crypto.randomBytes(4).toString('hex')}`;
  const operator = await prisma.operator.create({
    data: {
      slug,
      name: `Test Operator ${slug}`,
      status: 'ACTIVE',
      jurisdiction: 'INTL',
      defaultCurrency: opts.currency ?? 'LKR',
      walletCallbackUrl: opts.walletCallbackUrl,
    },
  });

  const inboundKid = `in_${crypto.randomBytes(6).toString('hex')}`;
  const outboundKid = `out_${crypto.randomBytes(6).toString('hex')}`;
  const inboundSecret = crypto.randomBytes(32).toString('hex');
  const outboundSecret = crypto.randomBytes(32).toString('hex');

  await prisma.operatorCredential.createMany({
    data: [
      {
        operatorId: operator.id,
        type: 'API_KEY_INBOUND',
        kid: inboundKid,
        cipherBlob: encryptSecret(inboundSecret),
        label: 'inbound-test',
      },
      {
        operatorId: operator.id,
        type: 'WALLET_HMAC_OUTBOUND',
        kid: outboundKid,
        cipherBlob: encryptSecret(outboundSecret),
        label: 'outbound-test',
      },
    ],
  });

  return {
    operatorId: operator.id,
    slug,
    outboundKid,
    outboundSecret,
    inboundKid,
    inboundSecret,
    walletCallbackUrl: opts.walletCallbackUrl,
  };
}

// ── DB reset ─────────────────────────────────────────────────

// FK-order: children → parents. `$executeRawUnsafe` with TRUNCATE ... CASCADE
// is the pragmatic choice here; per-table deletes would be noisier and more
// error-prone as the schema grows.
const TRUNCATE_TABLES = [
  'admin_audit_entries',
  'audit_anchors',
  'cert_upload_tokens',
  'inbound_idempotency',
  'pending_wallet_jobs',
  'pending_round_bets',
  'wallet_calls',
  'bets',
  'rounds',
  'game_sessions',
  'webauthn_challenges',
  'webauthn_credentials',
  'webhook_deliveries',
  'webhook_subscriptions',
  'operator_signing_keys',
  'operator_user_invites',
  'operator_game_configs',
  'operator_config_audit_log',
  'operator_users',
  'operator_credentials',
  'certificates',
  'operators',
];

// NOTE: global_kill_switch is a singleton row — NOT truncated.
// Individual tests that need to reset it should call
// `await prisma.globalKillSwitch.update({ where: { id: 'singleton' }, data: { engaged: false } })`.

export async function cleanDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

// ── Fake operator wallet ─────────────────────────────────────

export type FakeWalletEndpoint = 'balance' | 'bet' | 'win' | 'rollback';

export type FakeWalletHandler = (body: Record<string, unknown>) => Promise<{
  status: number;
  body: Record<string, unknown>;
  /** Optional synthetic delay, useful for timeout tests. */
  delayMs?: number;
}>;

export interface FakeWallet {
  url: string;
  port: number;
  /**
   * Override the response for one specific endpoint. Pass undefined to restore
   * the default behaviour (in-memory ledger).
   */
  setHandler(endpoint: FakeWalletEndpoint, handler: FakeWalletHandler | undefined): void;
  /** Number of times a given endpoint has been hit since spinup (or last reset). */
  hits(endpoint: FakeWalletEndpoint): number;
  /** Record of every request body received, in order. */
  log(): Array<{ endpoint: FakeWalletEndpoint; body: Record<string, unknown>; at: number }>;
  resetHits(): void;
  seed(playerRef: string, currency: string, balanceMicro: bigint): void;
  balanceOf(playerRef: string, currency: string): bigint;
  close(): Promise<void>;
}

/**
 * Creates an in-process fake wallet that speaks the same HTTP shape the real
 * HttpWalletAdapter expects. By default it maintains a tiny in-memory balance
 * ledger (keyed by `${playerRef}::${currency}`), deduplicates by
 * transactionUuid, and returns RS_OK. Tests use setHandler() to inject faults.
 */
export async function createFakeWallet(
  options: { port?: number } = {},
): Promise<FakeWallet> {
  const balances = new Map<string, bigint>();
  const committed = new Map<string, { kind: string; delta: bigint }>();
  const handlers = new Map<FakeWalletEndpoint, FakeWalletHandler>();
  const hits: Record<FakeWalletEndpoint, number> = {
    balance: 0,
    bet: 0,
    win: 0,
    rollback: 0,
  };
  const requestLog: Array<{
    endpoint: FakeWalletEndpoint;
    body: Record<string, unknown>;
    at: number;
  }> = [];

  function key(playerRef: string, currency: string): string {
    return `${playerRef}::${currency}`;
  }

  async function defaultHandler(
    endpoint: FakeWalletEndpoint,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const playerRef = body.playerRef as string;
    const currency = body.currency as string;
    const requestUuid = body.requestUuid as string;
    const k = key(playerRef, currency);
    const bal = balances.get(k) ?? 0n;

    if (endpoint === 'balance') {
      return {
        status: 200,
        body: {
          status: 'RS_OK',
          requestUuid,
          balanceMicro: bal.toString(),
          currency,
        },
      };
    }

    if (endpoint === 'bet') {
      const tx = body.transactionUuid as string;
      const amount = BigInt(body.amountMicro as string);
      const dup = committed.get(tx);
      if (dup) {
        return {
          status: 200,
          body: {
            status: 'RS_ERROR_DUPLICATE_TRANSACTION',
            requestUuid,
            balanceMicro: bal.toString(),
            currency,
          },
        };
      }
      if (bal < amount) {
        return {
          status: 200,
          body: {
            status: 'RS_ERROR_NOT_ENOUGH_MONEY',
            requestUuid,
            balanceMicro: bal.toString(),
            currency,
          },
        };
      }
      balances.set(k, bal - amount);
      committed.set(tx, { kind: 'bet', delta: -amount });
      return {
        status: 200,
        body: {
          status: 'RS_OK',
          requestUuid,
          balanceMicro: (bal - amount).toString(),
          currency,
        },
      };
    }

    if (endpoint === 'win') {
      const tx = body.transactionUuid as string;
      const amount = BigInt(body.amountMicro as string);
      const dup = committed.get(tx);
      if (dup) {
        return {
          status: 200,
          body: {
            status: 'RS_ERROR_DUPLICATE_TRANSACTION',
            requestUuid,
            balanceMicro: bal.toString(),
            currency,
          },
        };
      }
      balances.set(k, bal + amount);
      committed.set(tx, { kind: 'win', delta: amount });
      return {
        status: 200,
        body: {
          status: 'RS_OK',
          requestUuid,
          balanceMicro: (bal + amount).toString(),
          currency,
        },
      };
    }

    // rollback
    const tx = body.transactionUuid as string;
    const ref = body.referenceTransactionUuid as string;
    const refEntry = committed.get(ref);
    if (!refEntry) {
      return {
        status: 200,
        body: {
          status: 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST',
          requestUuid,
          message: 'unknown_reference_transaction',
        },
      };
    }
    const dup = committed.get(tx);
    if (dup) {
      return {
        status: 200,
        body: {
          status: 'RS_ERROR_DUPLICATE_TRANSACTION',
          requestUuid,
          balanceMicro: bal.toString(),
          currency,
        },
      };
    }
    balances.set(k, bal - refEntry.delta);
    committed.set(tx, { kind: 'rollback', delta: -refEntry.delta });
    committed.delete(ref);
    return {
      status: 200,
      body: {
        status: 'RS_OK',
        requestUuid,
        balanceMicro: (bal - refEntry.delta).toString(),
        currency,
      },
    };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const url = req.url ?? '';
      const endpoint = (url.split('?')[0]?.split('/').pop() ?? '') as FakeWalletEndpoint;
      if (!['balance', 'bet', 'win', 'rollback'].includes(endpoint)) {
        res.writeHead(404).end();
        return;
      }
      hits[endpoint] += 1;
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({ status: 'RS_ERROR_WRONG_SYNTAX' }),
        );
        return;
      }
      requestLog.push({ endpoint, body, at: Date.now() });

      const override = handlers.get(endpoint);
      try {
        const result = override
          ? await override(body)
          : await defaultHandler(endpoint, body);
        if (result.delayMs && result.delayMs > 0) {
          await new Promise((r) => setTimeout(r, result.delayMs));
        }
        res.writeHead(result.status, { 'content-type': 'application/json' }).end(
          JSON.stringify(result.body),
        );
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ status: 'RS_ERROR_UNKNOWN', message: (err as Error).message }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/wallet`;

  return {
    url: baseUrl,
    port,
    setHandler(endpoint, handler) {
      if (handler) handlers.set(endpoint, handler);
      else handlers.delete(endpoint);
    },
    hits(endpoint) {
      return hits[endpoint];
    },
    log() {
      return requestLog.slice();
    },
    resetHits() {
      hits.balance = 0;
      hits.bet = 0;
      hits.win = 0;
      hits.rollback = 0;
    },
    seed(playerRef, currency, balanceMicro) {
      balances.set(key(playerRef, currency), balanceMicro);
    },
    balanceOf(playerRef, currency) {
      return balances.get(key(playerRef, currency)) ?? 0n;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── Session JWT ──────────────────────────────────────────────

export function mintSessionToken(
  operatorId: string,
  playerRef: string,
  overrides: Partial<{ sessionId: string; gameCode: string; currency: string; lang: string }> = {},
): { token: string; sessionId: string } {
  const sessionId = overrides.sessionId ?? newUuid();
  const token = jwt.sign(
    {
      sub: sessionId,
      sessionId,
      operatorId,
      playerRef,
      gameCode: overrides.gameCode ?? 'yantra',
      currency: overrides.currency ?? 'LKR',
      jurisdiction: 'INTL',
      lang: overrides.lang ?? 'en',
      mode: 'real',
    },
    process.env.SESSION_JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: 3600 },
  );
  return { token, sessionId };
}

// ── Request builders ─────────────────────────────────────────

export function buildBetRequest(args: {
  operatorId: string;
  playerRef: string;
  amountMicro: bigint;
  roundId: string;
  currency?: string;
  gameCode?: string;
}): BetRequest {
  return {
    requestUuid: newUuid(),
    transactionUuid: newUuid(),
    operatorId: args.operatorId,
    playerRef: args.playerRef,
    currency: args.currency ?? 'LKR',
    gameCode: args.gameCode ?? 'yantra',
    amountMicro: args.amountMicro,
    roundId: args.roundId,
  };
}

// ── Signed HTTP helper (operator → RGS) ──────────────────────

export function signedHeaders(
  secret: string,
  kid: string,
  method: string,
  path: string,
  bodyJson: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(secret, method, path, timestamp, bodyJson);
  return {
    'content-type': 'application/json',
    [KEY_ID_HEADER]: kid,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
}

// ── Polling helpers ──────────────────────────────────────────

export async function awaitJobCompletion(
  jobId: string,
  timeoutMs = 10_000,
  pollMs = 100,
): Promise<{ completed: boolean; attempts: number; lastError: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.pendingWalletJob.findUnique({ where: { id: jobId } });
    if (job?.completedAt) {
      return { completed: true, attempts: job.attempts, lastError: job.lastError };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const job = await prisma.pendingWalletJob.findUnique({ where: { id: jobId } });
  return {
    completed: false,
    attempts: job?.attempts ?? 0,
    lastError: job?.lastError ?? null,
  };
}
