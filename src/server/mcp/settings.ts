// Parse mcp_servers.settings (jsonb) into McpSettings. Accepts the documented snake_case shape
// ({ two_step_confirm, budget_change_max_pct, max_daily_budget, max_lifetime_budget, max_bid,
//    rate_limit_per_min, write_rate_limit_per_10min, allowed_ips, money_caps_required })
// and camelCase (McpSettings). Every field is validated on its own: an invalid field falls back to
// its safe default without discarding the other (valid) fields.
import { z } from "zod"
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "./types"

const fields = {
  twoStepConfirm: z.boolean(),
  budgetChangeMaxPct: z.number().min(0).max(10_000),
  rateLimitPerMin: z.number().int().min(1).max(10_000),
  writeRateLimitPer10Min: z.number().int().min(1).max(10_000),
  allowedIps: z.array(z.string().max(64)).max(200),
}

const SNAKE_TO_CAMEL: Record<string, keyof McpSettings> = {
  two_step_confirm: "twoStepConfirm",
  budget_change_max_pct: "budgetChangeMaxPct",
  max_daily_budget: "maxDailyBudget",
  max_lifetime_budget: "maxLifetimeBudget",
  max_bid: "maxBid",
  rate_limit_per_min: "rateLimitPerMin",
  write_rate_limit_per_10min: "writeRateLimitPer10Min",
  allowed_ips: "allowedIps",
  money_caps_required: "moneyCapsRequired",
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
    twoStepConfirm: pick(fields.twoStepConfirm, n.twoStepConfirm, d.twoStepConfirm),
    budgetChangeMaxPct: pick(fields.budgetChangeMaxPct, n.budgetChangeMaxPct, d.budgetChangeMaxPct),
    maxDailyBudget: parseCaps(n.maxDailyBudget),
    maxLifetimeBudget: parseCaps(n.maxLifetimeBudget),
    maxBid: parseCaps(n.maxBid),
    rateLimitPerMin: pick(fields.rateLimitPerMin, n.rateLimitPerMin, d.rateLimitPerMin),
    writeRateLimitPer10Min: pick(fields.writeRateLimitPer10Min, n.writeRateLimitPer10Min, d.writeRateLimitPer10Min),
    // fail closed: a present but corrupt allowlist matches nothing (never "any IP")
    allowedIps:
      n.allowedIps === undefined || n.allowedIps === null
        ? [...d.allowedIps]
        : pick(fields.allowedIps, n.allowedIps, ["invalid-allowlist"]),
    // only an explicit true: rows written before the flag existed are legacy (caps optional)
    moneyCapsRequired: n.moneyCapsRequired === true,
  }
}
