ALTER TABLE "api_keys" ADD COLUMN "rpm" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tpm" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "rpm" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "tpm" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rpm_positive" CHECK ("api_keys"."rpm" > 0);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tpm_positive" CHECK ("api_keys"."tpm" > 0);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_rpm_positive" CHECK ("teams"."rpm" > 0);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tpm_positive" CHECK ("teams"."tpm" > 0);