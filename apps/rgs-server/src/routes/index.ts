import { Router } from 'express';
import { adminAuthRouter } from './admin-auth.js';
import { adminRouter } from './admin.js';
import { jwksRouter } from './jwks.js';
import { platformRouter } from './platform.js';
import { reportsRouter } from './reports.js';
import { roundsRouter } from './rounds.js';
import { sessionRouter } from './session.js';
import { webhooksRouter } from './webhooks.js';

export const v1Router = Router();

// JWKS discovery — public, unauthenticated, mounted FIRST so its static
// paths are not shadowed by dynamic matches elsewhere.
v1Router.use(jwksRouter);

v1Router.use('/session', sessionRouter);
v1Router.use('/rounds', roundsRouter);
v1Router.use('/reports', reportsRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/admin/auth', adminAuthRouter);
v1Router.use('/admin', adminRouter);
v1Router.use('/platform', platformRouter);
