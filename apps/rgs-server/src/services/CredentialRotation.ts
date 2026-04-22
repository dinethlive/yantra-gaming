import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret } from '../utils/secrets.js';

type CredentialType = 'API_KEY_INBOUND' | 'WALLET_HMAC_OUTBOUND';

// ──────────────────────────────────────────────────────────────────────────
// Credential rotation.
//
// Goals:
//   1. Zero downtime — the old credential remains valid for a configurable
//      grace window after rotation, so in-flight operator calls don't 401.
//   2. Plaintext returned exactly once; never stored in the clear.
//   3. Every rotation produces an audit trail (OperatorConfigAuditLog).
//   4. Independent rotation per credential TYPE — rotating the inbound
//      API key does not touch the outbound wallet HMAC secret.
//
// Both endpoints (provider-scoped /platform and operator-self-service
// /admin) funnel through this service; the caller identity differs but
// the transition rules are identical.

const DEFAULT_GRACE_MS = 60 * 60_000; // 1 hour

export interface RotateCredentialInput {
  operatorId: string;
  type: CredentialType;
  /** Portal user's UUID — written to OperatorConfigAuditLog.changedBy. */
  actorUserId: string;
  /** Portal user's email — used in structured logs only. */
  actorEmail: string;
  label?: string;
  graceMs?: number;
  /**
   * Optional — if set, a new KID is minted with this slug prefix so the
   * operator can quickly identify which credential is which in their
   * config. Defaults to a random 6-hex-char suffix.
   */
  kidLabel?: string;
}

export interface RotateCredentialResult {
  /** The NEW credential's public id. */
  kid: string;
  /** Plaintext HMAC secret — shown once, never re-emitted. */
  secret: string;
  /** When the old credential stops being accepted. */
  previousCredentialRetiresAt: string;
  /** KID of the previous credential that was retired. Null if this was the first. */
  previousKid: string | null;
}

export async function rotateCredential(
  input: RotateCredentialInput,
): Promise<RotateCredentialResult> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const retiresAt = new Date(Date.now() + graceMs);

  return prisma.$transaction(async (tx) => {
    // Find the active credential for this (operator, type). Active = not
    // revoked and not past notAfter. Multiple rotations in quick succession
    // is permitted; each retires the prior (the chain is flat, not nested).
    const previous = await tx.operatorCredential.findFirst({
      where: {
        operatorId: input.operatorId,
        type: input.type,
        revokedAt: null,
        OR: [{ notAfter: null }, { notAfter: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    const slug = await tx.operator
      .findUnique({ where: { id: input.operatorId }, select: { slug: true } })
      .then((o) => o?.slug ?? 'op');

    const kidSuffix = input.kidLabel ?? crypto.randomBytes(6).toString('hex');
    const prefix = input.type === 'API_KEY_INBOUND' ? 'kid' : 'out';
    const newKid = `${prefix}_${slug}_${kidSuffix}`;
    const plaintext = crypto.randomBytes(32).toString('hex');

    await tx.operatorCredential.create({
      data: {
        operatorId: input.operatorId,
        type: input.type,
        kid: newKid,
        cipherBlob: encryptSecret(plaintext),
        label: input.label ?? `rotated by ${input.actorEmail}`,
      },
    });

    if (previous) {
      // Sunset the old credential. It remains valid for `graceMs` so the
      // operator (or our outbound HttpWalletAdapter) has time to pick up
      // the new one. After the grace window, operatorAuth rejects it.
      await tx.operatorCredential.update({
        where: { id: previous.id },
        data: { notAfter: retiresAt },
      });
    }

    await tx.operatorConfigAuditLog.create({
      data: {
        operatorId: input.operatorId,
        gameCode: '-',
        field: `credential.${input.type}`,
        oldValue: previous?.kid ?? null,
        newValue: newKid,
        changedBy: input.actorUserId,
      },
    });

    logger.info('credential_rotated', {
      operatorId: input.operatorId,
      type: input.type,
      newKid,
      previousKid: previous?.kid ?? null,
      graceMs,
      actor: input.actorEmail,
    });

    return {
      kid: newKid,
      secret: plaintext,
      previousCredentialRetiresAt: retiresAt.toISOString(),
      previousKid: previous?.kid ?? null,
    };
  });
}

export async function revokeCredentialImmediately(
  credentialId: string,
  actorUserId: string,
  actorEmail: string,
): Promise<void> {
  const existing = await prisma.operatorCredential.findUnique({
    where: { id: credentialId },
  });
  if (!existing) throw new Error('credential_not_found');
  if (existing.revokedAt) return; // idempotent
  await prisma.operatorCredential.update({
    where: { id: credentialId },
    data: { revokedAt: new Date(), notAfter: new Date() },
  });
  await prisma.operatorConfigAuditLog.create({
    data: {
      operatorId: existing.operatorId,
      gameCode: '-',
      field: `credential.${existing.type}.revoke`,
      oldValue: existing.kid,
      newValue: 'REVOKED',
      changedBy: actorUserId,
    },
  });
  logger.warn('credential_revoked_immediately', {
    operatorId: existing.operatorId,
    type: existing.type,
    kid: existing.kid,
    actor: actorEmail,
  });
}
