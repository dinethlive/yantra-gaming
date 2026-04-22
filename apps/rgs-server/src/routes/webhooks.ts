import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.js';

export const webhooksRouter = Router();

webhooksRouter.post('/test', operatorAuth, (req, res) => {
  res.json({
    ok: true,
    receivedAt: new Date().toISOString(),
    yourOperatorId: req.operator?.id,
    echo: req.body ?? null,
  });
});
