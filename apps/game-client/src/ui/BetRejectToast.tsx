import type React from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './BetRejectToast.css';

// Listens for the `ketapola:bet-rejected` window event (fired from useSocket.ts
// when the server rejects a bet). Presents a reason-specific message —
// specifically for the RG limits, "bet out of range", and wallet failure
// modes. Auto-dismisses after 4 s; clicking the x dismisses earlier.

interface RejectPayload {
  reason: string;
  code?: string;
  remainingMicro?: string | null;
  detail?: string | null;
}

type Severity = 'info' | 'warn' | 'error';

interface ToastCopy {
  title: string;
  detail: string;
  severity: Severity;
}

function copyFor(reason: string, t: ReturnType<typeof useTranslation>['t']): ToastCopy {
  switch (reason) {
    case 'session_time_exceeded':
      return {
        title: t('betReject.sessionTime.title', { defaultValue: 'Session time up' }),
        detail: t('betReject.sessionTime.detail', {
          defaultValue:
            'Your session has reached its responsible-gambling time limit. Return to the casino to start a new session after a break.',
        }),
        severity: 'warn',
      };
    case 'daily_loss_exceeded':
      return {
        title: t('betReject.dailyLoss.title', { defaultValue: 'Daily loss limit reached' }),
        detail: t('betReject.dailyLoss.detail', {
          defaultValue:
            "You've hit your daily loss cap. Limits reset at midnight UTC.",
        }),
        severity: 'warn',
      };
    case 'daily_wager_exceeded':
      return {
        title: t('betReject.dailyWager.title', { defaultValue: 'Daily wager limit reached' }),
        detail: t('betReject.dailyWager.detail', {
          defaultValue:
            'You’ve hit your daily wager cap. Limits reset at midnight UTC.',
        }),
        severity: 'warn',
      };
    case 'session_loss_exceeded':
      return {
        title: t('betReject.sessionLoss.title', { defaultValue: 'Session loss limit reached' }),
        detail: t('betReject.sessionLoss.detail', {
          defaultValue: 'You’ve reached the loss limit for this session.',
        }),
        severity: 'warn',
      };
    case 'session_wager_exceeded':
      return {
        title: t('betReject.sessionWager.title', { defaultValue: 'Session wager limit reached' }),
        detail: t('betReject.sessionWager.detail', {
          defaultValue: 'You’ve reached the wager limit for this session.',
        }),
        severity: 'warn',
      };
    case 'bet_out_of_range':
      return {
        title: t('betReject.range.title', { defaultValue: 'Bet out of range' }),
        detail: t('betReject.range.detail', {
          defaultValue: 'Your stake is below the minimum or above the maximum bet allowed.',
        }),
        severity: 'info',
      };
    case 'RS_ERROR_NOT_ENOUGH_MONEY':
      return {
        title: t('betReject.balance.title', { defaultValue: 'Not enough balance' }),
        detail: t('betReject.balance.detail', {
          defaultValue: 'Top up at the casino to continue playing.',
        }),
        severity: 'info',
      };
    case 'RS_ERROR_LIMIT_REACHED':
      return {
        title: t('betReject.operatorLimit.title', { defaultValue: 'Operator limit reached' }),
        detail: t('betReject.operatorLimit.detail', {
          defaultValue: 'Your casino has blocked this bet. Check with support.',
        }),
        severity: 'warn',
      };
    case 'RS_ERROR_USER_DISABLED':
      return {
        title: t('betReject.disabled.title', { defaultValue: 'Account not active' }),
        detail: t('betReject.disabled.detail', {
          defaultValue: 'Your casino account is disabled for this game.',
        }),
        severity: 'error',
      };
    case 'wallet_timeout':
    case 'RS_ERROR_TIMEOUT':
      return {
        title: t('betReject.timeout.title', { defaultValue: 'Connection issue' }),
        detail: t('betReject.timeout.detail', {
          defaultValue: 'Your bet didn’t go through. Try again in a moment.',
        }),
        severity: 'warn',
      };
    case 'wallet_error':
      return {
        title: t('betReject.walletError.title', { defaultValue: 'Wallet error' }),
        detail: t('betReject.walletError.detail', {
          defaultValue: 'Your casino wallet couldn’t process the bet. Try again.',
        }),
        severity: 'error',
      };
    case 'session_not_found':
    case 'session_terminated':
    case 'session_expired':
      return {
        title: t('betReject.sessionEnded.title', { defaultValue: 'Session ended' }),
        detail: t('betReject.sessionEnded.detail', {
          defaultValue: 'Return to your casino to start a new session.',
        }),
        severity: 'error',
      };
    case 'betting_closed':
      return {
        title: t('betReject.bettingClosed.title', { defaultValue: 'Betting closed' }),
        detail: t('betReject.bettingClosed.detail', {
          defaultValue: 'Wait for the next round to place a bet.',
        }),
        severity: 'info',
      };
    default:
      return {
        title: t('betReject.generic.title', { defaultValue: 'Bet not accepted' }),
        detail: t('betReject.generic.detail', {
          defaultValue: 'We couldn’t place your bet. Please try again.',
        }),
        severity: 'info',
      };
  }
}

export const BetRejectToast: React.FC = () => {
  const { t } = useTranslation();
  const [toast, setToast] = useState<
    | {
        copy: ToastCopy;
        payload: RejectPayload;
        id: number;
      }
    | null
  >(null);

  useEffect(() => {
    const handler = (ev: Event) => {
      const payload = (ev as CustomEvent<RejectPayload>).detail;
      if (!payload) return;
      const copy = copyFor(payload.reason, t);
      setToast({ copy, payload, id: Date.now() });
    };
    window.addEventListener('ketapola:bet-rejected', handler);
    return () => window.removeEventListener('ketapola:bet-rejected', handler);
  }, [t]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      className={`bet-reject-toast bet-reject-toast--${toast.copy.severity}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="bet-reject-toast__title">{toast.copy.title}</div>
      <div className="bet-reject-toast__detail">{toast.copy.detail}</div>
      <button
        type="button"
        className="bet-reject-toast__dismiss"
        onClick={() => setToast(null)}
        aria-label={t('betReject.dismiss', { defaultValue: 'Dismiss' })}
      >
        ×
      </button>
    </div>
  );
};
