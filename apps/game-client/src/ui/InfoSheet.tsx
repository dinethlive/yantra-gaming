import type React from 'react';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { sideClass } from '../utils/sideClass';
import { DiceFace } from './DiceFace';
import { HistoryOrbs } from './HistoryOrbs';
import './InfoSheet.css';
import { RgLimitsPanel } from './RgLimitsPanel';

// Bottom-sheet modal. Same content as LeftPanel (which is hidden <1024px)
// plus the RG-limits panel. Opens from a button in the Header on mobile.

interface InfoSheetProps {
  open: boolean;
  onClose: () => void;
}

export const InfoSheet: React.FC<InfoSheetProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const betHistory = useGameStore((s) => s.betHistory);
  const lastResult = betHistory.length > 0 ? betHistory[betHistory.length - 1] : null;

  const onBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Lock background scroll while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div
      className={`info-sheet-backdrop ${open ? 'open' : ''}`}
      onClick={onBackdrop}
      aria-hidden={!open}
    >
      <div
        className={`info-sheet ${open ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('info.sheetLabel', { defaultValue: 'Game info' })}
      >
        <div className="info-sheet__handle" aria-hidden="true" />

        <button
          type="button"
          className="info-sheet__close"
          onClick={onClose}
          aria-label={t('info.close', { defaultValue: 'Close' })}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="info-sheet__body">
          <div className="info-sheet__section">
            <div className="info-sheet__section-title">
              {t('history.lastResult', { defaultValue: 'Last result' })}
            </div>
            {lastResult ? (
              <div className={`info-sheet__last-result ${sideClass(lastResult.side)}`}>
                {lastResult.diceValues && lastResult.diceValues.length > 0 && (
                  <div className="info-sheet__dice-row">
                    {lastResult.diceValues.map((v, i) => (
                      <DiceFace
                        // biome-ignore lint/suspicious/noArrayIndexKey: dice array is fixed-length and immutable once rolled
                        key={i}
                        value={v}
                        size="md"
                        variant={lastResult.side.toLowerCase() as 'low' | 'high'}
                      />
                    ))}
                  </div>
                )}
                <div className="info-sheet__result-info">
                  <span className="info-sheet__last-sum">{lastResult.sum}</span>
                  <span className="info-sheet__last-side">{lastResult.side}</span>
                </div>
              </div>
            ) : (
              <div className="info-sheet__last-result empty">
                <span className="info-sheet__last-side">--</span>
              </div>
            )}
          </div>

          <div className="info-sheet__section">
            <div className="info-sheet__section-title">
              {t('history.recent', { defaultValue: 'Recent rounds' })}
            </div>
            <HistoryOrbs />
          </div>

          <div className="info-sheet__section">
            <RgLimitsPanel />
          </div>
        </div>
      </div>
    </div>
  );
};
