-- Per-currency MiCA (Markets in Crypto-Assets) compliance gate on
-- OperatorGameConfig. Default true so existing fiat configs remain enabled;
-- new crypto configs for issuers without MiCA authorisation set this false
-- and the engine refuses to run them.

ALTER TABLE "operator_game_configs"
  ADD COLUMN "mica_compliant" BOOLEAN NOT NULL DEFAULT true;
