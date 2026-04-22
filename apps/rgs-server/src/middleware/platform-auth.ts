import type { NextFunction, Request, Response } from 'express';
import { portalAuth } from './portal-auth.js';
import { isStaffRole } from './role-gate.js';

// Gate for cross-operator platform routes. Chains after portalAuth, which
// populates req.portalUser / req.portalClaims / req.operator.
//
// Any KETAPOLA_* role may enter the platform namespace; fine-grained write
// gating (KETAPOLA_STAFF-only for operator mutations, KETAPOLA_COMPLIANCE
// for cert CRUD, etc.) is applied per-route via role-gate.ts's
// `requireYantraAdmin` / `requireYantraCompliance` / `requireYantraSupport`.
export function requireStaffRole(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.portalClaims?.role;
  if (!role || !isStaffRole(role)) {
    res.status(403).json({ error: 'insufficient_role' });
    return;
  }
  next();
}

export const platformAuth = [portalAuth, requireStaffRole];
