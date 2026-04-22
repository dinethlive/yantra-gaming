import { z } from 'zod';

/**
 * BetSelection for Ketapola Dice: the player picks LOW or HIGH before the
 * round rolls. The core engine validates the envelope (amount, autoplay,
 * turbo); the plugin's selectionSchema validates only the selection shape.
 */
export const ketapolaDiceSelectionSchema = z
  .object({
    side: z.enum(['LOW', 'HIGH']),
  })
  .strict();

export type KetapolaDiceSelection = z.infer<typeof ketapolaDiceSelectionSchema>;
