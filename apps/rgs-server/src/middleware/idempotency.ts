import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Inbound idempotency: we key by (operatorId, request_uuid, endpoint).
 * If the same request has been processed, replay the stored response;
 * otherwise capture res.json + status and persist it after the handler runs.
 *
 * The request_uuid is read from req.body.requestUuid — so this middleware
 * MUST run after the JSON body parser and operator-auth.
 */
const IDEMPOTENCY_TTL_HOURS = 24;

export function idempotency(endpointTag: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const operatorId = req.operator?.id;
    const requestUuid = req.body?.requestUuid as string | undefined;

    if (!operatorId || !requestUuid) {
      // Upstream auth/validation will reject; don't short-circuit here.
      next();
      return;
    }

    try {
      const existing = await prisma.inboundIdempotency.findUnique({
        where: {
          operatorId_requestUuid_endpoint: {
            operatorId,
            requestUuid,
            endpoint: endpointTag,
          },
        },
      });
      if (existing && existing.expiresAt.getTime() > Date.now()) {
        res.status(existing.httpStatus).json(existing.responseBody);
        return;
      }
    } catch (err) {
      logger.warn('idempotency lookup failed', { err: (err as Error).message });
    }

    // Patch res.json to persist after handler completes.
    const origJson = res.json.bind(res);
    let capturedBody: unknown = null;
    res.json = (body: unknown) => {
      capturedBody = body;
      return origJson(body);
    };

    res.on('finish', () => {
      if (res.statusCode >= 500) return;
      if (capturedBody === null) return;
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600 * 1000);
      prisma.inboundIdempotency
        .upsert({
          where: {
            operatorId_requestUuid_endpoint: {
              operatorId,
              requestUuid,
              endpoint: endpointTag,
            },
          },
          create: {
            operatorId,
            requestUuid,
            endpoint: endpointTag,
            httpStatus: res.statusCode,
            responseBody: capturedBody as object,
            expiresAt,
          },
          update: {
            httpStatus: res.statusCode,
            responseBody: capturedBody as object,
            expiresAt,
          },
        })
        .catch((err) => logger.warn('idempotency persist failed', { err: err.message }));
    });

    next();
  };
}
