import { prisma } from '../db.js';
import { logger } from '../logger.js';

// iGaming-native guardrail: every active, non-test operator's jurisdiction
// must be covered by a non-revoked, non-expired lab certificate for each
// game we serve them. We log at boot so an operations engineer notices the
// gap before the regulator does. Not fatal in dev (cert rows may be empty);
// a follow-up turn will promote this to a hard deploy-time block in prod.
export async function checkCertificateCoverage(): Promise<void> {
  const operators = await prisma.operator.findMany({
    where: { status: { not: 'TERMINATED' }, testMode: false },
    select: { id: true, slug: true, jurisdiction: true },
  });
  if (operators.length === 0) {
    logger.info('cert-coverage: no non-test operators to check');
    return;
  }

  const certs = await prisma.certificate.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    select: { gameCode: true, jurisdiction: true, expiresAt: true, buildHash: true },
  });
  const liveBuildHash = process.env.BUILD_HASH ?? null;

  const gameCodes = ['yantra'];
  let missing = 0;
  let expiring = 0;
  let buildMismatch = 0;

  for (const op of operators) {
    for (const gameCode of gameCodes) {
      const match = certs.find(
        (c) =>
          c.gameCode === gameCode &&
          (c.jurisdiction === op.jurisdiction || c.jurisdiction === 'MULTI'),
      );
      if (!match) {
        missing += 1;
        logger.warn('cert-coverage: missing certificate', {
          operator: op.slug,
          jurisdiction: op.jurisdiction,
          gameCode,
        });
        continue;
      }
      const daysLeft = Math.floor((match.expiresAt.getTime() - Date.now()) / 86_400_000);
      if (daysLeft < 60) {
        expiring += 1;
        logger.warn('cert-coverage: certificate expiring soon', {
          operator: op.slug,
          jurisdiction: op.jurisdiction,
          gameCode,
          daysLeft,
        });
      }
      if (liveBuildHash && match.buildHash !== liveBuildHash) {
        buildMismatch += 1;
        logger.warn('cert-coverage: build hash drift', {
          operator: op.slug,
          gameCode,
          liveBuildHash,
          certifiedBuildHash: match.buildHash,
        });
      }
    }
  }

  if (missing === 0 && expiring === 0 && buildMismatch === 0) {
    logger.info('cert-coverage: all active operators covered', {
      operatorCount: operators.length,
    });
  } else {
    logger.warn('cert-coverage: issues detected', { missing, expiring, buildMismatch });
  }
}
