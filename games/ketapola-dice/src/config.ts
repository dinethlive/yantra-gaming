import { z } from 'zod';

/**
 * GameMathConfig for Ketapola Dice. Stored per-operator-per-currency in
 * OperatorGameConfig.configJson and validated by the plugin before the engine
 * starts. `lowWeight` and `highWeight` set the LOW vs HIGH probability ratio
 * (both must be positive; total = lowWeight + highWeight).
 */
export const ketapolaDiceConfigSchema = z
  .object({
    lowWeight: z.number().int().positive(),
    highWeight: z.number().int().positive(),
  })
  .strict();

export type KetapolaDiceConfig = z.infer<typeof ketapolaDiceConfigSchema>;

export const defaultKetapolaDiceConfig: KetapolaDiceConfig = {
  lowWeight: 50,
  highWeight: 50,
};
