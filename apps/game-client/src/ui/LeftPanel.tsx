import type React from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { sideClass } from '../utils/sideClass';
import { DiceFace } from './DiceFace';
import { HistoryOrbs } from './HistoryOrbs';
import './LeftPanel.css';
import { RgLimitsPanel } from './RgLimitsPanel';

/**
 * Desktop-only sidebar: last round result + history + hot-streak indicator +
 * the RG-limits panel. Hidden under 1024px — `InfoSheet` carries the same
 * content on mobile, opened from the Header button.
 */
export const LeftPanel: React.FC = () => {
  const { t } = useTranslation();
  const betHistory = useGameStore((s) => s.betHistory);

  const lastResult = betHistory.length > 0 ? betHistory[betHistory.length - 1] : null;

  const streak = useMemo(() => {
    if (betHistory.length === 0) return { count: 0, side: null as string | null };
    const last = betHistory[betHistory.length - 1]!.side;
    let count = 0;
    for (let i = betHistory.length - 1; i >= 0; i--) {
      if (betHistory[i]!.side === last) count++;
      else break;
    }
    return { count, side: last };
  }, [betHistory]);

  return (
    <aside className="left-panel">
      <div className="left-panel__pane">
        <div className="left-panel__section">
          <div className="left-panel__section-title">{t('history.lastResult')}</div>
          {lastResult ? (
            <div className={`left-panel__last-result ${sideClass(lastResult.side)}`}>
              {lastResult.diceValues && lastResult.diceValues.length > 0 && (
                <div className="left-panel__dice-row">
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
              <div className="left-panel__result-info">
                <span className="left-panel__last-sum">{lastResult.sum}</span>
                <span className="left-panel__last-side">{lastResult.side}</span>
              </div>
            </div>
          ) : (
            <div className="left-panel__last-result empty">
              <span className="left-panel__last-side">--</span>
            </div>
          )}
        </div>

        <div className="left-panel__section">
          <HistoryOrbs />
        </div>

        {streak.count >= 2 && streak.side && (
          <div className="left-panel__section">
            <div className="left-panel__section-title">{t('history.hotStreak', 'Hot Streak')}</div>
            <div className={`left-panel__streak ${sideClass(streak.side)}`}>
              <span className="left-panel__streak-icon">{streak.side === 'LOW' ? '~' : '^'}</span>
              <span className="left-panel__streak-count">
                {t('history.consecutive', { count: streak.count, defaultValue: `{{count}} in a row` })}
              </span>
            </div>
          </div>
        )}

        <div className="left-panel__section">
          <RgLimitsPanel />
        </div>
      </div>
    </aside>
  );
};
