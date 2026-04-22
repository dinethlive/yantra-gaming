// @yantra/operator-sdk
//
// The SDK an operator installs to integrate the Yantra Gaming Remote Gaming Server.
// Two things operators need from it:
//
//   1. createSession()         — call the RGS to mint a player launch session.
//   2. verifyWebhookSignature() — verify inbound wallet callbacks are from the RGS.
//
// Plus: typed status codes, header names, and money-conversion helpers re-exported
// from @yantra/wallet-spec so the operator only installs one package.
//
// Usage is documented in README.md and docs/integration-guide.md in the repo root.

// ── Session creation ────────────────────────────────────
export {
  createSession,
  type CreateSessionParams,
  type CreateSessionResult,
} from './createSession.js';

// ── Webhook verification + parsing ──────────────────────
export {
  verifyWebhookSignature,
  parseWalletCallback,
  type VerifyWebhookParams,
  type WalletCallback,
  type WalletCallbackEndpoint,
} from './verifyWebhook.js';

// ── Errors ──────────────────────────────────────────────
export {
  SdkError,
  SessionCreationError,
  WebhookHeaderError,
} from './errors.js';

// ── Key-case transformer (for operators with a snake_case wallet) ─
export {
  toSnakeCase,
  fromSnakeCase,
  snakeToCamelMiddleware,
} from './keyCase.js';

// ── Re-exports from @yantra/wallet-spec ───────────────
//
// The SDK intentionally re-exports everything operators need so they only take
// one npm dependency. If you need to manipulate money amounts, classify a
// wallet response, or read a header name, it's here.

export {
  // Status codes + classifiers
  RsStatus,
  isRejectStatus,
  isSuccessOrDuplicate,

  // Money helpers
  MICRO_PER_UNIT,
  toMicro,
  fromMicro,

  // Header names
  SIGNATURE_HEADER,
  KEY_ID_HEADER,
  TIMESTAMP_HEADER,

  // Signing primitives (for operators who want to roll their own)
  signPayload,
  verifyPayload,
  DEFAULT_CLOCK_TOLERANCE_SECONDS,

  // Types — wire contract
  type MicroAmountString,
  type Uuid,
  type IsoCurrency,
  type PlayerRef,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type BalanceRequestWire,
  type BetRequestWire,
  type WinRequestWire,
  type RollbackRequestWire,
  type WalletResponseWire,
} from '@yantra/wallet-spec';
