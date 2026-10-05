// Entry point for /mcp/<key> (framework-agnostic: Request in, Response out - no next/* imports).
// Order: Host/Origin → key (unknown key: per-client 404 limiter; blocked client: active-key set) → IP allowlist → browser page →
// per-MCP rate limit (per JSON-RPC message) → body bound → SDK handler. Unknown/disabled/expired/deleted keys → 404 {"error":"not_found"}, never 401.
import { hostHeaderValidationResponse, originValidationResponse, readRequestBody } from "@modelcontextprotocol/server"
import { sql } from "drizzle-orm"
import { safeErrorForLog } from "../audit/safe-error"
import { db } from "../db/client"
import { env, isProduction } from "../env"
import { isActiveMcpKey, loadGrantByKey } from "./grant"
import { MAX_REQUEST_BODY_BYTES, mcpHandler } from "./handler"
import { stripUrlQueries } from "./log-args"
import { CallLog, type ActionKind } from "./logging"
import { clientIpFromHeaders, ipAllowed } from "./net"
import { consumeMcpRate, notFoundBlocked, recordNotFound } from "./rate-limit"
import { COMMON_TOOL_PERMISSIONS } from "./registry"
import { buildAuthInfo, detectClient, peekMessages, type PeekedMessage, type RequestState } from "./request-state"
import type { CallLogStatus } from "./errors"
import type { McpGrant } from "./types"

const BASE_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
}

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...extra })) headers.set(k, v)
  // never let anything trigger OAuth discovery on clients
  headers.delete("WWW-Authenticate")
  if ((headers.get("content-type") ?? "").includes("text/event-stream")) headers.set("X-Accel-Buffering", "no")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return withHeaders(Response.json(body, { status }), extra)
}

export function notFoundResponse(): Response {
  return json(404, { error: "not_found" })
}

const BROWSER_PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Endpoint MCP</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#1f2937;line-height:1.6}h1{font-size:20px}p{color:#4b5563}</style>
</head><body><h1>Đây là endpoint MCP</h1>
<p>Đây là endpoint MCP - dán link này vào Claude, ChatGPT hoặc Gemini (mục Connectors / MCP server) để AI dùng được. Không cần mở link này bằng trình duyệt.</p>
<p>Giữ link này bí mật: ai có link đều dùng được MCP.</p></body></html>`

function browserPage(): Response {
  return withHeaders(
    new Response(BROWSER_PAGE, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Robots-Tag": "noindex",
      },
    })
  )
}

function allowedHostnames(): string[] {
  const domain = env().APP_DOMAIN.trim().toLowerCase().replace(/:\d+$/, "")
  const list = [domain]
  if (!isProduction()) list.push("localhost", "127.0.0.1", "[::1]")
  return [...new Set(list.filter(Boolean))]
}

// ---------------------------------------------------------------------------
// last_used_at / last_client (at most once per minute per MCP)
// ---------------------------------------------------------------------------
const g = globalThis as unknown as { __adsMcpLastUsed?: Map<string, number>; __adsMcpRejectLog?: Map<string, { at: number; n: number }> }
const lastUsed = (g.__adsMcpLastUsed ??= new Map())
const rejectLog = (g.__adsMcpRejectLog ??= new Map())

function touchLastUsed(grant: McpGrant, req: RequestState) {
  const now = Date.now()
  const prev = lastUsed.get(grant.mcpId) ?? 0
  if (now - prev < 60_000) return
  lastUsed.set(grant.mcpId, now)
  if (lastUsed.size > 10_000) lastUsed.clear()
  const c = detectClient(req)
  const client = c.name ? `${c.name}${c.version ? ` ${c.version}` : ""}`.slice(0, 120) : null
  // raw SQL on purpose: usage must not bump updated_at
  db.execute(
    sql`update mcp_servers set last_used_at = now(), last_client = coalesce(${client}, last_client) where id = ${grant.mcpId}`
  ).catch((e: unknown) => console.warn("[mcp] last_used update failed", safeErrorForLog(e)))
}

// ---------------------------------------------------------------------------
// Protocol-level logging (initialize, tools/list, notifications, rejected requests, tools/call that
// never reached a tool handler). Tool handlers log their own rows (richer: platform, account, changes).
// ---------------------------------------------------------------------------
interface RpcAnswer {
  id: string | number | null
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

async function readAnswers(res: Response): Promise<RpcAnswer[]> {
  const type = res.headers.get("content-type") ?? ""
  const text = await res.text()
  if (!text) return []
  const values: unknown[] = []
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      try {
        values.push(JSON.parse(data))
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      values.push(JSON.parse(text))
    } catch {
      return []
    }
  }
  return values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is RpcAnswer => !!v && typeof v === "object")
}

function responseSummary(method: string | null, a: RpcAnswer | undefined): unknown {
  if (!a) return null
  if (a.error) return { error: a.error }
  const r = a.result ?? {}
  if (method === "tools/list") return { tools: Array.isArray(r.tools) ? (r.tools as { name?: string }[]).map((t) => t.name) : [] }
  if (method === "initialize" || method === "server/discover") {
    return { protocolVersion: r.protocolVersion ?? null, serverInfo: r.serverInfo ?? null, supportedVersions: r.supportedVersions ?? null }
  }
  if (method === "tools/call") return { isError: r.isError ?? false, content: r.content }
  return r
}

function statusFromAnswer(a: RpcAnswer | undefined, httpStatus: number, isToolCall: boolean): { status: CallLogStatus; code: string | null; message: string | null } {
  if (a?.error) {
    const code = a.error.code
    const invalidCodes = [-32700, -32600, -32601, -32602, -32020]
    return {
      status: typeof code === "number" && invalidCodes.includes(code) ? "invalid_request" : "error",
      code: code !== undefined ? `jsonrpc_${code}` : "jsonrpc_error",
      message: typeof a.error.message === "string" ? a.error.message : null,
    }
  }
  if (isToolCall && a?.result?.isError) {
    // tools/call answered by the SDK itself (input validation…): the handler never ran
    const content = a.result.content as { text?: string }[] | undefined
    return { status: "invalid_request", code: "invalid_arguments", message: content?.[0]?.text ?? null }
  }
  if (httpStatus >= 400) return { status: httpStatus === 429 ? "rate_limited" : "invalid_request", code: `http_${httpStatus}`, message: null }
  return { status: "success", code: null, message: null }
}

function actionKindForTool(name: unknown): ActionKind {
  if (typeof name !== "string") return "protocol"
  const perm = COMMON_TOOL_PERMISSIONS[name]
  if (perm) return perm === "read" ? "read" : "write"
  return "protocol"
}

function logMessages(grant: McpGrant, req: RequestState, messages: PeekedMessage[], answers: RpcAnswer[], httpStatus: number) {
  const byId = new Map(answers.map((a) => [String(a.id), a]))
  const list: PeekedMessage[] = messages.length
    ? messages
    : [{ id: null, method: `http/${req.httpMethod}`, params: null, kind: "invalid" }]
  for (const m of list) {
    if (m.kind === "response") continue // client → server JSON-RPC responses (legacy) are not requests
    const isToolCall = m.method === "tools/call"
    if (isToolCall && m.id !== null && req.loggedCallIds.has(String(m.id))) continue
    const answer = m.id !== null ? byId.get(String(m.id)) : undefined
    const st = statusFromAnswer(answer, httpStatus, isToolCall)
    const params = (m.params ?? null) as Record<string, unknown> | null
    const log = new CallLog(grant, req, {
      method: m.method ?? "(invalid)",
      toolName: isToolCall && typeof params?.name === "string" ? params.name.slice(0, 100) : null,
      jsonrpcId: m.id,
      actionKind: isToolCall ? actionKindForTool(params?.name) : "protocol",
      meta: (params?._meta as Record<string, unknown> | undefined) ?? null,
      // the SDK rejected these args before any tool ran (no logArgs): signed URL query strings are dropped
      request: isToolCall ? stripUrlQueries(params?.arguments ?? null) : params,
    })
    void log.finish({
      status: st.status,
      errorCode: st.code,
      errorMessage: st.message,
      response: responseSummary(m.method, answer),
      durationMs: Date.now() - req.startedAt,
    })
  }
}

/** Rejected (403/429) requests are logged at most once per MCP+reason every 10 s (flood protection). */
function logRejected(grant: McpGrant, req: RequestState, status: CallLogStatus, code: string, message: string) {
  const key = `${grant.mcpId}:${code}`
  const now = Date.now()
  const prev = rejectLog.get(key)
  if (prev && now - prev.at < 10_000) {
    prev.n++
    return
  }
  rejectLog.set(key, { at: now, n: 0 })
  if (rejectLog.size > 10_000) rejectLog.clear()
  const log = new CallLog(grant, req, { method: `http/${req.httpMethod}`, actionKind: "protocol", request: null })
  void log.finish({ status, errorCode: code, errorMessage: message, response: { suppressed_since_last: prev?.n ?? 0 } })
}

/**
 * Rate-limit cost of a POST body: one per JSON-RPC message that is not a client→server response
 * (a batch of N tools/call costs N; unparsable bodies cost 1). peekMessages() only looks at the
 * first 50 entries, so count the raw array here.
 */
export function rateCost(body: unknown): number {
  if (!Array.isArray(body)) return 1
  let n = 0
  for (const m of body) {
    const isResponse = !!m && typeof m === "object" && !("method" in m) && ("result" in m || "error" in m)
    if (!isResponse) n++
  }
  return Math.max(1, n)
}

// ---------------------------------------------------------------------------

export async function serveMcp(request: Request, rawKey: string): Promise<Response> {
  const startedAt = Date.now()
  const allowed = allowedHostnames()
  const rejected = hostHeaderValidationResponse(request, allowed) ?? originValidationResponse(request, allowed)
  if (rejected) return withHeaders(rejected)

  const ip = clientIpFromHeaders(request.headers)

  // The per-client 404 limiter only answers 429 for keys that do not resolve, so a client sharing an IP / NAT /
  // proxy (or a connector cloud egress IP) with a key-guesser keeps access with a valid key. While a client is
  // blocked, its key is checked against the in-memory set of usable MCP keys first: a valid key goes on to the normal
  // lookup, anything else gets 429 without a per-request database query.
  const blocked = notFoundBlocked(ip)
  let grant: McpGrant | null
  try {
    if (!blocked.ok && !(await isActiveMcpKey(rawKey))) {
      return json(429, { error: "rate_limited" }, { "Retry-After": String(blocked.retryAfterSec) })
    }
    grant = await loadGrantByKey(rawKey)
  } catch (e) {
    console.error("[mcp] grant lookup failed", safeErrorForLog(e))
    return json(503, { error: "unavailable" }, { "Retry-After": "5" })
  }
  if (!grant) {
    if (!blocked.ok) return json(429, { error: "rate_limited" }, { "Retry-After": String(blocked.retryAfterSec) })
    recordNotFound(ip)
    return notFoundResponse()
  }

  const reqState: RequestState = {
    startedAt,
    httpMethod: request.method.toUpperCase(),
    ip,
    userAgent: request.headers.get("user-agent"),
    protocolVersionHeader: request.headers.get("mcp-protocol-version"),
    messages: [],
    loggedCallIds: new Set(),
    requestBytes: 0,
  }

  if (!ipAllowed(grant.settings.allowedIps, ip)) {
    logRejected(grant, reqState, "denied", "ip_not_allowed", `IP ${ip ?? "unknown"} không nằm trong danh sách cho phép`)
    return json(403, { error: "forbidden" })
  }

  if (reqState.httpMethod === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) {
    return browserPage()
  }

  const rate = consumeMcpRate(grant.mcpId, grant.settings.rateLimitPerMin)
  if (!rate.ok) {
    logRejected(grant, reqState, "rate_limited", "rate_limited", `Vượt giới hạn ${grant.settings.rateLimitPerMin} lệnh/phút`)
    return json(429, { error: "rate_limited" }, { "Retry-After": String(rate.retryAfterSec) })
  }

  let forward: Request = request
  if (reqState.httpMethod === "POST") {
    const body = await readRequestBody(request, MAX_REQUEST_BODY_BYTES)
    if (body.tooLarge) {
      logRejected(grant, reqState, "invalid_request", "payload_too_large", "Body vượt 1 MB")
      return json(413, { error: "payload_too_large" })
    }
    reqState.requestBytes = Buffer.byteLength(body.text, "utf8")
    let parsed: unknown = null
    try {
      parsed = JSON.parse(body.text)
      reqState.messages = peekMessages(parsed)
    } catch {
      reqState.messages = []
    }
    // a JSON-RPC batch is charged per message (the first one was charged above)
    const extra = rateCost(parsed) - 1
    if (extra > 0) {
      const more = consumeMcpRate(grant.mcpId, grant.settings.rateLimitPerMin, Date.now(), extra)
      if (!more.ok) {
        logRejected(grant, reqState, "rate_limited", "rate_limited", `Vượt giới hạn ${grant.settings.rateLimitPerMin} lệnh/phút (batch)`)
        return json(429, { error: "rate_limited" }, { "Retry-After": String(more.retryAfterSec) })
      }
    }
    forward = new Request(request.url, { method: "POST", headers: request.headers, body: body.text, signal: request.signal })
  }

  touchLastUsed(grant, reqState)

  let res: Response
  try {
    res = await mcpHandler().fetch(forward, { authInfo: buildAuthInfo(grant, reqState) })
  } catch (e) {
    console.error("[mcp] handler failed", safeErrorForLog(e))
    logMessages(grant, reqState, reqState.messages, [], 500)
    return json(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } })
  }

  // log asynchronously from a clone so the client is not delayed (SSE streams are teed)
  const needsLog = reqState.messages.length === 0 || reqState.messages.some((m) => m.kind !== "response")
  if (needsLog) {
    const copy = res.clone()
    const grantRef = grant
    void readAnswers(copy)
      .catch(() => [] as RpcAnswer[])
      .then((answers) => logMessages(grantRef, reqState, reqState.messages, answers, res.status))
      .catch((e: unknown) => console.warn("[mcp] protocol log failed", safeErrorForLog(e)))
  }
  return withHeaders(res)
}
