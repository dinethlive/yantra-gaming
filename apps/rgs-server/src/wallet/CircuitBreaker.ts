// In-process circuit breaker for outbound wallet calls.
//
// Shape:
//    CLOSED  →  (N consecutive non-OK)  →  OPEN
//    OPEN    →  (cooldownMs elapsed)    →  HALF_OPEN
//    HALF_OPEN  →  (one probe succeeds) →  CLOSED
//    HALF_OPEN  →  (one probe fails)    →  OPEN (cooldown restarts)
//
// Keyed on `(operatorId, endpoint)` so a single misbehaving endpoint on one
// operator does not starve the others. Failures here are only counted for
// non-deterministic results (timeouts, 5xx, transport errors). Legitimate
// operator rejects (NOT_ENOUGH_MONEY, LIMIT_REACHED, USER_DISABLED) are NOT
// failures — they're just the operator's correct answer.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Non-OK responses in a row before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** How long OPEN stays OPEN before transitioning to HALF_OPEN. Default 30 s. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Entry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  probeInflight: boolean;
}

export interface BreakerDecision {
  state: CircuitState;
  /**
   * True if the caller may proceed; false if the circuit is short-circuiting
   * (OPEN, or HALF_OPEN and a probe is already in flight).
   */
  allow: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Returns the current state for `key` and whether the caller should proceed.
   * Safe to call without a subsequent record — a caller that decides NOT to
   * proceed (because allow=false) does not need to record anything.
   *
   * A HALF_OPEN allow=true call is implicitly marked as the inflight probe;
   * the caller MUST then call recordSuccess or recordFailure for that key.
   */
  tryAcquire(key: string): BreakerDecision {
    const entry = this.ensure(key);
    if (entry.state === 'OPEN') {
      if (this.now() - entry.openedAt >= this.cooldownMs) {
        entry.state = 'HALF_OPEN';
        entry.probeInflight = false;
      } else {
        return { state: 'OPEN', allow: false };
      }
    }
    if (entry.state === 'HALF_OPEN') {
      if (entry.probeInflight) {
        return { state: 'HALF_OPEN', allow: false };
      }
      entry.probeInflight = true;
      return { state: 'HALF_OPEN', allow: true };
    }
    return { state: 'CLOSED', allow: true };
  }

  recordSuccess(key: string): void {
    const entry = this.ensure(key);
    entry.state = 'CLOSED';
    entry.consecutiveFailures = 0;
    entry.probeInflight = false;
  }

  recordFailure(key: string): void {
    const entry = this.ensure(key);
    entry.consecutiveFailures += 1;
    entry.probeInflight = false;
    if (entry.state === 'HALF_OPEN' || entry.consecutiveFailures >= this.threshold) {
      entry.state = 'OPEN';
      entry.openedAt = this.now();
    }
  }

  /** Observability — snapshot state per key (e.g. for /admin/circuit-breakers). */
  snapshot(): Record<string, {
    state: CircuitState;
    consecutiveFailures: number;
    openedAt: number;
  }> {
    const out: Record<string, {
      state: CircuitState;
      consecutiveFailures: number;
      openedAt: number;
    }> = {};
    for (const [k, v] of this.entries) {
      out[k] = {
        state: v.state,
        consecutiveFailures: v.consecutiveFailures,
        openedAt: v.openedAt,
      };
    }
    return out;
  }

  /** Test utility — wipe state. */
  reset(): void {
    this.entries.clear();
  }

  private ensure(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        probeInflight: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
}
