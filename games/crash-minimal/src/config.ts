import { z } from 'zod';

/**
 * GameMathConfig for Crash Minimal. Stored per-operator-per-currency in
 * OperatorGameConfig.configJson and validated by the plugin before the engine
 * starts.
 */
export const crashMinimalConfigSchema = z
  .object({
    /** Fractional house edge applied as a pre-roll bust probability. 0.01 = 1% RTP reduction. */
    houseEdge: z.number().min(0).lt(1),
    /** Hard cap on the emitted multiplier. Keeps the client animation bounded. */
    maxMultiplier: z.number().min(1.01),
  })
  .strict();

export type CrashMinimalConfig = z.infer<typeof crashMinimalConfigSchema>;

export const defaultCrashMinimalConfig: CrashMinimalConfig = {
  houseEdge: 0.01,
  maxMultiplier: 1000,
};
