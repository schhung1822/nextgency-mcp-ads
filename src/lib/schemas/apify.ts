// Zod schemas + client-safe DTO types for Apify tokens (16-apify.md). Shared client/server.
// The API token is accepted on input only: no DTO ever carries it (only `credentialHint`, 4 last chars).
// Vietnamese strings for these messages live in src/lib/i18n/vi/apify.ts (imported lazily by the UI agent).
import { z } from "zod"

import { reauthCodeSchema } from "@/lib/schemas/reauth"
import { hasForbiddenNameChars } from "@/lib/text-safety"

/** company = shared by every MCP that enables Apify (admins only); personal = only the owner's MCPs */
export const APIFY_TOKEN_SCOPES = ["company", "personal"] as const
export type ApifyTokenScope = (typeof APIFY_TOKEN_SCOPES)[number]

/** exhausted = out of credit until `exhaustedUntil` (credit cycle end); invalid = rejected by Apify (401) */
export const APIFY_TOKEN_STATUSES = [
  "active",
  "exhausted",
  "invalid",
  "error",
  "disabled",
] as const
export type ApifyTokenStatus = (typeof APIFY_TOKEN_STATUSES)[number]

/**
 * Apify API token. Personal / organization tokens start with "apify_api_" (soft format check: the real check is
 * GET /v2/users/me). Only header auth is used (never ?token=), still keep the charset strict.
 */
export const APIFY_TOKEN_RE = /^apify_api_[A-Za-z0-9]{20,120}$/

export const APIFY_LIMITS = {
  nameMax: 80,
  /** per-run cap (USD) the MCP may set; always enforced, also in basic mode (owner decision A3) */
  runMaxUsd: { min: 0.05, max: 20, default: 1 },
  /** daily cap per MCP (USD, Asia/Ho_Chi_Minh day), advanced protection mode only; 0 = no daily cap */
  dailyMaxUsd: { min: 0, max: 1000, default: 10 },
} as const

export const APIFY_SCHEMA_MESSAGES = {
  nameRequired: "Nhập tên gợi nhớ cho token.",
  nameTooLong: `Tên tối đa ${APIFY_LIMITS.nameMax} ký tự.`,
  badChars: "Không dùng ký tự điều khiển hoặc ký tự đảo chiều văn bản.",
  tokenRequired: "Dán API token của Apify.",
  tokenFormat:
    'Token Apify có dạng "apify_api_…" (Apify Console → Settings → API & Integrations).',
  scopeAdminOnly: "Chỉ quản trị viên được thêm token dùng chung công ty.",
  id: "Mã không hợp lệ.",
} as const
const msg = APIFY_SCHEMA_MESSAGES

export const apifyTokenNameSchema = z
  .string()
  .trim()
  .min(1, msg.nameRequired)
  .max(APIFY_LIMITS.nameMax, msg.nameTooLong)
  .refine((v) => !hasForbiddenNameChars(v), msg.badChars)

export const apifyTokenValueSchema = z
  .string()
  .trim()
  .min(1, msg.tokenRequired)
  .regex(APIFY_TOKEN_RE, msg.tokenFormat)

/** "Kiểm tra" before saving: validates the token against Apify, nothing stored */
export const previewApifyTokenSchema = z.object({
  token: apifyTokenValueSchema,
})

export const createApifyTokenSchema = z.object({
  name: apifyTokenNameSchema,
  token: apifyTokenValueSchema,
  /** staff may only create "personal" (enforced again by the service) */
  scope: z.enum(APIFY_TOKEN_SCOPES),
})
export type CreateApifyTokenInput = z.input<typeof createApifyTokenSchema>

export const apifyTokenIdSchema = z.object({ id: z.uuid(msg.id) })

export const renameApifyTokenSchema = z.object({
  id: z.uuid(msg.id),
  name: apifyTokenNameSchema,
})

export const setApifyTokenEnabledSchema = z.object({
  id: z.uuid(msg.id),
  enabled: z.boolean(),
})

/** replacing the secret needs re-authentication (password + 2FA code when enabled) */
export const replaceApifyTokenSchema = z.object({
  id: z.uuid(msg.id),
  token: apifyTokenValueSchema,
  password: z.string().min(1, "Nhập mật khẩu.").max(256),
  code: reauthCodeSchema,
})

export const deleteApifyTokenSchema = z.object({
  id: z.uuid(msg.id),
  confirmName: z.string().max(APIFY_LIMITS.nameMax + 20),
})

/** Non-secret account info shown after "Kiểm tra" and on the list (from GET /v2/users/me + /users/me/limits). */
export interface ApifyAccountPreview {
  apifyUserId: string
  username: string | null
  /** e.g. FREE / STARTER / SCALE / BUSINESS */
  planId: string | null
  /** FREE…DIAMOND - pay-per-event prices depend on it */
  planTier: string | null
  /** current.monthlyUsageUsd */
  usageUsd: number | null
  /** limits.maxMonthlyUsageUsd */
  limitUsd: number | null
  /** monthlyUsageCycle.endAt (ISO) - credit resets then */
  cycleEndAt: string | null
  /** Actors can run on this account right now (effectivePlatformFeatures.ACTORS.isEnabled) */
  actorsEnabled: boolean
  /** other live tokens already saved for the same Apify account (they share the credit) */
  sameAccountTokens: number
}

/** One token as shown in the Connections → Apify tab / detail page. Never carries the secret. */
export interface ApifyTokenDto {
  id: string
  name: string
  scope: ApifyTokenScope
  ownerId: string
  /** creator's display name (admins see everyone's tokens) */
  ownerName: string | null
  credentialHint: string
  apifyUsername: string | null
  planId: string | null
  planTier: string | null
  usageUsd: number | null
  limitUsd: number | null
  cycleEndAt: string | null
  status: ApifyTokenStatus
  statusMessage: string | null
  exhaustedUntil: string | null
  lastCheckedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  /** the viewer may rename / replace / disable / delete it (admin: all; staff: own personal tokens) */
  canManage: boolean
}

/** What the MCP wizard shows on the Apify card for an MCP owner (no secrets, no other people's personal tokens). */
export interface McpApifyPoolSummary {
  /** live tokens the MCP would rotate through (company + the owner's personal, not disabled / invalid) */
  tokens: number
  /** distinct Apify accounts among them (tokens of one account share the credit) */
  accounts: number
  /** tokens usable right now (active, or exhausted whose credit cycle ended) */
  usableNow: number
  company: number
  personal: number
}

/** The pool has a token usable right now: enough to build an Apify-only MCP on it (decision A5). */
export function hasUsableApifyToken(
  pool: Pick<McpApifyPoolSummary, "usableNow"> | null | undefined
): boolean {
  return (pool?.usableNow ?? 0) > 0
}

export function isUsableApifyStatus(
  status: ApifyTokenStatus,
  exhaustedUntil: string | null,
  now = Date.now()
): boolean {
  if (status === "active") return true
  return (
    status === "exhausted" &&
    exhaustedUntil !== null &&
    new Date(exhaustedUntil).getTime() <= now
  )
}

/** Detail page of one token: the list DTO + where it is used + recent runs (no secrets, no run data). */
export interface ApifyTokenDetail extends ApifyTokenDto {
  /** MCPs that would rotate through this token (other people's MCPs anonymised for staff: mcpId null) */
  mcpUsage: { mcpId: string | null; mcpName: string; ownerName: string | null }[]
  /** latest runs started with this token (≤ 20, newest first) */
  recentRuns: {
    id: string
    mcpName: string
    actorId: string
    taskKey: string | null
    status: string
    usageUsd: number | null
    startedAt: string
  }[]
}
