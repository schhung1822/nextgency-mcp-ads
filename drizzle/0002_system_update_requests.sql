CREATE TABLE "system_update_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_version" text NOT NULL,
	"target_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text,
	"message" text,
	"log" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_update_requests_status_chk" CHECK ("system_update_requests"."status" in ('pending','running','succeeded','failed','rolled_back')),
	CONSTRAINT "system_update_requests_step_chk" CHECK ("system_update_requests"."step" is null or "system_update_requests"."step" in ('backup','pull','migrate','restart','healthcheck','rollback')),
	CONSTRAINT "system_update_requests_target_chk" CHECK ("system_update_requests"."target_version" ~ '^[0-9]+.[0-9]+.[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "system_update_requests" ADD CONSTRAINT "system_update_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "system_update_requests_open_uq" ON "system_update_requests" USING btree ((true)) WHERE "system_update_requests"."status" in ('pending','running');--> statement-breakpoint
CREATE INDEX "system_update_requests_created_idx" ON "system_update_requests" USING btree ("created_at" DESC NULLS LAST);