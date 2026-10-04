CREATE TABLE "mcp_page_scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"page_id" uuid,
	CONSTRAINT "mcp_page_scopes_uq" UNIQUE NULLS NOT DISTINCT("mcp_id","connection_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "meta_pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"link" text,
	"picture_url" text,
	"followers_count" integer,
	"verification_status" text,
	"is_published" boolean,
	"tasks" text[] DEFAULT '{}'::text[] NOT NULL,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"business_id" text,
	"business_name" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"is_missing" boolean DEFAULT false NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_pages_connection_external_uq" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_page_scopes" ADD CONSTRAINT "mcp_page_scopes_mcp_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_page_scopes" ADD CONSTRAINT "mcp_page_scopes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_page_scopes" ADD CONSTRAINT "mcp_page_scopes_page_id_meta_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."meta_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_pages" ADD CONSTRAINT "meta_pages_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_page_scopes_connection_idx" ON "mcp_page_scopes" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "mcp_page_scopes_page_idx" ON "mcp_page_scopes" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "meta_pages_external_idx" ON "meta_pages" USING btree ("external_id");