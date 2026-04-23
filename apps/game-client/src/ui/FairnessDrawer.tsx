import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { proofUrl } from '../api/client';
import { useGameStore } from '../store/gameStore';
import './FairnessDrawer.css';

interface FairnessDrawerProps {
  open: boolean;
  onClose: () => void;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Provably-fair side drawer (desktop) / bottom sheet (mobile). Shows the
 * current round's committed serverSeedHash. When the round settles and
 * the serverSeed is revealed, verifies the commitment client-side.
 * The B2C "Verify any round by ID" calculator is deferred — needs an
 * `/api/game` helper + outcome-recomputation util we haven't ported yet.
 */
export const FairnessDrawer: React.FC<FairnessDrawerProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const serverSeedHash = useGameStore((s) => s.serverSeedHash);
  const serverSeed = useGameStore((s) => s.serverSeed);
  const roundId = useGameStore((s) => s.roundId);
  const roundState = useGameStore((s) => s.roundState);
  const nonce = useGameStore((s) => s.nonce);

  const [copied, setCopied] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    if (!serverSeed || !serverSeedHash) {
      setVerified(null);
      return;
    }
    sha256Hex(serverSeed).then((hash) => setVerified(hash === serverSeedHash));
  }, [serverSeed, serverSeedHash]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const copyHash = () => {
    if (!serverSeedHash) return;
    navigator.clipboard.writeText(serverSeedHash).catch(() => {});
    setCopied(true);
  };

  const isRevealed = !!serverSeed;
  const isActive = roundState === 'BETTING_OPEN' || roundState === 'ROLLING';

  return (
    <div
      className={`fairness-backdrop ${open ? 'open' : ''}`}
      onClick={handleBackdrop}
      aria-hidden={!open}
    >
      <div className={`fairness-drawer ${open ? 'open' : ''}`}>
        <div className="fairness-drawer__handle" />

        <div className="fairness-drawer__header">
          <div className="fairness-drawer__title-row">
            <div className="fairness-drawer__icon-wrap">
              <svg
                aria-hidden="true"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>Provably fair</title>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div>
              <h2 className="fairness-drawer__title">{t('fairness.title')}</h2>
              <span className="fairness-drawer__subtitle">{t('fairness.subtitle')}</span>
            </div>
          </div>
          <button
            type="button"
            className="fairness-drawer__close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <title>Close</title>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="fairness-drawer__body">
          <div className="fairness-section">
            <h3 className="fairness-section__title">{t('fairness.currentRound')}</h3>
            {serverSeedHash ? (
              <div className="fairness-hash-card">
                <div className="fairness-hash-card__label">
                  {t('fairness.serverSeedHash')}
                  {nonce > 0 && <span className="fairness-hash-card__round">#{nonce}</span>}
                </div>
                <div className="fairness-hash-card__value">
                  <code className="fairness-hash-card__hash font-numbers">{serverSeedHash}</code>
                  <button type="button" className="fairness-hash-card__copy" onClick={copyHash}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="fairness-hash-card__note">
                  {isActive
                    ? t('fairness.commitment')
                    : isRevealed
                      ? t('fairness.seedRevealed')
                      : t('fairness.roundInProgress')}
                </p>

                {isRevealed && (
                  <div className="fairness-reveal">
                    <div className="fairness-reveal__label">Server Seed</div>
                    <code className="fairness-reveal__seed font-numbers">{serverSeed}</code>
                    <div
                      className={`fairness-reveal__status ${
                        verified ? 'verified' : verified === false ? 'failed' : ''
                      }`}
                    >
                      {verified === true && (
                        <>
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <title>Verified</title>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          {t('fairness.verified')}
                        </>
                      )}
                      {verified === false && (
                        <>
                          <svg
                            aria-hidden="true"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <title>Mismatch</title>
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                          Hash Mismatch
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="fairness-section__empty">{t('fairness.waitingForRound')}</p>
            )}
          </div>

          <div className="fairness-section">
            <h3 className="fairness-section__title">{t('fairness.howItWorks')}</h3>
            <div className="fairness-steps">
              <div className="fairness-step">
                <span className="fairness-step__num">1</span>
                <p className="fairness-step__text">{t('fairness.step1')}</p>
              </div>
              <div className="fairness-step">
                <span className="fairness-step__num">2</span>
                <p className="fairness-step__text">{t('fairness.step2')}</p>
              </div>
              <div className="fairness-step">
                <span className="fairness-step__num">3</span>
                <p className="fairness-step__text">{t('fairness.step3')}</p>
              </div>
            </div>
          </div>

          {roundId && (
            <a
              className="fairness-drawer__cta"
              href={proofUrl(roundId)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                aria-hidden="true"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>Open proof</title>
                <path d="M14 3h7v7" />
                <path d="M10 14L21 3" />
                <path d="M21 14v7H3V3h7" />
              </svg>
              {t('fairness.verifyRound')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
