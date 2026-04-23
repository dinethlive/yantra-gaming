// Asserts the rollback contract against the real HttpWalletAdapter + a fake
// operator wallet server.
//
// INVARIANTS under test (see B2B_ROADMAP.md §8 + §14):
//   1. Rollback is idempotent on the *operator* side by transactionUuid: repeating
//      the same rollback transactionUuid is a no-op (returns DUPLICATE_TRANSACTION).
//   2. Rollback against a non-existent referenceTransactionUuid returns
//      RS_ERROR_TRANSACTION_DOES_NOT_EXIST — never RS_OK.
//   3. A bet + immediate rollback restores the operator's player balance exactly.
//   4. Every WalletCall row is written *before* the HTTP call fires, and updated
//      *after* — even on failure — so the request_body is always persisted.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { prisma } from '../../apps/rgs-server/src/db.js';
import { HttpWalletAdapter } from '../../apps/rgs-server/src/wallet/HttpWalletAdapter.js';
import { WalletClient } from '../../apps/rgs-server/src/wallet/WalletClient.js';
import { RsStatus } from '../../apps/rgs-server/src/wallet/types.js';
import { newUuid } from '../../apps/rgs-server/src/utils/uuid.js';
import {
  cleanDb,
  createFakeWallet,
  seedOperator,
  type FakeWallet,
  type SeededOperator,
} from './harness.js';

describe('wallet rollback contract', () => {
  let fake: FakeWallet;
  let operator: SeededOperator;
  let client: WalletClient;

  const playerRef = 'player-rollback-1';
  const currency = 'LKR';
  const startingBalance = 10_000_000n; // 100 LKR in micro-units

  beforeAll(async () => {
    fake = await createFakeWallet();
  });

  afterAll(async () => {
    await fake.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDb();
    fake.resetHits();
    fake.setHandler('balance', undefined);
    fake.setHandler('bet', undefined);
    fake.setHandler('win', undefined);
    fake.setHandler('rollback', undefined);

    operator = await seedOperator({ walletCallbackUrl: fake.url });
    fake.seed(playerRef, currency, startingBalance);

    const adapter = new HttpWalletAdapter({
      operatorId: operator.operatorId,
      kid: operator.outboundKid,
      secret: operator.outboundSecret,
      walletCallbackUrl: fake.url,
      timeoutMs: 2_000,
    });
    client = new WalletClient(operator.operatorId, adapter);
  });

  it('a single rollback with a fresh transactionUuid returns RS_OK', async () => {
    // Arrange: an accepted bet to roll back.
    const betTx = newUuid();
    const betRes = await client.bet({
      requestUuid: newUuid(),
      transactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 1_000_000n,
      roundId: newUuid(),
    });
    expect(betRes.status).toBe(RsStatus.OK);

    const res = await client.rollback({
      requestUuid: newUuid(),
      transactionUuid: newUuid(),
      referenceTransactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });

    expect(res.status).toBe(RsStatus.OK);
  });

  it('repeating the same rollback transactionUuid is a no-op at the operator', async () => {
    const betTx = newUuid();
    await client.bet({
      requestUuid: newUuid(),
      transactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 1_000_000n,
      roundId: newUuid(),
    });
    fake.resetHits();

    const rollbackTx = newUuid();
    const first = await client.rollback({
      requestUuid: newUuid(),
      transactionUuid: rollbackTx,
      referenceTransactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });
    const second = await client.rollback({
      requestUuid: newUuid(),
      transactionUuid: rollbackTx,
      referenceTransactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });

    expect(first.status).toBe(RsStatus.OK);
    // The operator recognises the duplicate and returns DUPLICATE_TRANSACTION.
    // The RGS treats that as success via isSuccessOrDuplicate().
    expect(second.status).toBe(RsStatus.DUPLICATE_TRANSACTION);
    // Both HTTP calls were issued — the dedupe is on the operator side, not the client.
    expect(fake.hits('rollback')).toBe(2);
    // Net balance effect of the bet + TWO rollback calls is the same as one rollback.
    expect(fake.balanceOf(playerRef, currency)).toBe(startingBalance);
  });

  it('rolling back an unknown reference tx returns TRANSACTION_NOT_FOUND', async () => {
    const res = await client.rollback({
      requestUuid: newUuid(),
      transactionUuid: newUuid(),
      referenceTransactionUuid: newUuid(), // never placed as a bet
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });

    expect(res.status).toBe(RsStatus.TRANSACTION_NOT_FOUND);
  });

  it('bet + rollback restores the operator-side balance to the pre-bet value', async () => {
    const betTx = newUuid();
    const betRes = await client.bet({
      requestUuid: newUuid(),
      transactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 2_500_000n,
      roundId: newUuid(),
    });
    expect(betRes.status).toBe(RsStatus.OK);
    expect(fake.balanceOf(playerRef, currency)).toBe(startingBalance - 2_500_000n);

    await client.rollback({
      requestUuid: newUuid(),
      transactionUuid: newUuid(),
      referenceTransactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });

    expect(fake.balanceOf(playerRef, currency)).toBe(startingBalance);
  });

  it('WalletCall rows are written before the HTTP call and updated after — even on failure', async () => {
    // Force the operator wallet to return RS_ERROR_UNKNOWN on rollback. The
    // WalletCall row must still exist with request_body populated; only the
    // response fields should reflect the failure.
    fake.setHandler('rollback', async (body) => ({
      status: 200,
      body: {
        status: 'RS_ERROR_UNKNOWN',
        requestUuid: body.requestUuid,
        message: 'simulated_wallet_failure',
      },
    }));

    const rollbackTx = newUuid();
    const rollbackReqUuid = newUuid();
    const res = await client.rollback({
      requestUuid: rollbackReqUuid,
      transactionUuid: rollbackTx,
      referenceTransactionUuid: newUuid(),
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
    });

    expect(res.status).toBe(RsStatus.UNKNOWN);

    const call = await prisma.walletCall.findFirst({
      where: {
        operatorId: operator.operatorId,
        direction: 'OUTBOUND',
        endpoint: 'ROLLBACK',
        requestUuid: rollbackReqUuid,
      },
    });
    expect(call).not.toBeNull();
    // Pre-write: request body + identifiers captured.
    expect(call?.requestBody).toBeTruthy();
    expect((call?.requestBody as Record<string, unknown>).transactionUuid).toBe(rollbackTx);
    // Post-write: response status recorded, succeeded=false.
    expect(call?.responseStatus).toBe(RsStatus.UNKNOWN);
    expect(call?.succeeded).toBe(false);
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('the WalletCall attempt number is 1 for the first call (increases via PendingJobRunner)', async () => {
    // Sanity check: WalletClient itself does not retry. The attempt counter
    // only goes up when the PendingJobRunner re-invokes with audit.attempt.
    // See timeout-retry.spec.ts for monotonicity across retries.
    const betTx = newUuid();
    const betReqUuid = newUuid();
    await client.bet({
      requestUuid: betReqUuid,
      transactionUuid: betTx,
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 500_000n,
      roundId: newUuid(),
    });

    const call = await prisma.walletCall.findFirst({
      where: { requestUuid: betReqUuid },
    });
    expect(call?.attempt).toBe(1);
    expect(call?.succeeded).toBe(true);
  });
});
