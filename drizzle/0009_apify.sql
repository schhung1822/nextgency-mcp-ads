CREATE TABLE "apify_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"task_key" text,
	"run_id" text NOT NULL,
	"dataset_id" text,
	"status" text NOT NULL,
	"max_charge_usd" numeric(10, 4) NOT NULL,
	"usage_usd" numeric(12, 4),
	"item_count" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apify_runs_mcp_run_uq" UNIQUE("mcp_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "apify_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"credential_hint" text DEFAULT '' NOT NULL,
	"apify_user_id" text,
	"apify_username" text,
	"plan_id" text,
	"plan_tier" text,
	"usage_usd" numeric(12, 4),
	"limit_usd" numeric(12, 4),
	"cycle_end_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"exhausted_until" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "apify_tokens_scope_chk" CHECK ("apify_tokens"."scope" in ('company','personal')),
	CONSTRAINT "apify_tokens_status_chk" CHECK ("apify_tokens"."status" in ('active','exhausted','invalid','error','disabled'))
);
--> statement-breakpoint
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_token_id_apify_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."apify_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apify_tokens" ADD CONSTRAINT "apify_tokens_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apify_runs_run_uq" ON "apify_runs" USING btree ("run_id") WHERE "apify_runs"."run_id" not like 'pending:%';--> statement-breakpoint
CREATE INDEX "apify_runs_mcp_created_idx" ON "apify_runs" USING btree ("mcp_id","created_at");--> statement-breakpoint
CREATE INDEX "apify_runs_token_idx" ON "apify_runs" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "apify_tokens_owner_idx" ON "apify_tokens" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "apify_tokens_scope_idx" ON "apify_tokens" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "apify_tokens_apify_user_idx" ON "apify_tokens" USING btree ("apify_user_id");