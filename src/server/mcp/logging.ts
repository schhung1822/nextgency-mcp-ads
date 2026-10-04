// One mcp_call_logs row per JSON-RPC request (tools/call rows are written by the tool wrapper with
// platform/account/object ids/changes; protocol-level rows by serve.ts). Args/responses are redacted
// and capped (capJson) before they are queued. The raw key never reaches this module.
import { isIP } from "node:net"
import { capJson, LOG_REQUEST_MAX, LOG_RESPONSE_MAX } from "../audit/cap-json"
import { enqueueMcpLog, insertMcpLogNow, type McpCallLogRow } from "../audit/mcp-log-writer"
import { redactString } from "../audit/redact"
import { safeErrorForLog } from "../audit/safe-error"
import type { FieldChange } from "../providers/types"
import type { CallLogStatus } from "./errors"
import { detectClient, detectProtocolVersion, type RequestState } from "./request-state"
import type { McpGrant } from "./types"

export type ActionKind = "read" | "write" | "protocol"

export interface CallLogInit {
  method: string
  toolName?: string | null
  jsonrpcId?: string | number | null
  actionKind: ActionKind
  /** request `_meta` merged with the 2026 envelope keys */
  meta?: Record<string, unknown> | null
  /** the logged request payload (tool args / JSON-RPC params) - redacted + capped here */
  request?: unknown
}

export interface LoggedChange {
  object_id: string
  object_name?: string | null
  level?: string | null
  field: string
  before: unknown
  after: unknown
}

export function changesForLog(changes: FieldChange[] | undefined | null): LoggedChange[] | null {
  if (!changes || changes.length === 0) return null
  return changes.slice(0, 200).map((c) => ({
    object_id: c.objectId,
    object_name: c.objectName ?? null,
    level: c.level ?? null,
    field: c.field,
    before: c.before ?? null,
    after: c.after ?? null,
  }))
}

export class CallLog {
  private readonly startedAt = Date.now()
  private finished = false
  platform: string | null = null
  adAccountId: string | null = null
  objectIds: string[] = []
  upstreamRequestIds: string[] = []
  changes: LoggedChange[] | null = null
  pendingActionId: string | null = null

  constructor(
    private readonly grant: McpGrant,
    private readonly req: RequestState,
    private readonly init: CallLogInit
  ) {}

  setTarget(t: { platform?: string | null; accountId?: string | null; objectIds?: (string | null | undefined)[] }) {
    if (t.platform !== undefined) this.platform = t.platform
    if (t.accountId !== undefined) this.adAccountId = t.accountId
    if (t.objectIds) this.addObjectIds(t.objectIds)
  }

  addObjectIds(ids: (string | null | undefined)[]) {
    for (const id of ids) {
      if (id && !this.objectIds.includes(id) && this.objectIds.length < 200) this.objectIds.push(String(id).slice(0, 200))
    }
  }

  addUpstreamRequestId(id: string | null | undefined) {
    if (id && !this.upstreamRequestIds.includes(id) && this.upstreamRequestIds.length < 100) this.upstreamRequestIds.push(id.slice(0, 200))
  }

  setChanges(changes: FieldChange[] | undefined | null) {
    this.changes = changesForLog(changes)
  }

  /**
   * Build and store the row. Write-kind rows are inserted synchronously (the returned promise resolves
   * once committed); read/protocol rows go to the batch writer. Never rejects.
   */
  finish(r: {
    status: CallLogStatus
    errorCode?: string | null
    errorMessage?: string | null
    response?: unknown
    durationMs?: number
  }): Promise<void> {
    if (this.finished) return Promise.resolve()
    this.finished = true
    try {
      const req = capJson(this.init.request, LOG_REQUEST_MAX)
      const res = capJson(r.response, LOG_RESPONSE_MAX)
      const changes = this.changes ? capJson(this.changes, LOG_RESPONSE_MAX) : null
      const client = detectClient(this.req, this.init.meta)
      const row: McpCallLogRow = {
        mcpId: this.grant.mcpId,
        mcpName: this.grant.mcpName,
        ownerId: this.grant.ownerId,
        ownerEmail: this.grant.ownerEmail,
        jsonrpcId: this.init.jsonrpcId === null || this.init.jsonrpcId === undefined ? null : String(this.init.jsonrpcId).slice(0, 200),
        method: this.init.method.slice(0, 100),
        toolName: this.init.toolName ?? null,
        protocolVersion: detectProtocolVersion(this.req, this.init.meta),
        clientName: client.name,
        clientVersion: client.version,
        ip: this.req.ip && isIP(this.req.ip) ? this.req.ip : null,
        userAgent: this.req.userAgent ? redactString(this.req.userAgent).slice(0, 500) : null,
        platform: this.platform,
        adAccountId: this.adAccountId,
        objectIds: this.objectIds.length ? this.objectIds : null,
        actionKind: this.init.actionKind,
        status: r.status,
        errorCode: r.errorCode ? r.errorCode.slice(0, 100) : null,
        errorMessage: r.errorMessage ? redactString(r.errorMessage).slice(0, 2000) : null,
        upstreamRequestIds: this.upstreamRequestIds.length ? this.upstreamRequestIds : null,
        durationMs: Math.max(0, Math.round(r.durationMs ?? Date.now() - this.startedAt)),
        request: req.json,
        response: res.json,
        changes: changes?.json ?? null,
        pendingActionId: this.pendingActionId,
        requestBytes: req.bytes,
        responseBytes: res.bytes,
        truncated: req.truncated || res.truncated || (changes?.truncated ?? false),
      }
      if (this.init.actionKind === "write") return insertMcpLogNow(row)
      enqueueMcpLog(row)
    } catch (e) {
      console.error("[mcp-log] failed to build log row", safeErrorForLog(e))
    }
    return Promise.resolve()
  }
}

/**
 * Run `fn` with a CallLog; whatever happens, exactly one row is queued. `fn` decides the final status
 * by calling log.finish() itself (preferred) - otherwise success/error is recorded here.
 */
export async function withCallLogging<T>(
  grant: McpGrant,
  req: RequestState,
  init: CallLogInit,
  fn: (log: CallLog) => Promise<T>
): Promise<T> {
  const log = new CallLog(grant, req, init)
  try {
    const out = await fn(log)
    await log.finish({ status: "success" })
    return out
  } catch (e) {
    await log.finish({ status: "error", errorCode: "internal_error", errorMessage: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
