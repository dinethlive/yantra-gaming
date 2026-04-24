import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// Provably-fair proof viewer.
//
// Recomputes the Yantra outcome entirely in the browser. This is the
// same HMAC-SHA256 commit-reveal construction used by the server (see
// apps/rgs-server/src/utils/rng.ts). The point is INDEPENDENT
// verification — a regulator or operator pastes the server+client seeds
// and nonce from `GET /v1/rounds/:id/proof` and confirms the outcome
// without trusting our backend.

const LOW_FACES = [3, 6, 9];
const HIGH_FACES = [12, 15, 18];

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface ComputeResult {
  hmacHex: string;
  sideHex: string;
  sideInt: number;
  threshold: number;
  side: 'LOW' | 'HIGH';
  faceHex: string;
  faceInt: number;
  faceIndex: number;
  outcomeSum: number;
}

async function compute(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  lowWeight: number,
  highWeight: number,
): Promise<ComputeResult> {
  const message = `${clientSeed}:${nonce}`;
  const hmacHex = await hmacSha256Hex(serverSeed, message);
  const sideHex = hmacHex.slice(0, 8);
  const sideInt = Number.parseInt(sideHex, 16);
  const totalWeight = lowWeight + highWeight;
  const threshold = (lowWeight / totalWeight) * 0xffffffff;
  const side: 'LOW' | 'HIGH' = sideInt < threshold ? 'LOW' : 'HIGH';
  const faceHex = hmacHex.slice(8, 16);
  const faceInt = Number.parseInt(faceHex, 16);
  const faces = side === 'LOW' ? LOW_FACES : HIGH_FACES;
  const faceIndex = faceInt % faces.length;
  const outcomeSum = faces[faceIndex]!;
  return {
    hmacHex,
    sideHex,
    sideInt,
    threshold,
    side,
    faceHex,
    faceInt,
    faceIndex,
    outcomeSum,
  };
}

export function ProofViewer() {
  const [params] = useSearchParams();
  const [serverSeed, setServerSeed] = useState(params.get('serverSeed') ?? '');
  const [clientSeed, setClientSeed] = useState(params.get('clientSeed') ?? '');
  const [nonce, setNonce] = useState(Number(params.get('nonce') ?? '0') || 0);
  const [lowWeight, setLowWeight] = useState(48);
  const [highWeight, setHighWeight] = useState(48);
  const [expectedSide, setExpectedSide] = useState<'' | 'LOW' | 'HIGH'>('');
  const [expectedSum, setExpectedSum] = useState<number | ''>('');
  const [result, setResult] = useState<ComputeResult | null>(null);
  const [seedHash, setSeedHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canCompute = useMemo(
    () =>
      serverSeed.trim().length > 0 &&
      clientSeed.trim().length > 0 &&
      Number.isFinite(nonce) &&
      nonce >= 0 &&
      lowWeight > 0 &&
      highWeight > 0,
    [serverSeed, clientSeed, nonce, lowWeight, highWeight],
  );

  useEffect(() => {
    if (!serverSeed.trim()) {
      setSeedHash(null);
      return;
    }
    sha256Hex(serverSeed.trim()).then(setSeedHash);
  }, [serverSeed]);

  async function runCompute() {
    setErr(null);
    try {
      const r = await compute(
        serverSeed.trim(),
        clientSeed.trim(),
        nonce,
        lowWeight,
        highWeight,
      );
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const matches =
    result && expectedSide && expectedSum !== ''
      ? result.side === expectedSide && result.outcomeSum === Number(expectedSum)
      : null;

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Provably-fair proof viewer</h1>
          <p className="page__subtitle">
            Independent HMAC-SHA256 recompute. The browser does the work — no
            data is sent to the server. Paste the seed pair + nonce from{' '}
            <code className="mono">GET /v1/rounds/:id/proof</code> and confirm
            the same outcome the engine committed to.
          </p>
        </div>
      </header>

      <section className="card card--padded">
        <h2 className="card__title">Inputs</h2>
        <div className="form-grid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Server seed (revealed)</span>
            <input
              type="text"
              className="input mono"
              value={serverSeed}
              onChange={(e) => setServerSeed(e.target.value)}
              placeholder="64-char hex"
            />
            {seedHash ? (
              <em className="field__hint mono">
                sha256 = {seedHash}
              </em>
            ) : null}
          </label>
          <label className="field">
            <span>Client seed</span>
            <input
              className="input mono"
              value={clientSeed}
              onChange={(e) => setClientSeed(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Nonce</span>
            <input
              type="number"
              className="input mono"
              value={nonce}
              onChange={(e) => setNonce(Number(e.target.value))}
              min={0}
            />
          </label>
          <label className="field">
            <span>Low weight</span>
            <input
              type="number"
              className="input"
              value={lowWeight}
              onChange={(e) => setLowWeight(Number(e.target.value))}
              min={1}
            />
          </label>
          <label className="field">
            <span>High weight</span>
            <input
              type="number"
              className="input"
              value={highWeight}
              onChange={(e) => setHighWeight(Number(e.target.value))}
              min={1}
            />
          </label>
          <label className="field">
            <span>Expected side (optional)</span>
            <select
              className="input"
              value={expectedSide}
              onChange={(e) =>
                setExpectedSide(e.target.value as '' | 'LOW' | 'HIGH')
              }
            >
              <option value="">(no assertion)</option>
              <option value="LOW">LOW</option>
              <option value="HIGH">HIGH</option>
            </select>
          </label>
          <label className="field">
            <span>Expected sum (optional)</span>
            <input
              type="number"
              className="input"
              value={expectedSum}
              onChange={(e) =>
                setExpectedSum(
                  e.target.value === '' ? '' : Number(e.target.value),
                )
              }
            />
          </label>
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={runCompute}
            disabled={!canCompute}
          >
            Compute
          </button>
        </div>
        {err ? <div className="banner banner--danger">{err}</div> : null}
      </section>

      {result ? (
        <section className="card card--padded">
          <h2 className="card__title">Recomputation trace</h2>
          <dl className="meta-grid">
            <dt>Message</dt>
            <dd>
              <code className="mono">
                {clientSeed}:{nonce}
              </code>
            </dd>
            <dt>HMAC-SHA256 (hex)</dt>
            <dd>
              <code className="mono" style={{ wordBreak: 'break-all' }}>
                {result.hmacHex}
              </code>
            </dd>
            <dt>Side slice (bytes 0–3)</dt>
            <dd>
              <code className="mono">{result.sideHex}</code> →{' '}
              <code className="mono">{result.sideInt}</code>
            </dd>
            <dt>Threshold</dt>
            <dd>
              <code className="mono">
                ({lowWeight} / {lowWeight + highWeight}) × 0xffffffff ={' '}
                {Math.floor(result.threshold)}
              </code>
            </dd>
            <dt>Side decision</dt>
            <dd>
              {result.sideInt} {'<'} {Math.floor(result.threshold)} →{' '}
              <strong>{result.side}</strong>
            </dd>
            <dt>Face slice (bytes 4–7)</dt>
            <dd>
              <code className="mono">{result.faceHex}</code> →{' '}
              <code className="mono">{result.faceInt}</code> mod{' '}
              {result.side === 'LOW' ? LOW_FACES.length : HIGH_FACES.length} ={' '}
              <code className="mono">{result.faceIndex}</code>
            </dd>
            <dt>Outcome</dt>
            <dd>
              <span
                className={`chip chip--${result.side === 'LOW' ? 'suspended' : 'active'}`}
              >
                {result.side}
              </span>{' '}
              = <strong>{result.outcomeSum}</strong>
            </dd>
            {matches !== null ? (
              <>
                <dt>Assertion</dt>
                <dd>
                  {matches ? (
                    <span className="chip chip--active">MATCH</span>
                  ) : (
                    <span className="chip chip--warning">MISMATCH</span>
                  )}
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
