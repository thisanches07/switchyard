CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "semantic_cache_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"model" text NOT NULL,
	"params_hash" char(64) NOT NULL,
	"embedding" vector(768) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "semantic_cache_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "semantic_cache_entries_embedding_idx" ON "semantic_cache_entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "semantic_cache_entries_expires_at_idx" ON "semantic_cache_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "semantic_cache_entries_scope_idx" ON "semantic_cache_entries" USING btree ("team_id","params_hash");