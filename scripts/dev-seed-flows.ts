// DEV ONLY — extra demo connections / ad accounts / MCP servers (all four platforms, long names, several
// currencies, disabled / closed / expiring / invalid states) to review the "Kết nối" and "MCP" screens.
// Run AFTER scripts/dev-seed-logs.ts (it needs the two dev users):
//   ALLOW_DEV_SEED=1 tsx --env-file=.env scripts/dev-seed-flows.ts [--clean] [--out cookies.json]
// --out merges a session cookie for a third user WITHOUT any connection / MCP (key "empty") into the cookies
// file written by dev-seed-logs.ts, so the empty states can be reviewed (scripts/ui-shots-flows.mjs `empty-states`).
// Same safety guard as dev-seed-logs (localhost DB, non-production, @example.test users only).
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { eq, inArray, like } from "drizzle-orm"
import { getAuth } from "@/server/auth/auth"
import { runWithUserCreateContext } from "@/server/auth/user-create-context"
import { assertDevSeedAllowed } from "@/server/db/dev-seed-guard"
import { db, pool } from "@/server/db/client"
import {
  adAccounts,
  connections,
  mcpAccountScopes,
  mcpPlatformPermissions,
  mcpServers,
  user,
} from "@/server/db/schema"
import { connectionStatus } from "@/lib/i18n/vi/connection-status"
import { aad, encryptJson, encryptSecret } from "@/server/crypto/secret-box"
import {
  generateMcpKey,
  hashMcpKey,
  mcpKeyPrefix,
} from "@/server/crypto/mcp-key"

type Platform = "meta" | "tiktok" | "google_ads" | "openai_ads"
type Acc = {
  name: string
  cur: string
  tz?: string
  status?: string
  enabled?: boolean
  manager?: boolean
}

const TAG = "[flows] "
const day = 86_400_000

async function userId(email: string): Promise<string> {
  const r = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
  if (!r[0]) throw new Error(`Chạy dev-seed-logs.ts trước (thiếu ${email})`)
  return r[0].id
}

async function addConnection(
  ownerId: string,
  platform: Platform,
  name: string,
  opts: {
    status?: string
    msg?: string
    expiresInDays?: number | null
    /** soft-deleted connection (still referenced by MCP scopes) */
    deleted?: boolean
    accounts: Acc[]
  }
) {
  const id = randomUUID()
  await db.insert(connections).values({
    id,
    ownerId,
    platform,
    name: TAG + name,
    deletedAt: opts.deleted ? new Date(Date.now() - 2 * day) : null,
    credentialsEncrypted: encryptJson(
      { accessToken: "dev-fake-token" },
      aad.connectionCredentials(id)
    ),
    credentialHint: "…" + id.slice(-4),
    status: opts.status ?? "active",
    statusMessage: opts.msg ?? null,
    tokenExpiresAt:
      opts.expiresInDays == null
        ? null
        : new Date(Date.now() + opts.expiresInDays * day),
    scopes:
      platform === "meta"
        ? ["ads_management", "ads_read", "business_management"]
        : null,
    lastCheckedAt: new Date(Date.now() - 37 * 60_000),
  })
  const accs = opts.accounts.map((a, i) => ({
    connectionId: id,
    platform,
    externalId:
      platform === "meta"
        ? `act_${(900_000_000 + i * 7919).toString()}`
        : platform === "google_ads"
          ? (1_234_567_000 + i * 101).toString()
          : platform === "tiktok"
            ? `7${(300_000_000_000 + i * 137).toString()}`
            : `oaa_${(10_000 + i).toString()}`,
    name: a.name,
    currency: a.cur,
    timezone:
      a.tz ??
      (a.cur === "USD"
        ? "America/Los_Angeles"
        : a.cur === "THB"
          ? "Asia/Bangkok"
          : "Asia/Ho_Chi_Minh"),
    status: a.status ?? "active",
    isEnabled: a.enabled ?? true,
    isManager: a.manager ?? false,
    lastSyncedAt: new Date(Date.now() - 12 * 60_000),
  }))
  const rows = await db.insert(adAccounts).values(accs).returning({
    id: adAccounts.id,
    name: adAccounts.name,
    platform: adAccounts.platform,
    currency: adAccounts.currency,
  })
  return { id, accounts: rows }
}

type Conn = Awaited<ReturnType<typeof addConnection>>

async function addMcp(
  ownerId: string,
  name: string,
  opts: {
    description?: string
    status?: "active" | "disabled"
    expiresInDays?: number | null
    platforms: {
      platform: Platform
      permissions: string[]
      scopes: { conn: Conn; accounts: "all" | number[] }[]
    }[]
    settings?: Record<string, unknown>
    lastUsedMinutesAgo?: number | null
  }
) {
  const id = randomUUID()
  const key = generateMcpKey()
  await db.insert(mcpServers).values({
    id,
    ownerId,
    name: TAG + name,
    description: opts.description ?? null,
    keyHash: hashMcpKey(key),
    keyPrefix: mcpKeyPrefix(key),
    keyEncrypted: encryptSecret(key, aad.mcpKey(id)),
    status: opts.status ?? "active",
    expiresAt:
      opts.expiresInDays == null
        ? null
        : new Date(Date.now() + opts.expiresInDays * day),
    settings: {
      two_step_confirm: true,
      budget_change_max_pct: 50,
      max_daily_budget: {},
      max_lifetime_budget: {},
      max_bid: {},
      rate_limit_per_min: 60,
      write_rate_limit_per_10min: 20,
      allowed_ips: [],
      ...opts.settings,
    },
    lastUsedAt:
      opts.lastUsedMinutesAgo == null
        ? null
        : new Date(Date.now() - opts.lastUsedMinutesAgo * 60_000),
    lastClient: opts.lastUsedMinutesAgo == null ? null : "claude-ai",
  })
  for (const p of opts.platforms) {
    await db
      .insert(mcpPlatformPermissions)
      .values({ mcpId: id, platform: p.platform, permissions: p.permissions })
    for (const s of p.scopes) {
      if (s.accounts === "all")
        await db
          .insert(mcpAccountScopes)
          .values({ mcpId: id, connectionId: s.conn.id, adAccountId: null })
      else
        for (const i of s.accounts)
          await db.insert(mcpAccountScopes).values({
            mcpId: id,
            connectionId: s.conn.id,
            adAccountId: s.conn.accounts[i]!.id,
          })
    }
  }
  return id
}

async function clean(ids: string[]) {
  await db
    .delete(mcpServers)
    .where(inArray(mcpServers.ownerId, ids))
    .catch(() => {})
}

const EMPTY_EMAIL = "dev-logs-empty@example.test"

/** Creates (once) a staff user with no data, signs in and merges its session cookie into `file`. */
async function writeEmptyUserCookie(file: string) {
  const password = process.env.DEV_SEED_PASSWORD ?? "dev-password-123456"
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, EMPTY_EMAIL))
  if (!existing[0]) {
    await runWithUserCreateContext(
      { kind: "dev-seed", mustChangePassword: false },
      () =>
        getAuth().api.createUser({
          body: {
            email: EMPTY_EMAIL,
            password,
            name: "Người dùng trống",
            role: "staff",
          },
        })
    )
  }
  const res = await getAuth().api.signInEmail({
    body: { email: EMPTY_EMAIL, password },
    asResponse: true,
  })
  const token = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => c?.includes("session_token="))
  if (!token) throw new Error("Không đăng nhập được người dùng trống")
  const cookies = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    string
  >
  cookies.empty = token
  writeFileSync(file, JSON.stringify(cookies, null, 2))
}

async function main() {
  await assertDevSeedAllowed()
  const adminId = await userId("dev-logs-admin@example.test")
  const staffId = await userId("dev-logs-staff@example.test")
  await db.delete(mcpServers).where(like(mcpServers.name, `${TAG}%`))
  await db.delete(connections).where(like(connections.name, `${TAG}%`))
  if (process.argv.includes("--clean")) {
    console.log("dev-seed-flows: đã xoá dữ liệu demo.")
    return
  }
  void clean

  const meta = await addConnection(
    adminId,
    "meta",
    "BM chính — Công ty TNHH Thương mại và Dịch vụ Quảng cáo Noti Việt Nam",
    {
      expiresInDays: null,
      accounts: [
        { name: "Shop Thời Trang Nữ Hà Nội", cur: "VND" },
        {
          name: "Mỹ Phẩm Hana Chính Hãng — Chiến dịch Black Friday & Tết Nguyên Đán 2027 (long name)",
          cur: "VND",
        },
        { name: "Nội Thất Gỗ Sồi", cur: "VND" },
        { name: "Noti Education — Khoá học online", cur: "VND" },
        { name: "Noti Global (USD)", cur: "USD" },
        { name: "Noti Thailand", cur: "THB" },
        {
          name: "Tài khoản cũ — đã đóng",
          cur: "VND",
          status: "closed",
          enabled: false,
        },
        {
          name: "Tài khoản bị khoá thanh toán",
          cur: "VND",
          status: "disabled",
          enabled: false,
        },
        { name: "Chờ duyệt", cur: "VND", status: "pending" },
      ],
    }
  )
  const metaExp = await addConnection(
    adminId,
    "meta",
    "Meta Agency Client #2",
    {
      status: "expiring",
      msg: connectionStatus.message.expiring(3, "06/10/2026"),
      expiresInDays: 3,
      accounts: [
        { name: "Client 2 — Quán cà phê", cur: "VND" },
        { name: "Client 2 — USD", cur: "USD" },
      ],
    }
  )
  await addConnection(adminId, "meta", "Meta cũ (đã thu hồi)", {
    status: "invalid",
    msg: connectionStatus.message.invalid,
    expiresInDays: -5,
    accounts: [
      { name: "Tài khoản đã mất quyền", cur: "VND", status: "unknown" },
    ],
  })
  const shop = await addConnection(adminId, "meta", "Via Shop VN", {
    expiresInDays: null,
    accounts: [
      { name: "Shop — Thời trang", cur: "VND" },
      { name: "Shop — Gia dụng", cur: "VND" },
      { name: "Shop — Livestream", cur: "VND" },
      { name: "Shop — Brand US", cur: "USD" },
    ],
  })
  await addConnection(adminId, "meta", "BM tạm tắt", {
    status: "disabled",
    accounts: [{ name: "Tài khoản test", cur: "VND", enabled: false }],
  })
  const multi = await addConnection(adminId, "meta", "BM đa tiền tệ — Noti", {
    expiresInDays: null,
    accounts: [
      { name: "Khoá học — VN", cur: "VND" },
      { name: "Ebook — Global", cur: "USD" },
      { name: "Thailand", cur: "THB" },
    ],
  })
  const openai = await addConnection(
    adminId,
    "openai_ads",
    "OpenAI Ads — Noti",
    {
      expiresInDays: null,
      accounts: [
        { name: "OpenAI Ads Sandbox", cur: "USD" },
        { name: "OpenAI Ads Production", cur: "USD" },
      ],
    }
  )

  const tiktok = await addConnection(adminId, "tiktok", "TikTok Shop VN", {
    expiresInDays: null,
    accounts: [
      { name: "TikTok Shop — Thời trang", cur: "VND" },
      { name: "TikTok Shop — Gia dụng", cur: "VND" },
      { name: "TikTok Live Shopping", cur: "VND" },
      { name: "TikTok Brand US", cur: "USD" },
    ],
  })
  await addConnection(adminId, "tiktok", "TikTok tạm tắt", {
    status: "disabled",
    accounts: [{ name: "TikTok test", cur: "VND", enabled: false }],
  })
  const google = await addConnection(
    adminId,
    "google_ads",
    "MCC Google — Noti",
    {
      expiresInDays: null,
      accounts: [
        { name: "MCC Noti (tài khoản quản lý)", cur: "USD", manager: true },
        { name: "Search — Khoá học", cur: "VND" },
        { name: "Performance Max — Ebook", cur: "USD" },
        { name: "YouTube Ads Thailand", cur: "THB" },
      ],
    }
  )

  const sMeta = await addConnection(staffId, "meta", "Lan · Meta cá nhân", {
    expiresInDays: 55,
    accounts: [
      { name: "Shop của Lan", cur: "VND" },
      { name: "Shop Lan 2", cur: "VND" },
    ],
  })
  const sTik = await addConnection(staffId, "tiktok", "Lan · TikTok", {
    expiresInDays: null,
    accounts: [{ name: "TikTok của Lan", cur: "VND" }],
  })

  const readOnly = ["read"]
  const operate = ["read", "status", "update"]
  const noDelete = ["read", "status", "update", "copy", "create"]
  const full = ["read", "status", "update", "copy", "create", "delete"]

  await addMcp(adminId, "Báo cáo hằng ngày", {
    description: "Kéo chỉ số chi tiêu mỗi sáng cho đội Performance.",
    lastUsedMinutesAgo: 14,
    platforms: [
      {
        platform: "meta",
        permissions: readOnly,
        scopes: [{ conn: meta, accounts: "all" }],
      },
      {
        platform: "openai_ads",
        permissions: readOnly,
        scopes: [{ conn: openai, accounts: "all" }],
      },
    ],
  })
  await addMcp(adminId, "Vận hành Meta — Black Friday", {
    lastUsedMinutesAgo: 3 * 60,
    settings: {
      max_daily_budget: { VND: 5_000_000, USD: 200 },
      max_bid: { VND: 20_000 },
    },
    platforms: [
      {
        platform: "meta",
        permissions: operate,
        scopes: [
          { conn: meta, accounts: [0, 1, 4] },
          { conn: metaExp, accounts: "all" },
        ],
      },
    ],
  })
  await addMcp(
    adminId,
    "Toàn quyền (trừ xoá) — Trưởng nhóm Performance Marketing & Growth",
    {
      lastUsedMinutesAgo: 60 * 26,
      platforms: [
        {
          platform: "meta",
          permissions: noDelete,
          scopes: [
            { conn: meta, accounts: "all" },
            { conn: shop, accounts: [0, 1] },
            { conn: multi, accounts: "all" },
          ],
        },
        {
          platform: "openai_ads",
          permissions: full,
          scopes: [{ conn: openai, accounts: "all" }],
        },
      ],
    }
  )
  await addMcp(adminId, "Đa nền tảng — TikTok + Google Ads (YouTube)", {
    description: "Theo dõi TikTok Shop và chiến dịch Search / YouTube của MCC Google.",
    lastUsedMinutesAgo: 35,
    platforms: [
      {
        platform: "tiktok",
        permissions: noDelete,
        scopes: [{ conn: tiktok, accounts: [0, 1] }],
      },
      {
        platform: "google_ads",
        permissions: operate,
        scopes: [{ conn: google, accounts: "all" }],
      },
    ],
  })
  await addMcp(adminId, "MCP tạm tắt", {
    status: "disabled",
    lastUsedMinutesAgo: 60 * 24 * 9,
    platforms: [
      {
        platform: "meta",
        permissions: readOnly,
        scopes: [{ conn: multi, accounts: [1] }],
      },
    ],
  })
  await addMcp(adminId, "MCP đã hết hạn", {
    expiresInDays: -2,
    lastUsedMinutesAgo: null,
    platforms: [
      {
        platform: "openai_ads",
        permissions: readOnly,
        scopes: [{ conn: openai, accounts: "all" }],
      },
    ],
  })
  await addMcp(adminId, "Sắp hết hạn · giới hạn IP", {
    expiresInDays: 4,
    lastUsedMinutesAgo: 20,
    settings: {
      allowed_ips: ["113.161.12.45", "14.232.0.0/16"],
      two_step_confirm: false,
    },
    platforms: [
      {
        platform: "meta",
        permissions: noDelete,
        scopes: [{ conn: meta, accounts: [3] }],
      },
    ],
  })
  await addMcp(staffId, "Lan · Meta vận hành", {
    lastUsedMinutesAgo: 45,
    platforms: [
      {
        platform: "meta",
        permissions: operate,
        scopes: [{ conn: sMeta, accounts: "all" }],
      },
    ],
  })
  await addMcp(staffId, "Lan · TikTok báo cáo", {
    lastUsedMinutesAgo: 75,
    platforms: [
      {
        platform: "tiktok",
        permissions: readOnly,
        scopes: [{ conn: sTik, accounts: "all" }],
      },
    ],
  })
  // ---- status message + hint (connection detail / list / Overview "Cảnh báo") ----
  // Meta: the adapter embeds its own sentence, the platform hint adds the click path
  await addConnection(adminId, "meta", "Meta — token bị thu hồi", {
    status: "invalid",
    msg: "Kết nối Meta không còn hợp lệ: Token mất hiệu lực do đổi mật khẩu. Hãy tạo token mới và cập nhật kết nối.",
    accounts: [{ name: "Meta Hà Nội", cur: "VND" }],
  })
  // OpenAI: the message already carries the platform hint word for word → shown once
  await addConnection(adminId, "openai_ads", "OpenAI Ads — key bị từ chối", {
    status: "invalid",
    msg: `API key bị từ chối (401). ${connectionStatus.hint.invalid.openai_ads}`,
    accounts: [{ name: "OpenAI Ads cũ", cur: "USD", status: "unknown" }],
  })
  // Google: the adapter embeds its own "Hãy lấy refresh token mới…" sentence, the platform hint adds the click path
  await addConnection(adminId, "google_ads", "Google Ads — refresh token hết hạn", {
    status: "invalid",
    msg: "Refresh token đã hết hạn hoặc bị thu hồi (invalid_grant). Hãy lấy refresh token mới và dán lại.",
    accounts: [{ name: "Google Ads Hà Nội", cur: "VND" }],
  })
  // TikTok: transient failure on a healthy connection
  await addConnection(adminId, "tiktok", "TikTok — máy chủ đang bận", {
    status: "active",
    msg: connectionStatus.message.checkFailed("TikTok đang bận (HTTP 503)."),
    accounts: [{ name: "TikTok thử lại", cur: "VND" }],
  })
  // transient failure on a healthy connection → the "retry" hint
  await addConnection(adminId, "meta", "Meta — kiểm tra lỗi tạm thời", {
    status: "active",
    msg: connectionStatus.message.checkFailed("Meta đang gặp lỗi máy chủ (HTTP 503)."),
    accounts: [{ name: "Meta thử lại", cur: "VND" }],
  })

  // ---- MCP config tab: stored scopes that point at things that are gone ----
  const metaGone = await addConnection(adminId, "meta", "Meta chiến dịch cũ (đã xoá)", {
    deleted: true,
    accounts: [{ name: "Tài khoản của kết nối đã xoá", cur: "VND" }],
  })
  const metaOff = await addConnection(adminId, "meta", "BM cũ (đang tắt)", {
    status: "disabled",
    accounts: [{ name: "Tài khoản cũ", cur: "VND", enabled: false }],
  })
  const openaiNoAcc = await addConnection(adminId, "openai_ads", "OpenAI Ads — chưa bật TKQC", {
    accounts: [
      { name: "OpenAI Ads Staging", cur: "USD", enabled: false },
      { name: "OpenAI Ads QA", cur: "USD", enabled: false },
    ],
  })
  // meta: one live connection with some picked accounts switched off (indexes 6/7 are closed / disabled, 8 pending)
  await addMcp(adminId, "Báo cáo cũ — kết nối đã xoá & TKQC đã tắt", {
    description: "MCP còn trỏ tới kết nối đã xoá, kết nối tắt và TKQC đã tắt.",
    lastUsedMinutesAgo: 60 * 24 * 3,
    platforms: [
      {
        platform: "meta",
        permissions: operate,
        scopes: [
          { conn: meta, accounts: [0, 6, 7] },
          { conn: metaGone, accounts: "all" },
          { conn: shop, accounts: [0] },
          { conn: metaOff, accounts: "all" },
        ],
      },
    ],
  })
  // every platform without a usable account (overview warning, "all" variant)
  await addMcp(adminId, "MCP chưa có TKQC dùng được", {
    lastUsedMinutesAgo: null,
    platforms: [
      {
        platform: "openai_ads",
        permissions: readOnly,
        scopes: [{ conn: openaiNoAcc, accounts: "all" }],
      },
    ],
  })
  // only some platforms without a usable account ("some" variant): meta fine, openai none
  await addMcp(adminId, "Meta ổn · OpenAI chưa bật TKQC", {
    lastUsedMinutesAgo: 90,
    platforms: [
      {
        platform: "meta",
        permissions: readOnly,
        scopes: [{ conn: meta, accounts: [0, 1] }],
      },
      {
        platform: "openai_ads",
        permissions: readOnly,
        scopes: [{ conn: openaiNoAcc, accounts: "all" }],
      },
    ],
  })
  // staff-owned: its only OpenAI Ads connection was deleted and the owner has no other one → the platform is dropped
  const sOpenaiGone = await addConnection(staffId, "openai_ads", "Lan · OpenAI Ads đã xoá", {
    deleted: true,
    accounts: [{ name: "OpenAI Ads của Lan", cur: "USD" }],
  })
  await addMcp(staffId, "Lan · Meta + OpenAI Ads (OpenAI đã xoá)", {
    lastUsedMinutesAgo: 120,
    platforms: [
      {
        platform: "meta",
        permissions: readOnly,
        scopes: [{ conn: sMeta, accounts: "all" }],
      },
      {
        platform: "openai_ads",
        permissions: readOnly,
        scopes: [{ conn: sOpenaiGone, accounts: "all" }],
      },
    ],
  })

  const outIdx = process.argv.indexOf("--out")
  if (outIdx >= 0) await writeEmptyUserCookie(process.argv[outIdx + 1]!)
  console.log("dev-seed-flows: đã tạo kết nối + MCP demo.")
}

main()
  .catch((e) => {
    console.error("dev-seed-flows failed:", e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool().end())
