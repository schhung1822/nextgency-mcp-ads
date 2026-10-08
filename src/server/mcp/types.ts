// Shared MCP types (contract between mcp-core, mcp-admin and services).
// No imports from "next/*" under src/server/mcp.
import type { Platform } from "../providers/types"

export const PERMISSIONS = ["read", "status", "update", "copy", "create", "delete"] as const
export type Permission = (typeof PERMISSIONS)[number]

export interface McpSettings {
  /** require preview + confirm_token for write tools (delete always requires it) */
  twoStepConfirm: boolean
  /** max % change of a budget in one call (e.g. 50 → ±50%) */
  budgetChangeMaxPct: number
  /** optional hard cap of daily budget per currency, MAJOR units, e.g. { VND: 5_000_000 } */
  maxDailyBudget: Record<string, number>
  /**
   * optional cap of lifetime budgets per currency, MAJOR units. Lifetime budgets are always limited to
   * maxDailyBudget × days of the flight (when the end is known) or × LIFETIME_DEFAULT_DAYS (unknown end);
   * this explicit cap applies on top of that.
   */
  maxLifetimeBudget: Record<string, number>
  /** optional cap of bids / cost targets (bid_amount, max_bid, cpc_bid, target_cpa…) per currency, MAJOR units */
  maxBid: Record<string, number>
  /** requests per minute for this MCP */
  rateLimitPerMin: number
  /** executed write operations (set_status, budget, create, copy, delete, upload…) per 10 minutes */
  writeRateLimitPer10Min: number
  /** empty = any IP; supports single IPs and CIDR */
  allowedIps: string[]
  /**
   * true for MCPs created / saved since the security release (stored `money_caps_required: true`): money
   * writes need a daily cap for the account currency. false = legacy row (no cap required, warnings only).
   */
  moneyCapsRequired: boolean
  /** Telegram: the AI may call telegram_send_message (needs ≥ 1 channel in scope) */
  telegramTool: boolean
  /** Telegram: after every successful write execution, send a summary to the channels in scope */
  telegramNotifyWrites: boolean
  /** Telegram: messages per hour (sliding window) telegram_send_message may send for this MCP, 1–200 */
  telegramMessagesPerHour: number
}

/** Bounds of McpSettings.telegramMessagesPerHour */
export const TELEGRAM_MESSAGES_PER_HOUR = { min: 1, max: 200, default: 20 } as const

/** Lifetime budget without a known end date: at most maxDailyBudget × this many days. */
export const LIFETIME_DEFAULT_DAYS = 30

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  twoStepConfirm: true,
  budgetChangeMaxPct: 50,
  maxDailyBudget: {},
  maxLifetimeBudget: {},
  maxBid: {},
  rateLimitPerMin: 60,
  writeRateLimitPer10Min: 20,
  allowedIps: [],
  moneyCapsRequired: false,
  telegramTool: false,
  telegramNotifyWrites: false,
  telegramMessagesPerHour: TELEGRAM_MESSAGES_PER_HOUR.default,
}

/** An ad account the MCP may act on (already filtered: enabled, connection active, owner rules applied). */
export interface GrantAccount {
  /** ad_accounts.id */
  id: string
  connectionId: string
  platform: Platform
  externalId: string
  name: string
  currency: string
  timezone: string
}

/** A Facebook Page the MCP may read (Meta; enabled, not missing, connection usable, owner rules applied). */
export interface GrantPage {
  /** meta_pages.id */
  id: string
  connectionId: string
  /** Page id */
  externalId: string
  name: string
  category: string | null
  followersCount: number | null
  verificationStatus: string | null
  /** tasks of the connection's user on the Page (ANALYZE → insights, ADVERTISE → ads posts…) */
  tasks: string[]
  businessName: string | null
}

/**
 * A Telegram channel the MCP may send to (mcp_notification_scopes; status active|error, not deleted, owner rules
 * applied). Never carries the bot token or the raw chat id.
 */
export interface GrantChannel {
  /** notification_channels.id */
  id: string
  name: string
  chatTitle: string | null
  hasThread: boolean
}

/** Everything a request to /mcp/<key> is allowed to do. Loaded once per request. */
export interface McpGrant {
  mcpId: string
  mcpName: string
  ownerId: string
  ownerEmail: string
  ownerRole: "admin" | "staff"
  settings: McpSettings
  /** platform → granted permissions (always includes "read") */
  permissions: Partial<Record<Platform, Permission[]>>
  accounts: GrantAccount[]
  /** Facebook Pages in scope - only when the MCP may read Meta (empty otherwise) */
  pages: GrantPage[]
  /** Telegram channels in scope (telegram_* tools + notifications after writes); independent of ad platforms */
  notificationChannels: GrantChannel[]
}

export function grantAllows(grant: McpGrant, platform: Platform, permission: Permission): boolean {
  return grant.permissions[platform]?.includes(permission) ?? false
}

export function grantPlatformsWith(grant: McpGrant, permission: Permission): Platform[] {
  return (Object.keys(grant.permissions) as Platform[]).filter((p) => grantAllows(grant, p, permission))
}
