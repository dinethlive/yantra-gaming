-- CreateEnum
CREATE TYPE "CertLab" AS ENUM ('GLI', 'BMM', 'ITECH', 'ECOGRA', 'NMI', 'TRISIGMA', 'OTHER');

-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "allowed_countries" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "game_code" VARCHAR(32) NOT NULL,
    "jurisdiction" VARCHAR(8) NOT NULL,
    "lab" "CertLab" NOT NULL,
    "cert_id" VARCHAR(128) NOT NULL,
    "build_hash" VARCHAR(64) NOT NULL,
    "version" VARCHAR(32),
    "issued_at" TIMESTAMP(3) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "file_path" TEXT,
    "notes" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "certificates_build_hash_idx" ON "certificates"("build_hash");

-- CreateIndex
CREATE INDEX "certificates_game_code_jurisdiction_expires_at_idx" ON "certificates"("game_code", "jurisdiction", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_game_code_jurisdiction_lab_cert_id_key" ON "certificates"("game_code", "jurisdiction", "lab", "cert_id");
