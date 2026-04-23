# RNG Test Vectors: Crash Minimal

> **Submission status:** TBD. Vectors have not been generated yet. Run
> `bun scripts/generate-test-vectors.ts crash-minimal` before GLI-11
> submission; the script must write byte-identical output on every run
> (enforced by `tests/games/crash-minimal/rng-test-vectors.spec.ts` once
> the vectors exist).

Fixed `(serverSeed, clientSeed, nonce, houseEdge, maxMultiplier)` →
`(crashMultiplier, u)` triples for Crash Minimal. A cert lab, operator, or
independent reviewer can recompute these locally and compare bit-for-bit.
Drift from this table invalidates the conceptual RNG certification for
this game.

The machine-readable form will live at `../fixtures/rng-test-vectors.json`
(co-located with the test harness, generated before cert submission). The canonical code under test is split
across [`packages/rng-core/src/index.ts`](../../../packages/rng-core/src/index.ts)
(shared primitives) and
[`games/crash-minimal/src/outcome.ts`](../src/outcome.ts) (game-specific
mapping). The vectors are regression-tested by
`tests/games/crash-minimal/rng-test-vectors.spec.ts` (TBD) on every CI
run.

## Verification

```js
import crypto from 'node:crypto';

function verifyCrash({ serverSeed, clientSeed, nonce, houseEdge, maxMultiplier }) {
  const hmac = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const bits52 = BigInt(`0x${hmac.slice(0, 13)}`);
  const max = 1n << 52n;
  const uRaw = Number(bits52) / Number(max);

  if (uRaw < houseEdge) return { crashMultiplier: 1.0, u: uRaw };

  const u = (uRaw - houseEdge) / (1 - houseEdge);
  const raw = Math.floor(100 / (1 - u)) / 100;
  const crashMultiplier = Math.min(Math.max(1.0, raw), maxMultiplier);
  return { crashMultiplier, u: uRaw };
}
```

## Vectors

_TBD, generate with `scripts/generate-test-vectors.ts crash-minimal`.
The table below is a stub showing the expected shape._

| # | serverSeed (hex) | clientSeed | nonce | houseEdge | maxMultiplier | → crashMultiplier | u |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0000…0000` | `client-seed-a` | 0 | 0.01 | 1000 | TBD | TBD |
| 2 | `0000…0000` | `client-seed-a` | 1 | 0.01 | 1000 | TBD | TBD |

## Regenerating

```bash
bun scripts/generate-test-vectors.ts crash-minimal > games/crash-minimal/fixtures/rng-test-vectors.json
```

Rerunning this must produce byte-identical output. A diff indicates the
RNG or mapping has changed and requires a `CERT-ATTEST-CRASH_MINIMAL:` line
on the PR (enforced by the `rng-change-gate` CI job).
