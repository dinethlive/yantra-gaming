import type React from 'react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { sideClass } from '../utils/sideClass';
import { DiceFace } from './DiceFace';
import './HistoryOrbs.css';

/**
 * Renders the last N round outcomes as a compact list. Data comes from the
 * game store's `betHistory`, which is appended by useSocket on every
 * `round_state` / `round_result` event that carries a settled outcome.
 */
export const HistoryOrbs: React.FC = () => {
  const { t } = useTranslation();
  const betHistory = useGameStore((s) => s.betHistory);
  const reversed = [...betHistory].reverse();

  return (
    <div className="history-list">
      <div className="history-list__label">{t('history.title')}</div>

      {reversed.length === 0 && <span className="history-list__empty">--</span>}

      {reversed.length > 0 && (
        <>
          <div className="history-list__header">
            <span className="history-list__header-cell history-list__header-cell--round">
              {t('history.round')}
            </span>
            <span className="history-list__header-cell history-list__header-cell--dice">
              {t('history.dice')}
            </span>
            <span className="history-list__header-cell history-list__header-cell--sum">
              {t('history.sum')}
            </span>
            <span className="history-list__header-cell history-list__header-cell--side">
              {t('history.side')}
            </span>
          </div>

          <div className="history-list__rows">
            {reversed.map((entry) => {
              const variant = entry.side.toLowerCase() as 'low' | 'high';
              return (
                <div key={entry.roundId} className={`history-list__row ${sideClass(entry.side)}`}>
                  <span className="history-list__round">#{entry.roundNumber ?? '—'}</span>

                  <div className="history-list__dice">
                    {entry.diceValues && entry.diceValues.length > 0 ? (
                      entry.diceValues.map((v, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: dice array is fixed-length and immutable once rolled
                        <DiceFace key={i} value={v} size="sm" variant={variant} />
                      ))
                    ) : (
                      <span className="history-list__dice-fallback">{entry.sum}</span>
                    )}
                  </div>

                  <span className="history-list__sum">{entry.sum}</span>

                  <span className={`history-list__side-badge ${sideClass(entry.side)}`}>
                    {entry.side}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
