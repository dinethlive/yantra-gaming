import type React from 'react';
import { useTranslation } from 'react-i18next';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useGameStore } from '../store/gameStore';
import './OfflineBanner.css';

/**
 * Red banner at the top of the iframe whenever either the OS reports offline
 * or the Socket.IO connection to the RGS is down. The socket layer flips
 * `isConnected` via the `connect`/`disconnect` handlers in useSocket.
 */
export const OfflineBanner: React.FC = () => {
  const { t } = useTranslation();
  const isOnline = useOnlineStatus();
  const isConnected = useGameStore((s) => s.isConnected);

  if (isOnline && isConnected) return null;

  const message = !isOnline ? t('offline.message') : t('offline.reconnecting');

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner__icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>Offline</title>
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
          <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0122.58 9" />
          <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
          <path d="M8.53 16.11a6 6 0 016.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
      </span>
      <span className="offline-banner__text">{message}</span>
    </div>
  );
};
