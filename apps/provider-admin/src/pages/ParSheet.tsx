import { useEffect, useMemo, useState } from 'react';

// PAR-sheet viewer with hash pinning.
//
// Reads docs/par-sheet.json via the dev server's static serve. Computes
// SHA-256 of the file contents in the browser and displays it so a
// reviewer can diff against the `buildHash` on each certificate — the
// file's hash is what every GLI/BMM cert is anchored to. If this
// number changes without a corresponding new cert row, something has
// drifted outside the cert-change-management flow.

interface ParPayload {
  $schema?: string;
  game: {
    code: string;
    displayName: string;
    rngAlgorithm: string;
    rngSource: string;
    testVectorsSource: string;
  };
  faces: { LOW: number[]; HIGH: number[] };
  defaultConfig: {
    lowWeight: number;
    highWeight: number;
    payoutMultiplier: number;
    commissionMicroPerUnit: number;
    commissionFraction: number;
    bettingWindowMs: number;
    rollingWindowMs: number;
    cooldownMs: number;
  };
  probabilities?: {
    atDefaultConfig?: {
      P_LOW: number;
      P_HIGH: number;
      P_face_given_side: number;
      perFace: Record<string, number>;
    };
  };
}

// Dev fallback: try several locations. In production we ship the JSON
// next to the app as a static asset; in dev Vite serves from /src.
const PAR_LOCATIONS = [
  '/docs/par-sheet.json',
  '/par-sheet.json',
  '/src/par-sheet.json',
];

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function ParSheet() {
  const [par, setPar] = useState<ParPayload | null>(null);
  const [raw, setRaw] = useState<string>('');
  const [hash, setHash] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const loc of PAR_LOCATIONS) {
        try {
          const res = await fetch(loc);
          if (!res.ok) continue;
          const text = await res.text();
          if (cancelled) return;
          setRaw(text);
          setPar(JSON.parse(text));
          setSource(loc);
          setHash(await sha256Hex(text));
          return;
        } catch {
          /* try the next location */
        }
      }
      if (!cancelled) {
        setError(
          'par-sheet.json not found. Copy docs/par-sheet.json into the provider-admin public/ folder during deploy.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rtpComputed = useMemo(() => {
    if (!par) return null;
    const { lowWeight, highWeight, commissionFraction, payoutMultiplier } =
      par.defaultConfig;
    const total = lowWeight + highWeight;
    // P(win) across "pick a side, win if that side" is 0.5 when weights
    // are equal. We compute the true bettor RTP: payout × P(win) with
    // commission deducted.
    const pWin = 0.5;
    const rtp = (payoutMultiplier - payoutMultiplier * commissionFraction) * pWin;
    return {
      rtp,
      pLow: lowWeight / total,
      pHigh: highWeight / total,
    };
  }, [par]);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">PAR sheet</h1>
          <p className="page__subtitle">
            Certified probability &amp; RTP source. Any edit to this file must
            go through a new lab certification round.
          </p>
        </div>
      </header>

      {error ? <div className="banner banner--danger">{error}</div> : null}

      {par ? (
        <>
          <section className="card card--padded">
            <h2 className="card__title">File integrity</h2>
            <dl className="meta-grid">
              <dt>Source</dt>
              <dd>
                <code className="mono">{source}</code>
              </dd>
              <dt>Size</dt>
              <dd>{raw.length.toLocaleString()} bytes</dd>
              <dt>SHA-256</dt>
              <dd>
                <code className="mono" style={{ wordBreak: 'break-all' }}>
                  {hash}
                </code>
              </dd>
              <dt>RNG algorithm</dt>
              <dd>
                <code className="mono">{par.game.rngAlgorithm}</code>
              </dd>
              <dt>Source file</dt>
              <dd>
                <code className="mono">{par.game.rngSource}</code>
              </dd>
            </dl>
          </section>

          <section className="card card--padded">
            <h2 className="card__title">Theoretical RTP</h2>
            <dl className="meta-grid">
              <dt>LOW weight / HIGH weight</dt>
              <dd>
                {par.defaultConfig.lowWeight} / {par.defaultConfig.highWeight}
              </dd>
              <dt>P(LOW)</dt>
              <dd>
                <code className="mono">
                  {rtpComputed?.pLow.toFixed(6) ?? '—'}
                </code>
              </dd>
              <dt>P(HIGH)</dt>
              <dd>
                <code className="mono">
                  {rtpComputed?.pHigh.toFixed(6) ?? '—'}
                </code>
              </dd>
              <dt>Payout multiplier</dt>
              <dd>{par.defaultConfig.payoutMultiplier}×</dd>
              <dt>Commission fraction</dt>
              <dd>{(par.defaultConfig.commissionFraction * 100).toFixed(2)}%</dd>
              <dt>Computed RTP (bettor)</dt>
              <dd>
                <strong>
                  {rtpComputed ? (rtpComputed.rtp * 100).toFixed(3) : '—'}%
                </strong>
              </dd>
              <dt>House edge</dt>
              <dd>
                {rtpComputed
                  ? (100 - rtpComputed.rtp * 100).toFixed(3)
                  : '—'}%
              </dd>
            </dl>
          </section>

          <section className="card card--padded">
            <h2 className="card__title">Faces</h2>
            <div className="tag-row">
              <strong>LOW</strong>
              {par.faces.LOW.map((f) => (
                <code className="mono chip--tag" key={`l${f}`}>
                  {f}
                </code>
              ))}
            </div>
            <div className="tag-row" style={{ marginTop: 8 }}>
              <strong>HIGH</strong>
              {par.faces.HIGH.map((f) => (
                <code className="mono chip--tag" key={`h${f}`}>
                  {f}
                </code>
              ))}
            </div>
          </section>

          <section className="card card--padded">
            <h2 className="card__title">Raw JSON</h2>
            <pre className="mono" style={{ maxHeight: 400, overflow: 'auto' }}>
              {raw}
            </pre>
          </section>
        </>
      ) : null}
    </div>
  );
}
