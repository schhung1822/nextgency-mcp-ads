// Shared MCP types (contract between mcp-core, mcp-admin and services).
// No imports from "next/*" under src/server/mcp.
import type {
  DriveSourceKind,
  DriveSourceScope,
  FolderSourceConfig,
  SheetSourceConfig,
} from "../drive/types"
import type { Platform } from "../providers/types"

export const PERMISSIONS = ["read", "status", "update", "copy", "create", "delete"] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * MCP protection mode. "basic": only the expiry date applies - no two-step confirmation (ads_delete_object and TikTok
 * GMV Max writes still always confirm), no budget-change % limit, no per-currency money caps, no request / write rate
 * limit, no Telegram hourly limit, any IP; TikTok GMV Max create / copy need "advanced" + a daily cap. The advanced
 * values stay stored (applied again when switched back). "advanced": every setting below applies (behaviour before
 * the mode existed). Rows saved before the feature have no key → "advanced".
 */
export const PROTECTION_MODES = ["basic", "advanced"] as const
export type ProtectionMode = (typeof PROTECTION_MODES)[number]

/** Value of a numeric limit that does not apply (basic mode). Check with isUnlimited() - never do arithmetic on it. */
export const UNLIMITED = Number.POSITIVE_INFINITY

/** true when a numeric limit of the effective settings does not apply (basic mode). Only UNLIMITED itself - a NaN
 * computed by mistake must never open a limit. */
export function isUnlimited(n: number): boolean {
  return n === UNLIMITED
}

export interface McpSettings {
  /** basic / advanced (see PROTECTION_MODES). Grant settings are already effective (effectiveMcpSettings). */
  protectionMode: ProtectionMode
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
  /**
   * Pacing of ad-platform writes (runWrite: status, budget, update, create, copy, delete, media upload): an executed
   * write starts at least this many seconds after the previous one of this MCP finished; the server waits on its own
   * (write-pacing.ts). 0 = off (default; always 0 in basic mode). Telegram messages and sheet write-back are not paced.
   */
  writeDelaySeconds: number
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
  /**
   * Google Drive: public "Anyone with the link" Drive links (files / folders) may be used, read with the system API
   * key (15-google-drive-media.md G6). Default ON - a missing key (MCPs saved before the feature) reads as true.
   */
  drivePublicLinks: boolean
  /** Google Drive: the MCP may write status / result columns of sheets that enabled write-back. Default ON. */
  driveSheetWriteback: boolean
  /**
   * TikTok GMV Max: the AI may change GMV Max campaigns (on/off, budget/ROI, products, creatives, copy, create,
   * delete) within the MCP's TikTok permissions. Default OFF; only an admin can turn it on (C2). Fail closed: only an
   * explicit true enables it.
   */
  tiktokGmvMaxWrite: boolean
}

/** Bounds of McpSettings.telegramMessagesPerHour */
export const TELEGRAM_MESSAGES_PER_HOUR = { min: 1, max: 200, default: 20 } as const

/**
 * Bounds of McpSettings.writeDelaySeconds (0 = off). The max is also the longest pacing wait of one call: ChatGPT cuts
 * a tool call at 60 s, so wait + the write itself must fit well below that.
 */
export const WRITE_DELAY_SECONDS = { min: 0, max: 30 } as const

/** Lifetime budget without a known end date: at most maxDailyBudget × this many days. */
export const LIFETIME_DEFAULT_DAYS = 30

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  // runtime default for a stored row without the key (saved before the mode existed); new MCPs default to basic in the form
  protectionMode: "advanced",
  twoStepConfirm: true,
  budgetChangeMaxPct: 50,
  maxDailyBudget: {},
  maxLifetimeBudget: {},
  maxBid: {},
  rateLimitPerMin: 60,
  writeRateLimitPer10Min: 20,
  writeDelaySeconds: 0,
  allowedIps: [],
  moneyCapsRequired: false,
  telegramTool: false,
  telegramNotifyWrites: false,
  telegramMessagesPerHour: TELEGRAM_MESSAGES_PER_HOUR.default,
  drivePublicLinks: true,
  driveSheetWriteback: true,
  tiktokGmvMaxWrite: false,
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

/**
 * A Google Drive folder / Google Sheet tab the MCP may use (mcp_drive_scopes ⋈ live drive_sources, status ≠ disabled,
 * ⋈ live usable drive_credentials; staff-owned MCP: company sources + the owner's personal sources only).
 * Never carries a secret (credentials and resource keys are loaded / decrypted by drive-access.ts when needed).
 */
export interface GrantDriveSource {
  /** drive_sources.id */
  id: string
  kind: DriveSourceKind
  scope: DriveSourceScope
  /** display name (typed by a user: untrusted text) */
  name: string
  /** folder id / spreadsheet id */
  googleId: string
  /** sheet tab id, null for folders */
  sheetGid: number | null
  credentialId: string
  ownerId: string
  status: "active" | "error"
  /** shared drive id of a folder (listing with corpora=drive), null for My Drive */
  sharedDriveId: string | null
  /** normalised config: folder → FolderSourceConfig, sheet → SheetSourceConfig */
  config: FolderSourceConfig | SheetSourceConfig
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
  /** Google Drive folders / sheets in scope (drive_* tools, ads_upload_media drive_file) */
  driveSources: GrantDriveSource[]
  /** the system Drive credential is live (not disabled) AND has an API key: public "Anyone with the link" files readable */
  drivePublicAvailable: boolean
}

export function grantAllows(grant: McpGrant, platform: Platform, permission: Permission): boolean {
  return grant.permissions[platform]?.includes(permission) ?? false
}

export function grantPlatformsWith(grant: McpGrant, permission: Permission): Platform[] {
  return (Object.keys(grant.permissions) as Platform[]).filter((p) => grantAllows(grant, p, permission))
}
