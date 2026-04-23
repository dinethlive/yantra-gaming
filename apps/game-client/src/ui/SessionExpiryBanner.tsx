import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendSessionEnded } from '../iframe/parentMessaging';
import { useSessionStore } from '../session/sessionStore';
import './SessionExpiryBanner.css';

// Banner that surfaces in the last 5 minutes of the session. Yellow at T-5m,
// red at T-1m, then flips the terminated flag at T-0 so the ErrorScreen
// takes over. Also posts a session-ended message to the parent frame so the
// operator can redirect to their lobby.

const WARN_SECONDS = 300; // 5 min
const URGENT_SECONDS = 60;

export const SessionExpiryBanner: React.FC = () => {
  const { t } = useTranslation();
  const expiresAtMs = useSessionStore((s) => s.expiresAtMs);
  const terminate = useSessionStore((s) => s.terminate);
  const [remainingSec, setRemainingSec] = useState<number | null>(() => {
    if (!expiresAtMs) return null;
    return Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  });

  useEffect(() => {
    if (!expiresAtMs) {
      setRemainingSec(null);
      return;
    }
    const tick = () => {
      const s = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      setRemainingSec(s);
      if (s === 0) {
        terminate(t('session.expired', { defaultValue: 'Session expired.' }));
        sendSessionEnded('session_expired');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAtMs, terminate, t]);

  if (remainingSec == null || remainingSec > WARN_SECONDS) return null;
  if (remainingSec <= 0) return null;

  const severity = remainingSec <= URGENT_SECONDS ? 'urgent' : 'warn';
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const formatted = `${mm}:${ss.toString().padStart(2, '0')}`;

  return (
    <div
      className={`session-expiry-banner session-expiry-banner--${severity}`}
      role="status"
      aria-live="polite"
    >
      <span className="session-expiry-banner__icon" aria-hidden="true">
        ⏱
      </span>
      <span className="session-expiry-banner__text">
        {severity === 'urgent'
          ? t('session.endingSoon', {
              defaultValue: 'Session ends in {{time}}. Finish up.',
              time: formatted,
            })
          : t('session.endingIn', {
              defaultValue: 'Session ends in {{time}}.',
              time: formatted,
            })}
      </span>
    </div>
  );
};
