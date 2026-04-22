-- AlterTable
ALTER TABLE "operator_game_configs" ADD COLUMN     "kill_switch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kill_switch_reason" VARCHAR(256),
ADD COLUMN     "kill_switched_at" TIMESTAMP(3),
ADD COLUMN     "kill_switched_by" VARCHAR(254),
ADD COLUMN     "pinned_version" VARCHAR(64);
