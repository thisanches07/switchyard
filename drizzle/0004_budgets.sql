ALTER TABLE "api_keys" ADD COLUMN "monthly_budget_usd" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "monthly_budget_usd" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "soft_limit_pct" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_monthly_budget_usd_non_negative" CHECK ("api_keys"."monthly_budget_usd" >= 0);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_monthly_budget_usd_non_negative" CHECK ("teams"."monthly_budget_usd" >= 0);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_soft_limit_pct_range" CHECK ("teams"."soft_limit_pct" BETWEEN 1 AND 100);