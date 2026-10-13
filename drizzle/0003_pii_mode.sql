CREATE TYPE "public"."pii_mode" AS ENUM('off', 'mask', 'block');--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "pii_mode" "pii_mode";