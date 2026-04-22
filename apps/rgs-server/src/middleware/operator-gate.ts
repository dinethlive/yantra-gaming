import type { RequestHandler } from 'express';
import { ipAllowList } from './ip-allow-list.js';
import { operatorAuth } from './operator-auth.js';
import { operatorRateLimit } from './operator-rate-limit.js';

/**
 * Standard middleware chain for an operator-authenticated endpoint:
 *
 *   1. operatorAuth       — verify HMAC signature + timestamp; populate req.operator
 *   2. ipAllowList        — enforce Operator.ipAllowList if configured
 *   3. operatorRateLimit  — 300 req/min per operator (fall-back key: client IP)
 *
 * Use with the spread operator:
 *
 *     router.post('/thing', ...operatorGate, handler)
 */
export const operatorGate: RequestHandler[] = [
  operatorAuth,
  ipAllowList,
  operatorRateLimit,
];
