// Inbound idempotency — the InboundIdempotency cache used by
// middleware/idempotency.ts.
//
// INVARIANTS (see B2B_ROADMAP.md §9 + §14):
//   1. Two POSTs with the same (operatorId, endpoint, requestUuid) return
//      byte-identical responses; the handler runs only once.
//   2. The second POST is served from cache even if its body differs — body
//      is NOT part of the cache key, so a retry with a mangled body still
//      gets the original response.
//   3. Cache entries expire after their TTL. Expired entries are re-processed.
//   4. The cache is scoped by operatorId — two different operators can use the
//      same requestUuid without collision.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';

import { prisma } from '../../apps/rgs-server/src/db.js';
import { sessionRouter } from '../../apps/rgs-server/src/routes/session.js';
import { newUuid } from '../../apps/rgs-server/src/utils/uuid.js';
import {
  cleanDb,
  seedOperator,
  signedHeaders,
  type SeededOperator,
} from './harness.js';

interface RunningApp {
  url: string;
  close: () => Promise<void>;
}

/**
 * Build the smallest express app that exposes POST /v1/session exactly the way
 * the production server does — same body parser + rawBody capture + router.
 * We deliberately do NOT import src/index.ts because it starts background
 * workers and binds to a real port with signal handlers.
 */
async function startApp(): Promise<RunningApp> {
  const app = express();
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use('/v1/session', sessionRouter);

  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('inbound idempotency', () => {
  let appA: RunningApp;
  let operator: SeededOperator;
  let operator2: SeededOperator;

  beforeAll(async () => {
    appA = await startApp();
  });

  afterAll(async () => {
    await appA.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDb();
    operator = await seedOperator({ walletCallbackUrl: 'http://127.0.0.1:0/wallet' });
    operator2 = await seedOperator({
      slug: 'op-second',
      walletCallbackUrl: 'http://127.0.0.1:0/wallet',
    });
  });

  function sessionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requestUuid: newUuid(),
      operatorId: operator.operatorId,
      playerRef: 'player-idemp-1',
      gameCode: 'yantra',
      currency: 'LKR',
      lang: 'en',
      jurisdiction: 'INTL',
      ...overrides,
    };
  }

  async function postSession(
    op: SeededOperator,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const bodyJson = JSON.stringify(body);
    const headers = signedHeaders(
      op.inboundSecret,
      op.inboundKid,
      'POST',
      '/v1/session/',
      bodyJson,
    );
    const res = await fetch(`${appA.url}/v1/session/`, {
      method: 'POST',
      headers,
      body: bodyJson,
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it('same requestUuid returns identical response and only one GameSession is created', async () => {
    const reqUuid = newUuid();
    const body = sessionBody({ requestUuid: reqUuid });

    const first = await postSession(operator, body);
    const second = await postSession(operator, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    // Byte-identical payload: sessionId, sessionToken, serverSeedHash, expiresAt all match.
    expect(second.json).toEqual(first.json);

    const count = await prisma.gameSession.count({ where: { operatorId: operator.operatorId } });
    expect(count).toBe(1);
  });

  it('same requestUuid + different body still returns the ORIGINAL response', async () => {
    const reqUuid = newUuid();
    const bodyA = sessionBody({ requestUuid: reqUuid, playerRef: 'player-A' });
    const bodyB = sessionBody({ requestUuid: reqUuid, playerRef: 'player-B' });

    const first = await postSession(operator, bodyA);
    const second = await postSession(operator, bodyB);

    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    expect(second.json).toEqual(first.json);

    // Only the first body was ever persisted — player-B must not appear anywhere.
    const sessions = await prisma.gameSession.findMany({
      where: { operatorId: operator.operatorId },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.playerRef).toBe('player-A');
  });

  it('expired idempotency entries are re-processed', async () => {
    const reqUuid = newUuid();
    const body = sessionBody({ requestUuid: reqUuid });

    const first = await postSession(operator, body);
    expect(first.status).toBe(201);

    // Wait briefly so the middleware's `res.on('finish')` write has landed.
    // We don't rely on the finish hook for the replay-path test, but we do
    // need the row to exist before we can forcibly expire it.
    await waitFor(async () => {
      const row = await prisma.inboundIdempotency.findFirst({ where: { requestUuid: reqUuid } });
      return row !== null;
    });

    // Fast-forward by making the existing entry expire in the past.
    await prisma.inboundIdempotency.updateMany({
      where: { requestUuid: reqUuid, operatorId: operator.operatorId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const second = await postSession(operator, body);
    expect(second.status).toBe(201);
    // Same body → service.create ran again → a fresh session row should exist.
    const sessionCount = await prisma.gameSession.count({
      where: { operatorId: operator.operatorId },
    });
    expect(sessionCount).toBe(2);
    // And the two sessionIds must differ — the handler really did re-run.
    expect(second.json.sessionId).not.toBe(first.json.sessionId);
  });

  it('cache is scoped by operatorId — two operators can reuse the same requestUuid', async () => {
    const reqUuid = newUuid();

    const a = await postSession(operator, sessionBody({ requestUuid: reqUuid }));
    const b = await postSession(
      operator2,
      sessionBody({ requestUuid: reqUuid, operatorId: operator2.operatorId }),
    );

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.sessionId).not.toBe(b.json.sessionId);

    // Both operators have exactly one session.
    expect(
      await prisma.gameSession.count({ where: { operatorId: operator.operatorId } }),
    ).toBe(1);
    expect(
      await prisma.gameSession.count({ where: { operatorId: operator2.operatorId } }),
    ).toBe(1);
  });
});

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs = 2_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('waitFor timed out');
}
