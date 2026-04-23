import type React from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SoundManager } from '../game/SoundManager';
import './CanvasToolbar.css';

interface CanvasToolbarProps {
  onOpenFairness: () => void;
}

/**
 * Top-left overlay on the canvas: sound toggle, language toggle, and
 * fairness-drawer trigger. Bonus + Info buttons from B2C are intentionally
 * omitted — bonuses are operator-owned (roadmap §14) and the left-panel
 * already covers the info use case.
 */
export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({ onOpenFairness }) => {
  const { i18n } = useTranslation();
  const [isMuted, setIsMuted] = useState(SoundManager.muted);

  const toggleSound = useCallback(() => {
    SoundManager.toggleMute();
    setIsMuted(SoundManager.muted);
  }, []);

  const toggleLang = useCallback(() => {
    const next = i18n.language === 'en' ? 'si' : 'en';
    i18n.changeLanguage(next).catch(() => {});
  }, [i18n]);

  return (
    <div className="canvas-toolbar">
      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={toggleSound}
        aria-label="Toggle sound"
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Muted</title>
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Sound on</title>
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="canvas-toolbar__btn"
        onClick={toggleLang}
        aria-label="Toggle language"
        title={i18n.language === 'en' ? 'සිංහල' : 'English'}
      >
        <span className="canvas-toolbar__lang">{i18n.language === 'en' ? 'සි' : 'EN'}</span>
      </button>

      <button
        type="button"
        className="canvas-toolbar__btn canvas-toolbar__btn--fairness"
        onClick={onOpenFairness}
        aria-label="Provably fair"
        title="Provably fair"
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
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
      </button>
    </div>
  );
};
