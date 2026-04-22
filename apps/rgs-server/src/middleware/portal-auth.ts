import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';

export interface PortalJwtClaims {
  sub: string;           // OperatorUser.id
  operatorId: string;
  role: string;
  email: string;
  iat: number;
  exp: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    portalUser?: Awaited<ReturnType<typeof prisma.operatorUser.findUnique>>;
    portalClaims?: PortalJwtClaims;
  }
}

export function signPortalToken(
  claims: Omit<PortalJwtClaims, 'iat' | 'exp'>,
  expiresInSec = 60 * 60 * 8,
): string {
  return jwt.sign(claims, config.portalJwtSecret, {
    algorithm: 'HS256',
    expiresIn: expiresInSec,
  });
}

function extractToken(req: Request): string | undefined {
  const h = req.header('authorization');
  if (h && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const c = (req as Request & { cookies?: Record<string, string> }).cookies?.portal_token;
  if (typeof c === 'string' && c.length > 0) return c;
  return undefined;
}

export async function portalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing_portal_token' });
    return;
  }
  let claims: PortalJwtClaims;
  try {
    claims = jwt.verify(token, config.portalJwtSecret) as PortalJwtClaims;
  } catch {
    res.status(401).json({ error: 'invalid_portal_token' });
    return;
  }

  const user = await prisma.operatorUser.findUnique({
    where: { id: claims.sub },
    include: { operator: true },
  });
  if (!user || user.operatorId !== claims.operatorId) {
    res.status(401).json({ error: 'portal_user_not_found' });
    return;
  }
  if (!user.operator || user.operator.status === 'TERMINATED') {
    res.status(401).json({ error: 'operator_inactive' });
    return;
  }

  req.portalUser = user;
  req.portalClaims = claims;
  req.operator = user.operator;
  next();
}
