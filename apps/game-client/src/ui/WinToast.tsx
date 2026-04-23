import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMountTransition } from '../hooks/useMountTransition';
import { formatMicroAmount, useGameStore } from '../store/gameStore';
import './WinToast.css';

const PARTICLE_INDICES = Array.from({ length: 12 }, (_, i) => i);

/**
 * Gold card + particle burst shown briefly when the player's bet wins.
 * Reads `lastWinMicro` from the game store — the store itself clears it
 * when the next round opens, so we only need to handle our own dismiss.
 */
export const WinToast: React.FC = () => {
  const { t } = useTranslation();
  const lastWinMicro = useGameStore((s) => s.lastWinMicro);
  const currency = useGameStore((s) => s.config.currency);
  const [visible, setVisible] = useState(false);
  const [displayMicro, setDisplayMicro] = useState<bigint>(0n);

  useEffect(() => {
    if (lastWinMicro && lastWinMicro > 0n) {
      setDisplayMicro(lastWinMicro);
      setVisible(true);
    }
  }, [lastWinMicro]);

  // Auto-dismiss lives in its own effect so store changes can't cancel it.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [visible]);

  const { shouldRender, stage } = useMountTransition(visible, 400);

  if (!shouldRender) return null;

  return (
    <div className={`win-toast ${stage === 'exiting' ? 'exiting' : ''}`}>
      <div className="win-toast__card">
        <div className="win-toast__particles">
          {PARTICLE_INDICES.map((i) => (
            <span
              key={i}
              className="win-toast__particle"
              style={
                {
                  '--delay': `${i * 0.1}s`,
                  '--angle': `${(i / 12) * 360}deg`,
                  '--distance': `${60 + Math.random() * 40}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>

        <div className="win-toast__content">
          <span className="win-toast__label">{t('game.youWon')}</span>
          <span className="win-toast__amount">
            +{formatMicroAmount(displayMicro)} {currency}
          </span>
        </div>
      </div>
    </div>
  );
};
