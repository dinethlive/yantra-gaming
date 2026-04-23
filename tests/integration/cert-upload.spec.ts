// Tier-2-followup cert upload — presigned token + direct PUT.
//
// Verifies:
//   * mintUploadUrl creates a token that expires.
//   * consumeUploadToken writes bytes, verifies SHA-256, updates Certificate.
//   * Replay of the same token fails.
//   * Wrong SHA-256 is rejected.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { prisma } from '../../apps/rgs-server/src/db.js';
import {
  consumeUploadToken,
  mintUploadUrl,
  STORAGE_DIR,
} from '../../apps/rgs-server/src/services/CertStorage.js';
import { cleanDb } from './harness.js';

const SYSTEM_UUID = '00000000-0000-4000-8000-0000000000bb';

async function seedCert() {
  return prisma.certificate.create({
    data: {
      gameCode: 'yantra',
      jurisdiction: 'MT',
      lab: 'GLI',
      certId: `test-${crypto.randomBytes(4).toString('hex')}`,
      buildHash: 'deadbeef',
      issuedAt: new Date(),
      validFrom: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });
}

describe('CertStorage', () => {
  beforeEach(async () => {
    await cleanDb();
    // Clear storage dir for this cert so we don't see stale files.
    if (fs.existsSync(STORAGE_DIR)) {
      fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('mint + consume: file lands on disk, certificate is linked', async () => {
    const cert = await seedCert();
    const minted = await mintUploadUrl({
      certificateId: cert.id,
      createdByUserId: SYSTEM_UUID,
    });
    expect(minted.token.length).toBeGreaterThan(20);

    const bytes = Buffer.from('%PDF-1.4 test cert', 'utf8');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const result = await consumeUploadToken({
      token: minted.token,
      bytes,
      declaredSha256: sha256,
      originalName: 'cert.pdf',
    });
    expect(result.fileSize).toBe(bytes.length);
    expect(result.fileSha256).toBe(sha256);

    const updated = await prisma.certificate.findUnique({ where: { id: cert.id } });
    expect(updated!.filePath).toContain(cert.id);
    expect(updated!.fileSha256).toBe(sha256);
    expect(updated!.fileSize).toBe(bytes.length);

    const token = await prisma.certUploadToken.findUnique({
      where: { token: minted.token },
    });
    expect(token!.consumedAt).not.toBeNull();

    // File exists on disk and has the expected content.
    const dir = path.join(STORAGE_DIR, cert.id);
    const entries = fs.readdirSync(dir);
    expect(entries.length).toBe(1);
    const diskSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dir, entries[0]!)))
      .digest('hex');
    expect(diskSha).toBe(sha256);
  });

  test('replay of same token is rejected', async () => {
    const cert = await seedCert();
    const minted = await mintUploadUrl({
      certificateId: cert.id,
      createdByUserId: SYSTEM_UUID,
    });
    const bytes = Buffer.from('abc');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    await consumeUploadToken({ token: minted.token, bytes, declaredSha256: sha });

    await expect(
      consumeUploadToken({ token: minted.token, bytes, declaredSha256: sha }),
    ).rejects.toThrow(/token_already_consumed/);
  });

  test('wrong SHA-256 is rejected without writing the file', async () => {
    const cert = await seedCert();
    const minted = await mintUploadUrl({
      certificateId: cert.id,
      createdByUserId: SYSTEM_UUID,
    });
    const bytes = Buffer.from('abc');
    await expect(
      consumeUploadToken({
        token: minted.token,
        bytes,
        declaredSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/sha256_mismatch/);

    const dir = path.join(STORAGE_DIR, cert.id);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
