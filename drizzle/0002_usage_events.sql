CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"team_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"model" text NOT NULL,
	"requests" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"unknown_cost_requests" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_day_team_id_key_id_model_pk" PRIMARY KEY("day","team_id","key_id","model")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"stream" boolean NOT NULL,
	"requested_model" text NOT NULL,
	"provider" text,
	"served_model" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_input_tokens" integer NOT NULL,
	"estimated" boolean NOT NULL,
	"cost_usd" numeric,
	"status" smallint NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"latency_ms" integer NOT NULL,
	"ttfb_ms" integer,
	"attempts" integer NOT NULL,
	"cache_status" text NOT NULL,
	"pii_detections" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_events_occurred_at_idx" ON "usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_team_occurred_at_idx" ON "usage_events" USING btree ("team_id","occurred_at");