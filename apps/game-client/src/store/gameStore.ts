import { create } from 'zustand';

// Slimmed gameStore for the B2B iframe. Compared to the B2C version:
//   - no user identity, no leaderboard, no bonus wallet;
//   - balance lives here (operator-sourced via `balance_update`), in
//     micro-units (BigInt-as-string on the wire, number of minor units
//     internally for fast arithmetic — conversion to display currency
//     happens at render time in the UI layer);
//   - no localStorage persistence — the iframe is ephemeral.

export type RoundState = 'WAITING_FOR_BET' | 'BETTING_OPEN' | 'ROLLING' | 'RESULT' | 'COOLDOWN';
export type BetSide = 'LOW' | 'HIGH';

export interface CurrentBet {
  side: BetSide;
  /** Amount in micro-units (1 LKR = 100_000 micro). */
  amountMicro: bigint;
}

export interface HistoryEntry {
  roundId: string;
  roundNumber?: number;
  diceValues?: number[];
  dieValue: number;
  sum: number;
  side: BetSide;
  timestamp: number;
}

/**
 * Player's own placed-bet record with settlement outcome. Used by the
 * right-hand "Recent Bets" list. This is distinct from `betHistory` (which
 * is the round-outcome log shown on the left panel) — only the rounds in
 * which the player actually placed a bet appear here.
 */
export interface PlayerBetRecord {
  roundId: string;
  roundNumber?: number;
  side: BetSide;
  amountMicro: bigint;
  status: 'PENDING' | 'WIN' | 'LOSS';
  outcomeSide?: BetSide;
  outcomeSum?: number;
  /** Payout in micro (gross win when status === 'WIN', else 0n). */
  payoutMicro?: bigint;
  timestamp: number;
}

export interface GameConfig {
  /** Min bet in micro-units. */
  minBetMicro: bigint;
  /** Max bet in micro-units. */
  maxBetMicro: bigint;
  currency: string;
}

interface GameState {
  /* round info */
  roundId: string | null;
  roundState: RoundState;
  timeRemaining: number;
  bettingDuration: number;

  /* die result */
  dieValue: number;
  outcomeSide: BetSide | null;
  outcomeSum: number | null;

  /* player's bet for current round */
  currentBet: CurrentBet | null;
  lastWinMicro: bigint | null;
  lastLossMicro: bigint | null;

  /* history */
  betHistory: HistoryEntry[];
  /** Player's own bets (last ~20) with settlement status. */
  playerBets: PlayerBetRecord[];

  /* config */
  config: GameConfig;

  /* balance — operator is the source of truth, we mirror the latest value */
  balanceMicro: bigint;

  /* provably fair — `nonce` is the RNG seed index (0-indexed, cert-protected) */
  serverSeedHash: string | null;
  serverSeed: string | null;
  clientSeed: string | null;
  nonce: number;

  /* display-only 1-indexed round counter emitted by the server. Separate from
     `nonce` so the UI can show a human-friendly number without conflating it
     with the RNG seed used for fairness verification. */
  roundNumber: number;

  /* connectivity */
  isConnected: boolean;
  isPaused: boolean;

  /* actions */
  setCurrentBet: (bet: CurrentBet | null) => void;
  setRoundState: (state: RoundState) => void;
  setRoundInfo: (roundId: string, timeRemaining: number) => void;
  setDiceResult: (value: number, sum: number, side: BetSide) => void;
  setTimeRemaining: (t: number) => void;
  addHistoryEntry: (entry: HistoryEntry) => void;
  addPlayerBet: (entry: PlayerBetRecord) => void;
  resolvePlayerBet: (roundId: string, outcome: {
    outcomeSide: BetSide;
    outcomeSum: number;
    payoutMicro: bigint;
  }) => void;
  setConfig: (config: Partial<GameConfig>) => void;
  setLastWinMicro: (amount: bigint | null) => void;
  setLastLossMicro: (amount: bigint | null) => void;
  setBalanceMicro: (amount: bigint) => void;
  setServerSeedHash: (hash: string | null) => void;
  setServerSeed: (seed: string | null) => void;
  setClientSeed: (seed: string | null) => void;
  setNonce: (n: number) => void;
  setRoundNumber: (n: number) => void;
  setConnected: (connected: boolean) => void;
  setPaused: (paused: boolean) => void;
  reset: () => void;

  /* Legacy compat for PixiJS scene code: placeBet only stores locally. */
  placeBet: (side: BetSide, amountMicro: bigint) => void;
  clearBet: () => void;
}

const DEFAULT_CONFIG: GameConfig = {
  // 100 LKR min, 50,000 LKR max as placeholders — overwritten by server on
  // connect via game_config. Values are in micro-units (×100_000).
  minBetMicro: 100n * 100_000n,
  maxBetMicro: 50_000n * 100_000n,
  currency: 'LKR',
};

export const useGameStore = create<GameState>()((set) => ({
  roundId: null,
  roundState: 'WAITING_FOR_BET',
  timeRemaining: 0,
  bettingDuration: 10,

  dieValue: 0,
  outcomeSide: null,
  outcomeSum: null,

  currentBet: null,
  lastWinMicro: null,
  lastLossMicro: null,

  betHistory: [],
  playerBets: [],

  config: DEFAULT_CONFIG,

  balanceMicro: 0n,

  serverSeedHash: null,
  serverSeed: null,
  clientSeed: null,
  nonce: 0,
  roundNumber: 0,

  isConnected: false,
  isPaused: false,

  setCurrentBet: (bet) => set({ currentBet: bet }),

  setRoundState: (roundState) => {
    set({ roundState });
    if (roundState === 'BETTING_OPEN') {
      set({
        currentBet: null,
        lastWinMicro: null,
        lastLossMicro: null,
        outcomeSide: null,
        outcomeSum: null,
        dieValue: 0,
        serverSeed: null,
      });
    }
  },

  setRoundInfo: (roundId, timeRemaining) => set({ roundId, timeRemaining }),

  setDiceResult: (value, sum, side) => set({ dieValue: value, outcomeSum: sum, outcomeSide: side }),

  setTimeRemaining: (t) => set({ timeRemaining: t }),

  addHistoryEntry: (entry) =>
    set((state) => {
      if (entry.roundId && state.betHistory.some((h) => h.roundId === entry.roundId)) {
        return state;
      }
      return { betHistory: [...state.betHistory.slice(-4), entry] };
    }),

  addPlayerBet: (entry) =>
    set((state) => {
      if (state.playerBets.some((b) => b.roundId === entry.roundId)) return state;
      return { playerBets: [...state.playerBets.slice(-19), entry] };
    }),

  resolvePlayerBet: (roundId, outcome) =>
    set((state) => ({
      playerBets: state.playerBets.map((b) => {
        if (b.roundId !== roundId) return b;
        const isWin = b.side === outcome.outcomeSide;
        return {
          ...b,
          status: isWin ? 'WIN' : 'LOSS',
          outcomeSide: outcome.outcomeSide,
          outcomeSum: outcome.outcomeSum,
          payoutMicro: isWin ? outcome.payoutMicro : 0n,
        };
      }),
    })),

  setConfig: (partial) =>
    set((state) => ({ config: { ...state.config, ...partial } })),

  setLastWinMicro: (amount) => set({ lastWinMicro: amount }),
  setLastLossMicro: (amount) => set({ lastLossMicro: amount }),
  setBalanceMicro: (amount) => set({ balanceMicro: amount }),

  setServerSeedHash: (hash) => set({ serverSeedHash: hash }),
  setServerSeed: (seed) => set({ serverSeed: seed }),
  setClientSeed: (seed) => set({ clientSeed: seed }),
  setNonce: (n) => set({ nonce: n }),
  setRoundNumber: (n) => set({ roundNumber: n }),

  setConnected: (connected) => set({ isConnected: connected }),
  setPaused: (paused) => set({ isPaused: paused }),

  placeBet: (side, amountMicro) => set({ currentBet: { side, amountMicro } }),
  clearBet: () => set({ currentBet: null }),

  reset: () =>
    set({
      roundId: null,
      roundState: 'WAITING_FOR_BET',
      timeRemaining: 0,
      dieValue: 0,
      outcomeSide: null,
      outcomeSum: null,
      currentBet: null,
      lastWinMicro: null,
      lastLossMicro: null,
      betHistory: [],
      playerBets: [],
      balanceMicro: 0n,
      serverSeedHash: null,
      serverSeed: null,
      clientSeed: null,
      nonce: 0,
      roundNumber: 0,
      isConnected: false,
      isPaused: false,
    }),
}));

// ── Formatting helpers used by the render layer ─────────────────────

const MICRO = 100_000n;

/** Converts micro-units to a string like "1000.50" for display. */
export function formatMicroAmount(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO;
  const frac = abs % MICRO;
  if (frac === 0n) return `${neg ? '-' : ''}${whole.toString()}`;
  const fracStr = frac.toString().padStart(5, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/** Converts a plain LKR integer (e.g. 1000) to micro-units. */
export function lkrToMicro(amount: number): bigint {
  return BigInt(Math.round(amount * 100_000));
}
