// Key-case transformer for operators migrating a wallet built against the
// Hub88 / Softswiss / Pragmatic snake_case convention.
//
// Yantra uses camelCase on the wire; semantics are 1:1 with snake_case —
// this is a purely mechanical rename. Apply as Express middleware on the
// wallet callback handler:
//
//   import { snakeToCamelMiddleware } from '@yantra/operator-sdk';
//   app.use('/wallet', snakeToCamelMiddleware());
//   // ... your existing handlers that read req.body.transactionUuid etc.
//
// Or use `toSnakeCase` / `fromSnakeCase` directly if you need finer control.

type Plain = Record<string, unknown>;

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function transformKeys<T>(value: T, convert: (k: string) => string): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => transformKeys(v, convert)) as unknown as T;
  }
  if (typeof value === 'object' && value.constructor === Object) {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value as Plain)) {
      out[convert(k)] = transformKeys(v, convert);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Deep-convert an object's keys from camelCase to snake_case.
 *
 * Use when emitting responses to a Hub88-shaped wallet client that expects
 * `transaction_uuid`, `request_uuid`, etc.
 */
export function toSnakeCase<T = unknown>(v: T): T {
  return transformKeys(v, toSnake);
}

/**
 * Deep-convert an object's keys from snake_case to camelCase.
 *
 * Use on inbound wallet requests if your existing handler code expects
 * camelCase but the operator-side integration is built against snake_case.
 */
export function fromSnakeCase<T = unknown>(v: T): T {
  return transformKeys(v, toCamel);
}

// ── Express middleware helpers ─────────────────────────────────

type Req = {
  body?: unknown;
  // Loose-typed so we don't take a runtime Express dep; operators' existing
  // `express.Request` is assignable.
};
type Res = {
  json: (body: unknown) => unknown;
};
type Next = (err?: unknown) => void;

/**
 * Express middleware that translates an incoming snake_case JSON body to
 * camelCase before the handler runs, and translates the outgoing JSON body
 * back to snake_case on the way out. 1:1 mechanical mapping, no business
 * logic changed.
 */
export function snakeToCamelMiddleware() {
  return function snakeToCamel(req: Req, res: Res, next: Next) {
    if (req.body && typeof req.body === 'object') {
      req.body = fromSnakeCase(req.body);
    }
    const origJson = res.json.bind(res);
    res.json = (body: unknown) => origJson(toSnakeCase(body));
    next();
  };
}
