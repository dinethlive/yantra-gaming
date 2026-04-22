import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';

/**
 * Enforce `Operator.allowedCountries` on the session-launch path.
 *
 * An empty list means "no restriction" (default). A non-empty list means
 * "sessions may only be created for players located in one of these ISO
 * 3166-1 alpha-2 country codes". This is the iGaming-native geo-gating
 * surface — licensed jurisdictions (UKGC, MGA, Ontario, NJ) require the
 * RGS to reject launches from disallowed territories.
 *
 * Country resolution priority (most-trusted first):
 *   1. Body `country` field — set by the operator's backend after their
 *      own identity / KYC / location check. Authoritative.
 *   2. `CF-IPCountry` header — Cloudflare edge country lookup.
 *   3. `X-Vercel-IP-Country` / `X-Forwarded-Country` header.
 *
 * Fails closed: if the allowlist is set and no country can be determined,
 * the launch is rejected with `country_unknown`. This is the correct
 * regulatory default — "unknown" is not "permitted".
 *
 * Must run AFTER operatorAuth so `req.operator` is populated.
 *
 * NOTE: this is not a replacement for device-level geolocation
 * (GeoComply / iovation) that US-state regulators require. A later turn
 * will wire a vendor integration; for v1 this handles the header-based
 * checks that cover Curaçao / Malta / UK and most EU regulators.
 */
export function geoAllowlist(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const op = req.operator;
  if (!op) {
    res.status(401).json({ error: 'no_operator' });
    return;
  }
  const allowed = op.allowedCountries ?? [];
  if (allowed.length === 0) {
    next();
    return;
  }

  const country = resolveCountry(req);
  if (!country) {
    logger.warn('geo_country_unknown', { operatorId: op.id });
    res.status(403).json({
      error: 'country_unknown',
      hint: 'provide `country` in body or set CF-IPCountry/X-Vercel-IP-Country header',
    });
    return;
  }
  if (!allowed.includes(country)) {
    logger.warn('geo_country_not_allowed', { operatorId: op.id, country });
    res.status(403).json({ error: 'country_not_allowed', country });
    return;
  }
  next();
}

function resolveCountry(req: Request): string | null {
  const body = (req.body ?? {}) as { country?: unknown };
  const bodyCountry = typeof body.country === 'string' ? normalise(body.country) : null;
  if (bodyCountry) return bodyCountry;

  const header =
    req.header('cf-ipcountry') ??
    req.header('x-vercel-ip-country') ??
    req.header('x-forwarded-country') ??
    '';
  const headerCountry = normalise(header);
  return headerCountry;
}

function normalise(v: string): string | null {
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}
