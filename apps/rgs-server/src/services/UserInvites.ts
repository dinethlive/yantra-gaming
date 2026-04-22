import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Operator user invites.
//
// Single-use, time-bounded token issued by an OPERATOR_ADMIN to invite
// a new user. Token plaintext is returned ONCE (shared out-of-band —
// email is sent by the caller, we don't assume SMTP is wired in the
// core repo). We store only a SHA-256 hash so a DB leak cannot be used
// to accept invites.
//
// Roles & RBAC:
//   - Only OPERATOR_ADMIN and KETAPOLA_STAFF can issue invites (enforced
//     at the route middleware).
//   - An invite carries the target role; the accept endpoint never
//     permits role escalation.

const DEFAULT_TTL_MS = 48 * 60 * 60_000; // 48h
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export type InviteRole =
  | 'OPERATOR_ADMIN'
  | 'OPERATOR_FINANCE'
  | 'OPERATOR_SUPPORT'
  | 'OPERATOR_VIEWER';

export async function createInvite(args: {
  operatorId: string;
  email: string;
  role: InviteRole;
  invitedByEmail: string;
  ttlMs?: number;
}): Promise<{ inviteId: string; token: string; expiresAt: string }> {
  const email = args.email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('invalid_email');
  }

  const existingUser = await prisma.operatorUser.findUnique({ where: { email } });
  if (existingUser) throw new Error('email_already_in_use');

  // Revoke any prior un-accepted invites for this (operator, email) so a
  // late-arriving email can't be re-used after a re-issue.
  await prisma.operatorUserInvite.updateMany({
    where: {
      operatorId: args.operatorId,
      email,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS));

  const invite = await prisma.operatorUserInvite.create({
    data: {
      operatorId: args.operatorId,
      email,
      role: args.role,
      tokenHash,
      invitedByEmail: args.invitedByEmail,
      expiresAt,
    },
  });

  logger.info('operator_invite_created', {
    operatorId: args.operatorId,
    email,
    role: args.role,
    inviteId: invite.id,
    invitedByEmail: args.invitedByEmail,
    expiresAt: expiresAt.toISOString(),
  });

  return { inviteId: invite.id, token, expiresAt: expiresAt.toISOString() };
}

export async function acceptInvite(args: {
  token: string;
  displayName: string;
  password: string;
}): Promise<{ userId: string; operatorId: string; role: string; email: string }> {
  const tokenHash = hashToken(args.token);
  const invite = await prisma.operatorUserInvite.findUnique({ where: { tokenHash } });
  if (!invite) throw new Error('invite_not_found');
  if (invite.acceptedAt) throw new Error('invite_already_accepted');
  if (invite.revokedAt) throw new Error('invite_revoked');
  if (invite.expiresAt.getTime() < Date.now()) throw new Error('invite_expired');

  // Same email-unique constraint — race-safe because we check inside the
  // transaction.
  const passwordHash = await bcrypt.hash(args.password, 12);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.operatorUser.findUnique({
      where: { email: invite.email },
    });
    if (existing) throw new Error('email_already_in_use');

    const user = await tx.operatorUser.create({
      data: {
        operatorId: invite.operatorId,
        email: invite.email,
        passwordHash,
        role: invite.role,
        displayName: args.displayName.slice(0, 100),
      },
    });

    await tx.operatorUserInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    return user;
  });

  logger.info('operator_invite_accepted', {
    operatorId: result.operatorId,
    userId: result.id,
    email: result.email,
    role: result.role,
  });

  return {
    userId: result.id,
    operatorId: result.operatorId,
    role: result.role,
    email: result.email,
  };
}

export async function listInvites(operatorId: string) {
  return prisma.operatorUserInvite.findMany({
    where: { operatorId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      role: true,
      invitedByEmail: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });
}

export async function revokeInvite(args: {
  operatorId: string;
  inviteId: string;
  actorEmail: string;
}): Promise<boolean> {
  const inv = await prisma.operatorUserInvite.findUnique({
    where: { id: args.inviteId },
  });
  if (!inv || inv.operatorId !== args.operatorId) return false;
  if (inv.acceptedAt || inv.revokedAt) return true;
  await prisma.operatorUserInvite.update({
    where: { id: inv.id },
    data: { revokedAt: new Date() },
  });
  logger.info('operator_invite_revoked', {
    operatorId: args.operatorId,
    inviteId: inv.id,
    actor: args.actorEmail,
  });
  return true;
}
