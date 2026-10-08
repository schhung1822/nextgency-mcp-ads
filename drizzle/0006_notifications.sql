CREATE TABLE "mcp_notification_scopes" (
	"mcp_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	CONSTRAINT "mcp_notification_scopes_mcp_id_channel_id_pk" PRIMARY KEY("mcp_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" text NOT NULL,
	"type" text DEFAULT 'telegram' NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"credential_hint" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"all_connections" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"last_sent_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notification_channels_type_chk" CHECK ("notification_channels"."type" in ('telegram')),
	CONSTRAINT "notification_channels_status_chk" CHECK ("notification_channels"."status" in ('active','error','disabled')),
	CONSTRAINT "notification_channels_events_chk" CHECK ("notification_channels"."events" <@ array['connection_health','system_update']::text[])
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"mcp_id" uuid,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"telegram_message_id" bigint,
	"error_code" integer,
	"error_message" text,
	"preview" text DEFAULT '' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_dedupe_uq" UNIQUE("channel_id","dedupe_key"),
	CONSTRAINT "notification_deliveries_source_chk" CHECK ("notification_deliveries"."source" in ('system','mcp_tool','mcp_write','test')),
	CONSTRAINT "notification_deliveries_status_chk" CHECK ("notification_deliveries"."status" in ('pending','sent','failed')),
	CONSTRAINT "notification_deliveries_event_chk" CHECK ("notification_deliveries"."event_type" in ('connection_expiring','connection_invalid','connection_recovered','update_available','update_succeeded','update_failed','mcp_write','mcp_message','test'))
);
--> statement-breakpoint
ALTER TABLE "mcp_notification_scopes" ADD CONSTRAINT "mcp_notification_scopes_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_notification_scopes" ADD CONSTRAINT "mcp_notification_scopes_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_notification_scopes_channel_idx" ON "mcp_notification_scopes" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "notification_channels_owner_idx" ON "notification_channels" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_created_idx" ON "notification_deliveries" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_mcp_created_idx" ON "notification_deliveries" USING btree ("mcp_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries" USING btree ("created_at");