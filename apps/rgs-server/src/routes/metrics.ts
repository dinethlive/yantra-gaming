import { Router } from 'express';
import { registry } from '../telemetry/index.js';

export const metricsRouter = Router();

/**
 * GET /metrics — Prometheus exposition format.
 *
 * Not authenticated. A real production deployment would put this behind a
 * private network or an IP allow-list (the Prometheus scraper's IP).
 */
metricsRouter.get('/metrics', (_req, res) => {
  res.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(registry.toText());
});
