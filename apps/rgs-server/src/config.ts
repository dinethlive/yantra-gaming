import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_JWT_SECRET: z.string().min(16),
  PORTAL_JWT_SECRET: z.string().min(16),
  SECRETS_MASTER_KEY_B64: z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'SECRETS_MASTER_KEY_B64 must be 32 bytes base64-encoded' },
    ),
  PORT: z.coerce.number().int().positive().default(4500),
  CORS_ORIGIN: z.string().default('http://localhost:3100,http://localhost:3101,http://localhost:3102'),
  SIGNATURE_WINDOW_SECONDS: z.coerce.number().int().positive().default(30),
  GAME_CLIENT_BASE_URL: z.string().url().default('http://localhost:3100'),
  WALLET_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Cloudflare Turnstile — optional bot-challenge on session creation. Leave
  // TURNSTILE_SECRET_KEY unset to disable the middleware entirely (the default
  // for local dev and staging).
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_SITEVERIFY_URL: z
    .string()
    .url()
    .default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast — missing env is a boot-time bug, not a runtime error.
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  databaseUrl: env.DATABASE_URL,
  sessionJwtSecret: env.SESSION_JWT_SECRET,
  portalJwtSecret: env.PORTAL_JWT_SECRET,
  secretsMasterKeyB64: env.SECRETS_MASTER_KEY_B64,
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  signatureWindowSeconds: env.SIGNATURE_WINDOW_SECONDS,
  gameClientBaseUrl: env.GAME_CLIENT_BASE_URL,
  walletCallTimeoutMs: env.WALLET_CALL_TIMEOUT_MS,
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
  turnstileSiteverifyUrl: env.TURNSTILE_SITEVERIFY_URL,
} as const;

export type AppConfig = typeof config;
