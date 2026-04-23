import type React from 'react';
import { useTranslation } from 'react-i18next';
import { formatMicroAmount, useGameStore } from '../store/gameStore';
import './Header.css';

interface HeaderProps {
  /** Called when the mobile info button is tapped — opens the InfoSheet. */
  onInfoClick?: () => void;
}

/**
 * B2B-flavoured top bar: wordmark + round badge + socket connection dot +
 * balance chip. Deliberately no profile menu, no wallet switcher, no logout:
 * the player's identity lives at the operator. Logout is an operator-driven
 * postMessage event handled in App.tsx.
 *
 * On mobile (<1024px, CSS-controlled) a small "i" button appears next to the
 * logo and opens the InfoSheet — mirrors the LeftPanel content.
 */
export const Header: React.FC<HeaderProps> = ({ onInfoClick }) => {
  const { t } = useTranslation();
  const roundNumber = useGameStore((s) => s.roundNumber);
  const roundId = useGameStore((s) => s.roundId);
  const isConnected = useGameStore((s) => s.isConnected);
  const balanceMicro = useGameStore((s) => s.balanceMicro);
  const currency = useGameStore((s) => s.config.currency);

  return (
    <header className="header">
      <div className="header__left">
        <span className="header__logo">{t('app.name', 'KETAPOLA')}</span>
        {roundId && roundNumber > 0 ? (
          <div className="header__round-badge">
            <span className="header__round-label">{t('game.roundId')}</span>
            <span className="header__round-id">#{roundNumber}</span>
          </div>
        ) : null}
        <div className={`header__connection ${isConnected ? 'connected' : 'disconnected'}`}>
          <span className="header__connection-dot" />
        </div>
      </div>

      <div className="header__right">
        <div className="header__balance">
          <span className="header__balance-label">{t('game.balance')}</span>
          <span className="header__balance-value">
            <span className="font-numbers">{formatMicroAmount(balanceMicro)}</span>
            <span className="header__balance-currency">{currency}</span>
          </span>
        </div>

        {onInfoClick && (
          <button
            type="button"
            className="header__info-button"
            onClick={onInfoClick}
            aria-label={t('info.open', { defaultValue: 'Open info' })}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
};
