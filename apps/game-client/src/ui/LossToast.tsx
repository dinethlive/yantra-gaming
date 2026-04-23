import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMountTransition } from '../hooks/useMountTransition';
import { formatMicroAmount, useGameStore } from '../store/gameStore';
import './LossToast.css';

const SHARD_INDICES = Array.from({ length: 8 }, (_, i) => i);

/**
 * Red card + falling shards shown briefly when the player's bet loses.
 * Mirrors WinToast so the UX is symmetric around round result.
 */
export const LossToast: React.FC = () => {
  const { t } = useTranslation();
  const lastLossMicro = useGameStore((s) => s.lastLossMicro);
  const currency = useGameStore((s) => s.config.currency);
  const [visible, setVisible] = useState(false);
  const [displayMicro, setDisplayMicro] = useState<bigint>(0n);

  useEffect(() => {
    if (lastLossMicro && lastLossMicro > 0n) {
      setDisplayMicro(lastLossMicro);
      setVisible(true);
    }
  }, [lastLossMicro]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(timer);
  }, [visible]);

  const { shouldRender, stage } = useMountTransition(visible, 400);

  if (!shouldRender) return null;

  return (
    <div className={`loss-toast ${stage === 'exiting' ? 'exiting' : ''}`}>
      <div className="loss-toast__card">
        <div className="loss-toast__shards">
          {SHARD_INDICES.map((i) => (
            <span
              key={i}
              className="loss-toast__shard"
              style={
                {
                  '--delay': `${i * 0.08}s`,
                  '--x-offset': `${-30 + Math.random() * 60}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>

        <div className="loss-toast__content">
          <span className="loss-toast__label">{t('game.youLost')}</span>
          <span className="loss-toast__amount">
            -{formatMicroAmount(displayMicro)} {currency}
          </span>
        </div>
      </div>
    </div>
  );
};
