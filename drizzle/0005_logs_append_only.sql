-- Append-only guard for the log tables (defense in depth: the DB owner/superuser can still bypass it deliberately).
-- UPDATE / DELETE (row trigger on the partitioned parent, cloned by Postgres to every existing and future partition)
-- and TRUNCATE of the parent (statement trigger) raise SQLSTATE 42501 unless the session/transaction sets
-- ads_mcp.log_mutation = 'allow' (tests and dev cleanup only; production code never sets it).
-- Retention drops whole monthly partitions (app_drop_expired_partitions -> DROP TABLE): no DML trigger fires.
-- CREATE TRIGGER briefly takes SHARE ROW EXCLUSIVE on the tables (the running app keeps inserting logs during an
-- update): never queue behind a long transaction for more than 30 s - the migration fails and is retried instead.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ads_mcp.log_mutation', true) IS NOT DISTINCT FROM 'allow' THEN
    IF TG_LEVEL = 'ROW' THEN RETURN COALESCE(NEW, OLD); END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'append-only log table "%": % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Log rows are removed only by dropping expired monthly partitions (logs.maintain).';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "activity_logs_append_only" ON "activity_logs";
--> statement-breakpoint
CREATE TRIGGER "activity_logs_append_only" BEFORE UPDATE OR DELETE ON "activity_logs" FOR EACH ROW EXECUTE FUNCTION app_logs_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "activity_logs_no_truncate" ON "activity_logs";
--> statement-breakpoint
CREATE TRIGGER "activity_logs_no_truncate" BEFORE TRUNCATE ON "activity_logs" FOR EACH STATEMENT EXECUTE FUNCTION app_logs_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_call_logs_append_only" ON "mcp_call_logs";
--> statement-breakpoint
CREATE TRIGGER "mcp_call_logs_append_only" BEFORE UPDATE OR DELETE ON "mcp_call_logs" FOR EACH ROW EXECUTE FUNCTION app_logs_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_call_logs_no_truncate" ON "mcp_call_logs";
--> statement-breakpoint
CREATE TRIGGER "mcp_call_logs_no_truncate" BEFORE TRUNCATE ON "mcp_call_logs" FOR EACH STATEMENT EXECUTE FUNCTION app_logs_append_only();
--> statement-breakpoint
-- the migrator applies every pending migration in ONE transaction: restore the session value for the ones after this
SET LOCAL lock_timeout TO DEFAULT;
