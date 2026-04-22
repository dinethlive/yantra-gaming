import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Admin-action audit trail.
//
// Wraps every write under /v1/platform/* so a reviewer can answer
// "who did X on date Y". Reads are intentionally NOT logged here — the
// volume is too high and they already leave a trace through the
// reverse-proxy access log. Writes are rare + high-value.
//
// Secret scrubbing: request bodies may contain sensitive fields
// (password, secret, token, cipher, privateJwk, etc.). The middleware
// drops them before persisting. Response payloads are not logged at all
// since they may contain freshly-minted plaintexts (API keys, JWTs).

const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordHash',
  'secret',
  'token',
  'privateJwk',
  'cipher',
  'cipherBlob',
  'mfaCode',
  'newPassword',
  'oldPassword',
]);

function scrub(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = scrub(v);
    }
  }
  return out;
}

function inferTarget(path: string): { type: string | null; id: string | null } {
  // Light-touch parser. Rather than hand-code every route, we look for
  // path segments matching `/<collection>/<id>` and treat the collection
  // as the target type. Good enough for the platform routes today.
  const segments = path.split('?')[0]!.split('/').filter(Boolean);
  // Find operators/<id>, certificates/<id>, credentials/<id>, game-configs/<id>
  const collections = new Set([
    'operators',
    'certificates',
    'credentials',
    'game-configs',
    'webhooks',
    'signing-keys',
    'invites',
    'users',
  ]);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (collections.has(segments[i]!)) {
      return { type: segments[i]!.replace(/-/g, '_'), id: segments[i + 1]! };
    }
  }
  return { type: null, id: null };
}

export function adminAuditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Only audit writes. GET/HEAD/OPTIONS skip (read volume makes logging
  // more noise than signal; the platform portal already queries a lot).
  const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  if (!writeMethods.has(req.method)) {
    next();
    return;
  }

  const started = Date.now();
  // Capture body BEFORE next() — downstream handlers may drain/mutate it.
  const bodyCopy = req.body ? scrub(req.body) : undefined;

  res.on('finish', () => {
    const actor = req.portalUser;
    const path = req.originalUrl.split('?')[0] ?? req.path;
    const target = inferTarget(path);
    void prisma.adminAuditEntry
      .create({
        data: {
          actorUserId: actor?.id ?? null,
          actorEmail: actor?.email ?? 'anonymous',
          actorRole: req.portalClaims?.role ?? 'anonymous',
          method: req.method,
          path: path.slice(0, 256),
          targetType: target.type,
          targetId: target.id,
          bodySummary: bodyCopy as object | undefined,
          responseStatus: res.statusCode,
          latencyMs: Date.now() - started,
        },
      })
      .catch((err) => {
        // Audit-log failure must never break the response.
        logger.error('admin_audit_write_failed', {
          err: (err as Error).message,
          path,
        });
      });
  });
  next();
}
