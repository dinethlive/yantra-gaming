import { describe, expect, it } from 'bun:test';
import { signPayload } from '@yantra/wallet-spec';
import {
  parseWalletCallback,
  verifyWebhookSignature,
  WebhookHeaderError,
} from '../src/index.js';

const SECRET = 'operator-wallet-secret-64-bytes-of-dev-entropy--';
const NOW = 1_745_400_000;

function sign(method: string, path: string, body: string, ts: number) {
  return signPayload(SECRET, method, path, ts, body);
}

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature + fresh timestamp', () => {
    const body = JSON.stringify({ requestUuid: 'x', amountMicro: '1000000' });
    const sig = sign('POST', '/wallet/bet', body, NOW);
    const ok = verifyWebhookSignature({
      method: 'POST',
      path: '/wallet/bet',
      body,
      secret: SECRET,
      timestamp: NOW,
      signature: sig,
      nowSeconds: NOW,
    });
    expect(ok).toBe(true);
  });

  it('returns false if the body has been modified (tamper detection)', () => {
    const body = JSON.stringify({ amount: '1000000' });
    const tampered = JSON.stringify({ amount: '9999999' });
    const sig = sign('POST', '/wallet/bet', body, NOW);
    const ok = verifyWebhookSignature({
      method: 'POST',
      path: '/wallet/bet',
      body: tampered,
      secret: SECRET,
      timestamp: NOW,
      signature: sig,
      nowSeconds: NOW,
    });
    expect(ok).toBe(false);
  });

  it('returns false if the timestamp is outside the 30s tolerance window', () => {
    const body = JSON.stringify({ requestUuid: 'x' });
    const oldTs = NOW - 31; // outside ±30s window
    const sig = sign('POST', '/wallet/bet', body, oldTs);
    const ok = verifyWebhookSignature({
      method: 'POST',
      path: '/wallet/bet',
      body,
      secret: SECRET,
      timestamp: oldTs,
      signature: sig,
      nowSeconds: NOW,
    });
    expect(ok).toBe(false);
  });

  it('honours a larger custom tolerance', () => {
    const body = JSON.stringify({ requestUuid: 'x' });
    const oldTs = NOW - 120;
    const sig = sign('POST', '/wallet/bet', body, oldTs);
    const ok = verifyWebhookSignature({
      method: 'POST',
      path: '/wallet/bet',
      body,
      secret: SECRET,
      timestamp: oldTs,
      signature: sig,
      toleranceSeconds: 300,
      nowSeconds: NOW,
    });
    expect(ok).toBe(true);
  });

  it('returns false on a malformed base64 signature rather than throwing', () => {
    const body = JSON.stringify({ requestUuid: 'x' });
    const ok = verifyWebhookSignature({
      method: 'POST',
      path: '/wallet/bet',
      body,
      secret: SECRET,
      timestamp: NOW,
      signature: '!!!not-base64!!!',
      nowSeconds: NOW,
    });
    expect(ok).toBe(false);
  });

  it('throws WebhookHeaderError when signature header is missing', () => {
    expect(() =>
      verifyWebhookSignature({
        method: 'POST',
        path: '/wallet/bet',
        body: '{}',
        secret: SECRET,
        timestamp: NOW,
        // @ts-expect-error — deliberately omitted
        signature: undefined,
      }),
    ).toThrow(WebhookHeaderError);
  });
});

describe('parseWalletCallback', () => {
  const common = {
    requestUuid: '11111111-2222-4333-8444-555555555555',
    operatorId: 'op_abc123',
    playerRef: 'player-1',
    currency: 'LKR',
    gameCode: 'yantra',
  };

  it('narrows a balance callback', () => {
    const result = parseWalletCallback('balance', common);
    expect(result.endpoint).toBe('balance');
    expect(result.body.playerRef).toBe('player-1');
  });

  it('narrows a bet callback and preserves the transactionUuid', () => {
    const result = parseWalletCallback('bet', {
      ...common,
      transactionUuid: 'tx-1',
      amountMicro: '100000000',
      roundId: 'round-1',
    });
    if (result.endpoint !== 'bet') throw new Error('expected bet');
    expect(result.body.transactionUuid).toBe('tx-1');
    expect(result.body.amountMicro).toBe('100000000');
    expect(result.body.roundId).toBe('round-1');
  });

  it('narrows a win callback and preserves the referenceTransactionUuid', () => {
    const result = parseWalletCallback('win', {
      ...common,
      transactionUuid: 'win-tx',
      referenceTransactionUuid: 'bet-tx',
      amountMicro: '200000000',
      roundId: 'round-1',
    });
    if (result.endpoint !== 'win') throw new Error('expected win');
    expect(result.body.referenceTransactionUuid).toBe('bet-tx');
    expect(result.body.amountMicro).toBe('200000000');
  });

  it('narrows a rollback callback', () => {
    const result = parseWalletCallback('rollback', {
      ...common,
      transactionUuid: 'rb-tx',
      referenceTransactionUuid: 'bet-tx',
    });
    if (result.endpoint !== 'rollback') throw new Error('expected rollback');
    expect(result.body.transactionUuid).toBe('rb-tx');
    expect(result.body.referenceTransactionUuid).toBe('bet-tx');
  });

  it('throws on missing required fields', () => {
    expect(() =>
      parseWalletCallback('bet', { ...common, amountMicro: '100' }),
    ).toThrow(WebhookHeaderError);
  });

  it('throws on non-string required fields (defense against type coercion)', () => {
    expect(() =>
      parseWalletCallback('bet', {
        ...common,
        transactionUuid: 'tx-1',
        amountMicro: 100, // number instead of string — reject
        roundId: 'round-1',
      }),
    ).toThrow(WebhookHeaderError);
  });

  it('rejects a non-object body', () => {
    expect(() =>
      parseWalletCallback('balance', 'not-an-object' as unknown),
    ).toThrow(WebhookHeaderError);
  });
});
