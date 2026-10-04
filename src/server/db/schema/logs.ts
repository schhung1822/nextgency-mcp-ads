// Partitioned (monthly, by created_at) append-only log tables.
// The generated CREATE TABLE migration MUST be hand-edited to add: PARTITION BY RANGE ("created_at").
// No foreign keys: logs must outlive the objects they describe (snapshots are stored instead).
import { sql } from "drizzle-orm"
import { boolean, index, inet, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const mcpCallLogs = pgTable(
  "mcp_call_logs",
  {
    id: uuid("id").notNull().default(sql`uuidv7()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    mcpId: uuid("mcp_id"),
    mcpName: text("mcp_name"),
    ownerId: text("owner_id"),
    ownerEmail: text("owner_email"),
    jsonrpcId: text("jsonrpc_id"),
    method: text("method").notNull(),
    toolName: text("tool_name"),
    protocolVersion: text("protocol_version"),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    platform: text("platform"),
    adAccountId: text("ad_account_id"),
    objectIds: text("object_ids").array(),
    /** read | write | protocol */
    actionKind: text("action_kind").notNull().default("protocol"),
    /** success | error | denied | rate_limited | pending_confirmation | invalid_request */
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    upstreamRequestIds: text("upstream_request_ids").array(),
    durationMs: integer("duration_ms").notNull().default(0),
    request: jsonb("request"),
    response: jsonb("response"),
    changes: jsonb("changes"),
    pendingActionId: uuid("pending_action_id"),
    requestBytes: integer("request_bytes"),
    responseBytes: integer("response_bytes"),
    truncated: boolean("truncated").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.createdAt, t.id] }),
    index("mcp_call_logs_mcp_time_idx").on(t.mcpId, t.createdAt.desc()),
    index("mcp_call_logs_owner_time_idx").on(t.ownerId, t.createdAt.desc()),
    index("mcp_call_logs_account_time_idx").on(t.platform, t.adAccountId, t.createdAt.desc()),
    index("mcp_call_logs_errors_idx")
      .on(t.createdAt.desc())
      .where(sql`${t.status} <> 'success'`),
  ]
)

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").notNull().default(sql`uuidv7()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    /** success | failure */
    status: text("status").notNull().default("success"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.createdAt, t.id] }),
    index("activity_logs_actor_time_idx").on(t.actorId, t.createdAt.desc()),
    index("activity_logs_action_time_idx").on(t.action, t.createdAt.desc()),
    index("activity_logs_target_time_idx").on(t.targetType, t.targetId, t.createdAt.desc()),
  ]
)
