# Currency, FX, and Crypto

How Yantra handles money when the session currency, the player's wallet
currency, and the operator's ledger currency diverge.

**Contents**

- [Design principle](#design-principle)
- [Single-currency sessions (default)](#single-currency-sessions-default)
- [Multi-currency wallets + FX at bet time](#multi-currency-wallets--fx-at-bet-time)
- [Crypto stablecoins (USDC, USDT)](#crypto-stablecoins-usdc-usdt)
- [Rounding + precision](#rounding--precision)
- [Reconciliation across currencies](#reconciliation-across-currencies)

---

## Design principle

**Sessions are single-currency.** A session JWT locks in one currency at
`POST /v1/session` time; every bet in that session is in that currency;
payouts are in that currency. This is a hard rule, the round-state
machine, the `PendingRoundBet` register, and the proof endpoint all assume
it.

The currency mismatch question lives at the **wallet boundary**, not
inside the RGS. When the player's real balance is in currency A and the
session is in currency B, the conversion happens on the wallet (operator
side) at bet time, and the RGS records the conversion on the wire so both
sides' audit ledgers reconcile.

---

## Single-currency sessions (default)

The simplest case, and what `mock-operator` does by default:

- Session currency = player wallet currency.
- Every `/wallet/bet` and `/wallet/win` carries `currency` matching the
  session.
- RGS `WalletCall` ledger stores `amountMicro` + `currency` as a single
  scalar pair.
- No FX fields populated on the wire.

This is the correct shape for operators whose players each hold a single
native balance (LKR-only, EUR-only, crypto-only, etc.).

---

## Multi-currency wallets + FX at bet time

Operators whose players hold multiple wallets (USD + EUR + BTC, for
example) and who let the session run in a different currency than the
player's primary wallet use the FX fields on the wire:

```ts
interface FxContext {
  walletCurrency?: IsoCurrency;    // player's native wallet currency
  fxRate?: string;                 // session currency → wallet currency
  fxRateAt?: string;               // ISO-8601 timestamp the rate was locked
  fxRateSource?: string;           // 'ECB', 'COINBASE', 'OPERATOR_INTERNAL', ...
}
```

Populated on `BetRequestWire` and `WinRequestWire` (defined in
`packages/wallet-spec/src/index.ts`). Semantics:

- `amountMicro` remains in `currency` (session currency), the RGS does
  not see wallet-currency amounts on the wire.
- The operator wallet performs the debit / credit in `walletCurrency`
  using `fxRate`, and records **both** the session-currency amount and
  the wallet-currency equivalent in its internal ledger.
- The RGS records `amountMicro` + `currency` + the entire `FxContext`
  on the `WalletCall` row so audit trails on both sides reconcile.
- Rollbacks must use the **same** `fxRate` the original bet locked in ,
  otherwise the player profits from FX drift at rollback time. The operator
  wallet enforces this; the RGS replays whatever `fxRate` was on the
  original `transactionUuid`.

### Which side owns the rate

- The **operator wallet** is authoritative, it picks the rate and
  `fxRateSource`. The RGS records the operator's choice; it does not pick
  or verify rates.
- Suggested practice: lock the rate once per session (at session-create
  time) so all bets in a single session use the same rate. This avoids
  rate-hunting behaviours (player places many small bets at 1-second
  intervals hoping for a favourable tick).

### Rate staleness

- `fxRateAt` older than 5 minutes in production is a reconciliation
  warning; older than 1 hour is an error. Operators supplying stale rates
  are flagged in the weekly reconciliation report.

---

## Crypto stablecoins (USDC, USDT)

Crypto wallets are regular currencies from the RGS's point of view, the
wire format doesn't distinguish. But three things shift at the compliance
boundary:

- **MiCA compliance (EU).** `OperatorGameConfig.micaCompliant` is a flag
  the operator sets per-currency per-game to assert the issuer satisfies
  MiCA. Yantra does not verify issuer status; it records the claim in the
  audit trail.
- **FATF Travel Rule.** Cross-border transfers above the Travel Rule
  threshold require sender / recipient info, the operator wallet owns
  this. Yantra's audit ledger is opaque on source / destination accounts.
- **Stablecoin de-pegging.** A USDC bet at a 1.00 peg that settles at a
  0.98 peg is still settled at `amountMicro` in USDC; FX-to-fiat is
  out-of-scope for the RGS.

Operators who want USD-equivalent tracking use the FX fields above with
`walletCurrency: 'USD'` and a peg-tracking `fxRateSource`; the RGS records
the peg at bet time as a single row without running its own oracle.

### Brazil (SPA) constraint

Brazilian regulation (Law 14.790/2023 + SPA Normative Ordinances) **prohibits
cryptocurrency for regulated play**. The `BR` jurisdiction profile in
`packages/jurisdiction-rules` sets `cryptoAllowed: false`; any attempt to
open a session with a crypto currency for a BR-jurisdiction operator is
rejected at `POST /v1/session` before a round is ever minted.

---

## Rounding + precision

All money is BigInt micro-units (×100,000), see
[`wallet-api.md#money-format`](./wallet-api.md#money-format). This holds
across currencies:

- Fiat with 2 decimal places (USD, EUR, GBP, BRL): `$1.23 → 123_000` micro.
- Fiat with 0 decimal places (JPY, KRW): use whole units scaled ×100_000
  on the wire. Operators may narrow to ×1 internally, but the wire format
  is always ×100_000 for consistency.
- Crypto (USDC, USDT typically 6 decimal places; BTC 8 decimals): operators
  scale to 5 decimal places on the wire (×100_000). Sub-5-decimal precision
  is lost; this is a deliberate constraint, fractional-satoshi bets are
  not supported. Round **half-to-even** (banker's rounding) on any
  truncation.

The `toMicro` / `fromMicro` helpers in `@yantra/wallet-spec` do this
correctly for decimal strings; avoid floats.

---

## Reconciliation across currencies

The daily reconciliation (`scripts/reconcile.ts`) groups by
`(operator_id, currency)`: i.e. it reconciles per **session currency**,
not per wallet currency. Multi-currency operators see one reconciliation
row per currency pair they play in.

The operator's side of reconciliation (wallet-currency-based) is outside
the RGS scope. To match the two, operators typically join on
`transaction_uuid` + `fxRate` + `fxRateAt` to convert session-currency
totals into their ledger currency. A join recipe lives in the
`packages/operator-sdk` README.
