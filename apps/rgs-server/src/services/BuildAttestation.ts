import { prisma } from '../db.js';
import { getPlugin } from '../games/registry.js';
import { logger } from '../logger.js';

// ──────────────────────────────────────────────────────────────────────────
// Runtime build-hash attestation.
//
// A cert lab ships back "build hash X is certified for jurisdiction J on
// game G". If the deployed server's BUILD_HASH differs from every
// non-expired, non-revoked Certificate row for a given (operator, game,
// jurisdiction, rngVersion), we MUST NOT serve real-money rounds for
// that operator — the regulator has certified different code.
//
// Two checkpoints:
//   1. Boot: walk every ACTIVE, non-test operator and log any gap.
//   2. Pre-round: EngineRegistry.ensure() asks this service before
//      starting an engine for (operator, game, currency). In strict
//      mode (RGS_CERT_STRICT=1) an unmatched hash refuses to start
//      the engine. Dev/test default is non-strict to keep local flow
//      working without cert rows.
//
// This is distinct from the CertRegistry coverage check, which is a
// boot-time warning only. BuildAttestation is the *runtime gate*.

export interface BuildAttestationResult {
  allowed: boolean;
  buildHash: string | null;
  reason?: 'missing_build_hash'
    | 'no_matching_certificate'
    | 'build_hash_drift'
    | 'certificate_expired'
    | 'certificate_revoked'
    | 'rng_version_mismatch';
  certificateId?: string;
  certifiedBuildHash?: string;
  expiresAt?: string;
}

function strictMode(): boolean {
  return process.env.RGS_CERT_STRICT === '1';
}

export class BuildAttestation {
  private readonly buildHash: string | null;

  constructor() {
    const h = process.env.BUILD_HASH;
    this.buildHash = h && h.length >= 7 ? h : null;
  }

  /** The hash the server booted with, or null in dev with BUILD_HASH unset. */
  currentBuildHash(): string | null {
    return this.buildHash;
  }

  /**
   * Non-strict preview: check whether serving (operator, game, jurisdiction)
   * would be permitted, without enforcing. Always returns a reason when it
   * wouldn't — callers log for observability and, in strict mode, refuse.
   */
  async check(args: {
    operatorId: string;
    gameCode: string;
    jurisdiction: string;
  }): Promise<BuildAttestationResult> {
    if (!this.buildHash) {
      return { allowed: !strictMode(), buildHash: null, reason: 'missing_build_hash' };
    }

    const now = new Date();
    const candidates = await prisma.certificate.findMany({
      where: {
        gameCode: args.gameCode,
        jurisdiction: { in: [args.jurisdiction, 'MULTI'] },
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (candidates.length === 0) {
      return {
        allowed: !strictMode(),
        buildHash: this.buildHash,
        reason: 'no_matching_certificate',
      };
    }

    const matchesBuild = candidates.filter((c) => c.buildHash === this.buildHash);
    if (matchesBuild.length === 0) {
      return {
        allowed: !strictMode(),
        buildHash: this.buildHash,
        reason: 'build_hash_drift',
        certifiedBuildHash: candidates[0]?.buildHash,
      };
    }

    // Per-game RNG version: look up the plugin registered for this game and
    // compare certificates to its cert.rngVersion. If the game isn't registered
    // at all we still refuse (in strict mode) because an operator can't serve
    // an unknown game.
    const plugin = getPlugin(args.gameCode);
    if (!plugin) {
      return {
        allowed: !strictMode(),
        buildHash: this.buildHash,
        reason: 'no_matching_certificate',
      };
    }
    const liveRng = plugin.cert.rngVersion;
    // If the certificate declares an rngVersion, it must match. Null is
    // treated as "legacy, unspecified" — accepted for backfill but flagged.
    const rngMismatch = matchesBuild.find(
      (c) => c.rngVersion !== null && c.rngVersion !== liveRng,
    );
    if (rngMismatch) {
      return {
        allowed: !strictMode(),
        buildHash: this.buildHash,
        reason: 'rng_version_mismatch',
        certificateId: rngMismatch.id,
      };
    }

    const live = matchesBuild.find(
      (c) => c.revokedAt === null && c.expiresAt > now,
    );
    if (!live) {
      const expired = matchesBuild.find((c) => c.expiresAt <= now);
      const revoked = matchesBuild.find((c) => c.revokedAt !== null);
      if (revoked) {
        return {
          allowed: !strictMode(),
          buildHash: this.buildHash,
          reason: 'certificate_revoked',
          certificateId: revoked.id,
        };
      }
      if (expired) {
        return {
          allowed: !strictMode(),
          buildHash: this.buildHash,
          reason: 'certificate_expired',
          certificateId: expired.id,
          expiresAt: expired.expiresAt.toISOString(),
        };
      }
      return {
        allowed: !strictMode(),
        buildHash: this.buildHash,
        reason: 'no_matching_certificate',
      };
    }

    return {
      allowed: true,
      buildHash: this.buildHash,
      certificateId: live.id,
      certifiedBuildHash: live.buildHash,
      expiresAt: live.expiresAt.toISOString(),
    };
  }

  /**
   * Boot-time sweep: every ACTIVE, non-test operator, every game we know
   * about. Logs each gap individually, returns a summary. Promoted to a
   * hard block by RGS_CERT_STRICT=1.
   */
  async checkBoot(): Promise<{
    ok: number;
    blocked: number;
    strictMode: boolean;
  }> {
    const operators = await prisma.operator.findMany({
      where: { status: 'ACTIVE', testMode: false },
      select: { id: true, slug: true, jurisdiction: true },
    });
    let ok = 0;
    let blocked = 0;
    for (const op of operators) {
      const configs = await prisma.operatorGameConfig.findMany({
        where: { operatorId: op.id, enabled: true },
        select: { gameCode: true, currency: true },
      });
      for (const c of configs) {
        const r = await this.check({
          operatorId: op.id,
          gameCode: c.gameCode,
          jurisdiction: op.jurisdiction,
        });
        if (r.allowed && !r.reason) {
          ok += 1;
        } else {
          blocked += 1;
          logger.warn('build_attestation_gap', {
            operatorSlug: op.slug,
            gameCode: c.gameCode,
            currency: c.currency,
            jurisdiction: op.jurisdiction,
            reason: r.reason,
            certificateId: r.certificateId,
            liveBuildHash: r.buildHash,
            certifiedBuildHash: r.certifiedBuildHash,
          });
        }
      }
    }
    logger.info('build_attestation_boot_summary', {
      ok,
      blocked,
      strictMode: strictMode(),
    });
    return { ok, blocked, strictMode: strictMode() };
  }
}

export const buildAttestation = new BuildAttestation();
