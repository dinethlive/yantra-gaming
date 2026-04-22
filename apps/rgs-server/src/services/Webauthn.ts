import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// WebAuthn (FIDO2 / passkeys) for OperatorUser.
//
// Two phases per flow:
//   Registration:
//     beginRegistration()   → challenge + options the browser hands to
//                             navigator.credentials.create()
//     confirmRegistration() → verifies attestation, stores PublicKey
//   Authentication:
//     beginAuthentication() → challenge + list of allowed credential ids
//     verifyAuthentication()→ verifies assertion, bumps signature counter
//
// Challenges live in WebauthnChallenge with a 5-minute TTL; rows are
// deleted on success. Bumping the counter protects against cloned
// authenticators — if the server's stored counter is ever less than the
// one the authenticator reports, something is wrong.

const CHALLENGE_TTL_MS = 5 * 60_000;

function rpId(): string {
  return process.env.WEBAUTHN_RP_ID ?? 'localhost';
}

function rpName(): string {
  return process.env.WEBAUTHN_RP_NAME ?? 'Yantra';
}

function expectedOrigins(): string[] {
  const raw = process.env.WEBAUTHN_ORIGINS;
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Dev default — cover provider-admin + operator-portal + any common host.
  return ['http://localhost:3101', 'http://localhost:3103'];
}

// ── Registration ──────────────────────────────────────────────

export interface BeginRegistrationResult {
  options: unknown;              // PublicKeyCredentialCreationOptionsJSON
  challengeId: string;
  expiresAt: string;
}

export async function beginRegistration(args: {
  userId: string;
  userEmail: string;
  userDisplayName: string;
}): Promise<BeginRegistrationResult> {
  // Prior authenticators are excluded so the browser surfaces a new
  // prompt instead of overwriting. userId for WebAuthn is bytes —
  // we use the UUID hex representation.
  const existing = await prisma.webauthnCredential.findMany({
    where: { userId: args.userId },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    userID: Buffer.from(args.userId.replace(/-/g, ''), 'hex'),
    userName: args.userEmail,
    userDisplayName: args.userDisplayName,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | 'cable' | 'smart-card')[],
    })),
  });

  const challengeRow = await prisma.webauthnChallenge.create({
    data: {
      userId: args.userId,
      email: args.userEmail,
      challenge: options.challenge,
      kind: 'register',
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });

  return {
    options,
    challengeId: challengeRow.id,
    expiresAt: challengeRow.expiresAt.toISOString(),
  };
}

export async function confirmRegistration(args: {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
}): Promise<{ ok: boolean; credentialId?: string }> {
  const challenge = await prisma.webauthnChallenge.findUnique({
    where: { id: args.challengeId },
  });
  if (!challenge || challenge.userId !== args.userId || challenge.kind !== 'register') {
    return { ok: false };
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    return { ok: false };
  }

  const verified = await verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpId(),
    requireUserVerification: false,
  });

  if (!verified.verified || !verified.registrationInfo) {
    return { ok: false };
  }

  const info = verified.registrationInfo;
  const credential = info.credential;

  await prisma.$transaction([
    prisma.webauthnCredential.create({
      data: {
        userId: args.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: (credential.transports ?? []) as string[],
        aaguid: info.aaguid ?? null,
        deviceName: args.deviceName?.slice(0, 100),
        backedUp: info.credentialBackedUp ?? false,
      },
    }),
    prisma.webauthnChallenge.delete({ where: { id: challenge.id } }),
  ]);

  logger.info('webauthn_credential_enrolled', {
    userId: args.userId,
    credentialId: credential.id,
    aaguid: info.aaguid ?? null,
  });

  return { ok: true, credentialId: credential.id };
}

// ── Authentication ────────────────────────────────────────────

export interface BeginAuthenticationResult {
  options: unknown;              // PublicKeyCredentialRequestOptionsJSON
  challengeId: string;
  expiresAt: string;
}

export async function beginAuthentication(args: {
  email: string;
}): Promise<BeginAuthenticationResult | null> {
  const email = args.email.toLowerCase();
  const user = await prisma.operatorUser.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    // Return a "successful" challenge anyway to avoid user enumeration —
    // the client will proceed, authenticator returns nothing, verify fails.
    // We still persist the row under the email only, keyed by kind.
    const options = await generateAuthenticationOptions({
      rpID: rpId(),
      userVerification: 'preferred',
    });
    const row = await prisma.webauthnChallenge.create({
      data: {
        email,
        challenge: options.challenge,
        kind: 'authenticate',
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
    return { options, challengeId: row.id, expiresAt: row.expiresAt.toISOString() };
  }
  const creds = await prisma.webauthnCredential.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });
  if (creds.length === 0) return null;

  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | 'cable' | 'smart-card')[],
    })),
  });
  const row = await prisma.webauthnChallenge.create({
    data: {
      userId: user.id,
      email,
      challenge: options.challenge,
      kind: 'authenticate',
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  return { options, challengeId: row.id, expiresAt: row.expiresAt.toISOString() };
}

export async function verifyAuthentication(args: {
  email: string;
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<{ ok: boolean; userId?: string }> {
  const challenge = await prisma.webauthnChallenge.findUnique({
    where: { id: args.challengeId },
  });
  if (
    !challenge ||
    challenge.kind !== 'authenticate' ||
    challenge.email?.toLowerCase() !== args.email.toLowerCase()
  ) {
    return { ok: false };
  }
  if (challenge.expiresAt.getTime() < Date.now()) return { ok: false };

  const cred = await prisma.webauthnCredential.findUnique({
    where: { credentialId: args.response.id },
  });
  if (!cred) return { ok: false };

  const verified = await verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpId(),
    credential: {
      id: cred.credentialId,
      publicKey: Buffer.from(cred.publicKey),
      counter: Number(cred.counter),
      transports: cred.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid' | 'cable' | 'smart-card')[],
    },
    requireUserVerification: false,
  });

  if (!verified.verified) return { ok: false };

  await prisma.$transaction([
    prisma.webauthnCredential.update({
      where: { id: cred.id },
      data: {
        counter: BigInt(verified.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    }),
    prisma.webauthnChallenge.delete({ where: { id: challenge.id } }),
  ]);

  return { ok: true, userId: cred.userId };
}

// ── Credential management ─────────────────────────────────────

export async function listCredentials(userId: string) {
  return prisma.webauthnCredential.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      credentialId: true,
      deviceName: true,
      transports: true,
      aaguid: true,
      backedUp: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
}

export async function deleteCredential(args: {
  userId: string;
  credentialRowId: string;
}): Promise<boolean> {
  const row = await prisma.webauthnCredential.findUnique({
    where: { id: args.credentialRowId },
  });
  if (!row || row.userId !== args.userId) return false;
  await prisma.webauthnCredential.delete({ where: { id: row.id } });
  return true;
}

// Garbage-collect expired challenge rows. Called on boot; non-blocking.
export async function sweepExpiredChallenges(): Promise<number> {
  const out = await prisma.webauthnChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return out.count;
}

// suppress crypto-unused lint in cases where types package differs
void crypto;
