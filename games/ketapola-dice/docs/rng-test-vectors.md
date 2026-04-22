# RNG Test Vectors: Ketapola Dice

Fixed `(serverSeed, clientSeed, nonce, lowWeight, highWeight)` → `(outcomeSide, outcomeSum)` triples for the Ketapola Dice game. A cert lab, operator, or independent reviewer can recompute these locally and compare bit-for-bit. Drift from this table invalidates the conceptual RNG certification for this game.

The machine-readable form is [`../fixtures/rng-test-vectors.json`](../fixtures/rng-test-vectors.json) (co-located with the test harness so Bun-test and the cert packet read the same bytes). The canonical code under test is split across [`packages/rng-core/src/index.ts`](../../../packages/rng-core/src/index.ts) (shared primitives) and [`games/ketapola-dice/src/outcome.ts`](../src/outcome.ts) (game-specific mapping). The vectors are regression-tested by [`tests/games/ketapola-dice/rng-test-vectors.spec.ts`](../../../tests/games/ketapola-dice/rng-test-vectors.spec.ts) on every CI run.

## Verification (20 lines of JS)

```js
import crypto from 'node:crypto';

function verify({ serverSeed, clientSeed, nonce, lowWeight, highWeight }) {
  const hmac = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const sideValue = parseInt(hmac.slice(0, 8), 16);
  const threshold = (lowWeight / (lowWeight + highWeight)) * 0xffffffff;
  const side = sideValue < threshold ? 'LOW' : 'HIGH';
  const faceValue = parseInt(hmac.slice(8, 16), 16);
  const faces = side === 'LOW' ? [3, 6, 9] : [12, 15, 18];
  const sum = faces[faceValue % faces.length];
  return { outcomeSide: side, outcomeSum: sum };
}
```

## Vectors: symmetric weights (48, 48)

| # | serverSeed (hex) | clientSeed | nonce | → side | sum |
| - | --- | --- | --- | --- | --- |
| 1 | `0000…0000` | `client-seed-a` | 0 | LOW | 3 |
| 2 | `0000…0000` | `client-seed-a` | 1 | LOW | 3 |
| 3 | `0000…0000` | `client-seed-a` | 2 | LOW | 3 |
| 4 | `ffff…ffff` | `client-seed-b` | 0 | LOW | 9 |
| 5 | `deadbeefcafef00d0000000000000000000000000000000000000000deadbeef` | `operator-provided` | 0 | LOW | 9 |
| 6 | `deadbeefcafef00d0000000000000000000000000000000000000000deadbeef` | `operator-provided` | 100 | HIGH | 15 |
| 7 | `deadbeefcafef00d0000000000000000000000000000000000000000deadbeef` | `operator-provided` | 1,000,000 | HIGH | 15 |

## Vectors: asymmetric weights

| # | (low, high) | serverSeed (hex) | clientSeed | nonce | → side | sum |
| - | --- | --- | --- | --- | --- | --- |
| 8 | (60, 40) | `1111…1111` | `asymmetric-low` | 0 | LOW | 6 |
| 9 | (60, 40) | `1111…1111` | `asymmetric-low` | 1 | LOW | 9 |
| 10 | (40, 60) | `2222…2222` | `asymmetric-high` | 0 | HIGH | 18 |

## Vectors: edge cases

| # | input property | → side | sum |
| - | --- | --- | --- |
| 11 | 76-byte clientSeed (`a-much-longer-client-seed-that-exceeds-the-default-16-bytes-by-a-wide-margin`) with `3333…3333` seed | LOW | 6 |
| 12 | UTF-8 clientSeed (Sinhala `කැටපොල`) with `4444…4444` seed | HIGH | 12 |

## Full seeds (for copy-paste)

The `0000…0000`, `ffff…ffff`, `1111…1111`, `2222…2222`, `3333…3333`, `4444…4444` seeds in the tables above are each 32 bytes of the same hex character repeated. The single non-trivial seed in full:

```
deadbeefcafef00d0000000000000000000000000000000000000000deadbeef
```

## Regenerating

These vectors are produced by `scripts/generate-test-vectors.ts`. Rerunning that script must produce byte-identical output, if it does not, the RNG has changed and requires a `CERT-ATTEST:` line on the PR (enforced by the `rng-change-gate` CI job).

```bash
bun scripts/generate-test-vectors.ts > /tmp/actual.json
diff games/ketapola-dice/fixtures/rng-test-vectors.json /tmp/actual.json   # must be empty
```
