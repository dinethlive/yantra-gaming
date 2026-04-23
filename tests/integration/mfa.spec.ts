// Tier-1 MFA — TOTP (RFC 6238) enrollment + verify.
//
// Verifies:
//   * computeTotp produces RFC 6238 test-vector outputs for known seeds.
//   * A freshly-enrolled user can verify a code from the same secret.
//   * Wrong code is rejected.
//   * MFA disable clears the secret.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import bcrypt from 'bcryptjs';
import { prisma } from '../../apps/rgs-server/src/db.js';
import {
  _internal,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  verifyMfaCode,
} from '../../apps/rgs-server/src/services/Mfa.js';
import { cleanDb, seedOperator } from './harness.js';

async function seedUser(operatorId: string, email: string) {
  return prisma.operatorUser.create({
    data: {
      operatorId,
      email,
      passwordHash: await bcrypt.hash('correcthorsebatterystaple', 8),
      role: 'OPERATOR_ADMIN',
      displayName: 'T',
    },
  });
}

describe('Mfa', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('computeTotp matches RFC 6238 vectors (SHA1, 30s, 6 digits)', () => {
    // RFC 6238 test vector for "12345678901234567890" at t=59s.
    const ascii = Buffer.from('12345678901234567890', 'ascii');
    const t59 = _internal.computeTotp(ascii, 59 * 1000);
    expect(t59).toBe('287082');
    const t1111111109 = _internal.computeTotp(ascii, 1111111109 * 1000);
    expect(t1111111109).toBe('081804');
  });

  test('enroll + confirm round-trip', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const user = await seedUser(op.operatorId, 'admin@example.test');

    const enroll = await beginMfaEnrollment({
      userId: user.id,
      operatorSlug: op.slug,
      userEmail: user.email,
    });
    expect(enroll.secret.length).toBeGreaterThan(20);
    expect(enroll.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);
    expect(enroll.recoveryCodes.length).toBeGreaterThan(0);

    // Compute a valid code from the same secret.
    const code = _internal.computeTotp(_internal.base32Decode(enroll.secret), Date.now());
    const confirm = await confirmMfaEnrollment({ userId: user.id, code });
    expect(confirm.ok).toBe(true);

    const verify = await verifyMfaCode({ userId: user.id, code });
    expect(verify.ok).toBe(true);
  });

  test('invalid code is rejected', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const user = await seedUser(op.operatorId, 'admin2@example.test');
    const enroll = await beginMfaEnrollment({
      userId: user.id,
      operatorSlug: op.slug,
      userEmail: user.email,
    });
    const code = _internal.computeTotp(_internal.base32Decode(enroll.secret), Date.now());
    await confirmMfaEnrollment({ userId: user.id, code });

    const bad = await verifyMfaCode({ userId: user.id, code: '000000' });
    expect(bad.ok).toBe(false);
  });

  test('disableMfa clears the secret', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const user = await seedUser(op.operatorId, 'admin3@example.test');
    const enroll = await beginMfaEnrollment({
      userId: user.id,
      operatorSlug: op.slug,
      userEmail: user.email,
    });
    const code = _internal.computeTotp(_internal.base32Decode(enroll.secret), Date.now());
    await confirmMfaEnrollment({ userId: user.id, code });
    await disableMfa({ userId: user.id, actorEmail: 'ops@yantra.test' });
    const after = await prisma.operatorUser.findUnique({ where: { id: user.id } });
    expect(after!.mfaEnrolledAt).toBeNull();
    expect(after!.mfaTotpSecretCipher).toBeNull();
  });
});
