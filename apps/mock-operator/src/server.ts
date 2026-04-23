// Mock operator bootstrap.
//
// Serves two things on the same port (MOCK_OPERATOR_PORT, default 4300):
//   1. /wallet/*  — seamless wallet endpoints the RGS calls into.
//   2. /, /lobby/* — fake casino lobby UI + session-launch form.
//
// Dev-only. No TLS, no persistence, no process manager — `bun --watch`.

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { walletRouter } from './wallet/router.js';
import { lobbyRouter } from './lobby/router.js';

const app = express();

// CORS: wallet calls are server-to-server so no browser preflights; the lobby
// is same-origin. A permissive policy is fine for a dev harness.
app.use(cors());

// Trust no proxy in dev. Helmet is overkill for a local harness; skipped.

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, operatorId: config.operatorId });
});

// Wallet router uses its own raw-body parser (HMAC needs original bytes);
// mount it BEFORE any express.json() so its parser runs first.
app.use('/wallet', walletRouter);

// Lobby routes — render HTML at `/`, handle POST /lobby/launch.
app.use('/', lobbyRouter);

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[mock-operator] listening on http://localhost:${config.port}  ` +
      `(operatorId=${config.operatorId}, rgs=${config.rgsBaseUrl})`,
  );
});
