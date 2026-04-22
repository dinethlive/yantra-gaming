import type { NextFunction, Request, Response } from 'express';

// ──────────────────────────────────────────────────────────────────────────
// Role-based access control.
//
// Used after portalAuth to gate operator-side admin routes. We keep it
// lightweight: a hard-coded permission map per role, checked at route
// registration time. Expanding with per-field permissions is deferred —
// today every sensitive field is gated by its route.
//
// Roles (see Prisma enum OperatorRole):
//   OPERATOR_ADMIN    full — manage users, credentials, webhooks, config
//   OPERATOR_FINANCE  reconciliation + reports; no config changes
//   OPERATOR_SUPPORT  player-lookup + dispute pack; no config or reports
//   OPERATOR_VIEWER   read-only
//   KETAPOLA_STAFF    our own internal users — superset of all roles

export type OperatorRole =
  | 'OPERATOR_ADMIN'
  | 'OPERATOR_FINANCE'
  | 'OPERATOR_SUPPORT'
  | 'OPERATOR_VIEWER'
  | 'KETAPOLA_STAFF'
  | 'KETAPOLA_COMPLIANCE'
  | 'KETAPOLA_AUDITOR'
  | 'KETAPOLA_SUPPORT';

const STAFF_ROLE: OperatorRole = 'KETAPOLA_STAFF';
const STAFF_ROLES: OperatorRole[] = [
  'KETAPOLA_STAFF',
  'KETAPOLA_COMPLIANCE',
  'KETAPOLA_AUDITOR',
  'KETAPOLA_SUPPORT',
];

export function isStaffRole(role: string): boolean {
  return (STAFF_ROLES as string[]).includes(role);
}

export function requireRole(...allowed: OperatorRole[]) {
  const set = new Set<OperatorRole>([...allowed, STAFF_ROLE]);
  return function roleGate(req: Request, res: Response, next: NextFunction): void {
    const role = req.portalClaims?.role as OperatorRole | undefined;
    if (!role || !set.has(role)) {
      res.status(403).json({
        error: 'insufficient_role',
        required: allowed,
        actual: role ?? null,
      });
      return;
    }
    next();
  };
}

/** Ops-side operator admin: manage users, credentials, webhooks, config. */
export const requireOperatorAdmin = requireRole('OPERATOR_ADMIN');

/** Finance scope: reconciliation + reports. */
export const requireOperatorFinance = requireRole(
  'OPERATOR_ADMIN',
  'OPERATOR_FINANCE',
);

/** Support scope: player lookup, dispute pack. */
export const requireOperatorSupport = requireRole(
  'OPERATOR_ADMIN',
  'OPERATOR_SUPPORT',
);

/** Read-only scope: reports + audit. All operator roles count. */
export const requireOperatorAny = requireRole(
  'OPERATOR_ADMIN',
  'OPERATOR_FINANCE',
  'OPERATOR_SUPPORT',
  'OPERATOR_VIEWER',
);

// ── Platform (Yantra-side) role gates ──────────────────────
// Platform routes already sit behind `platformAuth` which requires any
// staff role. These gates narrow a write-level route to specific staff
// scopes. KETAPOLA_STAFF always passes.

/** Full platform admin — the only role that can mutate operator config. */
export const requireYantraAdmin = requireRole('KETAPOLA_STAFF');

/** Compliance scope: cert CRUD + kill-switch + audit read. */
export const requireYantraCompliance = requireRole(
  'KETAPOLA_STAFF',
  'KETAPOLA_COMPLIANCE',
);

/** Support scope: round finder + dispute pack + read-only operator detail. */
export const requireYantraSupport = requireRole(
  'KETAPOLA_STAFF',
  'KETAPOLA_COMPLIANCE',
  'KETAPOLA_SUPPORT',
);
