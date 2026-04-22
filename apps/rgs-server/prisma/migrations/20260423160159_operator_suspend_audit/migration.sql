-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "suspended_by" VARCHAR(254),
ADD COLUMN     "suspended_reason" VARCHAR(256);
