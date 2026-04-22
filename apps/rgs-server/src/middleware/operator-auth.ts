import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../utils/secrets.js';
import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from '../utils/signing.js';

declare module 'express-serve-static-core' {
  interface Request {
    operator?: Awaited<ReturnType<typeof prisma.operator.findUnique>>;
    operatorCredential?: Awaited<ReturnType<typeof prisma.operatorCredential.findUnique>>;
    rawBody?: Buffer;
  }
}

export async function operatorAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const kid = req.header(KEY_ID_HEADER);
  const ts = req.header(TIMESTAMP_HEADER);
  const sig = req.header(SIGNATURE_HEADER);

  if (!kid || !ts || !sig) {
    res.status(401).json({ error: 'missing_signature_headers' });
    return;
  }

  try {
    const cred = await prisma.operatorCredential.findUnique({
      where: { kid },
      include: { operator: true },
    });
    if (!cred || cred.type !== 'API_KEY_INBOUND' || cred.revokedAt) {
      res.status(401).json({ error: 'unknown_or_revoked_kid' });
      return;
    }
    if (cred.notAfter && cred.notAfter < new Date()) {
      res.status(401).json({ error: 'credential_expired' });
      return;
    }
    // Allow PAUSED operators through HMAC verification so in-flight wallet
    // calls (bet/win/rollback) can settle cleanly even after a suspend. The
    // session-create route gates new sessions on status === 'ACTIVE' itself.
    // TERMINATED is a hard stop — no traffic in either direction.
    if (!cred.operator || cred.operator.status === 'TERMINATED') {
      res.status(401).json({ error: 'operator_terminated' });
      return;
    }

    const secret = decryptSecret(Buffer.from(cred.cipherBlob));
    const body = req.rawBody ?? Buffer.alloc(0);

    const ok = verifySignature(
      secret,
      req.method,
      req.originalUrl.split('?')[0] ?? req.path,
      ts,
      body,
      sig,
      config.signatureWindowSeconds,
    );
    if (!ok) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    req.operator = cred.operator;
    req.operatorCredential = cred;
    next();
  } catch (err) {
    logger.error('operatorAuth failed', { err: (err as Error).message });
    res.status(500).json({ error: 'auth_internal_error' });
  }
}
