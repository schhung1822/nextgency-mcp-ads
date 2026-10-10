// One mcp_call_logs row per JSON-RPC request (tools/call rows are written by the tool wrapper with
// platform/account/object ids/changes; protocol-level rows by serve.ts). Args/responses are redacted
// and capped (capJson) before they are queued. The raw key never reaches this module.
import { isIP } from "node:net"
import { capJson, LOG_REQUEST_MAX, LOG_RESPONSE_MAX } from "../audit/cap-json"
import { enqueueMcpLog, insertMcpLogNow, type McpCallLogRow } from "../audit/mcp-log-writer"
import { redactString } from "../audit/redact"
import { safeErrorForLog } from "../audit/safe-error"
import { STARTED_MAX_DAILY_SPEND_FIELD, type FieldChange } from "../providers/types"
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

/** Max rows of the changes column. */
export const LOG_CHANGES_MAX_ROWS = 200
/** Longest object_name kept in a logged change. */
export const LOG_CHANGE_NAME_MAX = 120
/** Largest before / after value (JSON bytes) kept as is; bigger → {_truncated, _bytes, preview}. */
export const LOG_CHANGE_VALUE_MAX = 8192
/** Smaller per-value cap used when the whole column is still too big. */
const LOG_CHANGE_VALUE_SHRUNK = 256
/**
 * Budget of the whole changes column - well below LOG_RESPONSE_MAX so capJson (finish) never replaces the ARRAY with
 * a {_truncated, preview} object: the STARTED_MAX_DAILY_SPEND_FIELD rows read back by the cumulative cap (S5) must
 * survive (M3). Rows that do not fit are dropped (started rows never) and counted in a "_changes_truncated" row.
 */
export const LOG_CHANGES_BUDGET = 24 * 1024

function jsonBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "null", "utf8")
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function capChangeValue(v: unknown, max: number): unknown {
  if (v === undefined || v === null) return null
  let s: string
  try {
    s = JSON.stringify(v) ?? "null"
  } catch {
    s = JSON.stringify(String(v))
  }
  const bytes = Buffer.byteLength(s, "utf8")
  if (bytes <= max) return v
  return { _truncated: true, _bytes: bytes, preview: s.slice(0, Math.max(32, Math.floor(max / 4))) }
}

export function changesForLog(changes: FieldChange[] | undefined | null): LoggedChange[] | null {
  if (!changes || changes.length === 0) return null
  const isStarted = (c: FieldChange) => c.field === STARTED_MAX_DAILY_SPEND_FIELD
  // started rows first in the selection (never dropped), original order kept in the output
  const startedCount = Math.min(LOG_CHANGES_MAX_ROWS, changes.filter(isStarted).length)
  let room = LOG_CHANGES_MAX_ROWS - startedCount
  let startedLeft = startedCount
  const picked = changes.filter((c) => (isStarted(c) ? startedLeft-- > 0 : room-- > 0))
  const row = (c: FieldChange, valueMax: number): LoggedChange => ({
    object_id: String(c.objectId).slice(0, 200),
    object_name: c.objectName === null || c.objectName === undefined ? null : String(c.objectName).slice(0, LOG_CHANGE_NAME_MAX),
    level: c.level ? String(c.level).slice(0, 50) : null,
    field: String(c.field).slice(0, 100),
    before: capChangeValue(c.before, valueMax),
    after: capChangeValue(c.after, valueMax),
  })
  let out = picked.map((c) => row(c, LOG_CHANGE_VALUE_MAX))
  if (jsonBytes(out) > LOG_CHANGES_BUDGET)
    out = picked.map((c) => row(c, isStarted(c) ? LOG_CHANGE_VALUE_MAX : LOG_CHANGE_VALUE_SHRUNK))
  let dropped = 0
  for (let i = out.length - 1; i >= 0 && jsonBytes(out) > LOG_CHANGES_BUDGET - 200; i--) {
    if (out[i]!.field === STARTED_MAX_DAILY_SPEND_FIELD) continue
    out.splice(i, 1)
    dropped++
  }
  if (dropped) out.push({ object_id: "-", object_name: null, level: null, field: "_changes_truncated", before: null, after: dropped })
  return out
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
    await log.finish({ status: "error", errorCode: "internal_error", errorMessage: safeErrorForLog(e) })
    throw e
  }
}
