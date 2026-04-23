import type React from 'react';
import { useGameStore } from '../store/gameStore';

const OUTCOME_DOT_CLASS: Record<'LOW' | 'HIGH', string> = {
  LOW: 'round-info__dot round-info__dot--low',
  HIGH: 'round-info__dot round-info__dot--high',
};

/**
 * Countdown timer + current round nonce + last 5 outcomes strip.
 * All values come straight from the gameStore (server-driven).
 */
export const RoundInfo: React.FC = () => {
  const timeRemaining = useGameStore((s) => s.timeRemaining);
  const roundState = useGameStore((s) => s.roundState);
  const nonce = useGameStore((s) => s.nonce);
  const history = useGameStore((s) => s.betHistory);

  const seconds = Math.max(0, Math.ceil(timeRemaining));
  const last5 = history.slice(-5);

  return (
    <div className="round-info">
      <div className="round-info__meta">
        <span className="round-info__phase">{roundState.replace(/_/g, ' ')}</span>
        <span className="round-info__timer">{seconds}s</span>
        <span className="round-info__nonce">#{nonce}</span>
      </div>
      <div className="round-info__history" aria-label="Last 5 outcomes">
        {last5.length === 0 ? (
          <span className="round-info__history-empty">—</span>
        ) : (
          last5.map((entry) => (
            <span
              key={entry.roundId}
              className={OUTCOME_DOT_CLASS[entry.side]}
              title={`${entry.side} · sum ${entry.sum}`}
            >
              {entry.sum}
            </span>
          ))
        )}
      </div>
    </div>
  );
};
