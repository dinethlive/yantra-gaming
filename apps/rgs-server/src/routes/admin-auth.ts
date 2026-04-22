import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { portalAuth, signPortalToken } from '../middleware/portal-auth.js';
import { verifyMfaCode } from '../services/Mfa.js';
import { acceptInvite } from '../services/UserInvites.js';
import {
  beginAuthentication,
  verifyAuthentication,
} from '../services/Webauthn.js';

export const adminAuthRouter = Router();

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
  /** 6-digit TOTP code. Required if the user has MFA enrolled. */
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});

adminAuthRouter.post('/login', async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const user = await prisma.operatorUser.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
    include: { operator: true },
  });
  if (!user) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  if (user.disabledAt) {
    res.status(403).json({ error: 'user_disabled' });
    return;
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  if (!user.operator || user.operator.status === 'TERMINATED') {
    res.status(403).json({ error: 'operator_inactive' });
    return;
  }

  // MFA gate. Two factors are acceptable: TOTP and WebAuthn. If the user
  // has enrolled EITHER, at least one must succeed. The client chooses
  // by passing `mfaCode` (TOTP path) or the full webauthn login dance
  // via /webauthn:begin + /webauthn:verify (which issues its own session).
  const webauthnCount = await prisma.webauthnCredential.count({
    where: { userId: user.id },
  });
  const needsSecondFactor = Boolean(user.mfaEnrolledAt) || webauthnCount > 0;
  if (needsSecondFactor) {
    if (!parsed.data.mfaCode) {
      res.status(401).json({
        error: 'mfa_required',
        hint: 'POST /v1/admin/auth/webauthn:begin for WebAuthn, or resubmit login with mfaCode for TOTP.',
        factors: {
          totp: Boolean(user.mfaEnrolledAt),
          webauthn: webauthnCount > 0,
        },
      });
      return;
    }
    if (!user.mfaEnrolledAt) {
      res.status(401).json({ error: 'totp_not_enrolled' });
      return;
    }
    const mfa = await verifyMfaCode({ userId: user.id, code: parsed.data.mfaCode });
    if (!mfa.ok) {
      res.status(401).json({ error: 'invalid_mfa_code' });
      return;
    }
  }

  await prisma.operatorUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const token = signPortalToken({
    sub: user.id,
    operatorId: user.operatorId,
    role: user.role,
    email: user.email,
  });

  res.cookie('portal_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 60 * 8,
    path: '/',
  });

  res.json({
    token,
    operatorUser: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      mfaEnrolled: Boolean(user.mfaEnrolledAt),
    },
    operator: {
      id: user.operator.id,
      slug: user.operator.slug,
      name: user.operator.name,
      defaultCurrency: user.operator.defaultCurrency,
      jurisdiction: user.operator.jurisdiction,
      environment: user.operator.environment,
    },
  });
});

// Invite acceptance — unauthenticated by design, since the invited
// user has no credentials yet. The token is single-use and time-bounded.
const AcceptInviteBody = z.object({
  token: z.string().min(10).max(200),
  displayName: z.string().min(1).max(100),
  password: z.string().min(10).max(256),
});

adminAuthRouter.post('/invites:accept', async (req, res) => {
  const parsed = AcceptInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  try {
    const out = await acceptInvite(parsed.data);
    // Log the user in immediately by minting a portal token.
    const token = signPortalToken({
      sub: out.userId,
      operatorId: out.operatorId,
      role: out.role,
      email: out.email,
    });
    res.cookie('portal_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 8,
      path: '/',
    });
    res.status(201).json({
      token,
      operatorUser: {
        id: out.userId,
        email: out.email,
        role: out.role,
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg === 'invite_not_found' ||
      msg === 'invite_already_accepted' ||
      msg === 'invite_revoked' ||
      msg === 'invite_expired' ||
      msg === 'email_already_in_use'
    ) {
      res.status(400).json({ error: msg });
      return;
    }
    throw err;
  }
});

adminAuthRouter.post('/logout', (_req, res) => {
  res.clearCookie('portal_token', { path: '/' });
  res.json({ ok: true });
});

// ── WebAuthn login flow ──────────────────────────────────────────
//
// Phase 1: user submits email + password and the server replies with a
// 401 mfa_required when a second factor is needed. Phase 2a (TOTP) is
// "resubmit login with mfaCode". Phase 2b (WebAuthn) is this endpoint
// pair: :begin returns a challenge bound to the email; :verify takes
// the assertion and, on success, mints the portal token directly.

const WebAuthnBegin = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

adminAuthRouter.post('/webauthn:begin', async (req, res) => {
  const parsed = WebAuthnBegin.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const user = await prisma.operatorUser.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });
  if (!user) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  if (user.disabledAt) {
    res.status(403).json({ error: 'user_disabled' });
    return;
  }
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  const challenge = await beginAuthentication({ email: user.email });
  if (!challenge) {
    res.status(400).json({ error: 'no_webauthn_credentials' });
    return;
  }
  res.json(challenge);
});

const WebAuthnVerify = z.object({
  email: z.string().email(),
  challengeId: z.string().uuid(),
  response: z.record(z.unknown()),
});
adminAuthRouter.post('/webauthn:verify', async (req, res) => {
  const parsed = WebAuthnVerify.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const verified = await verifyAuthentication({
    email: parsed.data.email.toLowerCase(),
    challengeId: parsed.data.challengeId,
    response:
      parsed.data.response as unknown as import('@simplewebauthn/server').AuthenticationResponseJSON,
  });
  if (!verified.ok || !verified.userId) {
    res.status(401).json({ error: 'verification_failed' });
    return;
  }
  const user = await prisma.operatorUser.findUnique({
    where: { id: verified.userId },
    include: { operator: true },
  });
  if (!user || !user.operator || user.operator.status === 'TERMINATED') {
    res.status(403).json({ error: 'operator_inactive' });
    return;
  }
  await prisma.operatorUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  const token = signPortalToken({
    sub: user.id,
    operatorId: user.operatorId,
    role: user.role,
    email: user.email,
  });
  res.cookie('portal_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 1000 * 60 * 60 * 8,
    path: '/',
  });
  res.json({
    token,
    operatorUser: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      mfaEnrolled: Boolean(user.mfaEnrolledAt),
    },
    operator: {
      id: user.operator.id,
      slug: user.operator.slug,
      name: user.operator.name,
      defaultCurrency: user.operator.defaultCurrency,
      jurisdiction: user.operator.jurisdiction,
    },
  });
});

adminAuthRouter.get('/me', portalAuth, (req, res) => {
  const u = req.portalUser!;
  const op = req.operator!;
  res.json({
    operatorUser: {
      id: u.id,
      email: u.email,
      role: u.role,
      displayName: u.displayName,
    },
    operator: {
      id: op.id,
      slug: op.slug,
      name: op.name,
      defaultCurrency: op.defaultCurrency,
      jurisdiction: op.jurisdiction,
    },
  });
});
