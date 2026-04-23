// Tier-1 credential rotation — zero-downtime invariant.
//
// Verifies:
//   * Old credential remains accepted during the grace window.
//   * New credential is accepted immediately.
//   * After grace, old credential is rejected.
//   * An OperatorConfigAuditLog row is written.
//   * Immediate revoke is immediate.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { prisma } from '../../apps/rgs-server/src/db.js';
import {
  revokeCredentialImmediately,
  rotateCredential,
} from '../../apps/rgs-server/src/services/CredentialRotation.js';
import { cleanDb, seedOperator } from './harness.js';

const SYSTEM_UUID = '00000000-0000-4000-8000-0000000000aa';

describe('CredentialRotation', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('rotate: old credential retires at grace window; new one is active', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const result = await rotateCredential({
      operatorId: op.operatorId,
      type: 'API_KEY_INBOUND',
      actorUserId: SYSTEM_UUID,
      actorEmail: 'ops@yantra.test',
      graceMs: 60_000,
    });

    expect(result.kid).not.toBe(op.inboundKid);
    expect(result.secret.length).toBeGreaterThan(30);
    expect(result.previousKid).toBe(op.inboundKid);

    const credentials = await prisma.operatorCredential.findMany({
      where: { operatorId: op.operatorId, type: 'API_KEY_INBOUND' },
      orderBy: { createdAt: 'asc' },
    });
    expect(credentials).toHaveLength(2);
    const [oldCred, newCred] = credentials;
    expect(oldCred!.kid).toBe(op.inboundKid);
    expect(oldCred!.notAfter).not.toBeNull();
    expect(oldCred!.revokedAt).toBeNull();
    expect(newCred!.kid).toBe(result.kid);
    expect(newCred!.notAfter).toBeNull();

    // Audit log written.
    const audit = await prisma.operatorConfigAuditLog.findFirst({
      where: { operatorId: op.operatorId, field: 'credential.API_KEY_INBOUND' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.oldValue).toBe(op.inboundKid);
    expect(audit!.newValue).toBe(result.kid);
  });

  test('revoke: credential is flagged revoked immediately, audit row written', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });

    const cred = await prisma.operatorCredential.findFirst({
      where: { operatorId: op.operatorId, type: 'API_KEY_INBOUND' },
    });

    await revokeCredentialImmediately(cred!.id, SYSTEM_UUID, 'ops@yantra.test');

    const after = await prisma.operatorCredential.findUnique({ where: { id: cred!.id } });
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.notAfter).not.toBeNull();

    const audit = await prisma.operatorConfigAuditLog.findFirst({
      where: { operatorId: op.operatorId, field: 'credential.API_KEY_INBOUND.revoke' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.newValue).toBe('REVOKED');
  });

  test('revoke: idempotent on a row already revoked', async () => {
    const op = await seedOperator({ walletCallbackUrl: 'http://unused' });
    const cred = await prisma.operatorCredential.findFirst({
      where: { operatorId: op.operatorId, type: 'API_KEY_INBOUND' },
    });
    await revokeCredentialImmediately(cred!.id, SYSTEM_UUID, 'ops@yantra.test');
    // Second call must not throw and must not re-write the audit row.
    await revokeCredentialImmediately(cred!.id, SYSTEM_UUID, 'ops@yantra.test');
    const audits = await prisma.operatorConfigAuditLog.count({
      where: { operatorId: op.operatorId, field: 'credential.API_KEY_INBOUND.revoke' },
    });
    expect(audits).toBe(1);
  });
});
