import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RgLimits } from '../bootstrap/parseLaunchParams';
import { useSessionStore } from '../session/sessionStore';
import { formatMicroAmount, useGameStore } from '../store/gameStore';
import './RgLimitsPanel.css';

// Responsible-gambling panel.
//
// Three signals:
//   1. The configured limits (caps) — copied from the session JWT at launch.
//   2. A local estimate of "used this session" — computed from `playerBets`
//      in the game store. This is best-effort: the server holds the
//      authoritative running total (it's pessimistic-counted for ACCEPTED
//      bets too) and will reject the bet if a limit breaches.
//   3. Remaining session time — decrements from the JWT `exp` + the session
//      creation timestamp + sessionTimeSeconds (whichever is tighter).
//
// The component is intentionally conservative: when the server rejects a
// bet with an RG reason, that toast is the authoritative signal. This
// panel is the "how much room do I have?" UX hint.

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) {
    return `${hh}h ${mm.toString().padStart(2, '0')}m`;
  }
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

interface LimitRowProps {
  label: string;
  usedMicro: bigint;
  capMicro: bigint;
  currency: string;
}

const LimitRow: React.FC<LimitRowProps> = ({ label, usedMicro, capMicro, currency }) => {
  const pct = useMemo(() => {
    if (capMicro <= 0n) return 0;
    const p = Number(usedMicro) / Number(capMicro);
    return Math.max(0, Math.min(1, p));
  }, [usedMicro, capMicro]);
  const remainingMicro = capMicro > usedMicro ? capMicro - usedMicro : 0n;

  const severity =
    pct >= 0.9 ? 'critical' : pct >= 0.7 ? 'warn' : 'ok';

  return (
    <div className={`rg-limit rg-limit--${severity}`}>
      <div className="rg-limit__row">
        <span className="rg-limit__label">{label}</span>
        <span className="rg-limit__value">
          {formatMicroAmount(remainingMicro)} {currency}
        </span>
      </div>
      <div className="rg-limit__track">
        <div className="rg-limit__bar" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="rg-limit__row rg-limit__row--footnote">
        <span>
          {formatMicroAmount(usedMicro)} / {formatMicroAmount(capMicro)} {currency}
        </span>
      </div>
    </div>
  );
};

export const RgLimitsPanel: React.FC = () => {
  const { t } = useTranslation();
  const rgLimits = useSessionStore((s) => s.rgLimits);
  const sessionStartedAtMs = useSessionStore((s) => s.sessionStartedAtMs);
  const expiresAtMs = useSessionStore((s) => s.expiresAtMs);
  const currency = useGameStore((s) => s.config.currency);

  // Recompute each second so the UI counts down. Keep it to 1 Hz; anything
  // faster is noise and drains mobile battery.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Subscribe to playerBets directly; Zustand re-renders us whenever the
  // array reference changes, which happens on every addPlayerBet /
  // resolvePlayerBet call.
  const playerBets = useGameStore((s) => s.playerBets);
  const sessionWager = useMemo(() => {
    let total = 0n;
    for (const b of playerBets) total += b.amountMicro;
    return total;
  }, [playerBets]);
  const sessionLoss = useMemo(() => {
    let net = 0n;
    for (const b of playerBets) net += b.amountMicro - (b.payoutMicro ?? 0n);
    return net > 0n ? net : 0n;
  }, [playerBets]);

  // Compute effective session-time cap. RG sessionTimeSeconds can cap the
  // session tighter than the JWT exp; use the earlier of the two.
  const effectiveEndMs = useMemo(() => {
    const rgCapMs =
      rgLimits?.sessionTimeSeconds && sessionStartedAtMs
        ? sessionStartedAtMs + rgLimits.sessionTimeSeconds * 1000
        : null;
    const candidates = [expiresAtMs, rgCapMs].filter(
      (x): x is number => typeof x === 'number',
    );
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }, [rgLimits?.sessionTimeSeconds, sessionStartedAtMs, expiresAtMs]);

  const remainingSeconds =
    effectiveEndMs != null ? Math.max(0, (effectiveEndMs - nowMs) / 1000) : null;

  const hasAny =
    rgLimits?.dailyLossMicro !== undefined ||
    rgLimits?.dailyWagerMicro !== undefined ||
    rgLimits?.sessionLossMicro !== undefined ||
    rgLimits?.sessionWagerMicro !== undefined ||
    remainingSeconds != null;

  if (!hasAny) return null;

  return (
    <div className="rg-panel">
      <div className="rg-panel__title">
        {t('rg.title', { defaultValue: 'Session limits' })}
      </div>

      {rgLimits?.sessionLossMicro !== undefined && (
        <LimitRow
          label={t('rg.sessionLoss', { defaultValue: 'Session loss remaining' })}
          usedMicro={sessionLoss}
          capMicro={rgLimits.sessionLossMicro}
          currency={currency}
        />
      )}

      {rgLimits?.sessionWagerMicro !== undefined && (
        <LimitRow
          label={t('rg.sessionWager', { defaultValue: 'Session wager remaining' })}
          usedMicro={sessionWager}
          capMicro={rgLimits.sessionWagerMicro}
          currency={currency}
        />
      )}

      {rgLimits?.dailyLossMicro !== undefined && (
        <LimitRow
          label={t('rg.dailyLoss', { defaultValue: 'Daily loss cap' })}
          usedMicro={0n}
          capMicro={rgLimits.dailyLossMicro}
          currency={currency}
        />
      )}

      {rgLimits?.dailyWagerMicro !== undefined && (
        <LimitRow
          label={t('rg.dailyWager', { defaultValue: 'Daily wager cap' })}
          usedMicro={0n}
          capMicro={rgLimits.dailyWagerMicro}
          currency={currency}
        />
      )}

      {remainingSeconds != null && (
        <div className="rg-panel__time">
          <span className="rg-panel__time-label">
            {t('rg.timeRemaining', { defaultValue: 'Time remaining' })}
          </span>
          <span
            className={`rg-panel__time-value ${
              remainingSeconds < 60 ? 'rg-panel__time-value--critical' : ''
            }`}
          >
            {formatDuration(remainingSeconds)}
          </span>
        </div>
      )}

      <div className="rg-panel__footnote">
        {t('rg.disclaimer', {
          defaultValue:
            'Session estimates. Daily caps enforced by the operator—authoritative remaining is server-side.',
        })}
      </div>
    </div>
  );
};
