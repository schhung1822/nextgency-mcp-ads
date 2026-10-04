// Per-HTTP-request state shared between serve.ts (pre-SDK) and tool handlers (inside the SDK),
// carried through the SDK as authInfo.extra (pass-through, never derived from headers).
import type { AuthInfo } from "@modelcontextprotocol/server"
import { invalid } from "./errors"
import type { McpGrant } from "./types"

export const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion"
export const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo"

export interface PeekedMessage {
  id: string | number | null
  method: string | null
  params: unknown
  kind: "request" | "notification" | "response" | "invalid"
}

export interface ClientIdentity {
  name: string | null
  version: string | null
}

export interface RequestState {
  startedAt: number
  httpMethod: string
  ip: string | null
  userAgent: string | null
  /** MCP-Protocol-Version header */
  protocolVersionHeader: string | null
  /** JSON-RPC messages found in the POST body (empty for GET/DELETE or unparsable bodies) */
  messages: PeekedMessage[]
  /** jsonrpc ids of tools/call requests already logged by the tool wrapper */
  loggedCallIds: Set<string>
  /** request size in bytes */
  requestBytes: number
}

export interface McpAuthExtra {
  [key: string]: unknown
  grant: McpGrant
  req: RequestState
}

export function buildAuthInfo(grant: McpGrant, req: RequestState): AuthInfo {
  const scopes = Object.entries(grant.permissions).flatMap(([p, perms]) => (perms ?? []).map((x) => `${p}:${x}`))
  // token/clientId are the MCP id - the raw key never leaves serve.ts
  return { token: grant.mcpId, clientId: grant.mcpId, scopes, extra: { grant, req } satisfies McpAuthExtra }
}

/** Read grant + request state from a handler context (`ctx.http?.authInfo`). */
export function extraFromAuthInfo(authInfo: AuthInfo | undefined): McpAuthExtra {
  const extra = authInfo?.extra as Partial<McpAuthExtra> | undefined
  if (!extra?.grant || !extra.req) {
    // should never happen: serve.ts always passes authInfo
    throw invalid("no_grant", "Thiếu thông tin quyền của MCP cho yêu cầu này.")
  }
  return extra as McpAuthExtra
}

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null
}

/** Parse "name/version" from the first product token of a User-Agent. */
export function clientFromUserAgent(ua: string | null): ClientIdentity {
  if (!ua) return { name: null, version: null }
  const m = /^\s*([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._+-]+))?/.exec(ua)
  if (!m) return { name: ua.slice(0, 100), version: null }
  return { name: m[1]!.slice(0, 100), version: m[2]?.slice(0, 50) ?? null }
}

/** Client identity: 2026 envelope clientInfo → initialize clientInfo in this request → User-Agent. */
export function detectClient(req: RequestState, meta?: Record<string, unknown> | null): ClientIdentity {
  const env = meta?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined
  if (env && str(env.name)) return { name: str(env.name, 100), version: str(env.version, 50) }
  for (const m of req.messages) {
    if (m.method === "initialize") {
      const ci = (m.params as { clientInfo?: { name?: unknown; version?: unknown } } | null)?.clientInfo
      if (ci && str(ci.name)) return { name: str(ci.name, 100), version: str(ci.version, 50) }
    }
    const pm = (m.params as { _meta?: Record<string, unknown> } | null)?._meta
    const ci = pm?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined
    if (ci && str(ci.name)) return { name: str(ci.name, 100), version: str(ci.version, 50) }
  }
  if (meta && Object.keys(meta).some((k) => k.startsWith("openai/"))) {
    const ua = clientFromUserAgent(req.userAgent)
    return { name: ua.name ?? "chatgpt", version: ua.version }
  }
  return clientFromUserAgent(req.userAgent)
}

/** Protocol version: envelope → header → initialize params. */
export function detectProtocolVersion(req: RequestState, meta?: Record<string, unknown> | null): string | null {
  const env = str(meta?.[PROTOCOL_VERSION_META_KEY], 40)
  if (env) return env
  if (req.protocolVersionHeader) return req.protocolVersionHeader.slice(0, 40)
  for (const m of req.messages) {
    const pm = (m.params as { _meta?: Record<string, unknown> } | null)?._meta
    const v = str(pm?.[PROTOCOL_VERSION_META_KEY], 40)
    if (v) return v
    if (m.method === "initialize") {
      const pv = str((m.params as { protocolVersion?: unknown } | null)?.protocolVersion, 40)
      if (pv) return pv
    }
  }
  return null
}

/** Classify a parsed JSON-RPC body into messages (best effort, for logging only). */
export function peekMessages(body: unknown): PeekedMessage[] {
  const list = Array.isArray(body) ? body : [body]
  return list.slice(0, 50).map((m): PeekedMessage => {
    if (!m || typeof m !== "object") return { id: null, method: null, params: null, kind: "invalid" }
    const o = m as Record<string, unknown>
    const id = typeof o.id === "string" || typeof o.id === "number" ? o.id : null
    const method = typeof o.method === "string" ? o.method.slice(0, 100) : null
    if (method) return { id, method, params: o.params ?? null, kind: id === null ? "notification" : "request" }
    if ("result" in o || "error" in o) return { id, method: null, params: null, kind: "response" }
    return { id, method: null, params: null, kind: "invalid" }
  })
}
