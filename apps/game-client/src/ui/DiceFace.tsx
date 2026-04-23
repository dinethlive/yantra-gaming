import type React from 'react';
import { getPipPositions } from '../game/diceConstants';
import './DiceFace.css';

const SIZE_PX = { sm: 22, md: 40 };

function pipDiameter(value: number, sizePx: number): number {
  const radius =
    value <= 3
      ? sizePx * 0.09
      : value <= 6
        ? sizePx * 0.075
        : value <= 9
          ? sizePx * 0.065
          : value <= 12
            ? sizePx * 0.055
            : sizePx * 0.048;
  return Math.max(1.5, radius * 2);
}

interface DiceFaceProps {
  value: number;
  size?: 'sm' | 'md';
  variant?: 'low' | 'high' | 'neutral';
}

export const DiceFace: React.FC<DiceFaceProps> = ({ value, size = 'md', variant = 'neutral' }) => {
  const positions = getPipPositions(value);
  const d = pipDiameter(value, SIZE_PX[size]);

  return (
    <div className={`dice-face dice-face--${size} dice-face--${variant}`}>
      <div className="dice-face__face">
        {positions.map(([fx, fy]) => (
          <div
            key={`${fx}-${fy}`}
            className="dice-face__pip"
            style={{
              left: `${fx * 100}%`,
              top: `${fy * 100}%`,
              width: d,
              height: d,
            }}
          />
        ))}
      </div>
    </div>
  );
};
