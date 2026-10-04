// Build a ProviderContext for one granted ad account. Credentials are decrypted inside the request
// scope only (per tool call cache, dropped when the call ends) - never returned, logged or cached globally.
import { and, eq, isNull } from "drizzle-orm"
import { aad, decryptJson } from "../crypto/secret-box"
import { db } from "../db/client"
import { connections } from "../db/schema"
import type { ConnectionContext, ProviderContext, UpstreamEvent } from "../providers/types"
import { McpToolError } from "./errors"
import type { GrantAccount } from "./types"

interface LoadedConnection {
  credentials: unknown
  meta: Record<string, unknown>
}

export interface ProviderContextFactory {
  (account: GrantAccount): Promise<ProviderContext>
  /** context of a granted connection without an ad account (Facebook Pages tools) - same re-checks */
  connection(connectionId: string): Promise<ConnectionContext & { connectionId: string }>
  /** connection ids a context was built for during this tool call */
  readonly touched: ReadonlySet<string>
}

/**
 * Returns a factory scoped to one tool call. `onUpstream` receives every upstream event (request ids
 * are added to the call log). `signal` aborts upstream calls when the client cancels / times out.
 */
export function providerContextFactory(opts: {
  ownerId: string
  ownerIsAdmin: boolean
  signal?: AbortSignal
  onUpstream?: (e: UpstreamEvent) => void
}): ProviderContextFactory {
  const loaded = new Map<string, Promise<LoadedConnection>>()

  async function load(connectionId: string): Promise<LoadedConnection> {
    const rows = await db
      .select({
        id: connections.id,
        ownerId: connections.ownerId,
        status: connections.status,
        credentialsEncrypted: connections.credentialsEncrypted,
        meta: connections.meta,
      })
      .from(connections)
      .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
      .limit(1)
    const c = rows[0]
    // re-check (the grant may be a few seconds old): disabled / deleted / foreign connections are refused
    if (!c || c.status === "disabled" || (!opts.ownerIsAdmin && c.ownerId !== opts.ownerId)) {
      throw new McpToolError({
        code: "connection_unavailable",
        messageVi: "Kết nối của tài khoản quảng cáo này đã bị tắt hoặc không còn tồn tại.",
        hint: "Gọi ads_list_accounts để xem các tài khoản còn dùng được.",
        logStatus: "denied",
      })
    }
    if (c.status === "invalid") {
      throw new McpToolError({
        code: "auth_invalid",
        messageVi: "Token của kết nối này đã hết hạn hoặc bị thu hồi.",
        hint: "Cập nhật token trong trang Kết nối của Ads MCP rồi thử lại.",
      })
    }
    let credentials: unknown
    try {
      credentials = decryptJson(c.credentialsEncrypted, aad.connectionCredentials(c.id))
    } catch {
      throw new McpToolError({
        code: "credentials_unreadable",
        messageVi: "Không giải mã được thông tin đăng nhập của kết nối.",
        hint: "Quản trị viên cần kiểm tra cấu hình ENCRYPTION_KEYS hoặc nhập lại token cho kết nối.",
      })
    }
    const meta = c.meta && typeof c.meta === "object" && !Array.isArray(c.meta) ? (c.meta as Record<string, unknown>) : {}
    return { credentials, meta }
  }

  const touched = new Set<string>()
  const loadOnce = (connectionId: string): Promise<LoadedConnection> => {
    touched.add(connectionId)
    let p = loaded.get(connectionId)
    if (!p) {
      p = load(connectionId)
      loaded.set(connectionId, p)
      // do not keep a rejected promise around (allows a retry inside the same call)
      p.catch(() => loaded.delete(connectionId))
    }
    return p
  }
  const connection = async (connectionId: string) => {
    const conn = await loadOnce(connectionId)
    return { connectionId, credentials: conn.credentials, connectionMeta: conn.meta, signal: opts.signal, onUpstream: opts.onUpstream }
  }
  const factory = async (account: GrantAccount): Promise<ProviderContext> => {
    const conn = await loadOnce(account.connectionId)
    return {
      connectionId: account.connectionId,
      credentials: conn.credentials,
      connectionMeta: conn.meta,
      account: {
        id: account.id,
        externalId: account.externalId,
        name: account.name,
        currency: account.currency,
        timezone: account.timezone,
      },
      signal: opts.signal,
      onUpstream: opts.onUpstream,
    }
  }
  return Object.assign(factory, { touched, connection })
}
