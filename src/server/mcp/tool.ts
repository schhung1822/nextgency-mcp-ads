// Tool runtime: registers a tool on the per-request McpServer and wraps its handler with
// grant plumbing, call logging, error mapping and result shaping (structuredContent + short VI text).
import { createHash } from "node:crypto"
import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server"
import type { z } from "zod"
import { getProvider } from "../providers/registry"
import type { AdsProvider, Capability, FieldChange, Platform } from "../providers/types"
import { argsHash, runConfirmFlow, type PreviewInfo, type StoredOutcome } from "./confirm"
import { noteAuthFailure } from "./connection-health"
import { providerContextFactory, type ProviderContextFactory } from "./context"
import { McpToolError, mapToolError, type CallLogStatus, type ToolErrorPayload } from "./errors"
import { platformLabel } from "./grant"
import { CallLog } from "./logging"
import { appendNotice, currentNoticeText } from "./notices"
import { consumeWriteRate } from "./rate-limit"
import type { RequestState } from "./request-state"
import type { GrantAccount, McpGrant } from "./types"

// ---------------------------------------------------------------------------
// Annotations (04-mcp-design.md §3)
// ---------------------------------------------------------------------------
export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
/** set_status / update_budget / update_object / delete */
export const UPDATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
}
/** create / copy / upload */
export const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

/** Max characters of the structured JSON (the text block repeats it) - keeps results ≲10k tokens. */
export const MAX_STRUCTURED_CHARS = 24_000
/** Per tool-call budget before the upstream calls are aborted (Claude allows ~240 s per call). */
const TOOL_TIMEOUT_MS = 170_000

export interface ToolContext {
  grant: McpGrant
  req: RequestState
}

export interface ToolEnv {
  grant: McpGrant
  req: RequestState
  log: CallLog
  signal: AbortSignal
  providerCtx: ProviderContextFactory
  toolName: string
  /** spec.logArgs(args) when the tool defines it (stored instead of the raw args) */
  storedArgs?: Record<string, unknown>
}

export interface ToolOutcome {
  structured: Record<string, unknown>
  /** 1–2 short Vietnamese sentences */
  summary: string
  status?: CallLogStatus
  /** business error to return as isError (e.g. replay of a failed execution) */
  error?: ToolErrorPayload
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolSpec<S extends z.ZodObject<any>> {
  name: string
  title: string
  description: string
  kind: "read" | "write"
  annotations: ToolAnnotations
  input: S
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: z.ZodObject<any>
  /** transform args before they are logged / stored (e.g. strip signed URL query strings) */
  logArgs?(args: z.infer<S>): Record<string, unknown>
  handler(args: z.infer<S>, env: ToolEnv): Promise<ToolOutcome>
}

export function okResult(structured: Record<string, unknown>, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(structured)}` }],
    structuredContent: structured,
  }
}

export function errorResult(payload: ToolErrorPayload): CallToolResult {
  const lines = [`Lỗi: ${payload.message}`]
  if (payload.hint) lines.push(`Gợi ý: ${payload.hint}`)
  lines.push(JSON.stringify(payload))
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: payload, isError: true }
}

function mergedMeta(ctx: ServerContext): Record<string, unknown> | null {
  const meta = { ...(ctx.mcpReq._meta ?? {}), ...(ctx.mcpReq.envelope ?? {}) } as Record<string, unknown>
  return Object.keys(meta).length ? meta : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerToolSpec<S extends z.ZodObject<any>>(server: McpServer, tctx: ToolContext, spec: ToolSpec<S>) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: { title: spec.title, ...spec.annotations },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (args: any, ctx: ServerContext) => {
      // update / system notices ride along with every result (ok and error) as one extra text item
      const [result, notice] = await Promise.all([runTool(spec, tctx, args as z.infer<S>, ctx), currentNoticeText()])
      return appendNotice(result, notice)
    }) as never
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool<S extends z.ZodObject<any>>(
  spec: ToolSpec<S>,
  tctx: ToolContext,
  args: z.infer<S>,
  ctx: ServerContext
): Promise<CallToolResult> {
  const { grant, req } = tctx
  const jsonrpcId = ctx.mcpReq.id
  req.loggedCallIds.add(String(jsonrpcId))
  const log = new CallLog(grant, req, {
    method: "tools/call",
    toolName: spec.name,
    jsonrpcId,
    actionKind: spec.kind,
    meta: mergedMeta(ctx),
    request: spec.logArgs ? spec.logArgs(args) : args,
  })
  const signal = AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)])
  const env: ToolEnv = {
    grant,
    req,
    log,
    signal,
    toolName: spec.name,
    storedArgs: spec.logArgs ? spec.logArgs(args) : undefined,
    providerCtx: providerContextFactory({
      ownerId: grant.ownerId,
      ownerIsAdmin: grant.ownerRole === "admin",
      signal,
      onUpstream: (e) => log.addUpstreamRequestId(e.requestId ?? null),
    }),
  }
  // write rows are inserted synchronously (durable before the answer leaves); reads go to the batch writer
  try {
    const out = await spec.handler(args, env)
    if (out.error) {
      await log.finish({ status: "error", errorCode: out.error.code, errorMessage: out.error.message, response: out.error })
      return errorResult(out.error)
    }
    const structured = out.structured
    await log.finish({ status: out.status ?? "success", response: structured })
    return okResult(structured, out.summary)
  } catch (e) {
    // a revoked/expired token: flag the connection so the UI shows it (only when the call used one)
    if (env.providerCtx.touched.size === 1) await noteAuthFailure(e, [...env.providerCtx.touched][0])
    const mapped = mapToolError(e)
    log.addUpstreamRequestId(mapped.upstreamRequestId)
    await log.finish({
      status: mapped.logStatus,
      errorCode: mapped.payload.code,
      errorMessage: mapped.logMessage,
      response: mapped.payload,
    })
    return errorResult(mapped.payload)
  }
}

// ---------------------------------------------------------------------------
// Helpers for handlers
// ---------------------------------------------------------------------------

/** Provider for a platform, refusing capabilities the adapter declares unsupported. */
export function providerFor(platform: Platform, capability?: Capability): AdsProvider {
  const provider = getProvider(platform)
  if (capability && provider.capabilities?.[capability] === "unsupported") {
    throw new McpToolError({
      code: "unsupported",
      messageVi: `${platformLabel(platform)} không hỗ trợ thao tác này.`,
      hint: "Thao tác này không có trên nền tảng đã chọn.",
    })
  }
  return provider
}

export interface WriteExecution {
  structured: Record<string, unknown>
  summary: string
  changes?: FieldChange[]
}

/**
 * Idempotency key handed to the adapter for an executed write. Deterministic (never random) so an
 * adapter-level retry after a 5xx/timeout cannot create duplicates:
 *  - caller-supplied idempotency_key → scoped to MCP + tool
 *  - confirmed action → the consumed mcp_pending_actions id
 *  - two-step off → MCP + tool + args hash + minute bucket
 */
export function writeIdempotencyKey(
  o: { mcpId: string; toolName: string; args: Record<string, unknown>; pendingActionId: string | null },
  now = Date.now()
): string {
  const user = typeof o.args.idempotency_key === "string" ? o.args.idempotency_key.trim() : ""
  const material = user
    ? `user\n${o.mcpId}\n${o.toolName}\n${user}`
    : o.pendingActionId
      ? `pending\n${o.pendingActionId}`
      : `auto\n${o.mcpId}\n${o.toolName}\n${argsHash(o.toolName, o.args)}\n${Math.floor(now / 60_000)}`
  return `mcpw-${createHash("sha256").update(material).digest("hex").slice(0, 40)}`
}

/**
 * Standard write path: write rate limit → two-step confirmation (when enabled / always for delete) →
 * execute once (deterministic idempotency key) → changes recorded in the call log. Guardrails must be
 * checked by the caller BEFORE this (on both steps).
 */
export async function runWrite(
  env: ToolEnv,
  o: {
    args: Record<string, unknown>
    account: GrantAccount
    alwaysConfirm?: boolean
    preview: () => Promise<PreviewInfo>
    execute: (idempotencyKey: string) => Promise<WriteExecution>
  }
): Promise<ToolOutcome> {
  const base = { platform: o.account.platform, account_id: o.account.externalId }
  const flow = await runConfirmFlow({
    grant: env.grant,
    toolName: env.toolName,
    args: o.args,
    storedArgs: env.storedArgs,
    alwaysConfirm: o.alwaysConfirm,
    preview: o.preview,
    // the write quota is spent by real executions only (not by previews, replays of a consumed token or invalid tokens)
    admit: () => {
      const limit = env.grant.settings.writeRateLimitPer10Min
      const d = consumeWriteRate(env.grant.mcpId, limit)
      if (!d.ok) {
        throw new McpToolError({
          code: "write_rate_limited",
          messageVi: `MCP này đã thực hiện ${limit} thao tác ghi trong 10 phút qua - vượt giới hạn.`,
          hint: `Thử lại sau khoảng ${Math.ceil(d.retryAfterSec / 60)} phút (confirm_token vẫn dùng được nếu chưa hết hạn), hoặc nhờ chủ MCP nâng giới hạn.`,
          logStatus: "rate_limited",
        })
      }
    },
    execute: async (pendingActionId): Promise<StoredOutcome> => {
      const r = await o.execute(writeIdempotencyKey({ mcpId: env.grant.mcpId, toolName: env.toolName, args: o.args, pendingActionId }))
      // the logs UI ("Trước → Sau") reads only the changes column: never leave it empty for an executed write
      env.log.setChanges(
        r.changes?.length ? r.changes : [{ objectId: "-", field: env.toolName, before: null, after: r.structured.result ?? r.summary }]
      )
      return { ok: true, structured: { status: "success", ...base, ...r.structured }, summary: r.summary }
    },
  })
  if (flow.kind === "pending") {
    env.log.pendingActionId = flow.pendingActionId
    const n = flow.preview.changes.length
    return {
      structured: { ...flow.out, ...base },
      summary: `CHƯA thực hiện - cần người dùng xác nhận ${n} thay đổi. Trình bày preview cho người dùng và CHỜ họ đồng ý rõ ràng; chỉ khi đó mới gọi lại với cùng tham số kèm confirm_token.`,
      status: "pending_confirmation",
    }
  }
  env.log.pendingActionId = flow.pendingActionId
  if (!flow.outcome.ok) return { structured: {}, summary: "", error: flow.outcome.error }
  if (flow.kind === "replayed") {
    return {
      structured: { ...flow.outcome.structured, replayed: true },
      summary: `${flow.outcome.summary} (kết quả của lần thực thi trước - không thực thi lại)`,
    }
  }
  return { structured: { ...flow.outcome.structured, replayed: false }, summary: flow.outcome.summary }
}

/** JSON length helper for size budgeting. */
export function jsonLength(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0
}
