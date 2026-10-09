CREATE TABLE "media_upload_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"drive_file_id" text NOT NULL,
	"content_key" text NOT NULL,
	"source_id" uuid,
	"access" text NOT NULL,
	"credential_id" uuid,
	"resource_key_encrypted" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"md5" text,
	"name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"media_id" text,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "media_upload_jobs_status_chk" CHECK ("media_upload_jobs"."status" in ('queued','uploading','processing','done','failed')),
	CONSTRAINT "media_upload_jobs_access_chk" CHECK ("media_upload_jobs"."access" in ('service_account','api_key')),
	CONSTRAINT "media_upload_jobs_credential_chk" CHECK (("media_upload_jobs"."access" = 'service_account') = ("media_upload_jobs"."credential_id" is not null)),
	CONSTRAINT "media_upload_jobs_size_chk" CHECK ("media_upload_jobs"."size_bytes" >= 0 and "media_upload_jobs"."uploaded_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "drive_relay_links" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_sources" ADD COLUMN "ancestor_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "media_upload_jobs" ADD CONSTRAINT "media_upload_jobs_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_jobs" ADD CONSTRAINT "media_upload_jobs_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_jobs" ADD CONSTRAINT "media_upload_jobs_source_id_drive_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."drive_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_jobs" ADD CONSTRAINT "media_upload_jobs_credential_id_drive_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."drive_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_upload_jobs_active_uq" ON "media_upload_jobs" USING btree ("ad_account_id","drive_file_id","content_key") WHERE "media_upload_jobs"."status" in ('queued','uploading','processing');--> statement-breakpoint
CREATE INDEX "media_upload_jobs_mcp_created_idx" ON "media_upload_jobs" USING btree ("mcp_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_upload_jobs_status_updated_idx" ON "media_upload_jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "media_upload_jobs_ad_account_idx" ON "media_upload_jobs" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "media_upload_jobs_source_idx" ON "media_upload_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "media_upload_jobs_credential_idx" ON "media_upload_jobs" USING btree ("credential_id");--> statement-breakpoint
ALTER TABLE "drive_relay_links" ADD CONSTRAINT "drive_relay_links_source_id_drive_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."drive_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_relay_links_source_idx" ON "drive_relay_links" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "drive_sources_ancestor_ids_gin" ON "drive_sources" USING gin ("ancestor_ids");