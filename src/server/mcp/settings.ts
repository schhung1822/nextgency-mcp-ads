// Parse mcp_servers.settings (jsonb) into McpSettings. Accepts the documented snake_case shape
// ({ two_step_confirm, budget_change_max_pct, max_daily_budget, max_lifetime_budget, max_bid,
//    rate_limit_per_min, write_rate_limit_per_10min, write_delay_seconds, allowed_ips, money_caps_required,
//    telegram_tool, telegram_notify_writes, telegram_messages_per_hour, drive_public_links, drive_sheet_writeback,
//    tiktok_gmv_max_write, protection_mode, apify_enabled, apify_run_max_usd, apify_daily_max_usd, apify_store_actors, meta_page_messages })
// and camelCase (McpSettings). Every field is validated on its own: an invalid field falls back to
// its safe default without discarding the other (valid) fields; the two request limits are clamped to the bounds of
// the MCP form (MCP_LIMITS) instead.
import { z } from "zod"
import { APIFY_LIMITS } from "@/lib/schemas/apify"
import { MCP_LIMITS } from "@/lib/schemas/mcp-servers"
import {
  DEFAULT_MCP_SETTINGS,
  PROTECTION_MODES,
  TELEGRAM_MESSAGES_PER_HOUR,
  UNLIMITED,
  WRITE_DELAY_SECONDS,
  type McpSettings,
} from "./types"

const fields = {
  twoStepConfirm: z.boolean(),
  budgetChangeMaxPct: z.number().min(0).max(10_000),
  writeDelaySeconds: z.number().int().min(WRITE_DELAY_SECONDS.min).max(WRITE_DELAY_SECONDS.max),
  allowedIps: z.array(z.string().max(64)).max(200),
  telegramMessagesPerHour: z.number().int().min(TELEGRAM_MESSAGES_PER_HOUR.min).max(TELEGRAM_MESSAGES_PER_HOUR.max),
  protectionMode: z.enum(PROTECTION_MODES),
  apifyRunMaxUsd: z.number().finite().min(APIFY_LIMITS.runMaxUsd.min).max(APIFY_LIMITS.runMaxUsd.max),
  apifyDailyMaxUsd: z.number().finite().min(APIFY_LIMITS.dailyMaxUsd.min).max(APIFY_LIMITS.dailyMaxUsd.max),
}

const SNAKE_TO_CAMEL: Record<string, keyof McpSettings> = {
  two_step_confirm: "twoStepConfirm",
  budget_change_max_pct: "budgetChangeMaxPct",
  max_daily_budget: "maxDailyBudget",
  max_lifetime_budget: "maxLifetimeBudget",
  max_bid: "maxBid",
  rate_limit_per_min: "rateLimitPerMin",
  write_rate_limit_per_10min: "writeRateLimitPer10Min",
  write_delay_seconds: "writeDelaySeconds",
  allowed_ips: "allowedIps",
  money_caps_required: "moneyCapsRequired",
  telegram_tool: "telegramTool",
  telegram_notify_writes: "telegramNotifyWrites",
  telegram_messages_per_hour: "telegramMessagesPerHour",
  drive_public_links: "drivePublicLinks",
  drive_sheet_writeback: "driveSheetWriteback",
  tiktok_gmv_max_write: "tiktokGmvMaxWrite",
  protection_mode: "protectionMode",
  apify_enabled: "apifyEnabled",
  apify_run_max_usd: "apifyRunMaxUsd",
  apify_daily_max_usd: "apifyDailyMaxUsd",
  apify_store_actors: "apifyStoreActors",
  meta_page_messages: "metaPageMessages",
}

/**
 * A request limit within the bounds the MCP form allows (MCP_LIMITS, one source of truth): a number outside them is
 * clamped to the nearest bound (v1.1.6 B8 - e.g. a hand-edited 5000 → 1000), a fraction is rounded down; anything
 * that is not a finite number falls back to the default.
 */
function clampLimit(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
}

function pick<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback
  const r = schema.safeParse(value)
  return r.success ? r.data : fallback
}

/** keep every valid entry (a single bad entry must not drop the other caps) */
function parseCaps(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [cur, amount] of Object.entries(v as Record<string, unknown>)) {
      const n = typeof amount === "string" ? Number(amount) : amount
      if (/^[A-Za-z]{3}$/.test(cur) && typeof n === "number" && Number.isFinite(n) && n > 0) out[cur.toUpperCase()] = n
    }
  }
  return out
}

export function parseMcpSettings(raw: unknown): McpSettings {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const n: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    const camel = SNAKE_TO_CAMEL[k] ?? k
    // camelCase wins when both spellings are present
    if (camel in n && k !== camel) continue
    n[camel] = v
  }
  const d = DEFAULT_MCP_SETTINGS
  return {
    // missing (rows saved before the mode existed) or corrupt → advanced: every stored limit keeps applying (fail closed)
    protectionMode: pick(fields.protectionMode, n.protectionMode, d.protectionMode),
    twoStepConfirm: pick(fields.twoStepConfirm, n.twoStepConfirm, d.twoStepConfirm),
    budgetChangeMaxPct: pick(fields.budgetChangeMaxPct, n.budgetChangeMaxPct, d.budgetChangeMaxPct),
    maxDailyBudget: parseCaps(n.maxDailyBudget),
    maxLifetimeBudget: parseCaps(n.maxLifetimeBudget),
    maxBid: parseCaps(n.maxBid),
    rateLimitPerMin: clampLimit(n.rateLimitPerMin, MCP_LIMITS.rateLimitPerMin, d.rateLimitPerMin),
    writeRateLimitPer10Min: clampLimit(n.writeRateLimitPer10Min, MCP_LIMITS.writeRateLimitPer10Min, d.writeRateLimitPer10Min),
    // missing (rows saved before the setting existed) or invalid → 0 = no pacing (the behaviour before it existed)
    writeDelaySeconds: pick(fields.writeDelaySeconds, n.writeDelaySeconds, d.writeDelaySeconds),
    // fail closed: a present but corrupt allowlist matches nothing (never "any IP")
    allowedIps:
      n.allowedIps === undefined || n.allowedIps === null
        ? [...d.allowedIps]
        : pick(fields.allowedIps, n.allowedIps, ["invalid-allowlist"]),
    // only an explicit true: rows written before the flag existed are legacy (caps optional)
    moneyCapsRequired: n.moneyCapsRequired === true,
    // Telegram: off unless explicitly true (safe default), quota falls back to the default when invalid
    telegramTool: n.telegramTool === true,
    telegramNotifyWrites: n.telegramNotifyWrites === true,
    telegramMessagesPerHour: pick(fields.telegramMessagesPerHour, n.telegramMessagesPerHour, d.telegramMessagesPerHour),
    // Google Drive: ON unless explicitly false (owner decision G6) - MCPs saved before the feature have no key and
    // get the default without a data migration
    drivePublicLinks: n.drivePublicLinks !== false,
    driveSheetWriteback: n.driveSheetWriteback !== false,
    // TikTok GMV Max writes: OFF unless explicitly true (admin-only switch; fail closed)
    tiktokGmvMaxWrite: n.tiktokGmvMaxWrite === true,
    // Apify: OFF unless explicitly true; caps fall back to their defaults when missing / invalid (a corrupt per-run cap
    // never exceeds the default $1 - the store switch stays admin-only and fail closed)
    apifyEnabled: n.apifyEnabled === true,
    apifyRunMaxUsd: pick(fields.apifyRunMaxUsd, n.apifyRunMaxUsd, d.apifyRunMaxUsd),
    apifyDailyMaxUsd: pick(fields.apifyDailyMaxUsd, n.apifyDailyMaxUsd, d.apifyDailyMaxUsd),
    apifyStoreActors: n.apifyStoreActors === true,
    metaPageMessages: n.metaPageMessages === true,
  }
}

/**
 * Settings the MCP endpoint and its tools enforce. "basic" switches off every limit except the expiry date (see
 * PROTECTION_MODES); the stored advanced values are kept in the row and come back with "advanced". Numeric limits
 * that do not apply are UNLIMITED (callers check isUnlimited before using them).
 */
export function effectiveMcpSettings(s: McpSettings): McpSettings {
  if (s.protectionMode !== "basic") return s
  return {
    ...s,
    twoStepConfirm: false,
    budgetChangeMaxPct: UNLIMITED,
    maxDailyBudget: {},
    maxLifetimeBudget: {},
    maxBid: {},
    rateLimitPerMin: UNLIMITED,
    writeRateLimitPer10Min: UNLIMITED,
    writeDelaySeconds: 0,
    allowedIps: [],
    moneyCapsRequired: false,
    telegramMessagesPerHour: UNLIMITED,
    // the Apify per-run cap (apifyRunMaxUsd) always applies (A3); only the daily cap is an advanced limit
    apifyDailyMaxUsd: UNLIMITED,
  }
}
