import type React from 'react';
import { useTranslation } from 'react-i18next';
import './GameSplash.css';

interface GameSplashProps {
  /** When true the splash fades out and unmounts (timed by the caller). */
  hidden?: boolean;
}

export const GameSplash: React.FC<GameSplashProps> = ({ hidden }) => {
  const { t } = useTranslation();

  return (
    <div
      className={`game-splash ${hidden ? 'game-splash--hidden' : ''}`}
      aria-hidden={hidden}
      role="status"
      aria-live="polite"
    >
      <div className="game-splash__bg" aria-hidden="true">
        <div className="game-splash__bg-gradient" />
        <div className="game-splash__bg-orb game-splash__bg-orb--a" />
        <div className="game-splash__bg-orb game-splash__bg-orb--b" />
      </div>

      <div className="game-splash__content">
        <div className="game-splash__dice" aria-hidden="true">
          <div className="game-splash__dice-face">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>

        <h1 className="game-splash__logo">{t('app.name', 'KETAPOLA')}</h1>
        <p className="game-splash__tagline">{t('app.tagline')}</p>

        <div className="game-splash__loader" aria-hidden="true">
          <span className="game-splash__loader-bar" />
        </div>
        <p className="game-splash__label">{t('common.loading')}</p>
      </div>
    </div>
  );
};
