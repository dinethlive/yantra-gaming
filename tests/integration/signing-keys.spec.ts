// Tier-1 asymmetric launch JWT — ES256 sign + verify + JWKS publish.
//
// Verifies:
//   * getActiveSigningKey mints on demand.
//   * signLaunchJwt produces a token verifyLaunchJwt accepts.
//   * A tampered payload fails verification.
//   * rotateSigningKey retires the old key and mints a new one.
//   * listPublicJwks exposes active + retiring keys only.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { prisma } from '../../apps/rgs-server/src/db.js';
import {
  getActiveSigningKey,
  listPublicJwks,
  rotateSigningKey,
  signLaunchJwt,
  verifyLaunchJwt,
} from '../../apps/rgs-server/src/services/SigningKeys.js';
import { cleanDb, seedOperator } from './harness.js';

describe('SigningKeys', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('mint on demand and round-trip sign/verify', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const key = await getActiveSigningKey(op.operatorId);
    expect(key.algorithm).toBe('ES256');
    expect(key.kid.length).toBeGreaterThan(5);

    const token = await signLaunchJwt({
      operatorId: op.operatorId,
      payload: { sub: 'session-id', operatorId: op.operatorId, foo: 'bar' },
      expiresInSec: 3600,
    });
    expect(token.split('.').length).toBe(3);

    const verified = await verifyLaunchJwt(op.operatorId, token);
    expect(verified).not.toBeNull();
    expect(verified!.foo).toBe('bar');
    expect(verified!.operatorId).toBe(op.operatorId);
  });

  test('tampered payload fails verification', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const token = await signLaunchJwt({
      operatorId: op.operatorId,
      payload: { playerRef: 'p1' },
      expiresInSec: 3600,
    });
    const [h, , s] = token.split('.');
    const tampered = `${h}.${Buffer.from('{"playerRef":"other"}').toString('base64url')}.${s}`;
    const bad = await verifyLaunchJwt(op.operatorId, tampered);
    expect(bad).toBeNull();
  });

  test('rotate: old key moves to RETIRING, new key becomes ACTIVE', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const first = await getActiveSigningKey(op.operatorId);
    const { newKid, previousKid } = await rotateSigningKey(op.operatorId);
    expect(previousKid).toBe(first.kid);
    expect(newKid).not.toBe(first.kid);

    const rows = await prisma.operatorSigningKey.findMany({
      where: { operatorId: op.operatorId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('RETIRING');
    expect(rows[1]!.status).toBe('ACTIVE');
  });

  test('listPublicJwks exposes both ACTIVE and RETIRING keys', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    await getActiveSigningKey(op.operatorId);
    await rotateSigningKey(op.operatorId);
    const jwks = await listPublicJwks(op.operatorId);
    expect(jwks.keys.length).toBe(2);
    for (const k of jwks.keys) {
      expect(k.kty).toBe('EC');
      expect(k.alg).toBe('ES256');
      expect(k.d).toBeUndefined(); // private half must never leak
    }
  });
});
