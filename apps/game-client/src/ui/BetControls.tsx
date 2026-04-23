import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BetRejectedPayload } from '../hooks/useSocket';
import {
  type BetSide,
  formatMicroAmount,
  lkrToMicro,
  useGameStore,
} from '../store/gameStore';
import { DiceFace } from './DiceFace';
import './BetControls.css';

// Quick-chip values in whole LKR. Converted to micro-units at emit time.
const QUICK_CHIPS_LKR = [100, 500, 1000, 5000];

interface BetControlsProps {
  placeBet: (side: BetSide, amountMicro: bigint) => void;
}

/**
 * Right-side bet panel (desktop) / bottom bar (mobile). Adapted from the B2C
 * design with three differences: amounts are BigInt micro-units, there is
 * no bonus-wallet switch, and "recent bets" reads the session-scoped
 * `betHistory` from the store rather than hitting a server endpoint.
 */
export const BetControls: React.FC<BetControlsProps> = ({ placeBet }) => {
  const { t } = useTranslation();
  const roundState = useGameStore((s) => s.roundState);
  const currentBet = useGameStore((s) => s.currentBet);
  const balanceMicro = useGameStore((s) => s.balanceMicro);
  const config = useGameStore((s) => s.config);
  const playerBets = useGameStore((s) => s.playerBets);

  const [selectedSide, setSelectedSide] = useState<BetSide | null>(null);
  const [amountLkr, setAmountLkr] = useState<string>('100');
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  // Surface server bet-rejection reasons — useSocket dispatches a CustomEvent.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<BetRejectedPayload>).detail;
      setRejectReason(detail?.reason ?? 'Bet rejected');
    };
    window.addEventListener('ketapola:bet-rejected', handler);
    return () => window.removeEventListener('ketapola:bet-rejected', handler);
  }, []);

  const numericAmount = Number.parseFloat(amountLkr) || 0;
  const amountMicro = lkrToMicro(numericAmount);

  const isBettingOpen = roundState === 'BETTING_OPEN';
  const hasBet = currentBet !== null;
  const canInteract = isBettingOpen && !hasBet;

  const canBet =
    canInteract &&
    amountMicro > 0n &&
    amountMicro <= balanceMicro &&
    amountMicro >= config.minBetMicro &&
    amountMicro <= config.maxBetMicro &&
    selectedSide !== null;

  const handleQuickChip = useCallback(
    (value: number) => {
      if (!canInteract) return;
      setAmountLkr(String(value));
      setRejectReason(null);
    },
    [canInteract],
  );

  const handleMax = useCallback(() => {
    if (!canInteract) return;
    const max = balanceMicro < config.maxBetMicro ? balanceMicro : config.maxBetMicro;
    // Round down to whole LKR so the input stays tidy.
    const wholeLkr = Number(max / 100_000n);
    setAmountLkr(String(wholeLkr));
    setRejectReason(null);
  }, [canInteract, balanceMicro, config.maxBetMicro]);

  const handleSubmit = useCallback(() => {
    if (!canBet || !selectedSide) return;
    setRejectReason(null);
    placeBet(selectedSide, amountMicro);
  }, [canBet, selectedSide, amountMicro, placeBet]);

  const activeSide = hasBet ? currentBet.side : selectedSide;
  const displayAmount = hasBet ? formatMicroAmount(currentBet.amountMicro) : amountLkr;

  const buttonLabel = hasBet
    ? `${currentBet.side} · ${formatMicroAmount(currentBet.amountMicro)}`
    : t('game.placeBet');

  const recentBets = [...playerBets].reverse().slice(0, 8);

  return (
    <aside className="bet-panel">
      <div className={`bet-panel__form ${hasBet ? 'placed' : ''}`}>
        {/* Side selection */}
        <div className="bet-panel__sides">
          <button
            type="button"
            className={`bet-panel__side-btn low ${activeSide === 'LOW' ? 'active' : ''}`}
            onClick={() => canInteract && setSelectedSide('LOW')}
            disabled={!canInteract}
          >
            <span className="bet-panel__side-name">{t('game.low')}</span>
            <div className="bet-panel__side-dice">
              <DiceFace value={3} size="sm" variant="low" />
              <DiceFace value={6} size="sm" variant="low" />
              <DiceFace value={9} size="sm" variant="low" />
            </div>
          </button>

          <button
            type="button"
            className={`bet-panel__side-btn high ${activeSide === 'HIGH' ? 'active' : ''}`}
            onClick={() => canInteract && setSelectedSide('HIGH')}
            disabled={!canInteract}
          >
            <span className="bet-panel__side-name">{t('game.high')}</span>
            <div className="bet-panel__side-dice">
              <DiceFace value={12} size="sm" variant="high" />
              <DiceFace value={15} size="sm" variant="high" />
              <DiceFace value={18} size="sm" variant="high" />
            </div>
          </button>
        </div>

        {/* Amount input */}
        <div className="bet-panel__amount-wrap">
          <span className="bet-panel__currency">{config.currency}</span>
          <input
            type="number"
            className="bet-panel__amount-input font-numbers"
            value={displayAmount}
            onChange={(e) => {
              if (!canInteract) return;
              const raw = e.target.value;
              if (raw === '') {
                setAmountLkr('');
                setRejectReason(null);
                return;
              }
              const num = Number.parseFloat(raw);
              if (Number.isNaN(num) || num < 0) return;
              setAmountLkr(raw);
              setRejectReason(null);
            }}
            placeholder="0"
            disabled={!canInteract}
          />
        </div>

        {/* Quick chips + Max */}
        <div className="bet-panel__chips">
          {QUICK_CHIPS_LKR.map((val) => (
            <button
              type="button"
              key={val}
              className={`bet-panel__chip ${numericAmount === val ? 'active' : ''}`}
              onClick={() => handleQuickChip(val)}
              disabled={!canInteract}
            >
              {val >= 1000 ? `${val / 1000}K` : val}
            </button>
          ))}
          <button
            type="button"
            className="bet-panel__chip chip-max"
            onClick={handleMax}
            disabled={!canInteract}
          >
            {t('game.max')}
          </button>
        </div>

        {/* Throw button */}
        <button
          type="button"
          className={`bet-panel__throw-btn ${hasBet ? 'placed' : ''} ${canBet ? 'ready' : ''}`}
          onClick={handleSubmit}
          disabled={!canBet}
        >
          {buttonLabel}
        </button>

        {rejectReason && <div className="bet-panel__error">{rejectReason}</div>}
      </div>

      {/* Recent bets — from session-scoped history */}
      <div className="bet-panel__recent">
        <div className="bet-panel__recent-header">
          <span className="bet-panel__recent-title">{t('betControls.recentBets', 'Recent Bets')}</span>
        </div>
        {recentBets.length === 0 ? (
          <div className="bet-panel__recent-empty">{t('betControls.noBets', 'No bets yet')}</div>
        ) : (
          <div className="bet-panel__recent-list">
            {recentBets.map((entry) => {
              const isWin = entry.status === 'WIN';
              const isPending = entry.status === 'PENDING';
              const rowClass = isWin ? 'win' : isPending ? 'pending' : 'lose';
              const payoutLabel = isPending
                ? '…'
                : isWin
                  ? `+${formatMicroAmount(entry.payoutMicro ?? 0n)}`
                  : `-${formatMicroAmount(entry.amountMicro)}`;
              const payoutClass = isWin
                ? 'text-win'
                : isPending
                  ? 'text-muted'
                  : 'text-lose';
              return (
                <div key={entry.roundId} className={`bet-panel__recent-row ${rowClass}`}>
                  <span className={`badge badge-${entry.side.toLowerCase()}`}>{entry.side}</span>
                  <span className="bet-panel__recent-round font-numbers">
                    #{entry.roundNumber ?? '—'}
                  </span>
                  <span className={`bet-panel__recent-payout font-numbers ${payoutClass}`}>
                    {payoutLabel}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
