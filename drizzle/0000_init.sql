CREATE TYPE "public"."platform" AS ENUM('meta', 'tiktok', 'google_ads', 'openai_ads');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"must_change_password" boolean DEFAULT false,
	"created_by_id" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_raw" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"is_manager" boolean DEFAULT false NOT NULL,
	"parent_external_id" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_connection_external_uq" UNIQUE("connection_id","external_id"),
	CONSTRAINT "ad_accounts_status_chk" CHECK ("ad_accounts"."status" in ('active','disabled','pending','closed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"credential_hint" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[],
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "connections_status_chk" CHECK ("connections"."status" in ('active','expiring','invalid','disabled'))
);
--> statement-breakpoint
CREATE TABLE "mcp_account_scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"ad_account_id" uuid,
	CONSTRAINT "mcp_account_scopes_uq" UNIQUE NULLS NOT DISTINCT("mcp_id","connection_id","ad_account_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_call_stats_hourly" (
	"bucket" timestamp with time zone NOT NULL,
	"mcp_id" uuid NOT NULL,
	"owner_id" text,
	"platform" text DEFAULT '' NOT NULL,
	"tool_name" text DEFAULT '' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"duration_ms_sum" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "mcp_call_stats_hourly_bucket_mcp_id_platform_tool_name_pk" PRIMARY KEY("bucket","mcp_id","platform","tool_name")
);
--> statement-breakpoint
CREATE TABLE "mcp_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"mcp_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"args_hash" text NOT NULL,
	"args" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_pending_actions_token_uq" UNIQUE("token_hash"),
	CONSTRAINT "mcp_pending_actions_status_chk" CHECK ("mcp_pending_actions"."status" in ('pending','consumed','expired'))
);
--> statement-breakpoint
CREATE TABLE "mcp_platform_permissions" (
	"mcp_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"permissions" text[] NOT NULL,
	CONSTRAINT "mcp_platform_permissions_mcp_id_platform_pk" PRIMARY KEY("mcp_id","platform"),
	CONSTRAINT "mcp_platform_permissions_chk" CHECK ("mcp_platform_permissions"."permissions" <@ array['read','status','update','copy','create','delete']::text[] and 'read' = any("mcp_platform_permissions"."permissions"))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_encrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_client" text,
	"key_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "mcp_servers_key_hash_uq" UNIQUE("key_hash"),
	CONSTRAINT "mcp_servers_status_chk" CHECK ("mcp_servers"."status" in ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_role" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"status" text DEFAULT 'success' NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "activity_logs_created_at_id_pk" PRIMARY KEY("created_at","id")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "mcp_call_logs" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mcp_id" uuid,
	"mcp_name" text,
	"owner_id" text,
	"owner_email" text,
	"jsonrpc_id" text,
	"method" text NOT NULL,
	"tool_name" text,
	"protocol_version" text,
	"client_name" text,
	"client_version" text,
	"ip" "inet",
	"user_agent" text,
	"platform" text,
	"ad_account_id" text,
	"object_ids" text[],
	"action_kind" text DEFAULT 'protocol' NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"upstream_request_ids" text[],
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"changes" jsonb,
	"pending_action_id" uuid,
	"request_bytes" integer,
	"response_bytes" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mcp_call_logs_created_at_id_pk" PRIMARY KEY("created_at","id")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_account_scopes" ADD CONSTRAINT "mcp_account_scopes_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_account_scopes" ADD CONSTRAINT "mcp_account_scopes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_account_scopes" ADD CONSTRAINT "mcp_account_scopes_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_pending_actions" ADD CONSTRAINT "mcp_pending_actions_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_platform_permissions" ADD CONSTRAINT "mcp_platform_permissions_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ad_accounts_platform_external_idx" ON "ad_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "connections_owner_idx" ON "connections" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "connections_platform_idx" ON "connections" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "mcp_account_scopes_connection_idx" ON "mcp_account_scopes" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "mcp_account_scopes_account_idx" ON "mcp_account_scopes" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "mcp_call_stats_owner_idx" ON "mcp_call_stats_hourly" USING btree ("owner_id","bucket");--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_mcp_idx" ON "mcp_pending_actions" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "mcp_pending_actions_expires_idx" ON "mcp_pending_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_idx" ON "mcp_servers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "activity_logs_actor_time_idx" ON "activity_logs" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_logs_action_time_idx" ON "activity_logs" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_logs_target_time_idx" ON "activity_logs" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_call_logs_mcp_time_idx" ON "mcp_call_logs" USING btree ("mcp_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_call_logs_owner_time_idx" ON "mcp_call_logs" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_call_logs_account_time_idx" ON "mcp_call_logs" USING btree ("platform","ad_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_call_logs_errors_idx" ON "mcp_call_logs" USING btree ("created_at" DESC NULLS LAST) WHERE "mcp_call_logs"."status" <> 'success';