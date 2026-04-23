// Tier-1 webhook dispatcher — subscribe, dispatch, signed delivery, retry.
//
// Verifies:
//   * dispatchEvent fans out to subscribers whose eventTypes match.
//   * Non-matching subscribers are skipped.
//   * A 200 response marks the delivery SUCCEEDED.
//   * A 500 response marks FAILED_RETRY with an exponential next-attempt.
//   * The signature is a valid HMAC-SHA256 of canonical(envelope) under
//     the subscription's secret.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { canonicalJson } from '@yantra/webhook-spec';
import { prisma } from '../../apps/rgs-server/src/db.js';
import {
  dispatchEvent,
  webhookDispatcher,
} from '../../apps/rgs-server/src/services/WebhookDispatcher.js';
import { encryptSecret } from '../../apps/rgs-server/src/utils/secrets.js';
import { cleanDb, seedOperator } from './harness.js';

interface ReceiverHit {
  headers: Record<string, string>;
  body: string;
}

async function startReceiver(
  respond: (hit: ReceiverHit) => { status: number; body?: string },
): Promise<{ url: string; close: () => Promise<void>; hits: ReceiverHit[] }> {
  const hits: ReceiverHit[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const hit = { headers: req.headers as Record<string, string>, body: raw };
      hits.push(hit);
      const { status, body } = respond(hit);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body ?? '{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
  pollMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new Error('waitFor timeout');
}

describe('WebhookDispatcher', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    webhookDispatcher.stop();
    await prisma.$disconnect();
  });

  test('dispatch + successful delivery + signature matches', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const receiver = await startReceiver(() => ({ status: 200 }));
    try {
      const subSecret = 'shared-test-secret-32bytes-xxxxxx';
      const sub = await prisma.webhookSubscription.create({
        data: {
          operatorId: op.operatorId,
          url: receiver.url,
          eventTypes: ['round.settled'],
          secretCipher: encryptSecret(subSecret),
        },
      });

      await dispatchEvent({
        operatorId: op.operatorId,
        eventType: 'round.settled',
        data: { roundId: 'test-round', outcomeSide: 'LOW' },
      });

      webhookDispatcher.start();

      const delivered = await waitFor(async () => {
        const row = await prisma.webhookDelivery.findFirst({
          where: { subscriptionId: sub.id, state: 'SUCCEEDED' },
        });
        return row;
      });
      expect(delivered.httpStatus).toBe(200);

      // Verify receiver got it with a correct signature.
      expect(receiver.hits.length).toBeGreaterThan(0);
      const hit = receiver.hits[0]!;
      const expectedSig = crypto
        .createHmac('sha256', subSecret)
        .update(hit.body)
        .digest('hex');
      expect(hit.headers['x-yantra-signature']).toBe(expectedSig);

      // Envelope was canonical — we can re-canonicalise the parsed body
      // and get the same string we signed.
      const parsed = JSON.parse(hit.body);
      expect(parsed.eventType).toBe('round.settled');
      expect(canonicalJson(parsed)).toBe(hit.body);
    } finally {
      webhookDispatcher.stop();
      await receiver.close();
    }
  });

  test('non-matching subscriptions are skipped', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const receiver = await startReceiver(() => ({ status: 200 }));
    try {
      const sub = await prisma.webhookSubscription.create({
        data: {
          operatorId: op.operatorId,
          url: receiver.url,
          eventTypes: ['round.voided'], // only voided, not settled
          secretCipher: encryptSecret('shared-test-secret-32bytes-xxxxxx'),
        },
      });

      await dispatchEvent({
        operatorId: op.operatorId,
        eventType: 'round.settled',
        data: { roundId: 'x' },
      });

      const count = await prisma.webhookDelivery.count({
        where: { subscriptionId: sub.id },
      });
      expect(count).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  test('500 response triggers FAILED_RETRY with backoff', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const receiver = await startReceiver(() => ({ status: 500, body: '{"err":1}' }));
    try {
      const sub = await prisma.webhookSubscription.create({
        data: {
          operatorId: op.operatorId,
          url: receiver.url,
          eventTypes: [],
          secretCipher: encryptSecret('shared-test-secret-32bytes-xxxxxx'),
        },
      });

      await dispatchEvent({
        operatorId: op.operatorId,
        eventType: 'webhook.test',
        data: { note: 'fail' },
      });

      webhookDispatcher.start();

      const failed = await waitFor(async () => {
        return prisma.webhookDelivery.findFirst({
          where: { subscriptionId: sub.id, state: 'FAILED_RETRY' },
        });
      });
      expect(failed.attempt).toBe(2);
      expect(failed.nextAttemptAt).not.toBeNull();
      expect(failed.httpStatus).toBe(500);
    } finally {
      webhookDispatcher.stop();
      await receiver.close();
    }
  });
});
