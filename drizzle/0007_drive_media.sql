CREATE TABLE "drive_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"owner_id" text,
	"name" text DEFAULT '' NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_hint" text,
	"client_email" text NOT NULL,
	"credential_hint" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "drive_credentials_kind_chk" CHECK ("drive_credentials"."kind" in ('system','personal')),
	CONSTRAINT "drive_credentials_owner_chk" CHECK (("drive_credentials"."kind" = 'system') = ("drive_credentials"."owner_id" is null)),
	CONSTRAINT "drive_credentials_api_key_chk" CHECK ("drive_credentials"."api_key_encrypted" is null or "drive_credentials"."kind" = 'system'),
	CONSTRAINT "drive_credentials_status_chk" CHECK ("drive_credentials"."status" in ('active','error','disabled'))
);
--> statement-breakpoint
CREATE TABLE "drive_media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"drive_file_id" text NOT NULL,
	"content_key" text NOT NULL,
	"size_bytes" bigint,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"media_url" text,
	"source_id" uuid,
	"first_mcp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_media_uploads_type_chk" CHECK ("drive_media_uploads"."media_type" in ('image','video'))
);
--> statement-breakpoint
CREATE TABLE "drive_relay_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"mcp_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"drive_file_id" text NOT NULL,
	"content_key" text NOT NULL,
	"access" text NOT NULL,
	"credential_id" uuid,
	"resource_key_encrypted" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	"max_fetches" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_relay_links_access_chk" CHECK ("drive_relay_links"."access" in ('service_account','api_key')),
	CONSTRAINT "drive_relay_links_credential_chk" CHECK (("drive_relay_links"."access" = 'service_account') = ("drive_relay_links"."credential_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "drive_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"google_id" text NOT NULL,
	"sheet_gid" integer,
	"resource_key_encrypted" text,
	"name" text NOT NULL,
	"google_name" text,
	"shared_drive_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "drive_sources_kind_chk" CHECK ("drive_sources"."kind" in ('folder','sheet')),
	CONSTRAINT "drive_sources_scope_chk" CHECK ("drive_sources"."scope" in ('company','personal')),
	CONSTRAINT "drive_sources_status_chk" CHECK ("drive_sources"."status" in ('active','error','disabled')),
	CONSTRAINT "drive_sources_gid_chk" CHECK (("drive_sources"."kind" = 'sheet') = ("drive_sources"."sheet_gid" is not null))
);
--> statement-breakpoint
CREATE TABLE "mcp_drive_scopes" (
	"mcp_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "mcp_drive_scopes_mcp_id_source_id_pk" PRIMARY KEY("mcp_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "drive_credentials" ADD CONSTRAINT "drive_credentials_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_media_uploads" ADD CONSTRAINT "drive_media_uploads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_media_uploads" ADD CONSTRAINT "drive_media_uploads_source_id_drive_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."drive_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_media_uploads" ADD CONSTRAINT "drive_media_uploads_first_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("first_mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_relay_links" ADD CONSTRAINT "drive_relay_links_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_relay_links" ADD CONSTRAINT "drive_relay_links_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_relay_links" ADD CONSTRAINT "drive_relay_links_credential_id_drive_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."drive_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_sources" ADD CONSTRAINT "drive_sources_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_sources" ADD CONSTRAINT "drive_sources_credential_id_drive_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."drive_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_drive_scopes" ADD CONSTRAINT "mcp_drive_scopes_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_drive_scopes" ADD CONSTRAINT "mcp_drive_scopes_source_id_drive_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."drive_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_credentials_owner_idx" ON "drive_credentials" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_credentials_one_system_uq" ON "drive_credentials" USING btree ("kind") WHERE "drive_credentials"."kind" = 'system' and "drive_credentials"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_media_uploads_key_uq" ON "drive_media_uploads" USING btree ("ad_account_id","drive_file_id","content_key");--> statement-breakpoint
CREATE INDEX "drive_media_uploads_file_idx" ON "drive_media_uploads" USING btree ("drive_file_id");--> statement-breakpoint
CREATE INDEX "drive_media_uploads_source_idx" ON "drive_media_uploads" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "drive_media_uploads_first_mcp_idx" ON "drive_media_uploads" USING btree ("first_mcp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_relay_links_token_uq" ON "drive_relay_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "drive_relay_links_expires_idx" ON "drive_relay_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "drive_relay_links_mcp_idx" ON "drive_relay_links" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "drive_relay_links_ad_account_idx" ON "drive_relay_links" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "drive_relay_links_credential_idx" ON "drive_relay_links" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "drive_sources_owner_idx" ON "drive_sources" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "drive_sources_credential_idx" ON "drive_sources" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_sources_live_uq" ON "drive_sources" USING btree ("credential_id","google_id",coalesce("sheet_gid", -1)) WHERE "drive_sources"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_drive_scopes_source_idx" ON "mcp_drive_scopes" USING btree ("source_id");