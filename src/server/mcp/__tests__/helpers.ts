// Test helpers: dev-DB fixtures (unique prefix + cleanup) and JSON-RPC request builders.
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { eq, inArray } from "drizzle-orm"

/** Load .env (DATABASE_URL…) for integration tests; returns false when no database is configured. */
export function loadTestEnv(): boolean {
  const file = path.resolve(process.cwd(), ".env")
  if (!process.env.DATABASE_URL && existsSync(file)) {
    try {
      process.loadEnvFile(file)
    } catch {
      /* ignore */
    }
  }
  return Boolean(process.env.DATABASE_URL)
}

export const TEST_HOST = "mcp.example.test"

export interface Fixtures {
  prefix: string
  userIds: string[]
  connectionIds: string[]
  mcpIds: string[]
}

export async function createFixtures() {
  const { db } = await import("../../db/client")
  const { user, connections, adAccounts } = await import("../../db/schema")
  const { aad, encryptJson } = await import("../../crypto/secret-box")
  const prefix = `t${randomUUID().slice(0, 8)}`
  const f: Fixtures = { prefix, userIds: [], connectionIds: [], mcpIds: [] }

  const mkUser = async (role: string, banned = false) => {
    const id = `${prefix}_${role}_${randomUUID().slice(0, 6)}`
    await db.insert(user).values({ id, name: `${prefix} ${role}`, email: `${id}@example.test`, emailVerified: true, role, banned })
    f.userIds.push(id)
    return id
  }
  const mkConn = async (ownerId: string, platform: "meta" | "openai_ads", status = "active") => {
    const id = randomUUID()
    await db.insert(connections).values({
      id,
      ownerId,
      platform,
      name: `${prefix} ${platform}`,
      credentialsEncrypted: encryptJson({ access_token: `secret-${id}` }, aad.connectionCredentials(id)),
      credentialHint: "xxxx",
      status,
    })
    f.connectionIds.push(id)
    return id
  }
  const mkAcc = async (connectionId: string, platform: "meta" | "openai_ads", externalId: string, currency: string, timezone: string, isEnabled = true) => {
    const rows = await db
      .insert(adAccounts)
      .values({ connectionId, platform, externalId, name: `${prefix} ${externalId}`, currency, timezone, isEnabled, status: "active" })
      .returning({ id: adAccounts.id })
    return rows[0]!.id
  }

  const admin = await mkUser("admin")
  const staff = await mkUser("staff")
  const other = await mkUser("staff")
  const banned = await mkUser("staff", true)

  const connMeta = await mkConn(staff, "meta")
  const connOpenai = await mkConn(staff, "openai_ads")
  const connOther = await mkConn(other, "meta")
  const connDisabled = await mkConn(staff, "meta", "disabled")
  const connBanned = await mkConn(banned, "meta")

  const ids = {
    admin,
    staff,
    other,
    banned,
    connMeta,
    connOpenai,
    connOther,
    connDisabled,
    connBanned,
    accVnd: await mkAcc(connMeta, "meta", `act_${prefix}1`.replace(/[^a-z0-9_]/g, ""), "VND", "Asia/Ho_Chi_Minh"),
    accUsd: await mkAcc(connMeta, "meta", `act_${prefix}2`.replace(/[^a-z0-9_]/g, ""), "USD", "America/New_York"),
    accOff: await mkAcc(connMeta, "meta", `act_${prefix}3`.replace(/[^a-z0-9_]/g, ""), "VND", "Asia/Ho_Chi_Minh", false),
    accOpenai: await mkAcc(connOpenai, "openai_ads", `${prefix}70001`, "VND", "Asia/Ho_Chi_Minh"),
    accOther: await mkAcc(connOther, "meta", `act_${prefix}9`.replace(/[^a-z0-9_]/g, ""), "VND", "Asia/Ho_Chi_Minh"),
    accDisabledConn: await mkAcc(connDisabled, "meta", `act_${prefix}5`.replace(/[^a-z0-9_]/g, ""), "VND", "Asia/Ho_Chi_Minh"),
    accBanned: await mkAcc(connBanned, "meta", `act_${prefix}6`.replace(/[^a-z0-9_]/g, ""), "VND", "Asia/Ho_Chi_Minh"),
  }
  const ext = {
    vnd: `act_${prefix}1`.replace(/[^a-z0-9_]/g, ""),
    usd: `act_${prefix}2`.replace(/[^a-z0-9_]/g, ""),
    off: `act_${prefix}3`.replace(/[^a-z0-9_]/g, ""),
    openai: `${prefix}70001`,
    other: `act_${prefix}9`.replace(/[^a-z0-9_]/g, ""),
    disabledConn: `act_${prefix}5`.replace(/[^a-z0-9_]/g, ""),
  }
  return { f, ids, ext }
}

export async function createMcp(
  f: Fixtures,
  o: {
    ownerId: string
    permissions: Partial<Record<"meta" | "openai_ads", string[]>>
    scopes: { connectionId: string; adAccountId?: string | null }[]
    settings?: Record<string, unknown>
    status?: "active" | "disabled"
    expiresAt?: Date | null
    deletedAt?: Date | null
  }
) {
  const { db } = await import("../../db/client")
  const { mcpServers, mcpPlatformPermissions, mcpAccountScopes } = await import("../../db/schema")
  const { generateMcpKey, hashMcpKey, mcpKeyPrefix } = await import("../../crypto/mcp-key")
  const { aad, encryptSecret } = await import("../../crypto/secret-box")
  const key = generateMcpKey()
  const id = randomUUID()
  await db.insert(mcpServers).values({
    id,
    ownerId: o.ownerId,
    name: `${f.prefix} mcp`,
    keyHash: hashMcpKey(key),
    keyPrefix: mcpKeyPrefix(key),
    keyEncrypted: encryptSecret(key, aad.mcpKey(id)),
    status: o.status ?? "active",
    expiresAt: o.expiresAt ?? null,
    deletedAt: o.deletedAt ?? null,
    settings: o.settings ?? {},
  })
  f.mcpIds.push(id)
  for (const [platform, permissions] of Object.entries(o.permissions)) {
    await db.insert(mcpPlatformPermissions).values({ mcpId: id, platform: platform as "meta" | "openai_ads", permissions: permissions! })
  }
  for (const s of o.scopes) {
    await db.insert(mcpAccountScopes).values({ mcpId: id, connectionId: s.connectionId, adAccountId: s.adAccountId ?? null })
  }
  return { id, key }
}

export async function cleanupFixtures(f: Fixtures) {
  const { db } = await import("../../db/client")
  const { user, connections, mcpServers, mcpCallLogs } = await import("../../db/schema")
  if (f.mcpIds.length) {
    await db.delete(mcpCallLogs).where(inArray(mcpCallLogs.mcpId, f.mcpIds))
    await db.delete(mcpServers).where(inArray(mcpServers.id, f.mcpIds))
  }
  if (f.connectionIds.length) await db.delete(connections).where(inArray(connections.id, f.connectionIds))
  for (const id of f.userIds) await db.delete(user).where(eq(user.id, id))
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------
export const MODERN = "2026-07-28"
export const LEGACY = "2025-06-18"

export function mcpRequest(
  key: string,
  body: unknown,
  o: { headers?: Record<string, string>; method?: string; host?: string; modern?: boolean } = {}
): Request {
  const headers: Record<string, string> = {
    host: o.host ?? TEST_HOST,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "user-agent": "vitest-agent/1.0",
    // modern: true → 2026-07-28 header, false → 2025 header, undefined → none (initialize)
    ...(o.modern === undefined ? {} : { "mcp-protocol-version": o.modern ? MODERN : LEGACY }),
    ...o.headers,
  }
  // 2026-07-28 Streamable HTTP: Mcp-Method on every request, Mcp-Name mirrors params.name (tools/call)
  const b = body as { method?: string; params?: { name?: string } } | null
  if (o.modern && b?.method && !("mcp-method" in headers)) {
    headers["mcp-method"] = b.method
    if (b.method === "tools/call" && b.params?.name) headers["mcp-name"] = b.params.name
  }
  return new Request(`http://${o.host ?? TEST_HOST}/mcp/${key}`, {
    method: o.method ?? "POST",
    headers,
    body: (o.method ?? "POST") === "POST" ? JSON.stringify(body) : undefined,
  })
}

/** 2026-07-28 request envelope */
export function modernMeta(name = "vitest-modern", version = "2.0.0") {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name, version },
  }
}

/** Parse a JSON or SSE response into JSON-RPC messages. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: JSON-RPC payloads are inspected loosely
export async function readRpc(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text()
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) {
    return text
      .split(/\r?\n\r?\n/)
      .map((b) =>
        b
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n")
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d))
  }
  if (!text) return []
  const v = JSON.parse(text)
  return Array.isArray(v) ? v : [v]
}
