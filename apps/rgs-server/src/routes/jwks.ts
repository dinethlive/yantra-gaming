import { Router } from 'express';
import { prisma } from '../db.js';
import { listPublicJwks } from '../services/SigningKeys.js';

// JWKS discovery for per-operator launch-JWT signing keys.
//
// Two entry points:
//   GET /v1/operators/:slug/.well-known/jwks.json
//      — public JWK Set for ONE operator. This is the URL operators
//        publish so aggregators / regulators can verify launch tokens.
//   GET /v1/.well-known/jwks.json?operator=:slug
//      — query-param variant for platforms that prefer a single well-
//        known URL on a multi-tenant host.
//
// Returns 404 if the operator does not exist or has no non-retired
// signing keys. RETIRED keys are intentionally excluded.

export const jwksRouter = Router();

jwksRouter.get('/operators/:slug/.well-known/jwks.json', async (req, res) => {
  const op = await prisma.operator.findUnique({
    where: { slug: req.params.slug as string },
    select: { id: true, status: true },
  });
  if (!op || op.status === 'TERMINATED') {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  const jwks = await listPublicJwks(op.id);
  // JWKS is aggressively cacheable — keys rotate on the order of months
  // and RETIRED keys drop out automatically. 5-minute cache is a
  // reasonable tradeoff between freshness during incident rotation and
  // downstream fetch pressure.
  res.setHeader('cache-control', 'public, max-age=300');
  res.json(jwks);
});

jwksRouter.get('/.well-known/jwks.json', async (req, res) => {
  const slug = typeof req.query.operator === 'string' ? req.query.operator : '';
  if (!slug) {
    res.status(400).json({ error: 'missing_operator_query' });
    return;
  }
  const op = await prisma.operator.findUnique({
    where: { slug },
    select: { id: true, status: true },
  });
  if (!op || op.status === 'TERMINATED') {
    res.status(404).json({ error: 'operator_not_found' });
    return;
  }
  const jwks = await listPublicJwks(op.id);
  res.setHeader('cache-control', 'public, max-age=300');
  res.json(jwks);
});
