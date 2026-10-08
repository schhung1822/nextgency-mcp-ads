// Zod schemas + client-safe DTO types for the "Kết nối quảng cáo" feature (shared client/server).
// Platform credential *content* is validated server-side by each adapter's parseCredentials().
import { z } from "zod"

import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"
import { connections as m } from "@/lib/i18n/vi/connections"
import { reauthCodeSchema } from "@/lib/schemas/reauth"
import { RELEASED_PLATFORMS } from "@/lib/platforms"
import type { Platform } from "@/server/providers/types"

/** Platforms a connection can be created for in this build (src/lib/platforms.ts). */
export const CONNECTION_PLATFORMS = RELEASED_PLATFORMS
export type ConnectionStatusValue = "active" | "expiring" | "invalid" | "disabled"
export type AdAccountStatusValue = "active" | "disabled" | "pending" | "closed" | "unknown"

export const platformSchema = z.enum(CONNECTION_PLATFORMS, { error: m.errors.platformRequired })

export const connectionNameSchema = z
  .string({ error: m.errors.nameRequired })
  .trim()
  .min(1, { error: m.errors.nameRequired })
  .max(100, { error: m.errors.nameTooLong })

const uuid = z.uuid({ error: m.errors.notFound })

/** Raw credential form values keyed by CredentialFieldSpec.key (strings only, bounded). */
export const credentialValuesSchema = z
  .record(z.string().min(1).max(64), z.string().max(20_000))
  .refine((v) => Object.keys(v).length <= 20, { error: m.errors.invalidInput })

const externalIds = z.array(z.string().min(1).max(128)).max(5000).default([])

export const previewConnectionSchema = z.object({
  platform: platformSchema,
  credentials: credentialValuesSchema,
})
export type PreviewConnectionInput = z.input<typeof previewConnectionSchema>

export const createConnectionSchema = z.object({
  platform: platformSchema,
  name: connectionNameSchema,
  credentials: credentialValuesSchema,
  /** accounts the user switched OFF in step 3 */
  disabledExternalIds: externalIds,
  /**
   * accounts the user explicitly switched ON in step 3 although they default to OFF (closed / disabled / pending
   * accounts and manager accounts - see `isDefaultEnabled`). Everything else follows its default.
   */
  enabledExternalIds: externalIds,
})
export type CreateConnectionInput = z.input<typeof createConnectionSchema>

/** TikTok "Đổi auth_code": app id + secret + one-time auth_code (exchanged server-side, never echoed back). */
const authCodeFields = {
  appId: z
    .string({ error: m.errors.appIdRequired })
    .trim()
    .min(1, { error: m.errors.appIdRequired })
    .max(64, { error: m.errors.appIdFormat })
    .regex(/^\d+$/, { error: m.errors.appIdFormat }),
  secret: z.string({ error: m.errors.appSecretRequired }).trim().min(1, { error: m.errors.appSecretRequired }).max(256),
  authCode: z.string({ error: m.errors.authCodeRequired }).trim().min(1, { error: m.errors.authCodeRequired }).max(512),
}

export const tiktokAuthCodeCreateSchema = z.object({
  name: connectionNameSchema,
  ...authCodeFields,
})
export type TikTokAuthCodeCreateInput = z.input<typeof tiktokAuthCodeCreateSchema>

const password = z.string({ error: m.errors.passwordRequired }).min(1, { error: m.errors.passwordRequired }).max(256)

export const tiktokAuthCodeReplaceSchema = z.object({
  connectionId: uuid,
  password,
  /** TOTP code - required by the server when the user has 2FA enabled */
  code: reauthCodeSchema,
  ...authCodeFields,
})
export type TikTokAuthCodeReplaceInput = z.input<typeof tiktokAuthCodeReplaceSchema>

export const connectionIdSchema = z.object({ connectionId: uuid })

export const renameConnectionSchema = z.object({ connectionId: uuid, name: connectionNameSchema })
export type RenameConnectionInput = z.input<typeof renameConnectionSchema>

export const replaceCredentialsSchema = z.object({
  connectionId: uuid,
  credentials: credentialValuesSchema,
  password,
  /** TOTP code - required by the server when the user has 2FA enabled */
  code: reauthCodeSchema,
})
export type ReplaceCredentialsInput = z.input<typeof replaceCredentialsSchema>

export const toggleAccountsSchema = z.object({
  connectionId: uuid,
  changes: z
    .array(z.object({ adAccountId: uuid, enabled: z.boolean() }))
    .min(1)
    .max(500, { error: m.errors.tooManyAccounts }),
})
export type ToggleAccountsInput = z.input<typeof toggleAccountsSchema>

export const togglePagesSchema = z.object({
  connectionId: uuid,
  changes: z
    .array(z.object({ pageId: uuid, enabled: z.boolean() }))
    .min(1)
    .max(500, { error: m.errors.tooManyPages }),
})
export type TogglePagesInput = z.input<typeof togglePagesSchema>

// ---------------------------------------------------------------------------
// DTOs returned to pages / client components - NEVER contain credentials or ciphertext.
// Dates are ISO strings.
// ---------------------------------------------------------------------------

export interface ConnectionListItem {
  id: string
  name: string
  platform: Platform
  status: ConnectionStatusValue
  /** what happened (Vietnamese) - no instruction inside */
  statusMessage: string | null
  /** the concrete next step (Vietnamese), e.g. create a new token and press "Thay token"; null when nothing to do */
  statusHint: string | null
  credentialHint: string
  tokenExpiresAt: string | null
  lastCheckedAt: string | null
  createdAt: string
  accountCount: number
  enabledAccountCount: number
  owner: { id: string; email: string; name: string }
}

export interface AdAccountDto {
  id: string
  externalId: string
  name: string
  currency: string
  timezone: string
  status: AdAccountStatusValue
  statusRaw: string | null
  isEnabled: boolean
  isManager: boolean
  parentExternalId: string | null
  lastSyncedAt: string | null
}

/** Facebook Page of a Meta connection (read-only Pages tools). */
export interface MetaPageDto {
  id: string
  externalId: string
  name: string
  category: string | null
  link: string | null
  pictureUrl: string | null
  followersCount: number | null
  verificationStatus: string | null
  isPublished: boolean | null
  tasks: string[]
  sources: string[]
  businessName: string | null
  isEnabled: boolean
  /** not returned by the last sync (kept, never handed to an MCP) */
  isMissing: boolean
  lastSyncedAt: string | null
  /** what the connection's user may read on the Page */
  capabilities: { posts: boolean; insights: boolean; adsPosts: boolean }
}

/** Outcome of the last Pages sync of a Meta connection. */
export interface PagesSyncDto {
  ok: boolean
  at: string
  count: number
  warnings: string[]
}

export interface McpUsage {
  /** null when the MCP belongs to someone else and the viewer is staff (no foreign MCP ids for staff) */
  id: string | null
  /** null when the MCP belongs to someone else and the viewer is staff */
  name: string | null
  ownedByViewer: boolean
}

export interface ConnectionDetail extends ConnectionListItem {
  scopes: string[] | null
  warnings: string[]
  updatedAt: string
  accounts: AdAccountDto[]
  /** Facebook Pages (Meta connections; empty otherwise) */
  pages: MetaPageDto[]
  /** null = Pages never synced (or not a Meta connection) */
  pagesSync: PagesSyncDto | null
  usedBy: McpUsage[]
}

/** Account found during the step-3 preview (not yet saved). */
export interface PreviewAccount {
  externalId: string
  name: string
  currency: string
  timezone: string
  status: AdAccountStatusValue
  statusRaw: string
  isManager: boolean
  parentExternalId: string | null
  /** false → the wizard starts this account switched OFF (closed / disabled / pending / manager accounts) */
  defaultEnabled: boolean
}

export interface ConnectionPreview {
  status: ConnectionStatusValue
  statusMessage: string | null
  statusHint: string | null
  tokenExpiresAt: string | null
  scopes: string[] | null
  warnings: string[]
  accounts: PreviewAccount[]
}

export interface ConnectionCheckResult {
  status: ConnectionStatusValue
  statusMessage: string | null
  statusHint: string | null
  tokenExpiresAt: string | null
  accountCount?: number
}

/** Credential form spec + guide for one platform, passed from the server page to the wizard. */
export interface PlatformFormSpec {
  platform: Platform
  fields: {
    key: string
    label: string
    type: "secret" | "text" | "textarea" | "select"
    required: boolean
    placeholder?: string
    help?: string
    options?: { value: string; label: string }[]
    showWhen?: { key: string; equals: string }
  }[]
  guide: {
    summary: string
    steps: { title: string; detail: string; link?: { label: string; url: string } }[]
    requiredScopes?: string[]
    warnings?: string[]
  }
  /** TikTok only: offer the auth_code → access token exchange ("Đổi auth_code") */
  supportsAuthCode: boolean
}

/** Show a field given the current form values (CredentialFieldSpec.showWhen). */
export function isFieldVisible(
  field: { showWhen?: { key: string; equals: string } },
  values: Record<string, string | undefined>
): boolean {
  return !field.showWhen || values[field.showWhen.key] === field.showWhen.equals
}

/** Keep only visible, non-empty values (hidden branch of a showWhen form must not be sent). */
export function visibleCredentialValues(
  fields: PlatformFormSpec["fields"],
  values: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (!isFieldVisible(f, values)) continue
    const v = values[f.key]
    if (typeof v === "string" && v.trim() !== "") out[f.key] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared rules (pure, used by the services and by the wizard)
// ---------------------------------------------------------------------------

/**
 * Should a newly discovered ad account be switched ON by default (wizard step 3)? Closed / disabled / pending
 * accounts cannot run ads and manager accounts hold no campaigns of their own, so they start OFF -
 * the user can still switch them on. Everything else (active, unknown) starts ON.
 */
export function isDefaultEnabled(a: { status: AdAccountStatusValue | string; isManager?: boolean | null }): boolean {
  if (a.isManager) return false
  return a.status !== "closed" && a.status !== "disabled" && a.status !== "pending"
}

/** Wizard step 3: the accounts the user wants ON, starting from what the server will do by default. */
export function initialEnabledExternalIds(accounts: readonly Pick<PreviewAccount, "externalId" | "defaultEnabled">[]): Set<string> {
  return new Set(accounts.filter((a) => a.defaultEnabled).map((a) => a.externalId))
}

/**
 * What to send to `createConnection` for the switches in step 3. The server applies `isDefaultEnabled` to every
 * account, so only the DIFFERENCES from the default travel: default-on accounts the user switched off →
 * `disabledExternalIds`; default-off accounts (closed / disabled / pending / manager) switched on → `enabledExternalIds`.
 */
export function enabledDiffFromDefaults(
  accounts: readonly Pick<PreviewAccount, "externalId" | "defaultEnabled">[],
  enabled: ReadonlySet<string>
): { disabledExternalIds: string[]; enabledExternalIds: string[] } {
  const disabledExternalIds: string[] = []
  const enabledExternalIds: string[] = []
  for (const a of accounts) {
    const on = enabled.has(a.externalId)
    if (a.defaultEnabled && !on) disabledExternalIds.push(a.externalId)
    else if (!a.defaultEnabled && on) enabledExternalIds.push(a.externalId)
  }
  return { disabledExternalIds, enabledExternalIds }
}

/** How many found accounts start OFF, split by reason (a manager account counts as manager even when it is also closed). */
export function defaultOffSummary(accounts: readonly Pick<PreviewAccount, "defaultEnabled" | "isManager">[]): {
  inactive: number
  manager: number
  total: number
} {
  let inactive = 0
  let manager = 0
  for (const a of accounts) {
    if (a.defaultEnabled) continue
    if (a.isManager) manager++
    else inactive++
  }
  return { inactive, manager, total: inactive + manager }
}

// ---------------------------------------------------------------------------
// Status message + hint
// ---------------------------------------------------------------------------

/** Lower-case, collapse whitespace and drop trailing punctuation so two sentences compare loosely ("is it already said?"). */
function normalizeSentence(s: string): string {
  return s
    .toLocaleLowerCase("vi-VN")
    .replace(/\s+/g, " ")
    .replace(/[\s.!?…]+$/g, "")
    .trim()
}

/**
 * The `statusHint` text worth showing under `statusMessage`: some adapters already put the instruction inside the
 * message ("… Hãy tạo key mới rồi dán lại."), so a hint (or any sentence of it) that the message already contains is
 * dropped. Returns null when nothing new is left to say.
 */
export function visibleStatusHint(message: string | null | undefined, hint: string | null | undefined): string | null {
  const h = hint?.trim()
  if (!h) return null
  const said = normalizeSentence(message ?? "")
  if (!said) return h
  if (said.includes(normalizeSentence(h))) return null
  const left = h
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const n = normalizeSentence(sentence)
      return n !== "" && !said.includes(n)
    })
  return left.length > 0 ? left.join(" ") : null
}

/** Plain-text tooltip of a connection status: what happened, then the next step (once). undefined when there is nothing to say. */
export function statusTooltip(c: { statusMessage: string | null; statusHint: string | null }): string | undefined {
  const parts = [c.statusMessage?.trim() || null, visibleStatusHint(c.statusMessage, c.statusHint)].filter(
    (p): p is string => !!p
  )
  return parts.length > 0 ? parts.join("\n") : undefined
}

/** Every `statusHint` the server can produce (see `statusHintFor` + the wizard's "paste again"). */
const KNOWN_HINTS: readonly string[] = [
  ...Object.values(cs.hint.invalid),
  ...Object.values(cs.hint.expiring),
  cs.hint.credentialsUnreadable,
  cs.hint.pasteAgain,
  cs.hint.retry,
]

/**
 * Wizard / dialogs throw ONE string `"<message> <hint>"` (ConnectionServiceError). Splits a known trailing hint off
 * so the UI can show it as its own muted line; any other text comes back unchanged with `hint: null`.
 */
export function splitTrailingHint(text: string): { message: string; hint: string | null } {
  const t = text.trim()
  for (const hint of KNOWN_HINTS) {
    if (t.length > hint.length && t.endsWith(hint) && /\s/.test(t.charAt(t.length - hint.length - 1))) {
      return { message: t.slice(0, t.length - hint.length).trim(), hint }
    }
  }
  return { message: t, hint: null }
}

/**
 * The concrete next step for a connection, shown next to `statusMessage`: replace the token when it is invalid or
 * about to expire (platform specific wording), retry when the last check merely failed for a transient reason.
 */
export function statusHintFor(c: { platform: Platform; status: ConnectionStatusValue; statusMessage?: string | null }): string | null {
  if (c.statusMessage === cs.message.credentialsUnreadable) return cs.hint.credentialsUnreadable
  if (c.status === "invalid") return (cs.hint.invalid as Partial<Record<Platform, string>>)[c.platform] ?? null
  if (c.status === "expiring") return (cs.hint.expiring as Partial<Record<Platform, string>>)[c.platform] ?? null
  if (c.status === "active" && c.statusMessage) return cs.hint.retry
  return null
}
