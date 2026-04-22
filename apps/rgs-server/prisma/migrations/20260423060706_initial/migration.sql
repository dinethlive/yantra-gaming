-- CreateEnum
CREATE TYPE "OperatorStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('API_KEY_INBOUND', 'WALLET_HMAC_OUTBOUND');

-- CreateEnum
CREATE TYPE "OperatorRole" AS ENUM ('OPERATOR_ADMIN', 'OPERATOR_VIEWER', 'KETAPOLA_STAFF');

-- CreateEnum
CREATE TYPE "SessionMode" AS ENUM ('REAL', 'DEMO');

-- CreateEnum
CREATE TYPE "RoundState" AS ENUM ('PENDING', 'BETTING_OPEN', 'ROLLING', 'RESULT', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SETTLED', 'VOIDED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WalletEndpoint" AS ENUM ('BALANCE', 'BET', 'WIN', 'ROLLBACK', 'END_ROUND');

-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "OperatorStatus" NOT NULL DEFAULT 'ACTIVE',
    "jurisdiction" VARCHAR(8) NOT NULL,
    "default_currency" VARCHAR(8) NOT NULL,
    "wallet_callback_url" TEXT NOT NULL,
    "ip_allow_list" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "suspended_at" TIMESTAMP(3),

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_credentials" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "type" "CredentialType" NOT NULL,
    "kid" VARCHAR(64) NOT NULL,
    "cipher_blob" BYTEA NOT NULL,
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "not_after" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "label" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_users" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "OperatorRole" NOT NULL DEFAULT 'OPERATOR_ADMIN',
    "display_name" VARCHAR(100) NOT NULL,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_game_configs" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "game_code" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "low_weight" INTEGER NOT NULL,
    "high_weight" INTEGER NOT NULL,
    "min_bet_micro" BIGINT NOT NULL,
    "max_bet_micro" BIGINT NOT NULL,
    "commission_micro" BIGINT NOT NULL DEFAULT 0,
    "betting_window_ms" INTEGER NOT NULL DEFAULT 15000,
    "rolling_window_ms" INTEGER NOT NULL DEFAULT 4000,
    "cooldown_ms" INTEGER NOT NULL DEFAULT 3000,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_game_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_config_audit_log" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "game_code" VARCHAR(32) NOT NULL,
    "field" VARCHAR(64) NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_config_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "player_ref" VARCHAR(128) NOT NULL,
    "game_code" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "lang" VARCHAR(8) NOT NULL,
    "jurisdiction" VARCHAR(8) NOT NULL,
    "mode" "SessionMode" NOT NULL DEFAULT 'REAL',
    "rg_limits" JSONB,
    "return_url" TEXT,
    "server_seed" TEXT NOT NULL,
    "server_seed_hash" TEXT NOT NULL,
    "client_seed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "terminated_at" TIMESTAMP(3),
    "termination_reason" VARCHAR(64),

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rounds" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "game_code" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "nonce" INTEGER NOT NULL,
    "state" "RoundState" NOT NULL,
    "dice_values" INTEGER[],
    "outcome_sum" INTEGER,
    "outcome_side" VARCHAR(4),
    "server_seed" TEXT NOT NULL,
    "server_seed_hash" TEXT NOT NULL,
    "client_seed" TEXT NOT NULL,
    "total_bets_micro" BIGINT NOT NULL DEFAULT 0,
    "total_payouts_micro" BIGINT NOT NULL DEFAULT 0,
    "house_revenue_micro" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "rolled_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "settled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "player_ref" VARCHAR(128) NOT NULL,
    "side" VARCHAR(4) NOT NULL,
    "amount_micro" BIGINT NOT NULL,
    "commission_micro" BIGINT NOT NULL DEFAULT 0,
    "currency" VARCHAR(8) NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "won_amount_micro" BIGINT,
    "won" BOOLEAN,
    "bet_transaction_uuid" UUID NOT NULL,
    "win_transaction_uuid" UUID,
    "rollback_transaction_uuid" UUID,
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_calls" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "direction" "WalletDirection" NOT NULL,
    "endpoint" "WalletEndpoint" NOT NULL,
    "request_uuid" UUID NOT NULL,
    "transaction_uuid" UUID,
    "reference_transaction_uuid" UUID,
    "session_id" UUID,
    "round_id" UUID,
    "player_ref" VARCHAR(128),
    "amount_micro" BIGINT,
    "currency" VARCHAR(8),
    "request_body" JSONB NOT NULL,
    "response_status" TEXT,
    "response_body" JSONB,
    "http_status" INTEGER,
    "latency_ms" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_wallet_jobs" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "endpoint" "WalletEndpoint" NOT NULL,
    "bet_id" UUID,
    "round_id" UUID,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "locked_until" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_wallet_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_idempotency" (
    "operator_id" UUID NOT NULL,
    "request_uuid" UUID NOT NULL,
    "endpoint" VARCHAR(64) NOT NULL,
    "response_body" JSONB NOT NULL,
    "http_status" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_idempotency_pkey" PRIMARY KEY ("operator_id","request_uuid","endpoint")
);

-- CreateIndex
CREATE UNIQUE INDEX "operators_slug_key" ON "operators"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "operator_credentials_kid_key" ON "operator_credentials"("kid");

-- CreateIndex
CREATE INDEX "operator_credentials_operator_id_type_idx" ON "operator_credentials"("operator_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "operator_users_email_key" ON "operator_users"("email");

-- CreateIndex
CREATE INDEX "operator_users_operator_id_idx" ON "operator_users"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "operator_game_configs_operator_id_game_code_currency_key" ON "operator_game_configs"("operator_id", "game_code", "currency");

-- CreateIndex
CREATE INDEX "operator_config_audit_log_operator_id_game_code_idx" ON "operator_config_audit_log"("operator_id", "game_code");

-- CreateIndex
CREATE INDEX "game_sessions_operator_id_player_ref_idx" ON "game_sessions"("operator_id", "player_ref");

-- CreateIndex
CREATE INDEX "game_sessions_expires_at_idx" ON "game_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "rounds_operator_id_game_code_started_at_idx" ON "rounds"("operator_id", "game_code", "started_at");

-- CreateIndex
CREATE INDEX "rounds_session_id_idx" ON "rounds"("session_id");

-- CreateIndex
CREATE INDEX "rounds_settled_idx" ON "rounds"("settled");

-- CreateIndex
CREATE UNIQUE INDEX "bets_bet_transaction_uuid_key" ON "bets"("bet_transaction_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "bets_win_transaction_uuid_key" ON "bets"("win_transaction_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "bets_rollback_transaction_uuid_key" ON "bets"("rollback_transaction_uuid");

-- CreateIndex
CREATE INDEX "bets_operator_id_player_ref_idx" ON "bets"("operator_id", "player_ref");

-- CreateIndex
CREATE INDEX "bets_round_id_idx" ON "bets"("round_id");

-- CreateIndex
CREATE INDEX "bets_status_idx" ON "bets"("status");

-- CreateIndex
CREATE INDEX "wallet_calls_operator_id_transaction_uuid_idx" ON "wallet_calls"("operator_id", "transaction_uuid");

-- CreateIndex
CREATE INDEX "wallet_calls_round_id_idx" ON "wallet_calls"("round_id");

-- CreateIndex
CREATE INDEX "wallet_calls_succeeded_created_at_idx" ON "wallet_calls"("succeeded", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_calls_operator_id_direction_endpoint_request_uuid_key" ON "wallet_calls"("operator_id", "direction", "endpoint", "request_uuid");

-- CreateIndex
CREATE INDEX "pending_wallet_jobs_operator_id_completed_at_idx" ON "pending_wallet_jobs"("operator_id", "completed_at");

-- CreateIndex
CREATE INDEX "pending_wallet_jobs_next_attempt_at_idx" ON "pending_wallet_jobs"("next_attempt_at");

-- CreateIndex
CREATE INDEX "inbound_idempotency_expires_at_idx" ON "inbound_idempotency"("expires_at");

-- AddForeignKey
ALTER TABLE "operator_credentials" ADD CONSTRAINT "operator_credentials_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_users" ADD CONSTRAINT "operator_users_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_game_configs" ADD CONSTRAINT "operator_game_configs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_calls" ADD CONSTRAINT "wallet_calls_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_calls" ADD CONSTRAINT "wallet_calls_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_calls" ADD CONSTRAINT "wallet_calls_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
