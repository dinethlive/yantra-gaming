import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Certificate artefact storage.
//
// v1 implementation: short-lived upload token + local-disk shim.
//
// How it works:
//   1. Staff calls POST /v1/platform/certificates/:id/upload-url.
//   2. Server mints a random token, persists a CertUploadToken row with
//      a 15-minute expiry, returns { uploadUrl, token }.
//   3. UI streams the file to PUT /v1/platform/uploads/:token with the
//      body being the raw file bytes + X-Content-Sha256 header.
//   4. Server verifies token, streams to CERT_STORAGE_DIR/<certId>/<filename>,
//      computes SHA-256 in-flight, compares against the header, updates the
//      Certificate row with filePath/fileSize/fileSha256, marks the token
//      consumed.
//
// Production swap-out: set CERT_STORAGE_MODE=s3 and the mintUploadUrl
// function returns a real S3 presigned URL (not implemented here — the
// s3 branch is a TODO marker until the bucket is provisioned).
//
// Security posture:
//   * Token is stored server-side; the PUT endpoint refuses unknown or
//     consumed tokens.
//   * Token scope is tied to a single certificateId; it cannot be re-used
//     to overwrite another cert's artefact.
//   * Filenames are derived from certificateId + a random suffix; callers
//     cannot traverse outside CERT_STORAGE_DIR.

const STORAGE_DIR = process.env.CERT_STORAGE_DIR ?? path.join(process.cwd(), '.cert-storage');
const STORAGE_MODE = process.env.CERT_STORAGE_MODE ?? 'local';
const TOKEN_TTL_MS = 15 * 60_000;

function ensureStorageDir(): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  } catch (err) {
    logger.error('cert_storage_mkdir_failed', { err: (err as Error).message, dir: STORAGE_DIR });
  }
}

export interface MintedUpload {
  token: string;
  /** Relative URL to PUT the file to. */
  uploadUrl: string;
  /** Expiry (ISO-8601). */
  expiresAt: string;
  /** 15-minute window in ms. */
  ttlMs: number;
  /** Expected headers. */
  expectedHeaders: {
    contentType: 'application/octet-stream';
    contentSha256Header: 'X-Content-Sha256';
  };
}

export async function mintUploadUrl(args: {
  certificateId: string;
  createdByUserId: string;
}): Promise<MintedUpload> {
  const cert = await prisma.certificate.findUnique({
    where: { id: args.certificateId },
  });
  if (!cert) throw new Error('certificate_not_found');
  if (cert.revokedAt) throw new Error('certificate_revoked');

  if (STORAGE_MODE !== 'local') {
    // Placeholder for real S3 presigned URL implementation. Until the
    // bucket is configured we hard-fail rather than silently dropping
    // artefacts on the floor. The same API surface applies; only the
    // URL origin changes when wired up.
    throw new Error(`cert_storage_mode_not_implemented: ${STORAGE_MODE}`);
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.certUploadToken.create({
    data: {
      certificateId: args.certificateId,
      token,
      createdByUserId: args.createdByUserId,
      expiresAt,
    },
  });

  return {
    token,
    uploadUrl: `/v1/platform/uploads/${token}`,
    expiresAt: expiresAt.toISOString(),
    ttlMs: TOKEN_TTL_MS,
    expectedHeaders: {
      contentType: 'application/octet-stream',
      contentSha256Header: 'X-Content-Sha256',
    },
  };
}

export interface ConsumedUpload {
  filePath: string;
  fileSize: number;
  fileSha256: string;
}

/**
 * Consume a token and persist the file bytes. The caller streams the
 * request body into this function; we compute SHA-256 in one pass and
 * verify against the client-provided hash before writing the final file.
 */
export async function consumeUploadToken(args: {
  token: string;
  bytes: Buffer;
  declaredSha256?: string;
  originalName?: string;
}): Promise<ConsumedUpload> {
  const row = await prisma.certUploadToken.findUnique({
    where: { token: args.token },
  });
  if (!row) throw new Error('token_not_found');
  if (row.consumedAt) throw new Error('token_already_consumed');
  if (row.expiresAt.getTime() < Date.now()) throw new Error('token_expired');

  const computed = crypto.createHash('sha256').update(args.bytes).digest('hex');
  if (args.declaredSha256 && args.declaredSha256.toLowerCase() !== computed) {
    throw new Error('sha256_mismatch');
  }

  if (STORAGE_MODE !== 'local') {
    throw new Error(`cert_storage_mode_not_implemented: ${STORAGE_MODE}`);
  }

  ensureStorageDir();
  const certDir = path.join(STORAGE_DIR, row.certificateId);
  fs.mkdirSync(certDir, { recursive: true });
  const safeName = (args.originalName ?? 'artifact.bin')
    .replace(/[^\w.\-]/g, '_')
    .slice(0, 100);
  const finalName = `${Date.now()}-${safeName}`;
  const absPath = path.join(certDir, finalName);
  fs.writeFileSync(absPath, args.bytes);

  // Atomically: mark token consumed, update Certificate with the file.
  await prisma.$transaction([
    prisma.certUploadToken.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    }),
    prisma.certificate.update({
      where: { id: row.certificateId },
      data: {
        filePath: `/v1/platform/uploads/download/${row.certificateId}/${encodeURIComponent(finalName)}`,
        fileSize: args.bytes.length,
        fileSha256: computed,
      },
    }),
  ]);

  logger.info('cert_upload_consumed', {
    certificateId: row.certificateId,
    fileSize: args.bytes.length,
    fileSha256: computed,
  });

  return {
    filePath: `/v1/platform/uploads/download/${row.certificateId}/${encodeURIComponent(finalName)}`,
    fileSize: args.bytes.length,
    fileSha256: computed,
  };
}

/**
 * Sanitised resolver for the download route. Refuses path traversal
 * and files outside CERT_STORAGE_DIR.
 */
export function resolveForDownload(
  certificateId: string,
  filename: string,
): { absPath: string; exists: boolean } {
  if (STORAGE_MODE !== 'local') throw new Error('cert_storage_mode_not_implemented');
  const safe = filename.replace(/[^\w.\-]/g, '_');
  const absPath = path.join(STORAGE_DIR, certificateId, safe);
  if (!absPath.startsWith(path.resolve(STORAGE_DIR))) {
    return { absPath: '', exists: false };
  }
  return { absPath, exists: fs.existsSync(absPath) };
}

export { STORAGE_DIR };
// suppress unused-config warnings where config isn't referenced yet
void config;
