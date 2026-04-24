// Per-game cert-packet exporter.
//
// Assembles a self-contained GLI-11 submission bundle for one registered
// game plugin. The packet contains everything a cert lab needs to
// independently re-derive outcomes and verify math — plugin source, per-game
// docs, machine-readable test vectors, shared RNG primitives, and a manifest
// pinning the exact rng-core commit the cert is issued against.
//
// Output format: a plain folder tree (so no runtime dependency on a zip
// library, and any platform can archive it with its native tooling).
//
// Usage:
//   bun scripts/export-cert-packet.ts <game-code>
//   bun scripts/export-cert-packet.ts ketapola-dice
//   bun scripts/export-cert-packet.ts crash-minimal --out /tmp/packets
//
// Output: <outDir>/<game-code>-cert-packet-<timestamp>/
//
// Exit codes:
//   0 — packet written successfully
//   1 — unknown game code (no directory at games/<code>/)
//   2 — required artefact missing (e.g. par-sheet.md, rng-spec.md)
//   3 — fatal I/O error
//
// Maintainer notes: the packet layout is DELIBERATELY flat and
// self-explanatory. A reviewer looking at the packet should not need to
// know about Bun, Prisma, or the wider monorepo — the numbered-prefix file
// names document a reading order, and source/ + platform/ are clearly
// grouped. The MANIFEST.json carries a SHA-256 per artefact so a reviewer
// can verify nothing was tampered with between export and review.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

interface Artefact {
  src: string;
  inPacket: string;
  bytes: number;
  sha256: string;
}

interface PacketManifest {
  gameCode: string;
  builtAt: string;
  rngCoreCommit: string;
  gameCommit: string;
  artefacts: Artefact[];
  notes: string[];
}

function main() {
  const [, , gameCode, ...rest] = process.argv;
  if (!gameCode) {
    console.error('Usage: bun scripts/export-cert-packet.ts <game-code> [--out <dir>]');
    process.exit(3);
  }

  const outIdx = rest.indexOf('--out');
  const outBase = outIdx >= 0 ? rest[outIdx + 1]! : 'cert-packets';

  const repoRoot = process.cwd();
  const gameDir = join(repoRoot, 'games', gameCode);
  if (!existsSync(gameDir)) {
    console.error(`Unknown game: ${gameCode}. No directory at games/${gameCode}/.`);
    process.exit(1);
  }

  const required = [
    `games/${gameCode}/docs/game-rules.md`,
    `games/${gameCode}/docs/par-sheet.md`,
    `games/${gameCode}/docs/par-sheet.json`,
    `games/${gameCode}/docs/rng-spec.md`,
    `games/${gameCode}/docs/rng-test-vectors.md`,
    `games/${gameCode}/src/outcome.ts`,
    `games/${gameCode}/src/settle.ts`,
    `games/${gameCode}/src/config.ts`,
    `games/${gameCode}/src/index.ts`,
    'packages/rng-core/src/index.ts',
    'docs/provably-fair.md',
    'docs/change-management.md',
  ];
  const missing = required.filter((p) => !existsSync(join(repoRoot, p)));
  if (missing.length) {
    console.error(`Missing required artefacts:\n  ${missing.join('\n  ')}`);
    process.exit(2);
  }

  const vectorsFixture = `games/${gameCode}/fixtures/rng-test-vectors.json`;
  const hasVectors = existsSync(join(repoRoot, vectorsFixture));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const packetDir = join(outBase, `${gameCode}-cert-packet-${timestamp}`);
  mkdirSync(packetDir, { recursive: true });

  const manifest: PacketManifest = {
    gameCode,
    builtAt: new Date().toISOString(),
    rngCoreCommit: safeGitSha(repoRoot, 'packages/rng-core/src'),
    gameCommit: safeGitSha(repoRoot, `games/${gameCode}/src`),
    artefacts: [],
    notes: [],
  };

  if (!hasVectors) {
    manifest.notes.push(
      `rng-test-vectors.json NOT INCLUDED — fixture missing at ${vectorsFixture}. ` +
        `Generate with "bun scripts/generate-test-vectors.ts ${gameCode}" before submission.`,
    );
  }
  if (manifest.rngCoreCommit === 'NO_GIT_HISTORY' || manifest.gameCommit === 'NO_GIT_HISTORY') {
    manifest.notes.push(
      'rng-core or game commit SHA is missing — repo does not appear to have git history. ' +
        'Initialize git and commit the source before submission so the packet can be pinned.',
    );
  }

  const entries: Array<{ src: string; inPacket: string }> = [
    { src: `games/${gameCode}/docs/game-rules.md`, inPacket: '01-game-rules.md' },
    { src: `games/${gameCode}/docs/par-sheet.md`, inPacket: '02-par-sheet.md' },
    { src: `games/${gameCode}/docs/par-sheet.json`, inPacket: '02-par-sheet.json' },
    { src: `games/${gameCode}/docs/rng-spec.md`, inPacket: '03-rng-spec.md' },
    { src: `games/${gameCode}/docs/rng-test-vectors.md`, inPacket: '04-rng-test-vectors.md' },
    { src: `games/${gameCode}/src/outcome.ts`, inPacket: 'source/game/outcome.ts' },
    { src: `games/${gameCode}/src/settle.ts`, inPacket: 'source/game/settle.ts' },
    { src: `games/${gameCode}/src/config.ts`, inPacket: 'source/game/config.ts' },
    { src: `games/${gameCode}/src/selection.ts`, inPacket: 'source/game/selection.ts' },
    { src: `games/${gameCode}/src/index.ts`, inPacket: 'source/game/index.ts' },
    { src: 'packages/rng-core/src/index.ts', inPacket: 'source/rng-core/index.ts' },
    { src: 'docs/provably-fair.md', inPacket: 'platform/provably-fair.md' },
    { src: 'docs/change-management.md', inPacket: 'platform/change-management.md' },
  ];
  if (hasVectors) {
    entries.push({ src: vectorsFixture, inPacket: '04-rng-test-vectors.json' });
  }

  for (const { src, inPacket } of entries) {
    const abs = join(repoRoot, src);
    if (!existsSync(abs)) continue; // selection.ts is optional
    const dest = join(packetDir, inPacket);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    manifest.artefacts.push({
      src,
      inPacket,
      bytes: statSync(abs).size,
      sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
    });
  }

  writeFileSync(join(packetDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(packetDir, 'README.md'), renderReadme(manifest, hasVectors));

  console.log(`Wrote ${packetDir}/`);
  console.log(`  artefacts:        ${manifest.artefacts.length}`);
  console.log(`  rng-core commit:  ${manifest.rngCoreCommit}`);
  console.log(`  game commit:      ${manifest.gameCommit}`);
  if (manifest.notes.length) {
    console.log('  notes:');
    for (const n of manifest.notes) console.log(`    - ${n}`);
  }
  console.log('\nNext steps:');
  console.log(`  cd "${outBase}" && zip -r "${gameCode}-cert-packet-${timestamp}.zip" "${gameCode}-cert-packet-${timestamp}"`);
}

function safeGitSha(repoRoot: string, relPath: string): string {
  try {
    const sha = execSync(`git -C "${repoRoot}" log -1 --format=%H -- "${relPath}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || 'NO_GIT_HISTORY';
  } catch {
    return 'NO_GIT_AVAILABLE';
  }
}

function renderReadme(m: PacketManifest, hasVectors: boolean): string {
  const lines = [
    `# Cert packet — ${m.gameCode}`,
    '',
    `Built: ${m.builtAt}`,
    '',
    `rng-core commit: \`${m.rngCoreCommit}\``,
    `game commit:     \`${m.gameCommit}\``,
    '',
    '## Packet layout',
    '',
    '- `01-game-rules.md` — authoritative rules',
    '- `02-par-sheet.md` + `02-par-sheet.json` — math, RTP, volatility',
    '- `03-rng-spec.md` — RNG derivation pinned against the rng-core commit above',
    hasVectors
      ? '- `04-rng-test-vectors.md` + `04-rng-test-vectors.json` — fixed input/output tuples'
      : '- `04-rng-test-vectors.md` — TBD, regenerate before submission',
    '- `source/game/` — plugin source under test',
    '- `source/rng-core/` — shared commit-reveal primitives',
    '- `platform/provably-fair.md` — shared scheme specification',
    '- `platform/change-management.md` — re-cert policy',
    '- `MANIFEST.json` — every artefact with size + SHA-256',
  ];
  if (m.notes.length) {
    lines.push('', '## Notes', '', ...m.notes.map((n) => `- ${n}`));
  }
  return lines.join('\n') + '\n';
}

main();
