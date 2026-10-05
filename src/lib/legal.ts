// Public legal pages (/privacy, /terms, /data-deletion): paths + pure helpers shared by the server (pages, settings)
// and the client (sidebar "Liên kết cho ứng dụng"). No server imports here.
import { z } from "zod"

export const LEGAL_PAGES = [
  { key: "privacy", path: "/privacy" },
  { key: "terms", path: "/terms" },
  { key: "dataDeletion", path: "/data-deletion" },
] as const

export type LegalPageKey = (typeof LEGAL_PAGES)[number]["key"]

/** Bounds of the two optional admin settings (Cài đặt → Thông tin pháp lý). */
export const LEGAL_ORG_NAME_MAX = 120
export const LEGAL_CONTACT_EMAIL_MAX = 254

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Organisation name: trimmed, ≤ 120 chars, single line; "" = not set. */
export const legalOrgNameSchema = z
  .string()
  .trim()
  .max(LEGAL_ORG_NAME_MAX, `Tối đa ${LEGAL_ORG_NAME_MAX} ký tự`)
  .refine(
    (v) => !CONTROL_CHARS.test(v),
    "Không dùng ký tự điều khiển hoặc xuống dòng"
  )

/** Privacy contact email: trimmed; "" = not set, otherwise a valid address. */
export const legalContactEmailSchema = z
  .string()
  .trim()
  .max(LEGAL_CONTACT_EMAIL_MAX, `Tối đa ${LEGAL_CONTACT_EMAIL_MAX} ký tự`)
  .refine(
    (v) => v === "" || z.email().safeParse(v).success,
    "Email không hợp lệ"
  )

/** Everything the legal texts need about this install. */
export interface LegalInfo {
  /** operator (data controller) shown on the pages: the admin setting, else the domain */
  orgName: string
  /** public host name, e.g. ads.example.com */
  domain: string
  /** public origin without trailing slash, e.g. https://ads.example.com */
  baseUrl: string
  /** privacy contact; null when not set or invalid (the pages then name "the system administrator") */
  contactEmail: string | null
  /** full months kept (+ the current month) for the MCP / staff logs */
  retentionMcpMonths: number
  retentionStaffMonths: number
}

export interface LegalInfoInput {
  orgName?: unknown
  contactEmail?: unknown
  /** APP_DOMAIN */
  appDomain?: string | null
  /** BETTER_AUTH_URL (public app URL) */
  appUrl?: string | null
  retentionMcpMonths?: unknown
  retentionStaffMonths?: unknown
  /** used when a retention value is missing/invalid */
  defaultRetentionMonths?: number
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null
  } catch {
    return null
  }
}

function months(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : fallback
}

/**
 * Pure resolution with fallbacks: org name → APP_DOMAIN → host of the app URL → "localhost";
 * contact email only when it validates; base URL from the app URL, else https://<domain>.
 */
export function resolveLegalInfo(input: LegalInfoInput): LegalInfo {
  const appDomain =
    typeof input.appDomain === "string" ? input.appDomain.trim() : ""
  const domain =
    (appDomain && appDomain !== "localhost" ? appDomain : null) ??
    hostOf(input.appUrl) ??
    (appDomain || "localhost")
  const baseUrl = originOf(input.appUrl) ?? `https://${domain}`

  const org = legalOrgNameSchema.safeParse(
    typeof input.orgName === "string" ? input.orgName : ""
  )
  const orgName = org.success && org.data !== "" ? org.data : domain

  const email = legalContactEmailSchema.safeParse(
    typeof input.contactEmail === "string" ? input.contactEmail : ""
  )
  const contactEmail = email.success && email.data !== "" ? email.data : null

  const fallback = months(input.defaultRetentionMonths, 3)
  return {
    orgName,
    domain,
    baseUrl,
    contactEmail,
    retentionMcpMonths: months(input.retentionMcpMonths, fallback),
    retentionStaffMonths: months(input.retentionStaffMonths, fallback),
  }
}

/** Absolute URL of a legal page: `base` (configured app URL) when usable, else `fallbackOrigin` (window.location). */
export function legalPageUrl(
  path: string,
  base: string | null | undefined,
  fallbackOrigin = ""
): string {
  const origin = originOf(base) ?? originOf(fallbackOrigin) ?? ""
  return `${origin}${path}`
}
