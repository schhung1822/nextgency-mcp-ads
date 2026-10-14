// Shared building blocks of the Apify catalog (16-apify.md §6): zod field helpers (https-only URLs per platform,
// single-line text, country enums, handles), URL → marketplace helpers and the typed defineTask() wrapper.
// Pure module: no network, no DB, no next/* imports.
//
// Rules every task file follows (checked by catalog.test.ts):
// - task inputs are z.strictObject (unknown keys are rejected, so a mistyped field never silently falls back to a
//   default) and contain no transforms (they stay representable as JSON Schema for apify_list_tasks);
// - every buildInput sets EVERY limit-like field of its Actor (results, pages, reviews, comments, depth, scroll…)
//   from `limit`, switches paid add-ons off and never sets cookies / login / session / custom JS / webhooks /
//   output connectors / proxy URLs; field names come from the Actor's input schema (Apify Store, 2026-10-14);
// - timeoutSecs ≤ 600 and memoryMbytes ≤ 4096 (power of two, inside the Actor's min/max).
import { z } from "zod"

import { hasForbiddenNameChars } from "@/lib/text-safety"
import type { ApifyCatalogActor, ApifyCatalogTask } from "@/server/apify/types"

export const URL_MAX = 2048
export const KEYWORD_MAX = 120

/** Vietnamese validation messages (returned to the AI through apify_run_task errors). */
export const CATALOG_MESSAGES = {
  required: "Không được để trống.",
  tooLong: (n: number) => `Tối đa ${n} ký tự.`,
  badChars:
    "Không dùng ký tự điều khiển, xuống dòng hoặc ký tự đảo chiều văn bản.",
  https: (label: string) => `Cần link https:// hợp lệ của ${label}.`,
  credentials: "Link không được chứa tên đăng nhập hoặc mật khẩu.",
  unknownKeys: (keys: readonly PropertyKey[]) =>
    `Trường không được hỗ trợ: ${keys.map(String).join(", ")}.`,
  exactlyOne: (a: string, b: string) =>
    `Cần đúng một trong hai trường "${a}" hoặc "${b}".`,
  tooMany: (n: number) => `Tối đa ${n} mục.`,
  atLeastOne: "Cần ít nhất 1 mục.",
} as const
const MSG = CATALOG_MESSAGES

/** z.strictObject whose "unknown key" error is in Vietnamese. */
export function strictInput<T extends z.core.$ZodLooseShape>(shape: T) {
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys" ? MSG.unknownKeys(iss.keys) : undefined,
  })
}

export function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * https URL (≤ 2048 chars, trimmed) whose host matches `host` (when given) and that carries no user:password.
 * `check` adds a platform-specific rule (e.g. "must be a product page").
 */
export function httpsUrl(
  label: string,
  host?: RegExp,
  check?: { test: (url: URL) => boolean; message: string }
) {
  const base = z
    .string()
    .trim()
    .min(1, MSG.required)
    .max(URL_MAX, MSG.tooLong(URL_MAX))
    .pipe(
      z.url({
        protocol: /^https$/,
        ...(host ? { hostname: host } : {}),
        error: MSG.https(label),
      })
    )
    .refine((v) => {
      const u = safeUrl(v)
      return !!u && !u.username && !u.password
    }, MSG.credentials)
  if (!check) return base
  return base.refine((v) => {
    const u = safeUrl(v)
    return !!u && check.test(u)
  }, check.message)
}

/** 1–`max` URLs of the same kind. */
export function urlList(item: z.ZodType<string>, max: number) {
  return z.array(item).min(1, MSG.atLeastOne).max(max, MSG.tooMany(max))
}

/** Single-line free text (keyword, query, brand…): trimmed, 1..max chars, no control / bidi characters. */
export function singleLine(max = KEYWORD_MAX) {
  return z
    .string()
    .trim()
    .min(1, MSG.required)
    .max(max, MSG.tooLong(max))
    .refine((v) => !hasForbiddenNameChars(v), MSG.badChars)
}

/** Star filter 1–5 (unique values are enforced by the Actor mapping, duplicates are dropped there). */
export const starsField = z
  .array(z.int().min(1).max(5))
  .min(1)
  .max(5)
  .optional()
  .describe("Chỉ lấy đánh giá có số sao này, vd. [1, 2, 3] để đọc phàn nàn")

/** Unique star values as strings, highest first (Actor enums use "5".."1"). */
export function starStrings(stars: readonly number[] | undefined): string[] {
  const list = stars && stars.length > 0 ? stars : [5, 4, 3, 2, 1]
  return [...new Set(list)].sort((a, b) => b - a).map(String)
}

// ---------------------------------------------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------------------------------------------

/**
 * Markets accepted by the generic country fields (Facebook Ad Library, Google SERP / Maps / Ads Transparency /
 * Trends / Shopping, TikTok Creative Center). Every code exists in all of those Actors' enums (checked 2026-10-14).
 */
export const COUNTRY_CODES = [
  "VN",
  "TH",
  "ID",
  "MY",
  "PH",
  "SG",
  "KH",
  "US",
  "GB",
  "AU",
  "CA",
  "JP",
  "KR",
  "TW",
  "DE",
  "FR",
] as const
export type CountryCode = (typeof COUNTRY_CODES)[number]

export const countryField = z
  .enum(COUNTRY_CODES)
  .default("VN")
  .describe("Mã quốc gia (mặc định VN)")

export const languageField = z
  .enum(["vi", "en"])
  .default("vi")
  .describe("Ngôn ngữ kết quả (mặc định vi)")

// ---------------------------------------------------------------------------------------------------------------
// Platform hosts + URL helpers
// ---------------------------------------------------------------------------------------------------------------

export const HOSTS = {
  shopee:
    /(^|\.)shopee\.(vn|co\.id|co\.th|com\.my|sg|ph|com\.br|tw|com\.mx|com\.co|cl)$/,
  lazada: /(^|\.)lazada\.(vn|co\.id|com\.my|sg|com\.ph|co\.th)$/,
  tiki: /(^|\.)tiki\.vn$/,
  tiktok: /(^|\.)tiktok\.com$/,
  facebook: /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/,
  instagram: /(^|\.)instagram\.com$/,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/,
} as const

const SHOPEE_SUFFIX_COUNTRY: Record<string, string> = {
  vn: "VN",
  "co.id": "ID",
  "co.th": "TH",
  "com.my": "MY",
  sg: "SG",
  ph: "PH",
  "com.br": "BR",
  tw: "TW",
  "com.mx": "MX",
  "com.co": "CO",
  cl: "CL",
}

/** shopee.vn → "VN", shopee.co.id → "ID"…; null when the URL is not a Shopee URL. */
export function shopeeCountryFromUrl(url: string): string | null {
  const host = safeUrl(url)?.hostname ?? ""
  const m = /(?:^|\.)shopee\.(.+)$/.exec(host)
  return (m && SHOPEE_SUFFIX_COUNTRY[m[1]]) || null
}

const LAZADA_SUFFIX_COUNTRY: Record<string, string> = {
  vn: "VN",
  "co.id": "ID",
  "com.my": "MY",
  sg: "SG",
  "com.ph": "PH",
  "co.th": "TH",
}

/** lazada.vn → "VN", lazada.co.th → "TH"…; null when the URL is not a Lazada URL. */
export function lazadaCountryFromUrl(url: string): string | null {
  const host = safeUrl(url)?.hostname ?? ""
  const m = /(?:^|\.)lazada\.(.+)$/.exec(host)
  return (m && LAZADA_SUFFIX_COUNTRY[m[1]]) || null
}

/** Google Maps place / search URL (google.<tld>/maps…, maps.google.<tld>, maps.app.goo.gl, goo.gl/maps). */
export function isGoogleMapsUrl(u: URL): boolean {
  const h = u.hostname
  if (h === "maps.app.goo.gl") return true
  if (h === "goo.gl") return u.pathname.startsWith("/maps")
  if (/^maps\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)) return true
  return (
    /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h) &&
    u.pathname.startsWith("/maps")
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Handles (TikTok / Instagram usernames, hashtags)
// ---------------------------------------------------------------------------------------------------------------

const TIKTOK_HANDLE_RE = /^@?[A-Za-z0-9._]{2,24}$/
const INSTAGRAM_HANDLE_RE = /^@?[A-Za-z0-9._]{1,30}$/
/** letters (any script, incl. Vietnamese with combining marks), digits, underscore; optional leading # */
const HASHTAG_RE = /^#?[\p{L}\p{M}\p{N}_]{1,100}$/u

/** "@brand", "brand" or https://www.tiktok.com/@brand → "brand"; null when not a TikTok profile reference. */
export function tiktokHandle(ref: string): string | null {
  const v = ref.trim()
  if (v.startsWith("https://")) {
    const u = safeUrl(v)
    if (!u || !HOSTS.tiktok.test(u.hostname)) return null
    const seg = u.pathname.split("/").find((s) => s.startsWith("@"))
    const handle = seg ? decodeURIComponent(seg.slice(1)) : ""
    return TIKTOK_HANDLE_RE.test(handle) ? handle : null
  }
  return TIKTOK_HANDLE_RE.test(v) ? v.replace(/^@/, "") : null
}

const INSTAGRAM_RESERVED = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "stories",
  "accounts",
  "direct",
])

/** "@brand", "brand" or https://www.instagram.com/brand/ → "brand"; null when not an Instagram profile reference. */
export function instagramHandle(ref: string): string | null {
  const v = ref.trim()
  if (v.startsWith("https://")) {
    const u = safeUrl(v)
    if (!u || !HOSTS.instagram.test(u.hostname)) return null
    const first = u.pathname.split("/").filter(Boolean)[0] ?? ""
    if (INSTAGRAM_RESERVED.has(first.toLowerCase())) return null
    return INSTAGRAM_HANDLE_RE.test(first) ? first : null
  }
  return INSTAGRAM_HANDLE_RE.test(v) ? v.replace(/^@/, "") : null
}

export function hashtagField() {
  return z
    .string()
    .trim()
    .min(1, CATALOG_MESSAGES.required)
    .max(101)
    .regex(
      HASHTAG_RE,
      "Hashtag chỉ gồm chữ, số, dấu gạch dưới (có thể có # ở đầu)."
    )
}

export function stripHash(tag: string): string {
  return tag.trim().replace(/^#/, "")
}

// ---------------------------------------------------------------------------------------------------------------
// Typed task definitions
// ---------------------------------------------------------------------------------------------------------------

export interface CatalogActorDef<P> extends Omit<
  ApifyCatalogActor,
  "buildInput" | "memoryMbytes"
> {
  buildInput: (params: P, limit: number) => Record<string, unknown>
  /** always set explicitly in this catalog (power of two, ≤ 4096, inside the Actor's min/max) */
  memoryMbytes: number
}

export interface CatalogTaskDef<S extends z.ZodObject> extends Omit<
  ApifyCatalogTask,
  "input" | "actors"
> {
  input: S
  /** realistic input: used by the tests and as a hint for the AI (getCatalogTaskExample) */
  example: z.input<S>
  /** primary first, then fallbacks */
  actors: [CatalogActorDef<z.output<S>>, ...CatalogActorDef<z.output<S>>[]]
}

/** A catalog task plus its example input (extra field, invisible through the ApifyCatalogTask type). */
export type CatalogTask = ApifyCatalogTask & {
  example: Record<string, unknown>
}

/** Keeps buildInput typed against the task's own zod output while exposing the generic ApifyCatalogTask shape. */
export function defineTask<S extends z.ZodObject>(
  def: CatalogTaskDef<S>
): CatalogTask {
  const { actors, example, ...rest } = def
  return {
    ...rest,
    example: example as Record<string, unknown>,
    actors: actors.map((a) => ({
      ...a,
      buildInput: (params: Record<string, unknown>, limit: number) =>
        a.buildInput(params as z.output<S>, limit),
    })),
  }
}
