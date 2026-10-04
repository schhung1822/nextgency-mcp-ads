// DEV ONLY — demo data for the Overview / Logs / Settings pages + login cookies for screenshots.
//   tsx --env-file=.env scripts/dev-seed-logs.ts [--out cookies.json] [--clean]
// Creates two users (admin + staff, password DEV_SEED_PASSWORD or a dev default), demo connections,
// ad accounts, MCP servers, ~30 days of MCP call logs and staff activity, runs the hourly rollup, then
// signs both users in and writes their session cookies to --out. The admin row gets two_factor_enabled=true
// AFTER sign-in (dev shortcut so requireUser() does not force /security/enable-2fa).
// Refuses to run unless ALLOW_DEV_SEED=1, DATABASE_URL points to localhost/127.0.0.1/::1, NODE_ENV is not
// production and every existing user has an @example.test email (src/server/db/dev-seed-guard.ts).
//   ALLOW_DEV_SEED=1 tsx --env-file=.env scripts/dev-seed-logs.ts …
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { eq, inArray, or, sql } from "drizzle-orm"
import { safeErrorForLog } from "@/server/audit/safe-error"
import { getAuth } from "@/server/auth/auth"
import { runWithUserCreateContext } from "@/server/auth/user-create-context"
import { db, pool } from "@/server/db/client"
import { assertDevSeedAllowed } from "@/server/db/dev-seed-guard"
import {
  activityLogs,
  adAccounts,
  connections,
  mcpCallLogs,
  mcpAccountScopes,
  mcpCallStatsHourly,
  mcpPlatformPermissions,
  mcpServers,
  user,
} from "@/server/db/schema"
import { runLogsRollup } from "@/server/jobs/logs-rollup"


const ADMIN_EMAIL = "dev-logs-admin@example.test"
const STAFF_EMAIL = "dev-logs-staff@example.test"
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? "dev-password-123456"
const args = process.argv.slice(2)
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : null

async function ensureUser(email: string, name: string, role: "admin" | "staff"): Promise<string> {
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
  if (existing[0]) {
    // reset 2FA flag so sign-in returns a session (re-set below for the admin)
    await db.update(user).set({ twoFactorEnabled: false, mustChangePassword: false, banned: false }).where(eq(user.id, existing[0].id))
    return existing[0].id
  }
  // headerless createUser must be explicitly marked trusted (hooks.ts) — dev seed only
  const res = await runWithUserCreateContext({ kind: "dev-seed", mustChangePassword: false }, () =>
    getAuth().api.createUser({ body: { email, password: PASSWORD, name, role } })
  )
  return String((res as { user: { id: string } }).user.id)
}

async function clean(ids: string[]) {
  await db.delete(mcpCallLogs).where(inArray(mcpCallLogs.ownerId, ids))
  await db.delete(mcpCallStatsHourly).where(inArray(mcpCallStatsHourly.ownerId, ids))
  await db.delete(activityLogs).where(inArray(activityLogs.actorId, ids))
  await db.delete(mcpServers).where(inArray(mcpServers.ownerId, ids))
  await db.delete(connections).where(inArray(connections.ownerId, ids))
}

function pick<T>(a: readonly T[], i: number): T {
  return a[Math.abs(i) % a.length]
}

async function main() {
  await assertDevSeedAllowed()
  const adminId = await ensureUser(ADMIN_EMAIL, "Quản trị Demo", "admin")
  const staffId = await ensureUser(STAFF_EMAIL, "Lan Nguyễn", "staff")
  await clean([adminId, staffId])
  if (args.includes("--clean")) {
    await db.delete(user).where(or(eq(user.id, adminId), eq(user.id, staffId)))
    console.log("dev-seed-logs: đã xoá dữ liệu demo.")
    return
  }

  // previous month partitions so 30 days of history do not land in the DEFAULT partition
  const now = new Date()
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const cur = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const suffix = `${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, "0")}`
  for (const parent of ["mcp_call_logs", "activity_logs"]) {
    await db.execute(
      sql.raw(
        `create table if not exists "${parent}_p${suffix}" partition of "${parent}" for values from ('${prev.toISOString()}') to ('${cur.toISOString()}')`
      )
    )
  }

  const day = 86_400_000
  const conns = await db
    .insert(connections)
    .values([
      { ownerId: adminId, platform: "meta", name: "BM chính", credentialsEncrypted: "dev", credentialHint: "EAA…9xQ", status: "active", tokenExpiresAt: new Date(now.getTime() + 5 * day) },
      { ownerId: adminId, platform: "meta", name: "BM cũ", credentialsEncrypted: "dev", credentialHint: "EAA…ab", status: "invalid", statusMessage: "Token không hợp lệ hoặc đã bị thu hồi." },
      { ownerId: staffId, platform: "meta", name: "Via Shop VN", credentialsEncrypted: "dev", credentialHint: "EAA…f3", status: "active" },
      { ownerId: staffId, platform: "openai_ads", name: "OpenAI Ads", credentialsEncrypted: "dev", credentialHint: "sk-…k2", status: "active" },
    ])
    .returning({ id: connections.id, platform: connections.platform, ownerId: connections.ownerId })

  const accountRows = conns.flatMap((c, i) =>
    [0, 1, 2].map((j) => ({
      connectionId: c.id,
      platform: c.platform,
      externalId:
        c.platform === "meta" ? `act_10${i}${j}55` : `adacct_dev${i}${j}`,
      name: `${pick(["Shop Thời Trang", "Mỹ Phẩm Hana", "Nội Thất Gỗ"], j)} ${i + 1}`,
      currency: c.platform === "meta" ? "VND" : "USD",
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
    }))
  )
  const accounts = await db.insert(adAccounts).values(accountRows).returning({ externalId: adAccounts.externalId, platform: adAccounts.platform, connectionId: adAccounts.connectionId })

  const mcps = await db
    .insert(mcpServers)
    .values([
      { ownerId: adminId, name: "Báo cáo hằng ngày", keyHash: `dev-${randomBytes(8).toString("hex")}`, keyPrefix: "amcp_dev1", keyEncrypted: "dev", lastClient: "claude-ai" },
      { ownerId: adminId, name: "Vận hành Meta", keyHash: `dev-${randomBytes(8).toString("hex")}`, keyPrefix: "amcp_dev2", keyEncrypted: "dev", lastClient: "ChatGPT" },
      { ownerId: staffId, name: "Lan · Meta + OpenAI", keyHash: `dev-${randomBytes(8).toString("hex")}`, keyPrefix: "amcp_dev3", keyEncrypted: "dev", lastClient: "gemini-cli" },
    ])
    .returning({ id: mcpServers.id, name: mcpServers.name, ownerId: mcpServers.ownerId })

  // An MCP without platform permission / scope rows looks like "every platform OFF" in the admin UI (Config tab) and
  // serves no account: give each demo MCP the platforms its name promises (all accounts of the owner's connection).
  const grants: Record<string, Record<string, string[]>> = {
    "Báo cáo hằng ngày": { meta: ["read"], openai_ads: ["read"] },
    "Vận hành Meta": { meta: ["read", "status", "update"] },
    "Lan · Meta + OpenAI": { meta: ["read"], openai_ads: ["read"] },
  }
  for (const mcp of mcps) {
    for (const [platform, permissions] of Object.entries(grants[mcp.name] ?? {})) {
      const conn = conns.find((c) => c.platform === platform && c.ownerId === mcp.ownerId)
      if (!conn) continue
      await db.insert(mcpPlatformPermissions).values({ mcpId: mcp.id, platform: conn.platform, permissions })
      await db.insert(mcpAccountScopes).values({ mcpId: mcp.id, connectionId: conn.id, adAccountId: null })
    }
  }

  const clients = [
    ["claude-ai", "0.1"],
    ["ChatGPT", "1.0"],
    ["gemini-cli", "0.9.2"],
    ["claude-code", "2.1.0"],
  ] as const
  const tools: Record<string, { name: string; kind: "read" | "write" }[]> = {
    meta: [
      { name: "ads_get_report", kind: "read" },
      { name: "meta_list_campaigns", kind: "read" },
      { name: "ads_update_budget", kind: "write" },
      { name: "ads_set_status", kind: "write" },
    ],
    openai_ads: [
      { name: "ads_get_report", kind: "read" },
      { name: "openai_ads_list_campaigns", kind: "read" },
    ],
  }
  const ownerEmail = (id: string) => (id === adminId ? ADMIN_EMAIL : STAFF_EMAIL)
  const rows: (typeof mcpCallLogs.$inferInsert)[] = []
  let seed = 7
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let d = 29; d >= 0; d--) {
    const perDay = 8 + Math.round(rnd() * 22) + (d < 7 ? 10 : 0)
    for (let k = 0; k < perDay; k++) {
      const mcp = pick(mcps, Math.floor(rnd() * 10))
      const ownConns = conns.filter((c) => (mcp.ownerId === adminId ? c.ownerId === adminId || rnd() < 0.2 : c.ownerId === staffId))
      const conn = pick(ownConns, Math.floor(rnd() * 10))
      const acc = pick(accounts.filter((a) => a.connectionId === conn.id), Math.floor(rnd() * 10))
      const tool = pick(tools[conn.platform], Math.floor(rnd() * 10))
      const r = rnd()
      const status = r < 0.82 ? "success" : r < 0.88 ? "error" : r < 0.92 ? "denied" : r < 0.95 ? "rate_limited" : tool.kind === "write" ? "pending_confirmation" : "success"
      const client = pick(clients, Math.floor(rnd() * 10))
      const at = new Date(now.getTime() - d * day - Math.floor(rnd() * (d === 0 ? 20 * 3_600_000 : day)))
      const write = tool.kind === "write"
      rows.push({
        createdAt: at,
        mcpId: mcp.id,
        mcpName: mcp.name,
        ownerId: mcp.ownerId,
        ownerEmail: ownerEmail(mcp.ownerId),
        jsonrpcId: String(k + 1),
        method: "tools/call",
        toolName: tool.name,
        protocolVersion: "2025-11-25",
        clientName: client[0],
        clientVersion: client[1],
        ip: pick(["113.161.12.45", "14.232.88.10", "2405:4802:1d4::12"], k),
        userAgent: `${client[0]}/${client[1]}`,
        platform: conn.platform,
        adAccountId: acc.externalId,
        objectIds: write ? [`${Math.floor(rnd() * 1e12)}`] : null,
        actionKind: tool.kind,
        status,
        errorCode: status === "error" ? pick(["190", "40001", "AUTHENTICATION_ERROR"], k) : status === "denied" ? "permission_denied" : status === "rate_limited" ? "rate_limited" : null,
        errorMessage:
          status === "error"
            ? pick(["Token đã hết hạn hoặc bị thu hồi.", "Ngân sách vượt giới hạn cho phép của MCP (50%).", "Nền tảng trả lỗi tạm thời, thử lại sau."], k)
            : status === "denied"
              ? "MCP chưa được cấp quyền Sửa cho nền tảng này."
              : status === "rate_limited"
                ? "Vượt giới hạn 60 lệnh/phút."
                : null,
        upstreamRequestIds: status === "success" || status === "error" ? [`A${randomBytes(6).toString("hex")}`] : null,
        durationMs: Math.round(120 + rnd() * (tool.name === "ads_get_report" ? 2400 : 900)),
        request: { name: tool.name, arguments: { account_id: acc.externalId, date_preset: "last_7d", access_token: "[REDACTED]" } },
        response: status === "success" ? { ok: true, rows: Math.round(rnd() * 40), currency: "VND" } : { ok: false },
        changes:
          write && status === "success"
            ? [
                { object_id: "120210000000001", field: "daily_budget", before: { amount: 500000, currency: "VND" }, after: { amount: 650000, currency: "VND" } },
                { object_id: "120210000000001", field: "status", before: "ACTIVE", after: "ACTIVE" },
              ]
            : null,
        requestBytes: 240,
        responseBytes: 1800,
      })
    }
    // protocol noise
    rows.push({ createdAt: new Date(now.getTime() - d * day - 3_600_000), mcpId: mcps[0].id, mcpName: mcps[0].name, ownerId: adminId, ownerEmail: ADMIN_EMAIL, method: "tools/list", actionKind: "protocol", status: "success", clientName: "claude-ai", durationMs: 4 })
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(mcpCallLogs).values(rows.slice(i, i + 500))

  const act = (h: number, actorId: string | null, action: string, extra: Partial<typeof activityLogs.$inferInsert> = {}) => ({
    createdAt: new Date(now.getTime() - h * 3_600_000),
    actorId,
    actorEmail: actorId ? ownerEmail(actorId) : null,
    actorRole: actorId === adminId ? "admin" : "staff",
    action,
    ip: "113.161.12.45",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0",
    ...extra,
  })
  await db.insert(activityLogs).values([
    act(0.2, adminId, "auth.login.success"),
    act(0.5, staffId, "mcp.update", { targetType: "mcp", targetId: mcps[2].id, targetLabel: mcps[2].name, metadata: { before: { rate_limit_per_min: 60, confirm_writes: true }, after: { rate_limit_per_min: 120, confirm_writes: true } } }),
    act(1, adminId, "settings.update", { targetType: "setting", targetId: "log_retention_months_mcp", targetLabel: "log_retention_months_mcp", metadata: { before: { log_retention_months_mcp: 3 }, after: { log_retention_months_mcp: 6 } } }),
    act(2, staffId, "connection.test", { targetType: "connection", targetId: conns[2].id, targetLabel: "Via Shop VN" }),
    act(3, null, "auth.login.failure", { actorEmail: "unknown@example.test", actorRole: null, status: "failure", metadata: { reason: "invalid_credentials" } }),
    act(5, adminId, "mcp.key.reveal", { targetType: "mcp", targetId: mcps[0].id, targetLabel: mcps[0].name }),
    act(8, adminId, "user.create", { targetType: "user", targetId: staffId, targetLabel: STAFF_EMAIL, metadata: { after: { role: "staff", email: STAFF_EMAIL } } }),
    act(20, staffId, "auth.2fa.enable"),
    act(26, adminId, "connection.create", { targetType: "connection", targetId: conns[0].id, targetLabel: "BM chính" }),
    act(30, adminId, "logs.export", { targetType: "logs", targetId: "mcp", targetLabel: "Nhật ký MCP", metadata: { rows: 1284, tab: "mcp" } }),
    act(50, staffId, "mcp.create", { targetType: "mcp", targetId: mcps[2].id, targetLabel: mcps[2].name }),
    act(72, adminId, "user.role.change", { targetType: "user", targetId: staffId, targetLabel: STAFF_EMAIL, status: "failure", metadata: { reason: "last_admin" } }),
  ])

  const roll = await runLogsRollup({ hours: 24 * 31 })
  console.log(`dev-seed-logs: ${rows.length} MCP log rows, rollup ${roll.rows} buckets.`)

  if (outPath) {
    const cookies: Record<string, string> = {}
    for (const [label, email] of [
      ["admin", ADMIN_EMAIL],
      ["staff", STAFF_EMAIL],
    ] as const) {
      const res = await getAuth().api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true })
      const set = res.headers.getSetCookie?.() ?? []
      const token = set.map((c) => c.split(";")[0]).find((c) => c.includes("session_token="))
      if (!token) throw new Error(`Không đăng nhập được ${email}: ${res.status}`)
      cookies[label] = token
    }
    // dev shortcut: admins must have 2FA to pass requireUser()
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, adminId))
    writeFileSync(outPath, JSON.stringify(cookies, null, 2))
    console.log(`dev-seed-logs: cookies → ${outPath}`)
  }
}

main()
  .catch((e) => {
    console.error("dev-seed-logs failed:", safeErrorForLog(e))
    process.exitCode = 1
  })
  .finally(() => pool().end())
