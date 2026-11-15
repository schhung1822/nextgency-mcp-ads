CREATE TABLE "mcp_tiktok_social_scopes" (
	"mcp_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "mcp_tiktok_social_scopes_mcp_id_account_id_pk" PRIMARY KEY("mcp_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "tiktok_social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"profile_url" text,
	"is_business_account" boolean,
	"client_id" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"last_checked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tiktok_social_accounts_status_chk" CHECK ("tiktok_social_accounts"."status" in ('active','expiring','invalid','disabled'))
);
--> statement-breakpoint
CREATE TABLE "tiktok_social_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_social_clients_redirect_uri_unique" UNIQUE("redirect_uri")
);
--> statement-breakpoint
ALTER TABLE "mcp_tiktok_social_scopes" ADD CONSTRAINT "mcp_tiktok_social_scopes_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tiktok_social_scopes" ADD CONSTRAINT "mcp_tiktok_social_scopes_account_id_tiktok_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."tiktok_social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_social_accounts" ADD CONSTRAINT "tiktok_social_accounts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tiktok_social_scopes_account_idx" ON "mcp_tiktok_social_scopes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tiktok_social_accounts_owner_idx" ON "tiktok_social_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_social_accounts_username_uq" ON "tiktok_social_accounts" USING btree ("username") WHERE "tiktok_social_accounts"."deleted_at" is null;