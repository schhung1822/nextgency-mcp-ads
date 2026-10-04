-- Monthly partition management for append-only log tables (UTC months, names <parent>_pYYYYMM).
CREATE OR REPLACE FUNCTION app_ensure_monthly_partitions(p_parent text, p_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE base timestamp := date_trunc('month', now() AT TIME ZONE 'UTC'); i int;
BEGIN
  FOR i IN 0..p_ahead LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      p_parent || '_p' || to_char(base + make_interval(months => i), 'YYYYMM'), p_parent,
      (base + make_interval(months => i))     AT TIME ZONE 'UTC',
      (base + make_interval(months => i + 1)) AT TIME ZONE 'UTC');
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_drop_expired_partitions(p_parent text, p_keep_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
  cutoff text := to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_keep_months), 'YYYYMM');
BEGIN
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
           WHERE p.relname = p_parent AND c.relname ~ ('^' || p_parent || '_p[0-9]{6}$') LOOP
    IF right(r.relname, 6) < cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_call_logs_default" PARTITION OF "mcp_call_logs" DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_logs_default" PARTITION OF "activity_logs" DEFAULT;
--> statement-breakpoint
SELECT app_ensure_monthly_partitions('mcp_call_logs', 3), app_ensure_monthly_partitions('activity_logs', 3);
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_call_logs_error_trgm_idx" ON "mcp_call_logs" USING gin ("error_message" gin_trgm_ops) WHERE "error_message" IS NOT NULL;
