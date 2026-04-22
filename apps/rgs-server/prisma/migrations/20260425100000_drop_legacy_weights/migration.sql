-- Phase 4 of the multi-game plugin migration.
--
-- Drops the legacy low_weight / high_weight columns from operator_game_configs.
-- The Ketapola Dice weights have lived on OperatorGameConfig.config_json since
-- Phase 3; no reader still depends on the typed columns. Any new game's math
-- config is zod-validated by its plugin at engine startup.
--
-- Irreversible. For a hypothetical production migration you'd run a
-- verification step first:
--   SELECT id FROM operator_game_configs
--   WHERE (config_json->>'lowWeight')::int IS DISTINCT FROM low_weight
--      OR (config_json->>'highWeight')::int IS DISTINCT FROM high_weight;
-- and abort if any rows diverged before dropping.

ALTER TABLE "operator_game_configs" DROP COLUMN "low_weight";
ALTER TABLE "operator_game_configs" DROP COLUMN "high_weight";
