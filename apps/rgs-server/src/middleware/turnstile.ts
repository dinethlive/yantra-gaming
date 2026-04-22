import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { turnstileVerifications } from '../telemetry/index.js';

// Optional Cloudflare Turnstile bot-challenge.
//
// When to use: on /v1/session to harden against credential-replay and
// automated account-creation attacks. The operator renders a Turnstile
// widget on their launch page (client-side), receives a token from the
// player's browser, and passes it to their backend; the backend relays it
// in the `cfTurnstileToken` field of the POST /v1/session body (or the
// `cf-turnstile-response` header). The RGS verifies via the Cloudflare
// siteverify endpoint before minting the session.
//
// Configuration:
//   • TURNSTILE_SECRET_KEY  — the secret key from your Cloudflare dashboard.
//                             If unset, this middleware is a pass-through
//                             (the default for local dev and staging;
//                             production turns it on once the operator's
//                             launch page renders a Turnstile widget).
//   • TURNSTILE_SITEVERIFY_URL — override for tests; defaults to the real
//                                Cloudflare URL.

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export interface TurnstileOptions {
  /** Inject fetch for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Inject the secret-verify URL for tests. */
  siteverifyUrl?: string;
  /** Fail-closed if the Cloudflare endpoint is unreachable. Default false (fail-open on network error). */
  failClosedOnError?: boolean;
}

export function turnstileVerify(
  opts: TurnstileOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const siteverifyUrl = opts.siteverifyUrl ?? config.turnstileSiteverifyUrl;
  const failClosed = opts.failClosedOnError ?? false;

  return async (req, res, next) => {
    const secret = config.turnstileSecretKey;
    if (!secret) {
      // Not configured — pass-through. This is the default for local dev
      // and staging; production enables it by setting the env var once the
      // operator's launch page renders a Turnstile widget.
      turnstileVerifications.inc({ status: 'skip' });
      return next();
    }

    const token = extractToken(req);
    if (!token) {
      turnstileVerifications.inc({ status: 'fail', reason: 'missing_token' });
      res.status(401).json({
        error: 'turnstile_token_missing',
        detail:
          'include a `cfTurnstileToken` field in the request body or `cf-turnstile-response` header',
      });
      return;
    }

    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (req.ip) form.set('remoteip', req.ip);

    let body: SiteverifyResponse;
    try {
      const response = await fetchImpl(siteverifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      body = (await response.json()) as SiteverifyResponse;
    } catch (err) {
      logger.error('turnstile_network_error', { err: (err as Error).message });
      turnstileVerifications.inc({ status: 'error' });
      if (failClosed) {
        res.status(503).json({ error: 'turnstile_unreachable' });
        return;
      }
      // Fail-open: if Cloudflare is down we don't want to block real play.
      // Operators who want strict behaviour set `failClosedOnError: true`
      // when wiring the middleware.
      return next();
    }

    if (!body.success) {
      logger.warn('turnstile_verification_failed', {
        errorCodes: body['error-codes'],
        hostname: body.hostname,
      });
      turnstileVerifications.inc({ status: 'fail' });
      res.status(401).json({
        error: 'turnstile_verification_failed',
        detail: body['error-codes'] ?? [],
      });
      return;
    }

    turnstileVerifications.inc({ status: 'ok' });
    next();
  };
}

function extractToken(req: Request): string | undefined {
  const headerToken = req.header('cf-turnstile-response');
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;

  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.cfTurnstileToken === 'string' && body.cfTurnstileToken.length > 0) {
    return body.cfTurnstileToken;
  }
  return undefined;
}
