// Zod schemas + pure helpers for MCP servers, shared by client (wizard/config form) and server
// (actions/services). No server-only imports here.
import { z } from "zod"

import { isReleasedPlatform, RELEASED_PLATFORMS, type ReleasedPlatform } from "@/lib/platforms"
import { notifications as notificationsVi } from "@/lib/i18n/vi/notifications"
import {
  MULTILINE_FORBIDDEN_CHARS,
  NAME_FORBIDDEN_CHARS,
} from "@/lib/text-safety"
import type { Permission, ProtectionMode } from "@/server/mcp/types"
import type { Platform } from "@/server/providers/types"

/** Platforms an MCP can use in this build (src/lib/platforms.ts). */
export const MCP_PLATFORMS = RELEASED_PLATFORMS
export const MCP_PERMISSIONS = [
  "read",
  "status",
  "update",
  "copy",
  "create",
  "delete",
] as const satisfies readonly Permission[]

/**
 * Permissions that can make an MCP spend money (switch on, change budgets/bids/schedules, copy, create).
 * An MCP with any of them must set a daily cap for every currency in its scope (delete only stops spend).
 */
export const MONEY_WRITE_PERMISSIONS = [
  "status",
  "update",
  "copy",
  "create",
] as const satisfies readonly Permission[]

/** true when the permission list contains a money-write permission */
export function hasMoneyWritePermission(perms: readonly string[]): boolean {
  return perms.some((p) =>
    (MONEY_WRITE_PERMISSIONS as readonly string[]).includes(p)
  )
}

/** Required currencies (upper case) that have no daily cap, sorted. */
export function missingDailyCapCurrencies(
  caps: Record<string, number>,
  required: readonly string[]
): string[] {
  const missing = new Set<string>()
  for (const c of required) {
    const cur = c.toUpperCase()
    const v = caps[cur]
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0))
      missing.add(cur)
  }
  return [...missing].sort()
}

/** Protection modes (same values as PROTECTION_MODES in src/server/mcp/types.ts - client code must not import it). */
export const MCP_PROTECTION_MODES = ["basic", "advanced"] as const satisfies readonly ProtectionMode[]

export const MCP_LIMITS = {
  nameMax: 80,
  descriptionMax: 500,
  budgetChangeMaxPct: { min: 1, max: 500 },
  rateLimitPerMin: { min: 1, max: 600 },
  writeRateLimitPer10Min: { min: 1, max: 1000 },
  /** seconds between two ad-platform writes of the MCP (0 = off); same bounds as WRITE_DELAY_SECONDS */
  writeDelaySeconds: { min: 0, max: 30 },
  allowedIpsMax: 50,
  maxDailyBudgetMax: 1_000_000_000_000,
  currenciesMax: 20,
  /** Telegram messages / hour the AI may send (telegram_send_message), per MCP */
  telegramMessagesPerHour: { min: 1, max: 200 },
  /** Telegram channels per MCP (same bound as mcpChannelIdsSchema) */
  telegramChannelsMax: 20,
  /** Google Drive sources per MCP (mcp_drive_scopes) */
  driveSourcesMax: 50,
} as const

const msg = {
  nameRequired: "Nhập tên MCP.",
  nameTooLong: `Tên tối đa ${MCP_LIMITS.nameMax} ký tự.`,
  descTooLong: `Mô tả tối đa ${MCP_LIMITS.descriptionMax} ký tự.`,
  badChars: "Không dùng ký tự điều khiển hoặc ký tự đảo chiều văn bản.",
  platformsRequired: "Chọn ít nhất 1 nền tảng.",
  platformDuplicate: "Mỗi nền tảng chỉ được khai báo 1 lần.",
  connectionsRequired: "Chọn ít nhất 1 kết nối cho nền tảng này.",
  connectionDuplicate: "Kết nối bị chọn trùng.",
  accountsRequired:
    'Chọn ít nhất 1 tài khoản quảng cáo, hoặc chọn "Tất cả tài khoản".',
  pagesRequired:
    'Chọn ít nhất 1 Trang, hoặc chọn "Tất cả Trang" / "Không dùng Trang".',
  pagesMetaOnly: "Chỉ kết nối Meta mới chọn được Trang Facebook.",
  budgetPct: `Giới hạn đổi ngân sách phải từ ${MCP_LIMITS.budgetChangeMaxPct.min} đến ${MCP_LIMITS.budgetChangeMaxPct.max}%.`,
  rateLimit: `Giới hạn lệnh/phút phải từ ${MCP_LIMITS.rateLimitPerMin.min} đến ${MCP_LIMITS.rateLimitPerMin.max}.`,
  writeRateLimit: `Giới hạn thao tác ghi / 10 phút phải từ ${MCP_LIMITS.writeRateLimitPer10Min.min} đến ${MCP_LIMITS.writeRateLimitPer10Min.max}.`,
  writeDelay: `Giãn cách giữa các lệnh ghi phải từ ${MCP_LIMITS.writeDelaySeconds.min} đến ${MCP_LIMITS.writeDelaySeconds.max} giây (0 = tắt).`,
  telegramPerHour: `Giới hạn tin Telegram / giờ phải từ ${MCP_LIMITS.telegramMessagesPerHour.min} đến ${MCP_LIMITS.telegramMessagesPerHour.max}.`,
  currency: "Mã tiền tệ phải gồm 3 chữ cái in hoa (vd VND, USD).",
  maxBudget: "Trần ngân sách phải là số dương hợp lệ.",
  maxBid: "Trần giá thầu phải là số dương hợp lệ.",
  dailyCapRequired: (cur: string) =>
    `Nhập trần ngân sách/ngày cho ${cur} (bắt buộc khi MCP có quyền ghi).`,
  tooManyCurrencies: `Tối đa ${MCP_LIMITS.currenciesMax} loại tiền tệ.`,
  ip: (v: string) => `"${v}" không phải địa chỉ IP hoặc dải CIDR hợp lệ.`,
  tooManyIps: `Tối đa ${MCP_LIMITS.allowedIpsMax} địa chỉ IP.`,
  expiresAt: "Ngày hết hạn không hợp lệ.",
  expiresFuture: "Ngày hết hạn phải sau thời điểm hiện tại.",
  id: "Mã không hợp lệ.",
  tooManyDriveSources: `Tối đa ${MCP_LIMITS.driveSourcesMax} thư mục / sheet Google Drive cho mỗi MCP.`,
} as const
export const MCP_SCHEMA_MESSAGES = msg

// ---------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------
const ipOrCidr = z.union([z.ipv4(), z.cidrv4(), z.ipv6(), z.cidrv6()])

export function isValidIpOrCidr(value: string): boolean {
  return ipOrCidr.safeParse(value).success
}

/** Split a textarea (newline / comma / space separated) into trimmed, de-duplicated entries. */
export function parseIpList(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\s,;]+/)) {
    const v = part.trim()
    if (v) seen.add(v)
  }
  return [...seen]
}

// ---------------------------------------------------------------------------
// Settings (McpSettings) - camelCase, exactly the McpSettings contract in src/server/mcp/types.ts
// ---------------------------------------------------------------------------
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, msg.currency)

/** currency → positive amount in MAJOR units (per-currency caps: daily, lifetime, bid). */
function capsSchema(message: string) {
  return z
    .record(
      currencyCodeSchema,
      z
        .number({ error: message })
        .finite(message)
        .positive(message)
        .max(MCP_LIMITS.maxDailyBudgetMax, message)
    )
    .refine(
      (r) => Object.keys(r).length <= MCP_LIMITS.currenciesMax,
      msg.tooManyCurrencies
    )
}

/** Per-currency cap fields shared by the schema, the stored shape and the form model. */
export const MCP_CAP_FIELDS = [
  "maxDailyBudget",
  "maxLifetimeBudget",
  "maxBid",
] as const
export type McpCapField = (typeof MCP_CAP_FIELDS)[number]

export const mcpSettingsSchema = z.object({
  /**
   * basic = only the expiry applies (every limit below is kept but not enforced); advanced = all of them apply.
   * Omitted on input (older clients) → advanced, the behaviour before the mode existed.
   */
  protectionMode: z.enum(MCP_PROTECTION_MODES).default("advanced"),
  twoStepConfirm: z.boolean(),
  budgetChangeMaxPct: z
    .number({ error: msg.budgetPct })
    .int(msg.budgetPct)
    .min(MCP_LIMITS.budgetChangeMaxPct.min, msg.budgetPct)
    .max(MCP_LIMITS.budgetChangeMaxPct.max, msg.budgetPct),
  maxDailyBudget: capsSchema(msg.maxBudget),
  /** optional on input: older clients may omit the newer guardrails → safe defaults */
  maxLifetimeBudget: capsSchema(msg.maxBudget).default({}),
  maxBid: capsSchema(msg.maxBid).default({}),
  rateLimitPerMin: z
    .number({ error: msg.rateLimit })
    .int(msg.rateLimit)
    .min(MCP_LIMITS.rateLimitPerMin.min, msg.rateLimit)
    .max(MCP_LIMITS.rateLimitPerMin.max, msg.rateLimit),
  writeRateLimitPer10Min: z
    .number({ error: msg.writeRateLimit })
    .int(msg.writeRateLimit)
    .min(MCP_LIMITS.writeRateLimitPer10Min.min, msg.writeRateLimit)
    .max(MCP_LIMITS.writeRateLimitPer10Min.max, msg.writeRateLimit)
    .default(20),
  /** pacing of ad-platform writes, seconds (0 = off). Optional on input (older clients) → 0 */
  writeDelaySeconds: z
    .number({ error: msg.writeDelay })
    .int(msg.writeDelay)
    .min(MCP_LIMITS.writeDelaySeconds.min, msg.writeDelay)
    .max(MCP_LIMITS.writeDelaySeconds.max, msg.writeDelay)
    .default(0),
  allowedIps: z
    .array(
      z
        .string()
        .trim()
        .refine(isValidIpOrCidr, { error: (iss) => msg.ip(String(iss.input)) })
    )
    .max(MCP_LIMITS.allowedIpsMax, msg.tooManyIps),
  /** Telegram (14-telegram-notifications.md §6) - optional on input, safe defaults (off / 20 per hour) */
  telegramTool: z.boolean().default(false),
  telegramNotifyWrites: z.boolean().default(false),
  telegramMessagesPerHour: z
    .number({ error: msg.telegramPerHour })
    .int(msg.telegramPerHour)
    .min(MCP_LIMITS.telegramMessagesPerHour.min, msg.telegramPerHour)
    .max(MCP_LIMITS.telegramMessagesPerHour.max, msg.telegramPerHour)
    .default(20),
  /**
   * Google Drive (15-google-drive-media.md §7.5) - optional on input, default ON (owner decision G6): public
   * "Anyone with the link" Drive links; status write-back into sheets that enabled it.
   */
  drivePublicLinks: z.boolean().default(true),
  driveSheetWriteback: z.boolean().default(true),
  /**
   * TikTok GMV Max: the AI may change GMV Max campaigns (status, budget/ROI, products, creatives, copy, create, delete)
   * within this MCP's TikTok permissions. Default OFF; only an admin may turn it on (enforced server-side).
   */
  tiktokGmvMaxWrite: z.boolean().default(false),
})
export type McpSettingsInput = z.infer<typeof mcpSettingsSchema>

export const DEFAULT_SETTINGS_INPUT: McpSettingsInput = {
  /** new MCPs start in basic mode (owner decision 2026-10-13); stored rows without the key read as advanced */
  protectionMode: "basic",
  twoStepConfirm: true,
  budgetChangeMaxPct: 50,
  maxDailyBudget: {},
  maxLifetimeBudget: {},
  maxBid: {},
  rateLimitPerMin: 60,
  writeRateLimitPer10Min: 20,
  writeDelaySeconds: 0,
  allowedIps: [],
  telegramTool: false,
  telegramNotifyWrites: false,
  telegramMessagesPerHour: 20,
  drivePublicLinks: true,
  driveSheetWriteback: true,
  tiktokGmvMaxWrite: false,
}

/** Shape stored in `mcp_servers.settings` (snake_case, as documented in 03-database-schema.md). */
export interface StoredMcpSettings {
  protection_mode: ProtectionMode
  two_step_confirm: boolean
  budget_change_max_pct: number
  max_daily_budget: Record<string, number>
  max_lifetime_budget: Record<string, number>
  max_bid: Record<string, number>
  rate_limit_per_min: number
  write_rate_limit_per_10min: number
  write_delay_seconds: number
  allowed_ips: string[]
  /** written on every create/save since the security release; rows without it are legacy (caps optional) */
  money_caps_required: true
  telegram_tool: boolean
  telegram_notify_writes: boolean
  telegram_messages_per_hour: number
  drive_public_links: boolean
  drive_sheet_writeback: boolean
  tiktok_gmv_max_write: boolean
}

function sortedCaps(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(r).sort(([a], [b]) => a.localeCompare(b))
  )
}

/** Validated settings → jsonb (read back with parseMcpSettings in src/server/mcp/settings.ts). */
export function toStoredMcpSettings(s: McpSettingsInput): StoredMcpSettings {
  return {
    protection_mode: s.protectionMode,
    two_step_confirm: s.twoStepConfirm,
    budget_change_max_pct: s.budgetChangeMaxPct,
    max_daily_budget: sortedCaps(s.maxDailyBudget),
    max_lifetime_budget: sortedCaps(s.maxLifetimeBudget),
    max_bid: sortedCaps(s.maxBid),
    rate_limit_per_min: s.rateLimitPerMin,
    write_rate_limit_per_10min: s.writeRateLimitPer10Min,
    write_delay_seconds: s.writeDelaySeconds,
    allowed_ips: [...s.allowedIps],
    money_caps_required: true,
    telegram_tool: s.telegramTool,
    telegram_notify_writes: s.telegramNotifyWrites,
    telegram_messages_per_hour: s.telegramMessagesPerHour,
    drive_public_links: s.drivePublicLinks,
    drive_sheet_writeback: s.driveSheetWriteback,
    tiktok_gmv_max_write: s.tiktokGmvMaxWrite,
  }
}

// ---------------------------------------------------------------------------
// Config (wizard steps 2–4) / create / update
// ---------------------------------------------------------------------------
export const permissionsSchema = z
  .array(z.enum(MCP_PERMISSIONS))
  .transform((arr) => normalizePermissions(arr))

/** Always contains "read"; canonical order; no duplicates. */
export function normalizePermissions(arr: readonly Permission[]): Permission[] {
  const set = new Set<Permission>(arr)
  set.add("read")
  return MCP_PERMISSIONS.filter((p) => set.has(p))
}

export const connectionScopeSchema = z.object({
  connectionId: z.uuid(msg.id),
  /** null = every enabled account of the connection (including accounts synced later) */
  accountIds: z.array(z.uuid(msg.id)).min(1, msg.accountsRequired).nullable(),
  /**
   * Facebook Pages (Meta connections only, read-only tools): omitted / [] = no Page, null = every enabled Page of the
   * connection (including Pages synced later), list = those Pages.
   */
  pageIds: z.array(z.uuid(msg.id)).max(5_000).nullable().optional(),
})

/** true when the scope grants at least one Page (null = all) */
export function scopeHasPages(c: { pageIds?: string[] | null }): boolean {
  return c.pageIds === null || (Array.isArray(c.pageIds) && c.pageIds.length > 0)
}

export const platformScopeSchema = z
  .object({
    platform: z.enum(MCP_PLATFORMS),
    connections: z.array(connectionScopeSchema).min(1, msg.connectionsRequired),
    permissions: permissionsSchema,
  })
  .superRefine((p, ctx) => {
    const ids = p.connections.map((c) => c.connectionId)
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: msg.connectionDuplicate,
        path: ["connections"],
      })
    if (p.platform !== "meta" && p.connections.some(scopeHasPages))
      ctx.addIssue({
        code: "custom",
        message: msg.pagesMetaOnly,
        path: ["connections"],
      })
  })

const nullableExpiry = z
  .union([z.iso.datetime({ offset: true, error: msg.expiresAt }), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v) : null))

export const mcpConfigSchema = z.object({
  platforms: z
    .array(platformScopeSchema)
    .min(1, msg.platformsRequired)
    .superRefine((arr, ctx) => {
      const ps = arr.map((p) => p.platform)
      if (new Set(ps).size !== ps.length)
        ctx.addIssue({ code: "custom", message: msg.platformDuplicate })
    }),
  settings: mcpSettingsSchema,
  expiresAt: nullableExpiry,
  /**
   * Telegram channels the MCP may use (telegram_* tools + notifications after writes). Omitted = keep the stored
   * scope on update (none on create); [] = no channel.
   */
  notificationChannelIds: z
    .array(z.uuid(msg.id))
    .max(MCP_LIMITS.telegramChannelsMax, notificationsVi.errors.tooManyChannels)
    .optional(),
  /**
   * Google Drive sources (drive_sources ids) the MCP may use. Omitted = keep the stored scope on update (none on
   * create); [] = no source.
   */
  driveSourceIds: z
    .array(z.uuid(msg.id))
    .max(MCP_LIMITS.driveSourcesMax, msg.tooManyDriveSources)
    .optional(),
})

/** control characters (except newline/tab in descriptions) and bidi overrides - spoofing in UI/logs */
const NAME_FORBIDDEN = NAME_FORBIDDEN_CHARS
const DESC_FORBIDDEN = MULTILINE_FORBIDDEN_CHARS

const nameSchema = z
  .string()
  .trim()
  .min(1, msg.nameRequired)
  .max(MCP_LIMITS.nameMax, msg.nameTooLong)
  .refine((v) => !NAME_FORBIDDEN.test(v), msg.badChars)
const descriptionSchema = z
  .string()
  .trim()
  .max(MCP_LIMITS.descriptionMax, msg.descTooLong)
  .refine((v) => !DESC_FORBIDDEN.test(v), msg.badChars)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))

export const createMcpSchema = mcpConfigSchema.extend({
  name: nameSchema,
  description: descriptionSchema,
})
export type CreateMcpInput = z.input<typeof createMcpSchema>
export type CreateMcpData = z.output<typeof createMcpSchema>

export const updateMcpSchema = createMcpSchema.extend({ id: z.uuid(msg.id) })
export type UpdateMcpInput = z.input<typeof updateMcpSchema>
export type UpdateMcpData = z.output<typeof updateMcpSchema>

export const mcpIdSchema = z.object({ id: z.uuid(msg.id) })

export const setMcpEnabledSchema = z.object({
  id: z.uuid(msg.id),
  enabled: z.boolean(),
})

export const deleteMcpSchema = z.object({
  id: z.uuid(msg.id),
  confirmName: z.string().max(MCP_LIMITS.nameMax + 20),
})

/** {id, password, code?} - re-authentication for "Xem lại link" and "Xoay key". */
export const reauthMcpSchema = z.object({
  id: z.uuid(msg.id),
  password: z.string().min(1, "Nhập mật khẩu.").max(256),
  /** 6-digit TOTP code; required when the user has 2FA enabled */
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Mã xác thực gồm 6 chữ số.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
})
export const revealMcpSchema = reauthMcpSchema
export type RevealMcpInput = z.input<typeof reauthMcpSchema>

// ---------------------------------------------------------------------------
// Form model (wizard + config editor). Text inputs stay strings; converted by formValuesToInput.
// ---------------------------------------------------------------------------
export type ConnectionDraft = {
  connectionId: string
  mode: "all" | "pick"
  accountIds: string[]
  /** Facebook Pages (Meta only): none = no Page tools, all = every enabled Page, pick = pageIds */
  pagesMode?: "none" | "all" | "pick"
  pageIds?: string[]
}

/** Draft value of `pageIds` for the API: undefined (none), null (all) or the picked ids. */
export function draftPageIds(c: ConnectionDraft): string[] | null | undefined {
  if (c.pagesMode === "all") return null
  if (c.pagesMode === "pick") return c.pageIds ?? []
  return undefined
}

export type PlatformDraft = {
  enabled: boolean
  connections: ConnectionDraft[]
  permissions: Permission[]
}

export type McpFormValues = {
  name: string
  description: string
  platforms: Record<ReleasedPlatform, PlatformDraft>
  /** basic = only the expiry applies (the advanced fields below are hidden, kept and not enforced) */
  protectionMode: ProtectionMode
  twoStepConfirm: boolean
  budgetChangeMaxPct: string
  /** currency → amount text ("" = no cap) */
  maxDailyBudget: Record<string, string>
  /** currency → amount text ("" = only the implicit daily × days cap) */
  maxLifetimeBudget: Record<string, string>
  /** currency → amount text ("" = no cap) */
  maxBid: Record<string, string>
  /** YYYY-MM-DD (end of that day, Asia/Ho_Chi_Minh) or "" */
  expiresOn: string
  rateLimitPerMin: string
  writeRateLimitPer10Min: string
  /** seconds between two ad-platform writes ("0" = off) */
  writeDelaySeconds: string
  allowedIpsText: string
  /** Telegram channels in scope (notification_channels ids) */
  notificationChannelIds: string[]
  telegramTool: boolean
  telegramNotifyWrites: boolean
  telegramMessagesPerHour: string
  /** Google Drive sources in scope (drive_sources ids) */
  driveSourceIds: string[]
  drivePublicLinks: boolean
  driveSheetWriteback: boolean
  /** TikTok GMV Max write switch (admin-only) */
  tiktokGmvMaxWrite: boolean
}

export const PERMISSION_PRESETS = {
  readOnly: ["read"],
  operate: ["read", "status", "update"],
  fullNoDelete: ["read", "status", "update", "copy", "create"],
} as const satisfies Record<string, readonly Permission[]>
export type PermissionPreset = keyof typeof PERMISSION_PRESETS

/** The preset a permission set equals (order/duplicates ignored, "read" implied), or null for a hand-picked combination. */
export function matchPermissionPreset(
  perms: readonly Permission[]
): PermissionPreset | null {
  const current = normalizePermissions([...perms]).join()
  const keys = Object.keys(PERMISSION_PRESETS) as PermissionPreset[]
  return (
    keys.find(
      (k) => normalizePermissions([...PERMISSION_PRESETS[k]]).join() === current
    ) ?? null
  )
}

export function emptyPlatformDraft(): PlatformDraft {
  return { enabled: false, connections: [], permissions: ["read"] }
}

export function defaultMcpFormValues(): McpFormValues {
  return {
    name: "",
    description: "",
    platforms: {
      meta: emptyPlatformDraft(),
      tiktok: emptyPlatformDraft(),
      google_ads: emptyPlatformDraft(),
      openai_ads: emptyPlatformDraft(),
    },
    protectionMode: DEFAULT_SETTINGS_INPUT.protectionMode,
    twoStepConfirm: DEFAULT_SETTINGS_INPUT.twoStepConfirm,
    budgetChangeMaxPct: String(DEFAULT_SETTINGS_INPUT.budgetChangeMaxPct),
    maxDailyBudget: {},
    maxLifetimeBudget: {},
    maxBid: {},
    expiresOn: "",
    rateLimitPerMin: String(DEFAULT_SETTINGS_INPUT.rateLimitPerMin),
    writeRateLimitPer10Min: String(
      DEFAULT_SETTINGS_INPUT.writeRateLimitPer10Min
    ),
    writeDelaySeconds: String(DEFAULT_SETTINGS_INPUT.writeDelaySeconds),
    allowedIpsText: "",
    notificationChannelIds: [],
    telegramTool: DEFAULT_SETTINGS_INPUT.telegramTool,
    telegramNotifyWrites: DEFAULT_SETTINGS_INPUT.telegramNotifyWrites,
    telegramMessagesPerHour: String(DEFAULT_SETTINGS_INPUT.telegramMessagesPerHour),
    driveSourceIds: [],
    drivePublicLinks: DEFAULT_SETTINGS_INPUT.drivePublicLinks,
    driveSheetWriteback: DEFAULT_SETTINGS_INPUT.driveSheetWriteback,
    tiktokGmvMaxWrite: DEFAULT_SETTINGS_INPUT.tiktokGmvMaxWrite,
  }
}

const VN_OFFSET = "+07:00"

/** "2026-12-31" → ISO string at 23:59:59 Asia/Ho_Chi_Minh (fixed +07:00, no DST). */
export function expiryDateToIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const d = new Date(`${day}T23:59:59${VN_OFFSET}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** ISO / Date → "YYYY-MM-DD" in Asia/Ho_Chi_Minh. */
export function isoToExpiryDate(
  value: Date | string | null | undefined
): string {
  if (!value) return ""
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** Parse a user-typed amount ("5.000.000", "5000000", "12,5") into a number; NaN when invalid. */
export function parseAmountText(text: string): number {
  const s = text.trim().replace(/\s/g, "")
  if (!s) return Number.NaN
  // vi-VN: "." thousands, "," decimals. Accept plain "12.5" too when there is a single dot + ≤2 decimals.
  let normalized: string
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))
    normalized = s.replace(/\./g, "").replace(",", ".")
  else if (/^\d+(,\d+)?$/.test(s)) normalized = s.replace(",", ".")
  else if (/^\d+(\.\d{1,2})?$/.test(s)) normalized = s
  else return Number.NaN
  const n = Number(normalized)
  return Number.isFinite(n) ? n : Number.NaN
}

/** {currency: text} → {currency: number}; blank entries are dropped (= no cap). */
export function capsTextToNumbers(
  caps: Record<string, string> | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [cur, text] of Object.entries(caps ?? {})) {
    if (text.trim() === "") continue
    out[cur] = parseAmountText(text)
  }
  return out
}

/** {currency: number} → {currency: text} for the form. */
export function capsNumbersToText(
  caps: Record<string, number> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(caps ?? {}).map(([k, n]) => [k, String(n)])
  )
}

/**
 * Basic mode hides the advanced fields: keep their valid values (applied again when the owner switches back to
 * advanced) and reset invalid ones to the defaults, so a hidden field can never block a save.
 */
export function sanitizeHiddenAdvanced(v: McpFormValues): McpFormValues {
  const e = validateProtectionStep(
    { ...v, protectionMode: "advanced", expiresOn: "" },
    { requireFutureExpiry: false }
  )
  // no early return: the currency-count limit below is not part of validateProtectionStep
  const d = defaultMcpFormValues()
  const out: McpFormValues = { ...v }
  if (e.budgetChangeMaxPct) out.budgetChangeMaxPct = d.budgetChangeMaxPct
  if (e.rateLimitPerMin) out.rateLimitPerMin = d.rateLimitPerMin
  if (e.writeRateLimitPer10Min)
    out.writeRateLimitPer10Min = d.writeRateLimitPer10Min
  if (e.writeDelaySeconds) out.writeDelaySeconds = d.writeDelaySeconds
  if (e.telegramMessagesPerHour)
    out.telegramMessagesPerHour = d.telegramMessagesPerHour
  for (const field of MCP_CAP_FIELDS) {
    const kept = Object.entries(v[field] ?? {}).filter(
      ([cur]) => !e[`${field}.${cur}`]
    )
    // a currency limit (more than currenciesMax entries) would fail the server schema: keep the first ones
    out[field] = Object.fromEntries(
      kept
        .filter(([, text]) => text.trim() !== "")
        .slice(0, MCP_LIMITS.currenciesMax)
    )
  }
  if (e.allowedIps)
    out.allowedIpsText = parseIpList(v.allowedIpsText)
      .filter(isValidIpOrCidr)
      .slice(0, MCP_LIMITS.allowedIpsMax)
      .join("\n")
  return out
}

/** Steps 2–4 of the form → API config (validated again on the server). */
export function formValuesToConfig(
  values: McpFormValues
): z.input<typeof mcpConfigSchema> {
  const v =
    values.protectionMode === "basic" ? sanitizeHiddenAdvanced(values) : values
  const platforms = MCP_PLATFORMS.filter((p) => v.platforms[p]?.enabled).map(
    (p) => ({
      platform: p,
      connections: v.platforms[p].connections.map((c) => {
        const pageIds = p === "meta" ? draftPageIds(c) : undefined
        return {
          connectionId: c.connectionId,
          accountIds: c.mode === "all" ? null : c.accountIds,
          ...(pageIds !== undefined ? { pageIds } : {}),
        }
      }),
      permissions: normalizePermissions(v.platforms[p].permissions),
    })
  )
  return {
    platforms,
    settings: {
      // a value missing here (never for a form built by defaultMcpFormValues / configToFormValues) must not loosen an
      // existing MCP: same fallback as the server schema
      protectionMode: v.protectionMode ?? "advanced",
      twoStepConfirm: v.twoStepConfirm,
      budgetChangeMaxPct: Number(v.budgetChangeMaxPct),
      maxDailyBudget: capsTextToNumbers(v.maxDailyBudget),
      maxLifetimeBudget: capsTextToNumbers(v.maxLifetimeBudget),
      maxBid: capsTextToNumbers(v.maxBid),
      rateLimitPerMin: Number(v.rateLimitPerMin),
      writeRateLimitPer10Min: Number(v.writeRateLimitPer10Min),
      // missing on a form built before the field existed → 0 (off)
      writeDelaySeconds: Number(v.writeDelaySeconds ?? "0"),
      allowedIps: parseIpList(v.allowedIpsText),
      telegramTool: v.telegramTool,
      telegramNotifyWrites: v.telegramNotifyWrites,
      telegramMessagesPerHour: Number(v.telegramMessagesPerHour),
      drivePublicLinks: v.drivePublicLinks ?? DEFAULT_SETTINGS_INPUT.drivePublicLinks,
      driveSheetWriteback: v.driveSheetWriteback ?? DEFAULT_SETTINGS_INPUT.driveSheetWriteback,
      tiktokGmvMaxWrite: v.tiktokGmvMaxWrite ?? DEFAULT_SETTINGS_INPUT.tiktokGmvMaxWrite,
    },
    expiresAt: v.expiresOn ? expiryDateToIso(v.expiresOn) : null,
    notificationChannelIds: [...new Set(v.notificationChannelIds)],
    driveSourceIds: [...new Set(v.driveSourceIds ?? [])],
  }
}

export function formValuesToCreateInput(v: McpFormValues): CreateMcpInput {
  return { ...formValuesToConfig(v), name: v.name, description: v.description }
}

/** Stored config → form values (config editor). */
export function configToFormValues(config: {
  name: string
  description: string | null
  platforms: {
    platform: Platform
    permissions: Permission[]
    connections: {
      connectionId: string
      accountIds: string[] | null
      pageIds?: string[] | null
    }[]
  }[]
  settings: z.input<typeof mcpSettingsSchema>
  expiresAt: Date | string | null
  notificationChannelIds?: string[]
  driveSourceIds?: string[]
}): McpFormValues {
  const v = defaultMcpFormValues()
  v.name = config.name
  v.description = config.description ?? ""
  for (const p of config.platforms) {
    // a stored scope of a platform not shipped in this build is dropped from the form
    if (!isReleasedPlatform(p.platform)) continue
    v.platforms[p.platform] = {
      enabled: true,
      permissions: normalizePermissions(p.permissions),
      connections: p.connections.map((c) => ({
        connectionId: c.connectionId,
        mode: c.accountIds === null ? "all" : "pick",
        accountIds: c.accountIds ?? [],
        ...(c.pageIds !== undefined
          ? {
              pagesMode:
                c.pageIds === null
                  ? ("all" as const)
                  : c.pageIds.length
                    ? ("pick" as const)
                    : ("none" as const),
              pageIds: c.pageIds ?? [],
            }
          : {}),
      })),
    }
  }
  // missing on rows saved before the mode existed → advanced (same default as the runtime parser)
  v.protectionMode = config.settings.protectionMode ?? "advanced"
  v.twoStepConfirm = config.settings.twoStepConfirm
  v.budgetChangeMaxPct = String(config.settings.budgetChangeMaxPct)
  v.maxDailyBudget = capsNumbersToText(config.settings.maxDailyBudget)
  v.maxLifetimeBudget = capsNumbersToText(config.settings.maxLifetimeBudget)
  v.maxBid = capsNumbersToText(config.settings.maxBid)
  v.rateLimitPerMin = String(config.settings.rateLimitPerMin)
  v.writeRateLimitPer10Min = String(
    config.settings.writeRateLimitPer10Min ??
      DEFAULT_SETTINGS_INPUT.writeRateLimitPer10Min
  )
  v.writeDelaySeconds = String(
    config.settings.writeDelaySeconds ?? DEFAULT_SETTINGS_INPUT.writeDelaySeconds
  )
  v.allowedIpsText = config.settings.allowedIps.join("\n")
  v.expiresOn = isoToExpiryDate(config.expiresAt)
  v.notificationChannelIds = [...(config.notificationChannelIds ?? [])]
  v.telegramTool = config.settings.telegramTool ?? DEFAULT_SETTINGS_INPUT.telegramTool
  v.telegramNotifyWrites =
    config.settings.telegramNotifyWrites ?? DEFAULT_SETTINGS_INPUT.telegramNotifyWrites
  v.telegramMessagesPerHour = String(
    config.settings.telegramMessagesPerHour ??
      DEFAULT_SETTINGS_INPUT.telegramMessagesPerHour
  )
  v.driveSourceIds = [...(config.driveSourceIds ?? [])]
  // missing on rows saved before the feature → ON (same default as the runtime parser)
  v.drivePublicLinks = config.settings.drivePublicLinks ?? DEFAULT_SETTINGS_INPUT.drivePublicLinks
  v.driveSheetWriteback =
    config.settings.driveSheetWriteback ?? DEFAULT_SETTINGS_INPUT.driveSheetWriteback
  // missing on rows saved before the feature → OFF (same default as the runtime parser)
  v.tiktokGmvMaxWrite = config.settings.tiktokGmvMaxWrite ?? DEFAULT_SETTINGS_INPUT.tiktokGmvMaxWrite
  return v
}

/** Keep only Google Drive sources the owner can still pick (deleted / no longer usable ones are dropped on save). */
export function pruneDriveSourcesToSelectable(
  values: McpFormValues,
  options: readonly { id: string }[]
): McpFormValues {
  const ids = new Set(options.map((o) => o.id))
  const current = values.driveSourceIds ?? []
  const kept = current.filter((id) => ids.has(id))
  return kept.length === current.length
    ? values
    : { ...values, driveSourceIds: kept }
}

/** Keep only Telegram channels the owner can still pick (deleted channels / other owners are dropped on save). */
export function pruneChannelsToSelectable(
  values: McpFormValues,
  options: readonly { id: string }[]
): McpFormValues {
  const ids = new Set(options.map((o) => o.id))
  const kept = values.notificationChannelIds.filter((id) => ids.has(id))
  return kept.length === values.notificationChannelIds.length
    ? values
    : { ...values, notificationChannelIds: kept }
}

/** Field-level problems of a wizard step, keyed by a stable path (Vietnamese messages). */
export type StepErrors = Record<string, string>

export function validateNameStep(v: McpFormValues): StepErrors {
  const e: StepErrors = {}
  const r = nameSchema.safeParse(v.name)
  if (!r.success) e.name = r.error.issues[0]?.message ?? msg.nameRequired
  if (v.description.trim().length > MCP_LIMITS.descriptionMax)
    e.description = msg.descTooLong
  return e
}

export function validatePlatformsStep(v: McpFormValues): StepErrors {
  const e: StepErrors = {}
  const enabled = MCP_PLATFORMS.filter((p) => v.platforms[p]?.enabled)
  if (enabled.length === 0) e.platforms = msg.platformsRequired
  for (const p of enabled) {
    const d = v.platforms[p]
    if (d.connections.length === 0)
      e[`platforms.${p}`] = msg.connectionsRequired
    for (const c of d.connections) {
      if (c.mode === "pick" && c.accountIds.length === 0)
        e[`platforms.${p}.${c.connectionId}`] = msg.accountsRequired
      if (
        p === "meta" &&
        c.pagesMode === "pick" &&
        (c.pageIds ?? []).length === 0
      )
        e[`platforms.${p}.${c.connectionId}.pages`] = msg.pagesRequired
    }
  }
  return e
}

export function validateProtectionStep(
  v: McpFormValues,
  opts: {
    requireFutureExpiry?: boolean
    /** currencies that must have a daily cap (money-write scope, see moneyScopeCurrencies) */
    requiredCapCurrencies?: readonly string[]
  } = {}
): StepErrors {
  const e: StepErrors = {}
  validateExpiry(v, opts, e)
  // basic mode: only the expiry applies; the hidden advanced fields are sanitized on submit (sanitizeHiddenAdvanced)
  if (v.protectionMode === "basic") return e
  const pct = Number(v.budgetChangeMaxPct)
  if (
    !mcpSettingsSchema.shape.budgetChangeMaxPct.safeParse(pct).success ||
    v.budgetChangeMaxPct.trim() === ""
  )
    e.budgetChangeMaxPct = msg.budgetPct
  const rate = Number(v.rateLimitPerMin)
  if (
    !mcpSettingsSchema.shape.rateLimitPerMin.safeParse(rate).success ||
    v.rateLimitPerMin.trim() === ""
  )
    e.rateLimitPerMin = msg.rateLimit
  const writeRate = Number(v.writeRateLimitPer10Min)
  if (
    !mcpSettingsSchema.shape.writeRateLimitPer10Min.safeParse(writeRate)
      .success ||
    v.writeRateLimitPer10Min.trim() === ""
  )
    e.writeRateLimitPer10Min = msg.writeRateLimit
  const writeDelay = Number(v.writeDelaySeconds ?? "0")
  if (
    !mcpSettingsSchema.shape.writeDelaySeconds.safeParse(writeDelay).success ||
    (v.writeDelaySeconds ?? "0").trim() === ""
  )
    e.writeDelaySeconds = msg.writeDelay
  const tgRate = Number(v.telegramMessagesPerHour)
  if (
    !mcpSettingsSchema.shape.telegramMessagesPerHour.safeParse(tgRate)
      .success ||
    (v.telegramMessagesPerHour ?? "").trim() === ""
  )
    e.telegramMessagesPerHour = msg.telegramPerHour
  for (const field of MCP_CAP_FIELDS) {
    for (const [cur, text] of Object.entries(v[field] ?? {})) {
      if (text.trim() === "") continue
      const n = parseAmountText(text)
      if (!(n > 0 && n <= MCP_LIMITS.maxDailyBudgetMax))
        e[`${field}.${cur}`] = field === "maxBid" ? msg.maxBid : msg.maxBudget
    }
  }
  const daily: Record<string, number> = {}
  for (const [cur, text] of Object.entries(v.maxDailyBudget ?? {}))
    if (text.trim() !== "") daily[cur] = parseAmountText(text)
  for (const cur of missingDailyCapCurrencies(
    daily,
    opts.requiredCapCurrencies ?? []
  ))
    e[`maxDailyBudget.${cur}`] ??= msg.dailyCapRequired(cur)
  const ips = parseIpList(v.allowedIpsText)
  const bad = ips.find((ip) => !isValidIpOrCidr(ip))
  if (bad) e.allowedIps = msg.ip(bad)
  else if (ips.length > MCP_LIMITS.allowedIpsMax) e.allowedIps = msg.tooManyIps
  return e
}

function validateExpiry(
  v: McpFormValues,
  opts: { requireFutureExpiry?: boolean },
  e: StepErrors
): void {
  if (!v.expiresOn) return
  const iso = expiryDateToIso(v.expiresOn)
  if (!iso) e.expiresOn = msg.expiresAt
  else if (
    opts.requireFutureExpiry !== false &&
    new Date(iso).getTime() <= Date.now()
  )
    e.expiresOn = msg.expiresFuture
}

// ---------------------------------------------------------------------------
// Scope health: stored references the config editor drops when the config is saved.
// Pure and structural (the service types satisfy these shapes) so it is shared by the UI and its tests.
// ---------------------------------------------------------------------------

/** One connection of a stored MCP scope (subset of `McpScopeConnection`). */
export interface ScopeConfigConnection {
  connectionId: string
  connectionName: string
  connectionStatus: string
  connectionDeleted: boolean
  /** null = all enabled accounts of the connection */
  accountIds: string[] | null
}

export interface ScopeConfigPlatform {
  platform: Platform
  connections: ScopeConfigConnection[]
}

/** What the MCP owner can use right now (subset of `SelectableConnection`): live connections + their ENABLED accounts. */
export interface ScopeSelectableConnection {
  id: string
  platform: Platform
  accounts: { id: string }[]
  /** Meta: ENABLED Facebook Pages */
  pages?: { id: string }[]
}

/** Drop references to connections / accounts that are no longer selectable (deleted, disabled, accounts switched off). */
export function pruneToSelectable(
  values: McpFormValues,
  connections: readonly ScopeSelectableConnection[]
): McpFormValues {
  const byId = new Map(connections.map((c) => [c.id, c]))
  const platforms = { ...values.platforms }
  for (const p of MCP_PLATFORMS) {
    const d = platforms[p]
    const conns = d.connections
      .filter((c) => byId.get(c.connectionId)?.platform === p)
      .map((c) => {
        const conn = byId.get(c.connectionId)!
        const ids = new Set(conn.accounts.map((a) => a.id))
        const next = { ...c, accountIds: c.accountIds.filter((a) => ids.has(a)) }
        if (c.pagesMode === "pick") {
          // Pages switched off since: drop them; nothing left → no Page (a save would fail on an empty pick)
          const pages = new Set((conn.pages ?? []).map((x) => x.id))
          const kept = (c.pageIds ?? []).filter((x) => pages.has(x))
          return { ...next, pageIds: kept, pagesMode: kept.length ? ("pick" as const) : ("none" as const) }
        }
        return next
      })
    // the owner has no usable connection of this platform left → the editor shows no card for it, so there is
    // nothing to pick from: switch it off (a save would otherwise fail on an error nobody can see)
    const nothingToPick =
      d.enabled && conns.length === 0 && !connections.some((c) => c.platform === p)
    platforms[p] = nothingToPick
      ? { ...d, enabled: false, connections: [] }
      : { ...d, connections: conns }
  }
  return { ...values, platforms }
}

export type McpScopeIssue =
  /** the connection was deleted */
  | {
      kind: "connection_deleted"
      platform: Platform
      connectionId: string
      connectionName: string
    }
  /** not deleted but the owner cannot use it (switched off, or someone else's) */
  | {
      kind: "connection_unavailable"
      platform: Platform
      connectionId: string
      connectionName: string
      /** the connection's own status is "disabled" */
      disabled: boolean
    }
  /** accounts picked one by one that were switched off since (`name` null = unknown) */
  | {
      kind: "accounts_disabled"
      platform: Platform
      connectionId: string
      connectionName: string
      accounts: { id: string; name: string | null }[]
    }

/** Why a platform has no usable account (priority: every connection deleted → every one switched off → none enabled). */
export type NoUsableReason = "deleted" | "unavailable" | "no_accounts"

export interface PlatformUsability {
  platform: Platform
  /** ad accounts the MCP can really use for this platform right now */
  usableAccounts: number
  /** set when `usableAccounts` is 0 */
  reason: NoUsableReason | null
}

export interface ScopeAnalysis {
  /** references that are dropped from the form (and from the MCP once saved) */
  issues: McpScopeIssue[]
  /** platforms the editor switches off because the owner has no usable connection of them left */
  droppedPlatforms: Platform[]
  /** usable accounts per platform of the stored config */
  platforms: PlatformUsability[]
}

export function analyzeScope(
  config: readonly ScopeConfigPlatform[],
  selectable: readonly ScopeSelectableConnection[],
  /** ad account id → name, for accounts that are no longer selectable (optional: shown in the warning) */
  accountNames: Readonly<Record<string, string>> = {}
): ScopeAnalysis {
  const byId = new Map(selectable.map((c) => [c.id, c]))
  const issues: McpScopeIssue[] = []
  const droppedPlatforms: Platform[] = []
  const platforms: PlatformUsability[] = []
  for (const p of config) {
    let usable = 0
    let live = 0
    let kept = 0
    for (const c of p.connections) {
      const base = {
        platform: p.platform,
        connectionId: c.connectionId,
        connectionName: c.connectionName,
      }
      if (c.connectionDeleted) {
        issues.push({ kind: "connection_deleted", ...base })
        continue
      }
      live++
      const conn = byId.get(c.connectionId)
      if (!conn || conn.platform !== p.platform) {
        issues.push({
          kind: "connection_unavailable",
          ...base,
          disabled: c.connectionStatus === "disabled",
        })
        continue
      }
      kept++
      const enabled = new Set(conn.accounts.map((a) => a.id))
      if (c.accountIds === null) {
        usable += enabled.size
        continue
      }
      const gone = c.accountIds.filter((a) => !enabled.has(a))
      usable += c.accountIds.length - gone.length
      if (gone.length > 0)
        issues.push({
          kind: "accounts_disabled",
          ...base,
          accounts: gone.map((id) => ({ id, name: accountNames[id] ?? null })),
        })
    }
    // same rule as pruneToSelectable
    if (kept === 0 && !selectable.some((c) => c.platform === p.platform))
      droppedPlatforms.push(p.platform)
    platforms.push({
      platform: p.platform,
      usableAccounts: usable,
      reason:
        usable > 0
          ? null
          : p.connections.length > 0 && live === 0
            ? "deleted"
            : p.connections.length > 0 && kept === 0
              ? "unavailable"
              : "no_accounts",
    })
  }
  return { issues, droppedPlatforms, platforms }
}

/** Counts for the save bar: connections and ad accounts that will be dropped, platforms switched off. */
export function summarizeScopeIssues(a: Pick<ScopeAnalysis, "issues" | "droppedPlatforms">): {
  connections: number
  accounts: number
  platforms: number
} {
  let connections = 0
  let accounts = 0
  for (const i of a.issues) {
    if (i.kind === "accounts_disabled") accounts += i.accounts.length
    else connections++
  }
  return { connections, accounts, platforms: a.droppedPlatforms.length }
}
