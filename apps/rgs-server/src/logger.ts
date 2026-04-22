type Level = 'debug' | 'info' | 'warn' | 'error';

function fmt(level: Level, msg: string, meta?: Record<string, unknown>): string {
  const base = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  return `${base} ${JSON.stringify(meta, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>) {
    if (process.env.NODE_ENV !== 'production') console.log(fmt('debug', msg, meta));
  },
  info(msg: string, meta?: Record<string, unknown>) {
    console.log(fmt('info', msg, meta));
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    console.warn(fmt('warn', msg, meta));
  },
  error(msg: string, meta?: Record<string, unknown>) {
    console.error(fmt('error', msg, meta));
  },
};

export type Logger = typeof logger;
