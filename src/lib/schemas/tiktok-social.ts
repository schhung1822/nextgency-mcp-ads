// TikTok Social (17-tiktok-social.md): shared contract between the UI, actions and services. No secrets here.
import { z } from "zod"

import { tiktokSocialVi } from "@/lib/i18n/vi/tiktok-social"

export const TIKTOK_SOCIAL_LIMITS = {
  nameMax: 80,
  /** TikTok accounts one MCP may use */
  perMcpMax: 50,
} as const

export const TIKTOK_SOCIAL_STATUSES = ["active", "expiring", "invalid", "disabled"] as const
export type TiktokSocialStatus = (typeof TIKTOK_SOCIAL_STATUSES)[number]

const e = tiktokSocialVi.errors

export const tiktokSocialIdSchema = z.object({ id: z.uuid({ error: e.notFound }) })

export const startTiktokSocialConnectSchema = z.object({
  /** "Kết nối lại" of an existing row (same TikTok account expected) */
  reconnectId: z.uuid({ error: e.notFound }).optional(),
})

export const renameTiktokSocialSchema = z.object({
  id: z.uuid({ error: e.notFound }),
  name: z
    .string()
    .trim()
    .min(1, { error: e.nameRequired })
    .max(TIKTOK_SOCIAL_LIMITS.nameMax, { error: e.nameTooLong }),
})

export const setTiktokSocialEnabledSchema = z.object({ id: z.uuid({ error: e.notFound }), enabled: z.boolean() })

export const deleteTiktokSocialSchema = z.object({
  id: z.uuid({ error: e.notFound }),
  confirmName: z.string().max(200),
})

/** callback query (?code&state | ?error&error_description) */
export const tiktokSocialCallbackSchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
})

export interface TiktokSocialAccountDto {
  id: string
  name: string
  username: string
  displayName: string | null
  profileUrl: string | null
  isBusinessAccount: boolean | null
  status: TiktokSocialStatus
  statusMessage: string | null
  /** end of the 1-year authorization (sign in again after it) */
  refreshExpiresAt: string
  lastCheckedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  /** the actor may rename / reconnect / disable / delete it */
  canManage: boolean
  /** admins only: who connected it */
  ownerEmail: string | null
  ownerId: string
}

export interface TiktokSocialAccountDetailDto extends TiktokSocialAccountDto {
  scopes: string[]
  /** MCPs that currently list this account (admins: every MCP; staff: their own) */
  mcps: { id: string; name: string }[]
}

/** an account a MCP form may pick: live and not disabled */
export function isUsableTiktokSocialAccount(a: Pick<TiktokSocialAccountDto, "status">): boolean {
  return a.status === "active" || a.status === "expiring"
}
