-- CreateEnum
CREATE TYPE "PendingBetState" AS ENUM ('HELD', 'RESOLVED', 'REFUNDED');

-- CreateTable
CREATE TABLE "pending_round_bets" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "bet_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "state" "PendingBetState" NOT NULL DEFAULT 'HELD',
    "held_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "resolution_reason" VARCHAR(64),

    CONSTRAINT "pending_round_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_round_bets_bet_id_key" ON "pending_round_bets"("bet_id");

-- CreateIndex
CREATE INDEX "pending_round_bets_operator_id_state_idx" ON "pending_round_bets"("operator_id", "state");

-- CreateIndex
CREATE INDEX "pending_round_bets_round_id_idx" ON "pending_round_bets"("round_id");

-- AddForeignKey
ALTER TABLE "pending_round_bets"
  ADD CONSTRAINT "pending_round_bets_bet_id_fkey"
  FOREIGN KEY ("bet_id") REFERENCES "bets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
