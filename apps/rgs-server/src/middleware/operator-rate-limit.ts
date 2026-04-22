import rateLimit from 'express-rate-limit';

// Per-operator rate limit.
//
// Applied AFTER operatorAuth so `req.operator.id` is set. If for any reason
// the operator isn't identified (e.g. unauthenticated error path that still
// reached here), we fall back to IP-based keying.
//
// Soft limits — they exist to contain a misconfigured operator, not to
// police normal traffic.

export const operatorRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const op = req.operator;
    if (op?.id) return `op:${op.id}`;
    return `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    status: 'RS_ERROR_RATE_LIMIT',
    message: 'too many requests for this operator',
  },
});

/**
 * Tighter limit for the session endpoint — most operators are creating at
 * most a few sessions per second per player. 30/min should fit even a very
 * active operator comfortably; a breach is a likely sign of a login-loop bug.
 */
export const sessionCreateRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const op = req.operator;
    if (op?.id) return `op-session:${op.id}`;
    return `ip-session:${req.ip ?? 'unknown'}`;
  },
  message: {
    status: 'RS_ERROR_RATE_LIMIT',
    message: 'too many session creations for this operator',
  },
});
