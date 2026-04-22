-- DropForeignKey
ALTER TABLE "operator_signing_keys" DROP CONSTRAINT "operator_signing_keys_operator_id_fkey";

-- DropForeignKey
ALTER TABLE "operator_user_invites" DROP CONSTRAINT "operator_user_invites_operator_id_fkey";

-- DropForeignKey
ALTER TABLE "webauthn_credentials" DROP CONSTRAINT "webauthn_credentials_user_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_operator_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_subscription_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_subscriptions" DROP CONSTRAINT "webhook_subscriptions_operator_id_fkey";

-- AlterTable
ALTER TABLE "bets" ALTER COLUMN "selection" DROP DEFAULT,
ALTER COLUMN "selection_type" DROP DEFAULT;

-- AlterTable
ALTER TABLE "operator_users" ALTER COLUMN "mfa_recovery_codes_hash" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "operator_user_invites" ADD CONSTRAINT "operator_user_invites_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "operator_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_signing_keys" ADD CONSTRAINT "operator_signing_keys_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "admin_audit_entries_actor_idx" RENAME TO "admin_audit_entries_actor_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "admin_audit_entries_path_idx" RENAME TO "admin_audit_entries_path_created_at_idx";

-- RenameIndex
ALTER INDEX "admin_audit_entries_target_idx" RENAME TO "admin_audit_entries_target_type_target_id_created_at_idx";

-- RenameIndex
ALTER INDEX "audit_anchors_period_stream_op_uidx" RENAME TO "audit_anchors_period_date_stream_name_operator_id_key";

-- RenameIndex
ALTER INDEX "cert_upload_tokens_cert_idx" RENAME TO "cert_upload_tokens_certificate_id_idx";

-- RenameIndex
ALTER INDEX "webauthn_challenges_user_kind_idx" RENAME TO "webauthn_challenges_user_id_kind_idx";
