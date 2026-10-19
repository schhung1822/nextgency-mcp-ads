// Search assets (formerly "extensions"): sitelink, callout, call, structured snippet, price, promotion.
// - google_ads_list_assets: account assets of those types + their account-level (customer_asset) and campaign-level
//   (campaign_asset) links; with campaign_id: which level actually serves for each field type.
// - google_ads_create_assets: one atomic googleAds:mutate creating assets in the account library (no links: linking
//   changes what a campaign serves, so it is an update - google_ads_link_assets); identical ADVERTISER assets are reused.
// - google_ads_link_assets: attach / detach existing assets at account or campaign level (assets themselves cannot be
//   removed on Google Ads).
// API facts: providers/google-ads.md + v1.1.7 research (Asset / CampaignAsset / CustomerAsset, v25).
import { z } from "zod"
import { UNSAFE_TEXT_CHARS } from "../../../lib/text-safety"
import { redactString } from "../../audit/redact"
import { isIsoDate, todayInTz } from "../dates"
import { isProviderError } from "../errors"
import { fromMicros, roundMoney, toMicros } from "../money"
import type {
  FieldChange,
  MutationOptions,
  MutationResult,
  ProviderExtension,
} from "../types"
import {
  field,
  resourceId,
  str,
  type GoogleAdsClient,
  type GoogleAdsRow,
} from "./client"
import {
  clientFor,
  customerIdOf,
  invalidRequest,
  notFound,
  type GCtx,
} from "./context"
import { responseResourceName } from "./copy"
import type { GoogleAdsCredentials } from "./credentials"
import { decodeCursor, slicePage } from "./cursor"
import { assertId, gaqlString, idList } from "./gaql"
import { buildUpdate, failuresToError } from "./mutate"
import { assertNotVideo } from "./youtube"

// ---------------------------------------------------------------------------
// Types, labels, text rules
// ---------------------------------------------------------------------------

/** asset.type values handled here - identical to the AssetFieldType used when linking them. */
export const ASSET_KINDS = [
  "SITELINK",
  "CALLOUT",
  "CALL",
  "STRUCTURED_SNIPPET",
  "PRICE",
  "PROMOTION",
] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export const ASSET_LABEL_VI: Record<AssetKind, string> = {
  SITELINK: "đường liên kết trang web",
  CALLOUT: "chú thích",
  CALL: "cuộc gọi",
  STRUCTURED_SNIPPET: "đoạn nội dung có cấu trúc",
  PRICE: "giá",
  PROMOTION: "khuyến mãi",
}

const MAX_CREATE = 50
const MAX_LINK_ITEMS = 100
/** asset.id IN (…) filters are only built up to this many ids (longer lists: type filter + client-side filter). */
const MAX_ID_FILTER = 1_000
const LINK_ROWS = 10_000

const UNSAFE_ONE = new RegExp(UNSAFE_TEXT_CHARS.source, "u")

/** Control / bidi / zero-width / tag characters (lib/text-safety UNSAFE_TEXT_CHARS) plus tab and newline: ad texts are one line. */
export function hasUnsafeChars(s: string): boolean {
  return UNSAFE_ONE.test(s) || /[\t\n]/.test(s)
}

/** East Asian Wide / Fullwidth code points (Hangul Jamo, CJK, kana, Hangul syllables, fullwidth forms, CJK ext. B+). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/**
 * Length as Google Ads counts it for ad text limits: NFC code points (a Vietnamese letter with diacritics = 1, even
 * when typed decomposed), double-width characters (CJK, kana, Hangul, fullwidth forms) = 2.
 */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s.normalize("NFC")) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

/** NFC + trimmed + inner whitespace collapsed: the exact string sent to Google and compared for dedupe. */
export function cleanText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim()
}

const adText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .refine(
      (s) => !hasUnsafeChars(s),
      `${what} chứa ký tự ẩn / điều khiển / xuống dòng không được phép.`
    )
    .refine((s) => textWidth(s) >= 1, `${what} không được để trống.`)
    .refine(
      (s) => textWidth(s) <= max,
      `${what} tối đa ${max} ký tự (chữ Trung/Nhật/Hàn và ký tự toàn độ rộng tính 2).`
    )

function isHttpsUrl(s: string): boolean {
  if (/\s/.test(s) || hasUnsafeChars(s)) return false
  try {
    const u = new URL(s)
    return u.protocol === "https:" && !!u.hostname
  } catch {
    return false
  }
}

const httpsUrl = z
  .string()
  .trim()
  .max(2048, "URL tối đa 2048 ký tự.")
  .refine(isHttpsUrl, "URL phải là đường dẫn đầy đủ bắt đầu bằng https://")
const idStr = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Id chỉ gồm chữ số.")
const isoDate = z.string().refine(isIsoDate, "Ngày phải có dạng YYYY-MM-DD.")
/** Upper bound of advertised amounts (keeps toMicros / BigInt in range: invalid_request, never a SyntaxError). */
export const MAX_DISPLAY_MONEY = 1e12
const displayMoney = z
  .number()
  .positive("Số tiền phải lớn hơn 0.")
  .finite()
  .max(MAX_DISPLAY_MONEY, "Số tiền tối đa 1.000.000.000.000 (đơn vị chính).")
const languageCode = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "language_code phải là mã ngôn ngữ BCP 47 (vd vi, en)."
  )
  .default("vi")

// ---------------------------------------------------------------------------
// Structured snippet headers (https://developers.google.com/google-ads/api/data/structured-snippet-headers)
// ---------------------------------------------------------------------------

export const SNIPPET_HEADERS_EN = [
  "Brands",
  "Amenities",
  "Styles",
  "Types",
  "Destinations",
  // UNVERIFIED against a live account: the Help Center and the 2017 API announcement list "Service catalog" (the
  // header-table title says "Services (Service catalog)"). "Services" is accepted as an alias.
  "Service catalog",
  "Courses",
  "Neighborhoods",
  "Shows",
  "Insurance coverage",
  "Degree programs",
  "Featured hotels",
  "Models",
] as const

/** Vietnamese (vi) row of the localized headers table - exact strings. */
export const SNIPPET_HEADERS_VI = [
  "Thương hiệu",
  "Tiện nghi",
  "Kiểu",
  "Loại",
  "Điểm đến",
  "Dịch vụ",
  "Khóa học",
  "Vùng lân cận",
  "Chương trình",
  "Phạm vi bảo hiểm",
  "Cấp bằng",
  "Khách sạn nổi bật",
  "Model",
] as const

const headerKey = (s: string) => cleanText(s).toLowerCase()
const SNIPPET_HEADER_MAP = new Map<string, string>([
  ...[...SNIPPET_HEADERS_EN, ...SNIPPET_HEADERS_VI].map(
    (h) => [headerKey(h), h] as [string, string]
  ),
  // "Services" (header-table title / localized en rows) → "Service catalog"; en-GB / en-AU spellings; old Vietnamese
  // tone placement
  [headerKey("Services"), "Service catalog"],
  [headerKey("Neighbourhoods"), "Neighborhoods"],
  [headerKey("Degree programmes"), "Degree programs"],
  [headerKey("Khoá học"), "Khóa học"],
])

/** Canonical predefined header (case-insensitive, NFC) or null when the header is not in the list. */
export function canonicalSnippetHeader(raw: string): string | null {
  return SNIPPET_HEADER_MAP.get(headerKey(raw)) ?? null
}

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

const sitelinkInput = z
  .object({
    link_text: adText(25, "link_text"),
    description1: adText(35, "description1").optional(),
    description2: adText(35, "description2").optional(),
    final_url: httpsUrl,
  })
  .refine(
    (s) => (s.description1 === undefined) === (s.description2 === undefined),
    {
      message:
        "description1 và description2 phải có cả hai hoặc không có cả hai.",
      path: ["description2"],
    }
  )

const calloutInput = z.object({ text: adText(25, "Chú thích") })

const snippetInput = z.object({
  header: z
    .string()
    .trim()
    .refine((h) => canonicalSnippetHeader(h) !== null, {
      message: `header phải là một tiêu đề định sẵn của Google: ${SNIPPET_HEADERS_EN.join(", ")} (hoặc tiếng Việt: ${SNIPPET_HEADERS_VI.join(", ")}).`,
    }),
  values: z
    .array(adText(25, "Giá trị"))
    .min(3, "Cần ít nhất 3 giá trị.")
    .max(10, "Tối đa 10 giá trị."),
})

const callInput = z.object({
  phone_number: z
    .string()
    .trim()
    .max(30, "Số điện thoại tối đa 30 ký tự.")
    .regex(
      /^\+?[0-9 ().-]+$/,
      "Số điện thoại chỉ gồm chữ số, khoảng trắng, + - ( ) ."
    )
    .refine(
      (s) =>
        s.replace(/\D/g, "").length >= 3 && s.replace(/\D/g, "").length <= 15,
      "Số điện thoại phải có 3–15 chữ số."
    ),
  country_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "country_code là mã quốc gia 2 chữ cái (vd VN).")
    .default("VN"),
})

const PRICE_TYPES = [
  "BRANDS",
  "EVENTS",
  "LOCATIONS",
  "NEIGHBORHOODS",
  "PRODUCT_CATEGORIES",
  "PRODUCT_TIERS",
  "SERVICES",
  "SERVICE_CATEGORIES",
  "SERVICE_TIERS",
] as const
const PRICE_UNITS = [
  "PER_HOUR",
  "PER_DAY",
  "PER_WEEK",
  "PER_MONTH",
  "PER_YEAR",
  "PER_NIGHT",
] as const

const priceInput = z.object({
  type: z.enum(PRICE_TYPES),
  price_qualifier: z.enum(["FROM", "UP_TO", "AVERAGE"]).optional(),
  language_code: languageCode,
  offerings: z
    .array(
      z
        .object({
          header: adText(25, "header"),
          description: adText(25, "description"),
          price: displayMoney.describe(
            "Giá hiển thị, đơn vị chính của tiền tệ tài khoản"
          ),
          unit: z.enum(PRICE_UNITS).optional(),
          final_url: httpsUrl,
        })
        .refine(
          (o) =>
            cleanText(o.header).toLowerCase() !==
            cleanText(o.description).toLowerCase(),
          {
            message: "header và description của một mục giá phải khác nhau.",
            path: ["description"],
          }
        )
    )
    .min(3, "Cần ít nhất 3 mục giá.")
    .max(8, "Tối đa 8 mục giá."),
})

/** PromotionExtensionOccasion (v25), without UNKNOWN / UNSPECIFIED. */
export const PROMOTION_OCCASIONS = [
  "NEW_YEARS",
  "CHINESE_NEW_YEAR",
  "VALENTINES_DAY",
  "EASTER",
  "MOTHERS_DAY",
  "FATHERS_DAY",
  "LABOR_DAY",
  "BACK_TO_SCHOOL",
  "HALLOWEEN",
  "BLACK_FRIDAY",
  "CYBER_MONDAY",
  "CHRISTMAS",
  "BOXING_DAY",
  "INDEPENDENCE_DAY",
  "NATIONAL_DAY",
  "END_OF_SEASON",
  "WINTER_SALE",
  "SUMMER_SALE",
  "FALL_SALE",
  "SPRING_SALE",
  "RAMADAN",
  "EID_AL_FITR",
  "EID_AL_ADHA",
  "SINGLES_DAY",
  "WOMENS_DAY",
  "HOLI",
  "PARENTS_DAY",
  "ST_NICHOLAS_DAY",
  "CARNIVAL",
  "EPIPHANY",
  "ROSH_HASHANAH",
  "PASSOVER",
  "HANUKKAH",
  "DIWALI",
  "NAVRATRI",
  "SONGKRAN",
  "YEAR_END_GIFT",
] as const

/** Promotion item length: 20 per the Google Ads Help limits (the API reference states none - UNVERIFIED). */
export const PROMOTION_TARGET_MAX = 20
/** Promo code length: 15 per the Google Ads Help limits (UNVERIFIED in the API reference). */
export const PROMOTION_CODE_MAX = 15

const promotionInput = z
  .object({
    promotion_target: adText(PROMOTION_TARGET_MAX, "promotion_target"),
    percent_off: z
      .number()
      .min(1, "percent_off từ 1 đến 100.")
      .max(100, "percent_off từ 1 đến 100.")
      .refine(
        (p) => Math.abs(p * 10 - Math.round(p * 10)) < 1e-9,
        "percent_off tối đa 1 chữ số thập phân."
      )
      .optional(),
    money_amount_off: displayMoney
      .optional()
      .describe("Số tiền giảm hiển thị, đơn vị chính của tiền tệ tài khoản"),
    promotion_code: adText(PROMOTION_CODE_MAX, "promotion_code").optional(),
    orders_over_amount: displayMoney
      .optional()
      .describe("Áp dụng cho đơn từ (đơn vị chính của tiền tệ tài khoản)"),
    discount_modifier: z.enum(["UP_TO"]).optional(),
    occasion: z.enum(PROMOTION_OCCASIONS).optional(),
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
    final_url: httpsUrl,
    language_code: languageCode,
  })
  .superRefine((p, c) => {
    if ((p.percent_off === undefined) === (p.money_amount_off === undefined)) {
      c.addIssue({
        code: "custom",
        path: ["percent_off"],
        message: "Cần đúng một trong percent_off hoặc money_amount_off.",
      })
    }
    if (p.promotion_code !== undefined && p.orders_over_amount !== undefined) {
      c.addIssue({
        code: "custom",
        path: ["promotion_code"],
        message: "Chỉ dùng một trong promotion_code hoặc orders_over_amount.",
      })
    }
    if (p.start_date && p.end_date && p.end_date < p.start_date)
      c.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date phải sau hoặc bằng start_date.",
      })
  })

export const createAssetsInput = z
  .object({
    sitelinks: z
      .array(sitelinkInput)
      .max(MAX_CREATE)
      .optional()
      .describe("Đường liên kết trang web"),
    callouts: z
      .array(calloutInput)
      .max(MAX_CREATE)
      .optional()
      .describe("Chú thích"),
    structured_snippets: z
      .array(snippetInput)
      .max(MAX_CREATE)
      .optional()
      .describe("Đoạn nội dung có cấu trúc"),
    calls: z.array(callInput).max(MAX_CREATE).optional().describe("Cuộc gọi"),
    prices: z
      .array(priceInput)
      .max(MAX_CREATE)
      .optional()
      .describe("Giá (giá hiển thị, không phải chi tiêu)"),
    promotions: z
      .array(promotionInput)
      .max(MAX_CREATE)
      .optional()
      .describe("Khuyến mãi"),
  })
  .superRefine((v, c) => {
    const total =
      (v.sitelinks?.length ?? 0) +
      (v.callouts?.length ?? 0) +
      (v.structured_snippets?.length ?? 0) +
      (v.calls?.length ?? 0) +
      (v.prices?.length ?? 0) +
      (v.promotions?.length ?? 0)
    if (total === 0)
      c.addIssue({
        code: "custom",
        path: [],
        message:
          "Cần ít nhất 1 asset (sitelinks, callouts, structured_snippets, calls, prices hoặc promotions).",
      })
    if (total > MAX_CREATE)
      c.addIssue({
        code: "custom",
        path: [],
        message: `Tối đa ${MAX_CREATE} asset mỗi lần (nhận ${total}).`,
      })
    const dup = (list: string[] | undefined, path: string, what: string) => {
      if (!list) return
      const seen = new Set<string>()
      list.forEach((k, i) => {
        if (seen.has(k))
          c.addIssue({
            code: "custom",
            path: [path, i],
            message: `${what} bị trùng trong cùng yêu cầu.`,
          })
        seen.add(k)
      })
    }
    dup(
      v.sitelinks?.map((s) =>
        sitelinkKey(s.link_text, s.description1, s.description2, s.final_url)
      ),
      "sitelinks",
      "Đường liên kết trang web"
    )
    dup(
      v.callouts?.map((s) => calloutKey(s.text)),
      "callouts",
      "Chú thích"
    )
    dup(
      v.structured_snippets?.map((s) =>
        snippetKey(canonicalSnippetHeader(s.header) ?? s.header, s.values)
      ),
      "structured_snippets",
      "Đoạn nội dung có cấu trúc"
    )
    dup(
      v.calls?.map((s) => callKey(s.country_code, s.phone_number)),
      "calls",
      "Số điện thoại"
    )
  })
export type CreateAssetsInput = z.infer<typeof createAssetsInput>

// ---------------------------------------------------------------------------
// Dedupe keys (same function for the input and for rows read from Google)
// ---------------------------------------------------------------------------

export function sitelinkKey(
  linkText: string,
  d1: string | null | undefined,
  d2: string | null | undefined,
  url: string | null | undefined
): string {
  return [
    "SITELINK",
    cleanText(linkText),
    cleanText(d1 ?? ""),
    cleanText(d2 ?? ""),
    (url ?? "").trim(),
  ].join("\u0001")
}
export function calloutKey(text: string): string {
  return `CALLOUT\u0001${cleanText(text)}`
}
export function snippetKey(header: string, values: readonly string[]): string {
  return [
    "STRUCTURED_SNIPPET",
    headerKey(header),
    ...values.map(cleanText),
  ].join("\u0001")
}

/** Phone number as compared for dedupe: digits only; Vietnamese +84… = 0…. */
export function phoneDigits(phone: string, country: string): string {
  const t = phone.trim()
  const digits = t.replace(/\D/g, "")
  if (country.toUpperCase() === "VN" && t.startsWith("+84"))
    return `0${digits.slice(2)}`
  return digits
}
export function callKey(country: string, phone: string): string {
  return `CALL\u0001${country.trim().toUpperCase()}\u0001${phoneDigits(phone, country)}`
}

/** Phone number sent to Google: spaces collapsed, otherwise as typed. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// Money shown in ads (price / promotion) - NOT spend
// ---------------------------------------------------------------------------

/**
 * Advertised amount (PriceOffering.price, promotion money) → micros string. These are display prices, not budgets or
 * bids: no billable-unit rounding (currency_constant.billable_unit_micros applies to spend - units.ts moneyToMicros
 * would floor a price like 99.500 VND if a larger billable unit were cached), only the currency's precision
 * (VND/JPY… integer, others 2 decimals - PriceAsset refuses TOO_MANY_DECIMAL_PLACES_SPECIFIED). Integer micros math.
 */
export function displayMoneyMicros(
  amount: number,
  currency: string,
  warnings: string[],
  label: string
): string {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_DISPLAY_MONEY) {
    throw invalidRequest(
      `Invalid amount ${amount}`,
      `${label} phải là số dương, tối đa 1.000.000.000.000 (đơn vị chính của tiền tệ tài khoản).`
    )
  }
  const cur = (currency || "USD").toUpperCase()
  const rounded = roundMoney(amount, cur)!
  if (rounded <= 0)
    throw invalidRequest(
      `Amount too small ${amount}`,
      `${label} quá nhỏ cho tiền tệ ${cur}.`
    )
  if (rounded !== amount)
    warnings.push(
      `${label} ${amount} đã được làm tròn thành ${rounded} ${cur} (đơn vị nhỏ nhất của tiền tệ).`
    )
  return toMicros(rounded)
}

/** 12.5 (%) → "125000" (PromotionAsset.percent_off: 1,000,000 = 100%), integer math on tenths of a percent. */
export function percentToMicros(percent: number): string {
  return String(Math.round(percent * 10) * 1_000)
}

// ---------------------------------------------------------------------------
// Reading assets and links
// ---------------------------------------------------------------------------

const ASSET_FIELDS = [
  "asset.id",
  "asset.type",
  "asset.source",
  "asset.final_urls",
  "asset.policy_summary.approval_status",
  "asset.policy_summary.review_status",
  "asset.sitelink_asset.link_text",
  "asset.sitelink_asset.description1",
  "asset.sitelink_asset.description2",
  "asset.callout_asset.callout_text",
  "asset.call_asset.country_code",
  "asset.call_asset.phone_number",
  "asset.structured_snippet_asset.header",
  "asset.structured_snippet_asset.values",
  "asset.price_asset.type",
  "asset.price_asset.price_qualifier",
  "asset.price_asset.language_code",
  "asset.price_asset.price_offerings",
  "asset.promotion_asset.promotion_target",
  "asset.promotion_asset.percent_off",
  "asset.promotion_asset.money_amount_off.amount_micros",
  "asset.promotion_asset.money_amount_off.currency_code",
  "asset.promotion_asset.orders_over_amount.amount_micros",
  "asset.promotion_asset.orders_over_amount.currency_code",
  "asset.promotion_asset.promotion_code",
  "asset.promotion_asset.discount_modifier",
  "asset.promotion_asset.occasion",
  "asset.promotion_asset.start_date",
  "asset.promotion_asset.end_date",
  "asset.promotion_asset.language_code",
]

const kindList = (kinds: readonly AssetKind[]) =>
  `(${kinds.map((k) => `'${k}'`).join(", ")})`
const isKind = (v: string | null): v is AssetKind =>
  !!v && (ASSET_KINDS as readonly string[]).includes(v)

/** Text read from Google shown to the AI: unsafe characters removed. */
const safe = (v: unknown): string | null =>
  v === undefined || v === null
    ? null
    : String(v).replace(UNSAFE_TEXT_CHARS, "")
/** str() + safe(): every platform string returned to the AI goes through the sanitizer. */
const sstr = (row: unknown, path: string): string | null => safe(field(row, path))

function moneyOut(
  row: GoogleAdsRow,
  path: string
): { amount: number | null; currency: string | null } | null {
  const micros = sstr(row, `${path}.amount_micros`)
  if (micros === null) return null
  return {
    amount: fromMicros(micros),
    currency: sstr(row, `${path}.currency_code`),
  }
}

/** Type-specific readable content of an asset row (money in MAJOR units + currency). */
export function assetContent(row: GoogleAdsRow): Record<string, unknown> {
  const type = sstr(row, "asset.type")
  const finalUrl = safe(
    ((field(row, "asset.final_urls") as unknown[] | undefined) ?? [])[0]
  )
  switch (type) {
    case "SITELINK":
      return {
        link_text: safe(field(row, "asset.sitelink_asset.link_text")),
        description1: safe(field(row, "asset.sitelink_asset.description1")),
        description2: safe(field(row, "asset.sitelink_asset.description2")),
        final_url: finalUrl,
      }
    case "CALLOUT":
      return { text: safe(field(row, "asset.callout_asset.callout_text")) }
    case "CALL":
      return {
        country_code: safe(field(row, "asset.call_asset.country_code")),
        phone_number: safe(field(row, "asset.call_asset.phone_number")),
      }
    case "STRUCTURED_SNIPPET":
      return {
        header: safe(field(row, "asset.structured_snippet_asset.header")),
        values: (
          (field(row, "asset.structured_snippet_asset.values") as
            unknown[] | undefined) ?? []
        ).map(safe),
      }
    case "PRICE": {
      const offerings =
        (field(row, "asset.price_asset.price_offerings") as
          Record<string, unknown>[] | undefined) ?? []
      return {
        type: sstr(row, "asset.price_asset.type"),
        price_qualifier: sstr(row, "asset.price_asset.price_qualifier"),
        language_code: sstr(row, "asset.price_asset.language_code"),
        offerings: offerings.map((o) => ({
          header: safe(o.header),
          description: safe(o.description),
          price: fromMicros(sstr(o, "price.amount_micros")),
          currency: sstr(o, "price.currency_code"),
          unit: sstr(o, "unit"),
          final_url: safe(o.finalUrl),
        })),
      }
    }
    case "PROMOTION": {
      const pct = sstr(row, "asset.promotion_asset.percent_off")
      return {
        promotion_target: safe(
          field(row, "asset.promotion_asset.promotion_target")
        ),
        percent_off: pct !== null ? Number(pct) / 10_000 : null,
        money_amount_off: moneyOut(
          row,
          "asset.promotion_asset.money_amount_off"
        ),
        promotion_code: safe(
          field(row, "asset.promotion_asset.promotion_code")
        ),
        orders_over_amount: moneyOut(
          row,
          "asset.promotion_asset.orders_over_amount"
        ),
        discount_modifier: sstr(row, "asset.promotion_asset.discount_modifier"),
        occasion: sstr(row, "asset.promotion_asset.occasion"),
        start_date: sstr(row, "asset.promotion_asset.start_date"),
        end_date: sstr(row, "asset.promotion_asset.end_date"),
        language_code: sstr(row, "asset.promotion_asset.language_code"),
        final_url: finalUrl,
      }
    }
    default:
      return {}
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const short = (s: string, max = 80) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s

/** "Chú thích: Miễn phí gội đầu" */
export function assetLabel(
  kind: AssetKind,
  main: string | null | undefined
): string {
  return short(`${cap(ASSET_LABEL_VI[kind])}: ${main ?? ""}`.trim())
}

function rowLabel(row: GoogleAdsRow): string {
  const type = str(row, "asset.type")
  if (!isKind(type)) return `Asset ${str(row, "asset.id") ?? ""}`.trim()
  const c = assetContent(row)
  const main =
    type === "SITELINK"
      ? c.link_text
      : type === "CALLOUT"
        ? c.text
        : type === "CALL"
          ? c.phone_number
          : type === "STRUCTURED_SNIPPET"
            ? c.header
            : type === "PRICE"
              ? ((c.offerings as { header?: string | null }[])[0]?.header ??
                c.type)
              : c.promotion_target
  return assetLabel(type, main as string | null)
}

export interface AssetLink {
  level: "account" | "campaign"
  resource_name: string
  asset_id: string
  field_type: string
  status: string | null
  primary_status: string | null
  source: string | null
  campaign_id?: string | null
  campaign_name?: string | null
}

async function readCampaignLinks(
  client: GoogleAdsClient,
  cid: string,
  o: {
    kinds: readonly AssetKind[]
    campaignId?: string
    assetIds?: string[]
    enabledOnly?: boolean
  }
): Promise<{ links: AssetLink[]; truncated: boolean }> {
  const conds = [
    `campaign_asset.field_type IN ${kindList(o.kinds)}`,
    o.enabledOnly
      ? "campaign_asset.status = 'ENABLED'"
      : "campaign_asset.status != 'REMOVED'",
    o.campaignId
      ? `campaign.id = ${assertId(o.campaignId, "campaign_id")}`
      : "campaign.status != 'REMOVED'",
  ]
  if (o.assetIds?.length)
    conds.push(`asset.id IN ${idList(o.assetIds, "asset_id")}`)
  const { rows, truncated } = await client.searchAll(
    cid,
    `SELECT campaign_asset.resource_name, campaign_asset.field_type, campaign_asset.status, campaign_asset.primary_status, campaign_asset.source, asset.id, campaign.id, campaign.name FROM campaign_asset WHERE ${conds.join(" AND ")}`,
    { maxRows: LINK_ROWS }
  )
  return {
    truncated,
    links: rows.map((r) => ({
      level: "campaign" as const,
      resource_name: sstr(r, "campaign_asset.resource_name") ?? "",
      asset_id: sstr(r, "asset.id") ?? "",
      field_type: sstr(r, "campaign_asset.field_type") ?? "",
      status: sstr(r, "campaign_asset.status"),
      primary_status: sstr(r, "campaign_asset.primary_status"),
      source: sstr(r, "campaign_asset.source"),
      campaign_id: sstr(r, "campaign.id"),
      campaign_name: safe(field(r, "campaign.name")),
    })),
  }
}

async function readAccountLinks(
  client: GoogleAdsClient,
  cid: string,
  o: { kinds: readonly AssetKind[]; assetIds?: string[]; enabledOnly?: boolean }
): Promise<{ links: AssetLink[]; truncated: boolean }> {
  const conds = [
    `customer_asset.field_type IN ${kindList(o.kinds)}`,
    o.enabledOnly
      ? "customer_asset.status = 'ENABLED'"
      : "customer_asset.status != 'REMOVED'",
  ]
  if (o.assetIds?.length)
    conds.push(`asset.id IN ${idList(o.assetIds, "asset_id")}`)
  const { rows, truncated } = await client.searchAll(
    cid,
    `SELECT customer_asset.resource_name, customer_asset.field_type, customer_asset.status, customer_asset.primary_status, customer_asset.source, asset.id FROM customer_asset WHERE ${conds.join(" AND ")}`,
    { maxRows: LINK_ROWS }
  )
  return {
    truncated,
    links: rows.map((r) => ({
      level: "account" as const,
      resource_name: sstr(r, "customer_asset.resource_name") ?? "",
      asset_id: sstr(r, "asset.id") ?? "",
      field_type: sstr(r, "customer_asset.field_type") ?? "",
      status: sstr(r, "customer_asset.status"),
      primary_status: sstr(r, "customer_asset.primary_status"),
      source: sstr(r, "customer_asset.source"),
    })),
  }
}

async function loadCampaign(
  client: GoogleAdsClient,
  cid: string,
  id: string
): Promise<GoogleAdsRow> {
  const campaignId = assertId(id, "campaign_id")
  const { rows } = await client.searchAll(
    cid,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${campaignId}`,
    { maxRows: 1 }
  )
  const row = rows[0]
  if (!row || str(row, "campaign.status") === "REMOVED")
    throw notFound("chiến dịch", campaignId)
  return row
}

/** Writes on a campaign's assets: not VIDEO (read-only in this app), not SMART (Google Ads UI only). */
function assertWritableCampaign(row: GoogleAdsRow, what: string): void {
  assertNotVideo([row], what)
  if (str(row, "campaign.advertising_channel_type") === "SMART") {
    throw invalidRequest(
      "Smart campaign assets are not managed through the API here",
      "Chiến dịch Thông minh (Smart) không được sửa qua MCP - hãy quản lý asset của chiến dịch này trong giao diện Google Ads."
    )
  }
}

function isUncertain(e: unknown): boolean {
  return (
    isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")
  )
}

// ---------------------------------------------------------------------------
// google_ads_list_assets
// ---------------------------------------------------------------------------

export const listAssetsInput = z.object({
  types: z
    .array(z.enum(ASSET_KINDS))
    .min(1)
    .max(6)
    .optional()
    .describe("Loại asset (mặc định: cả 6 loại)"),
  campaign_id: idStr
    .optional()
    .describe(
      "Chỉ xem asset gắn với chiến dịch này (và asset cấp tài khoản cùng loại)"
    ),
  include_unlinked: z
    .boolean()
    .default(true)
    .describe("Kèm asset chưa gắn ở đâu (chỉ khi không có campaign_id)"),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z
    .string()
    .max(4_000)
    .optional()
    .describe("next_cursor từ lần gọi trước"),
})

async function runListAssets(
  ctx: GCtx,
  input: z.infer<typeof listAssetsInput>
) {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const kinds: AssetKind[] = input.types?.length
    ? [...new Set(input.types)]
    : [...ASSET_KINDS]
  const warnings: string[] = []
  let campaign: GoogleAdsRow | null = null
  if (input.campaign_id)
    campaign = await loadCampaign(client, cid, input.campaign_id)

  const [camp, acct] = await Promise.all([
    readCampaignLinks(client, cid, { kinds, campaignId: input.campaign_id }),
    readAccountLinks(client, cid, { kinds }),
  ])
  if (camp.truncated || acct.truncated)
    warnings.push(
      `Có hơn ${LINK_ROWS} liên kết asset - danh sách liên kết có thể chưa đủ.`
    )
  const linksByAsset = new Map<string, AssetLink[]>()
  for (const l of [...acct.links, ...camp.links]) {
    if (!l.asset_id) continue
    const list = linksByAsset.get(l.asset_id) ?? []
    list.push(l)
    linksByAsset.set(l.asset_id, list)
  }

  const onlyLinked = !!campaign || !input.include_unlinked
  // sorted: the query (and so the cursor hash) must not depend on the order links were read
  const linkedIds = [...linksByAsset.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
  const conds = [`asset.type IN ${kindList(kinds)}`]
  if (onlyLinked && linkedIds.length && linkedIds.length <= MAX_ID_FILTER)
    conds.push(`asset.id IN ${idList(linkedIds, "asset_id")}`)

  let items: Record<string, unknown>[] = []
  let nextCursor: string | null = null
  if (!onlyLinked || linkedIds.length) {
    const query = `SELECT ${ASSET_FIELDS.join(", ")} FROM asset WHERE ${conds.join(" AND ")} ORDER BY asset.id`
    // the cursor is bound to the query AND the client-side filter
    const cursorKey = `${query}|linked_only=${onlyLinked}|campaign=${input.campaign_id ?? ""}`
    const cur = decodeCursor(input.cursor, cursorKey)
    const page = await client.search(cid, query, cur.pt)
    // automatically created assets only when linked; unlinked ones only when asked
    const kept = page.results.filter((r) => {
      const id = sstr(r, "asset.id") ?? ""
      if (linksByAsset.has(id)) return true
      return !onlyLinked && sstr(r, "asset.source") === "ADVERTISER"
    })
    const sliced = slicePage(
      kept,
      cur,
      page.nextPageToken,
      input.limit,
      cursorKey
    )
    nextCursor = sliced.nextCursor
    items = sliced.items.map((r) => {
      const type = sstr(r, "asset.type")
      const id = sstr(r, "asset.id") ?? ""
      return {
        asset_id: id,
        type,
        label_vi: isKind(type) ? ASSET_LABEL_VI[type] : null,
        source: sstr(r, "asset.source"),
        content: assetContent(r),
        policy: {
          approval_status: sstr(r, "asset.policy_summary.approval_status"),
          review_status: sstr(r, "asset.policy_summary.review_status"),
        },
        links: (linksByAsset.get(id) ?? []).map((l) => ({
          level: l.level,
          ...(l.level === "campaign"
            ? { campaign_id: l.campaign_id, campaign_name: l.campaign_name }
            : {}),
          field_type: l.field_type,
          status: l.status,
          primary_status: l.primary_status,
        })),
      }
    })
  }

  const out: Record<string, unknown> = {
    assets: items,
    count: items.length,
    next_cursor: nextCursor,
    currency: ctx.account.currency,
    note:
      "Giá / số tiền khuyến mãi theo đơn vị chính kèm mã tiền tệ (giá hiển thị trong quảng cáo, không phải chi tiêu). " +
      "Asset tự tạo (AUTOMATICALLY_CREATED) chỉ hiện khi đang được gắn và không gắn/gỡ được qua MCP. Một trang có thể ít hơn limit; còn dữ liệu khi next_cursor khác null.",
  }
  if (campaign) {
    out.campaign = {
      id: sstr(campaign, "campaign.id"),
      name: safe(field(campaign, "campaign.name")),
      channel_type: sstr(campaign, "campaign.advertising_channel_type"),
    }
    out.effective = kinds.map((k) => {
      const c = camp.links.filter(
        (l) => l.field_type === k && l.status === "ENABLED"
      ).length
      const a = acct.links.filter(
        (l) => l.field_type === k && l.status === "ENABLED"
      ).length
      return {
        field_type: k,
        label_vi: ASSET_LABEL_VI[k],
        campaign_enabled: c,
        account_enabled: a,
        serving_level: c > 0 ? "campaign" : a > 0 ? "account" : "none",
      }
    })
    out.effective_note =
      "Nếu chiến dịch có ít nhất 1 asset cấp chiến dịch ĐANG BẬT của một loại, các asset cấp tài khoản cùng loại KHÔNG hiển thị cho chiến dịch này (serving_level = campaign). " +
      "Gỡ hết asset cấp chiến dịch của loại đó thì asset cấp tài khoản sẽ hiển thị lại."
  }
  if (warnings.length) out.warnings = warnings
  return out
}

// ---------------------------------------------------------------------------
// google_ads_create_assets
// ---------------------------------------------------------------------------

export interface PlannedAsset {
  kind: AssetKind
  /** null = never deduplicated (price, promotion) */
  key: string | null
  label: string
  summary: Record<string, unknown>
  /** Asset create body without resourceName */
  body: Record<string, unknown>
}

/** Pure: normalized input → asset create bodies (money converted with the account currency). */
export function planAssets(
  input: CreateAssetsInput,
  currency: string,
  warnings: string[]
): PlannedAsset[] {
  const out: PlannedAsset[] = []
  const cur = (currency || "USD").toUpperCase()
  for (const s of input.sitelinks ?? []) {
    const linkText = cleanText(s.link_text)
    const d1 =
      s.description1 !== undefined ? cleanText(s.description1) : undefined
    const d2 =
      s.description2 !== undefined ? cleanText(s.description2) : undefined
    const sitelinkAsset: Record<string, unknown> = { linkText }
    if (d1 !== undefined) sitelinkAsset.description1 = d1
    if (d2 !== undefined) sitelinkAsset.description2 = d2
    out.push({
      kind: "SITELINK",
      key: sitelinkKey(linkText, d1, d2, s.final_url),
      label: assetLabel("SITELINK", linkText),
      summary: {
        link_text: linkText,
        description1: d1 ?? null,
        description2: d2 ?? null,
        final_url: s.final_url,
      },
      body: { finalUrls: [s.final_url], sitelinkAsset },
    })
  }
  for (const c of input.callouts ?? []) {
    const text = cleanText(c.text)
    out.push({
      kind: "CALLOUT",
      key: calloutKey(text),
      label: assetLabel("CALLOUT", text),
      summary: { text },
      body: { calloutAsset: { calloutText: text } },
    })
  }
  for (const s of input.structured_snippets ?? []) {
    const header = canonicalSnippetHeader(s.header)
    if (!header)
      throw invalidRequest(
        `Unknown snippet header ${s.header.slice(0, 40)}`,
        `Tiêu đề “${s.header.slice(0, 40)}” không nằm trong danh sách tiêu đề định sẵn của Google.`
      )
    const values = s.values.map(cleanText)
    out.push({
      kind: "STRUCTURED_SNIPPET",
      key: snippetKey(header, values),
      label: assetLabel(
        "STRUCTURED_SNIPPET",
        `${header} (${values.length} giá trị)`
      ),
      summary: { header, values },
      body: { structuredSnippetAsset: { header, values } },
    })
  }
  for (const c of input.calls ?? []) {
    const countryCode = c.country_code.trim().toUpperCase()
    const phoneNumber = normalizePhone(c.phone_number)
    out.push({
      kind: "CALL",
      key: callKey(countryCode, phoneNumber),
      label: assetLabel("CALL", phoneNumber),
      summary: { country_code: countryCode, phone_number: phoneNumber },
      body: { callAsset: { countryCode, phoneNumber } },
    })
  }
  for (const p of input.prices ?? []) {
    const offerings = p.offerings.map((o, i) => {
      const off: Record<string, unknown> = {
        header: cleanText(o.header),
        description: cleanText(o.description),
        price: {
          currencyCode: cur,
          amountMicros: displayMoneyMicros(
            o.price,
            cur,
            warnings,
            `Giá mục ${i + 1}`
          ),
        },
        finalUrl: o.final_url,
      }
      if (o.unit) off.unit = o.unit
      return off
    })
    const priceAsset: Record<string, unknown> = {
      type: p.type,
      languageCode: p.language_code,
      priceOfferings: offerings,
    }
    if (p.price_qualifier) priceAsset.priceQualifier = p.price_qualifier
    out.push({
      kind: "PRICE",
      key: null,
      label: assetLabel(
        "PRICE",
        `${offerings[0]!.header as string} (${offerings.length} mục)`
      ),
      summary: {
        type: p.type,
        price_qualifier: p.price_qualifier ?? null,
        language_code: p.language_code,
        offerings: offerings.map((o) => ({
          header: o.header,
          description: o.description,
          price: fromMicros((o.price as { amountMicros: string }).amountMicros),
          currency: cur,
          unit: o.unit ?? null,
          final_url: o.finalUrl,
        })),
      },
      body: { priceAsset },
    })
  }
  for (const p of input.promotions ?? []) {
    const target = cleanText(p.promotion_target)
    const promotionAsset: Record<string, unknown> = {
      promotionTarget: target,
      languageCode: p.language_code,
    }
    const summary: Record<string, unknown> = {
      promotion_target: target,
      language_code: p.language_code,
      final_url: p.final_url,
    }
    if (p.percent_off !== undefined) {
      promotionAsset.percentOff = percentToMicros(p.percent_off)
      summary.percent_off = p.percent_off
    } else {
      const micros = displayMoneyMicros(
        p.money_amount_off!,
        cur,
        warnings,
        "Số tiền giảm"
      )
      promotionAsset.moneyAmountOff = {
        currencyCode: cur,
        amountMicros: micros,
      }
      summary.money_amount_off = fromMicros(micros)
      summary.currency = cur
    }
    if (p.promotion_code !== undefined) {
      promotionAsset.promotionCode = cleanText(p.promotion_code)
      summary.promotion_code = promotionAsset.promotionCode
    }
    if (p.orders_over_amount !== undefined) {
      const micros = displayMoneyMicros(
        p.orders_over_amount,
        cur,
        warnings,
        "Giá trị đơn tối thiểu"
      )
      promotionAsset.ordersOverAmount = {
        currencyCode: cur,
        amountMicros: micros,
      }
      summary.orders_over_amount = fromMicros(micros)
      summary.currency = cur
    }
    if (p.discount_modifier)
      promotionAsset.discountModifier = summary.discount_modifier =
        p.discount_modifier
    if (p.occasion) promotionAsset.occasion = summary.occasion = p.occasion
    if (p.start_date)
      promotionAsset.startDate = summary.start_date = p.start_date
    if (p.end_date) promotionAsset.endDate = summary.end_date = p.end_date
    out.push({
      kind: "PROMOTION",
      key: null,
      label: assetLabel("PROMOTION", target),
      summary,
      body: { finalUrls: [p.final_url], promotionAsset },
    })
  }
  return out
}

/** Key of an asset row read from Google (same shape as the planned keys). null for price / promotion. */
function rowKey(row: GoogleAdsRow): string | null {
  switch (str(row, "asset.type")) {
    case "SITELINK": {
      const urls =
        (field(row, "asset.final_urls") as string[] | undefined) ?? []
      if (urls.length !== 1) return null
      return sitelinkKey(
        str(row, "asset.sitelink_asset.link_text") ?? "",
        str(row, "asset.sitelink_asset.description1"),
        str(row, "asset.sitelink_asset.description2"),
        urls[0]
      )
    }
    case "CALLOUT":
      return calloutKey(str(row, "asset.callout_asset.callout_text") ?? "")
    case "STRUCTURED_SNIPPET":
      return snippetKey(
        str(row, "asset.structured_snippet_asset.header") ?? "",
        (
          (field(row, "asset.structured_snippet_asset.values") as
            string[] | undefined) ?? []
        ).map(String)
      )
    case "CALL":
      return callKey(
        str(row, "asset.call_asset.country_code") ?? "",
        str(row, "asset.call_asset.phone_number") ?? ""
      )
    default:
      return null
  }
}

/** Existing identical ADVERTISER assets: planned index → asset id (lowest id when several match). */
export async function findExistingAssets(
  client: GoogleAdsClient,
  cid: string,
  planned: PlannedAsset[]
): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  const byKind = new Map<AssetKind, { i: number; p: PlannedAsset }[]>()
  planned.forEach((p, i) => {
    if (!p.key) return
    const list = byKind.get(p.kind) ?? []
    list.push({ i, p })
    byKind.set(p.kind, list)
  })
  for (const [kind, list] of byKind) {
    const base = `asset.type = '${kind}' AND asset.source = 'ADVERTISER'`
    let filter = ""
    if (kind === "CALLOUT")
      filter = ` AND asset.callout_asset.callout_text IN (${list.map((x) => gaqlString(String(x.p.summary.text))).join(", ")})`
    else if (kind === "SITELINK")
      filter = ` AND asset.sitelink_asset.link_text IN (${[...new Set(list.map((x) => String(x.p.summary.link_text)))].map(gaqlString).join(", ")})`
    else if (kind === "STRUCTURED_SNIPPET")
      filter = ` AND asset.structured_snippet_asset.header IN (${[...new Set(list.map((x) => String(x.p.summary.header)))].map(gaqlString).join(", ")})`
    const { rows } = await client.searchAll(
      cid,
      `SELECT asset.id, asset.type, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, asset.call_asset.country_code, asset.call_asset.phone_number FROM asset WHERE ${base}${filter} ORDER BY asset.id`,
      { maxRows: 5_000 }
    )
    const have = new Map<string, string>()
    for (const r of rows) {
      const k = rowKey(r)
      const id = str(r, "asset.id")
      if (k && id && !have.has(k)) have.set(k, id)
    }
    for (const { i, p } of list) {
      const id = have.get(p.key!)
      if (id) found.set(i, id)
    }
  }
  return found
}

async function runCreateAssets(
  ctx: GCtx,
  input: CreateAssetsInput,
  opts: MutationOptions
): Promise<MutationResult & Record<string, unknown>> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const currency = ctx.account.currency
  const warnings: string[] = []
  const planned = planAssets(input, currency, warnings)

  const today = todayInTz(ctx.account.timezone)
  for (const p of input.promotions ?? []) {
    if (p.end_date && p.end_date < today)
      throw invalidRequest(
        "Promotion end in past",
        `end_date của khuyến mãi (${p.end_date}) đã qua (hôm nay theo múi giờ tài khoản: ${today}).`
      )
  }

  // Library only: no campaign / account link here (that changes what campaigns serve → google_ads_link_assets).
  const existing = await findExistingAssets(client, cid, planned)
  const ops: Record<string, unknown>[] = []
  const assetOpIndex = new Map<number, number>()
  let tmp = 0
  planned.forEach((p, i) => {
    const reused = existing.get(i)
    if (reused) {
      warnings.push(`${p.label}: đã có asset giống hệt - dùng lại asset có sẵn (id ${reused}), không tạo mới.`)
      return
    }
    assetOpIndex.set(i, ops.length)
    ops.push({ assetOperation: { create: { resourceName: `customers/${cid}/assets/${--tmp}`, ...p.body } } })
  })

  warnings.push("Asset mới được Google xét duyệt chính sách trước khi hiển thị (xem trạng thái bằng google_ads_list_assets).")
  if ((input.prices?.length ?? 0) || input.promotions?.some((p) => p.money_amount_off !== undefined || p.orders_over_amount !== undefined)) {
    warnings.push(
      `Giá / số tiền khuyến mãi tính theo tiền tệ tài khoản (${currency.toUpperCase()}) - đây là giá hiển thị trong quảng cáo, không phải chi tiêu.`
    )
  }
  if (input.sitelinks?.length) warnings.push("Đường liên kết trang web chỉ hiển thị khi có ít nhất 2 liên kết đủ điều kiện ở cùng cấp.")
  if (input.calls?.length) {
    warnings.push(
      "Số điện thoại phải xuất hiện trên trang web của bạn (hoặc tên miền đã xác minh trong Google Search Console), nếu không Google sẽ từ chối với lý do “Số điện thoại chưa xác minh”. Không dùng số cước cao / số đặc biệt (vanity) / fax."
    )
  }
  if (input.promotions?.some((p) => p.occasion)) {
    warnings.push("Khuyến mãi có occasion: thời gian áp dụng phải nằm trong khoảng ngày của dịp đó, nếu không Google sẽ từ chối.")
  }
  warnings.push(
    "Asset chỉ nằm trong thư viện tài khoản, chưa hiển thị - gắn vào chiến dịch hoặc cấp tài khoản bằng google_ads_link_assets (dùng asset_id trong kết quả)."
  )

  const buildChanges = (newIds: Map<number, string>, preview: boolean): FieldChange[] =>
    planned.flatMap((p, i): FieldChange[] =>
      existing.has(i)
        ? []
        : [
            {
              objectId: newIds.get(i) ?? (preview ? "(mới)" : "?"),
              objectName: p.label,
              field: "create",
              before: null,
              after: { type: p.kind, label_vi: ASSET_LABEL_VI[p.kind], ...p.summary },
            },
          ]
    )
  const assetsOut = (newIds: Map<number, string>) =>
    planned.map((p, i) => ({ type: p.kind, label: p.label, asset_id: existing.get(i) ?? newIds.get(i) ?? null, reused: existing.has(i) }))

  if (!ops.length) return { preview: !!opts.dryRun, changes: [], warnings, createdIds: [], assets: assetsOut(new Map()) }

  if (opts.dryRun) {
    await client.googleAdsMutate(cid, ops, { validateOnly: true })
    return { preview: true, changes: buildChanges(new Map(), true), warnings, createdIds: [] }
  }

  let res
  try {
    res = await client.googleAdsMutate(cid, ops, { idempotent: false })
  } catch (e) {
    if (!isUncertain(e)) throw e
    // outcome unknown: report what now exists (identical assets) instead of inviting a duplicate retry
    const now = await findExistingAssets(client, cid, planned).catch(() => null)
    const appeared = new Map<number, string>()
    if (now) for (const [i, id] of now) if (!existing.has(i)) appeared.set(i, id)
    if (!appeared.size) throw e
    const unverifiable = planned.filter((_, i) => !existing.has(i) && !appeared.has(i)).map((p) => p.label)
    return {
      preview: false,
      changes: buildChanges(appeared, false).filter((c) => c.objectId !== "?"),
      warnings: [
        ...warnings,
        "Mất kết nối khi tạo nhưng các asset dưới đây đã có trên Google Ads - không tạo lại.",
        ...(unverifiable.length
          ? [`Chưa xác nhận được: ${unverifiable.join("; ")} - có thể đã tạo hoặc chưa; kiểm tra bằng google_ads_list_assets trước khi thử lại.`]
          : []),
      ],
      createdIds: [...appeared.values()].map((id) => `customers/${cid}/assets/${id}`),
      assets: assetsOut(appeared),
    }
  }
  if (res.failures.length) throw failuresToError(res.failures)
  const newIds = new Map<number, string>()
  const createdIds: string[] = []
  for (const [i, opIdx] of assetOpIndex) {
    const rn = responseResourceName(res.results[opIdx])
    const id = resourceId(rn)
    if (rn) createdIds.push(rn)
    if (id) newIds.set(i, id)
  }
  return { preview: false, changes: buildChanges(newIds, false), warnings, createdIds, assets: assetsOut(newIds) }
}

// ---------------------------------------------------------------------------
// google_ads_link_assets
// ---------------------------------------------------------------------------

const linkItem = z.object({ asset_id: idStr, field_type: z.enum(ASSET_KINDS) })

export const linkAssetsInput = z
  .object({
    campaign_id: idStr
      .optional()
      .describe(
        "Bỏ trống = cấp tài khoản (áp dụng cho mọi chiến dịch đủ điều kiện)"
      ),
    attach: z
      .array(linkItem)
      .max(MAX_LINK_ITEMS)
      .optional()
      .describe("Asset cần gắn"),
    detach: z
      .array(linkItem)
      .max(MAX_LINK_ITEMS)
      .optional()
      .describe("Asset cần gỡ"),
  })
  .superRefine((v, c) => {
    const total = (v.attach?.length ?? 0) + (v.detach?.length ?? 0)
    if (total === 0)
      c.addIssue({
        code: "custom",
        path: [],
        message: "Cần ít nhất 1 mục trong attach hoặc detach.",
      })
    if (total > MAX_LINK_ITEMS)
      c.addIssue({
        code: "custom",
        path: [],
        message: `Tối đa ${MAX_LINK_ITEMS} mục mỗi lần (nhận ${total}).`,
      })
    const seen = new Set<string>()
    for (const [path, list] of [
      ["attach", v.attach],
      ["detach", v.detach],
    ] as const) {
      list?.forEach((it, i) => {
        const k = `${it.asset_id}~${it.field_type}`
        if (seen.has(k))
          c.addIssue({
            code: "custom",
            path: [path, i],
            message: `Asset ${k} xuất hiện hơn một lần (attach/detach).`,
          })
        seen.add(k)
      })
    }
  })
export type LinkAssetsInput = z.infer<typeof linkAssetsInput>

/** Resource name of an asset link. */
export function assetLinkResourceName(
  cid: string,
  assetId: string,
  fieldType: string,
  campaignId?: string | null
): string {
  return campaignId
    ? `customers/${cid}/campaignAssets/${campaignId}~${assetId}~${fieldType}`
    : `customers/${cid}/customerAssets/${assetId}~${fieldType}`
}

const LINK_STATE_VI = { ENABLED: "đã gắn", PAUSED: "tạm dừng" } as Record<
  string,
  string
>

async function runLinkAssets(
  ctx: GCtx,
  input: LinkAssetsInput,
  opts: MutationOptions
): Promise<MutationResult> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const attach = input.attach ?? []
  const detach = input.detach ?? []
  const all = [...attach, ...detach]
  const warnings: string[] = []

  let campaign: GoogleAdsRow | null = null
  if (input.campaign_id) {
    campaign = await loadCampaign(client, cid, input.campaign_id)
    assertWritableCampaign(campaign, "link_assets")
  }
  const campaignId = campaign ? str(campaign, "campaign.id")! : null
  const campaignName = campaign ? safe(field(campaign, "campaign.name")) : null

  // the assets: must exist, be ADVERTISER assets, and match the field type
  const ids = [...new Set(all.map((x) => x.asset_id))]
  const { rows: assetRows } = await client.searchAll(
    cid,
    `SELECT ${ASSET_FIELDS.join(", ")} FROM asset WHERE asset.id IN ${idList(ids, "asset_id")}`,
    { maxRows: ids.length }
  )
  const assets = new Map(assetRows.map((r) => [str(r, "asset.id") ?? "", r]))
  const unknown = ids.filter((id) => !assets.has(id))
  if (unknown.length) {
    throw invalidRequest(
      `Unknown assets ${unknown.join(",")}`,
      `Không tìm thấy asset: ${unknown.join(", ")}.`,
      "Gọi google_ads_list_assets để lấy đúng asset_id."
    )
  }
  const auto = ids.filter(
    (id) => str(assets.get(id)!, "asset.source") === "AUTOMATICALLY_CREATED"
  )
  if (auto.length) {
    throw invalidRequest(
      `Automatically created assets ${auto.join(",")}`,
      `Asset do Google tự tạo không gắn/gỡ được qua MCP: ${auto.join(", ")}. Hãy quản lý chúng trong giao diện Google Ads.`
    )
  }
  const mismatch = all.filter(
    (x) => str(assets.get(x.asset_id)!, "asset.type") !== x.field_type
  )
  if (mismatch.length) {
    throw invalidRequest(
      "field_type does not match asset type",
      `field_type không khớp loại asset: ${mismatch.map((x) => `${x.asset_id} là ${str(assets.get(x.asset_id)!, "asset.type") ?? "?"}, không phải ${x.field_type}`).join("; ")}.`,
      "field_type phải trùng loại asset (SITELINK↔SITELINK, CALLOUT↔CALLOUT…)."
    )
  }

  const kinds = [...new Set(all.map((x) => x.field_type))]
  const readLinks = async () => {
    const [camp, acct] = await Promise.all([
      campaignId
        ? readCampaignLinks(client, cid, { kinds, campaignId })
        : Promise.resolve({ links: [] as AssetLink[], truncated: false }),
      readAccountLinks(client, cid, { kinds }),
    ])
    return { camp: camp.links, acct: acct.links }
  }
  const before = await readLinks()
  const own = campaignId ? before.camp : before.acct
  const linkOf = new Map(own.map((l) => [`${l.asset_id}~${l.field_type}`, l]))

  type Planned = {
    assetId: string
    fieldType: AssetKind
    action: "create" | "enable" | "remove"
    before: string
    after: string
    resourceName: string
  }
  const plan: Planned[] = []
  const ops: Record<string, unknown>[] = []
  const labelOf = (id: string) => `${rowLabel(assets.get(id)!)} (asset ${id})`
  for (const x of attach) {
    const rn = assetLinkResourceName(cid, x.asset_id, x.field_type, campaignId)
    const prev = linkOf.get(`${x.asset_id}~${x.field_type}`)
    const op = campaignId ? "campaignAssetOperation" : "customerAssetOperation"
    if (prev?.status === "ENABLED") {
      warnings.push(`${labelOf(x.asset_id)} đã được gắn - bỏ qua.`)
      continue
    }
    if (prev?.status === "PAUSED") {
      ops.push({
        [op]: buildUpdate(prev.resource_name || rn, { status: "ENABLED" }),
      })
      plan.push({
        assetId: x.asset_id,
        fieldType: x.field_type,
        action: "enable",
        before: "tạm dừng",
        after: "đã gắn",
        resourceName: rn,
      })
      continue
    }
    const create: Record<string, unknown> = {
      asset: `customers/${cid}/assets/${x.asset_id}`,
      fieldType: x.field_type,
      status: "ENABLED",
    }
    if (campaignId) create.campaign = `customers/${cid}/campaigns/${campaignId}`
    ops.push({ [op]: { create } })
    plan.push({
      assetId: x.asset_id,
      fieldType: x.field_type,
      action: "create",
      before: "chưa gắn",
      after: "đã gắn",
      resourceName: rn,
    })
  }
  for (const x of detach) {
    const prev = linkOf.get(`${x.asset_id}~${x.field_type}`)
    if (!prev) {
      warnings.push(
        `${labelOf(x.asset_id)} chưa được gắn ở ${campaignId ? "chiến dịch này" : "cấp tài khoản"} - bỏ qua.`
      )
      continue
    }
    const rn =
      prev.resource_name ||
      assetLinkResourceName(cid, x.asset_id, x.field_type, campaignId)
    ops.push({
      [campaignId ? "campaignAssetOperation" : "customerAssetOperation"]: {
        remove: rn,
      },
    })
    plan.push({
      assetId: x.asset_id,
      fieldType: x.field_type,
      action: "remove",
      before: LINK_STATE_VI[prev.status ?? ""] ?? "đã gắn",
      after: "đã gỡ",
      resourceName: rn,
    })
  }
  if (!plan.length) return { preview: !!opts.dryRun, changes: [], warnings }

  // serving-level consequences
  for (const k of kinds) {
    const label = ASSET_LABEL_VI[k]
    if (campaignId) {
      const enabledBefore = before.camp
        .filter((l) => l.field_type === k && l.status === "ENABLED")
        .map((l) => l.asset_id)
      const after = new Set(enabledBefore)
      for (const p of plan) {
        if (p.fieldType !== k) continue
        if (p.action === "remove") after.delete(p.assetId)
        else after.add(p.assetId)
      }
      const acct = before.acct.filter(
        (l) => l.field_type === k && l.status === "ENABLED"
      ).length
      if (enabledBefore.length > 0 && after.size === 0) {
        warnings.push(
          acct > 0
            ? `Chiến dịch không còn ${label} cấp chiến dịch → ${acct} asset ${label} cấp tài khoản sẽ hiển thị lại cho chiến dịch này.`
            : `Chiến dịch sẽ không còn ${label} nào (cả cấp chiến dịch lẫn cấp tài khoản).`
        )
      } else if (enabledBefore.length === 0 && after.size > 0 && acct > 0) {
        warnings.push(
          `Chiến dịch sẽ có ${label} cấp chiến dịch → ${acct} asset ${label} cấp tài khoản sẽ KHÔNG còn hiển thị cho chiến dịch này.`
        )
      }
    } else if (plan.some((p) => p.fieldType === k)) {
      const affected = await countAccountLevelCampaigns(client, cid, k).catch(
        () => null
      )
      warnings.push(
        `Thay đổi ${label} cấp tài khoản ảnh hưởng mọi chiến dịch đủ điều kiện chưa có ${label} cấp chiến dịch đang bật` +
          (affected !== null
            ? ` (hiện có ${affected} chiến dịch như vậy).`
            : ".")
      )
    }
  }
  warnings.push(
    "Gỡ chỉ bỏ liên kết - bản thân asset vẫn còn trong tài khoản (Google Ads không cho xoá asset)."
  )

  const changes = (subset: Planned[]): FieldChange[] =>
    subset.map((p) => ({
      objectId: campaignId ?? `${p.assetId}~${p.fieldType}`,
      objectName: campaignId
        ? `${labelOf(p.assetId)} - chiến dịch ${campaignName ?? campaignId}`
        : labelOf(p.assetId),
      ...(campaignId ? { level: "campaign" as const } : {}),
      field: "asset_link",
      before: p.before,
      after: p.after,
    }))

  if (opts.dryRun) {
    await client.googleAdsMutate(cid, ops, { validateOnly: true })
    return { preview: true, changes: changes(plan), warnings }
  }
  try {
    const res = await client.googleAdsMutate(cid, ops, { idempotent: false })
    if (res.failures.length) throw failuresToError(res.failures)
  } catch (e) {
    if (!isUncertain(e)) throw e
    // outcome unknown (remove is not retry-safe): re-read the links and report the ones now in the target state
    const now = await readLinks().catch(() => null)
    if (!now) throw e
    const state = new Map(
      (campaignId ? now.camp : now.acct).map((l) => [
        `${l.asset_id}~${l.field_type}`,
        l.status,
      ])
    )
    const done = plan.filter((p) => {
      const s = state.get(`${p.assetId}~${p.fieldType}`)
      return p.action === "remove" ? s === undefined : s === "ENABLED"
    })
    if (!done.length) throw e
    const pending = plan.filter((p) => !done.includes(p))
    return {
      preview: false,
      changes: changes(done),
      warnings: [
        ...warnings,
        "Mất kết nối nhưng đã đọc lại: các thay đổi dưới đây đã áp dụng trên Google Ads - không gửi lại.",
        ...(pending.length
          ? [
              redactString(
                `Chưa áp dụng: ${pending.map((p) => `${p.assetId}~${p.fieldType}`).join(", ")} - kiểm tra bằng google_ads_list_assets trước khi thử lại.`
              ),
            ]
          : []),
      ],
    }
  }
  return { preview: false, changes: changes(plan), warnings }
}

/** Channel types where these assets serve (Search, PMax; sitelinks also Demand Gen). */
export function assetServingChannels(kind: AssetKind): string[] {
  return kind === "SITELINK" ? ["SEARCH", "PERFORMANCE_MAX", "DEMAND_GEN"] : ["SEARCH", "PERFORMANCE_MAX"]
}

/** Non-removed campaigns of those channel types WITHOUT an enabled campaign-level asset of `kind` (they use account-level ones). */
async function countAccountLevelCampaigns(
  client: GoogleAdsClient,
  cid: string,
  kind: AssetKind
): Promise<number | null> {
  const channels = assetServingChannels(kind)
  const [{ rows: campaigns, truncated }, own] = await Promise.all([
    client.searchAll(
      cid,
      `SELECT campaign.id, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type IN (${channels.map((c) => `'${c}'`).join(", ")})`,
      { maxRows: 10_000 }
    ),
    readCampaignLinks(client, cid, { kinds: [kind], enabledOnly: true }),
  ])
  if (truncated || own.truncated) return null
  const withOwn = new Set(own.links.map((l) => l.campaign_id))
  return campaigns.filter(
    (r) =>
      channels.includes(str(r, "campaign.advertising_channel_type") ?? "") &&
      !withOwn.has(str(r, "campaign.id"))
  ).length
}

// ---------------------------------------------------------------------------

type Ext = ProviderExtension<GoogleAdsCredentials>

export const googleAdsAssetExtensions: Ext[] = [
  {
    name: "google_ads_list_assets",
    permission: "read",
    title: "Xem asset Google Ads",
    description:
      "Dùng khi cần xem các asset của tài khoản Google Ads: đường liên kết trang web (SITELINK), chú thích (CALLOUT), cuộc gọi (CALL), đoạn nội dung có cấu trúc (STRUCTURED_SNIPPET), giá (PRICE), khuyến mãi (PROMOTION) - nội dung, trạng thái duyệt chính sách và nơi đang gắn (cấp tài khoản / từng chiến dịch). " +
      "Truyền campaign_id để xem asset của một chiến dịch kèm asset cấp tài khoản cùng loại và effective: nếu chiến dịch có asset cấp chiến dịch đang bật của một loại thì asset cấp tài khoản loại đó không hiển thị cho chiến dịch. " +
      "Giá trong asset theo đơn vị chính + mã tiền tệ. Dùng để lấy asset_id trước khi gọi google_ads_link_assets; tạo asset mới bằng google_ads_create_assets. Gọi trước: ads_list_accounts, ads_list_objects (campaign_id).",
    input: listAssetsInput,
    write: false,
    run: (ctx, input: z.infer<typeof listAssetsInput>) =>
      runListAssets(ctx, input),
  },
  {
    name: "google_ads_create_assets",
    permission: "create",
    title: "Tạo asset Google Ads",
    description:
      "Dùng khi cần tạo asset cho quảng cáo Tìm kiếm: đường liên kết trang web (link_text ≤25, 2 mô tả ≤35 có cả hai hoặc không), chú thích (≤25), đoạn nội dung có cấu trúc (tiêu đề định sẵn tiếng Anh hoặc tiếng Việt như Dịch vụ, Thương hiệu, Loại… + 3–10 giá trị ≤25), cuộc gọi (số điện thoại + mã quốc gia, mặc định VN), giá (3–8 mục) và khuyến mãi (giảm % hoặc số tiền). " +
      "Tất cả trong 1 lần ghi nguyên khối, tối đa 50 asset. Chữ Trung/Nhật/Hàn tính 2 ký tự. Asset giống hệt đã có thì dùng lại, không tạo trùng. " +
      "Giá / số tiền khuyến mãi theo đơn vị chính của tiền tệ tài khoản và chỉ là giá hiển thị (không phải chi tiêu). " +
      "Chỉ tạo asset vào thư viện tài khoản (chưa hiển thị); gắn vào chiến dịch / tài khoản bằng google_ads_link_assets với asset_id trả về. " +
      "Gọi trước: google_ads_list_assets để xem asset hiện có.",
    input: createAssetsInput,
    write: true,
    // price / money_amount_off / orders_over_amount are ADVERTISED amounts shown in the ad (price list, promotion), not
    // a budget or a bid: nothing here can make the account spend more, so no item is checked against the MCP's spend
    // caps. Declared (empty) because mcp-core refuses undeclared money-like keys of write tools.
    moneyOf: () => [],
    // assets are library items without a status (not ad objects): no "created paused" note
    createsAdObject: false,
    run: (ctx, input: CreateAssetsInput, opts) =>
      runCreateAssets(ctx, input, opts),
  },
  {
    name: "google_ads_link_assets",
    permission: "update",
    title: "Gắn / gỡ asset Google Ads",
    description:
      "Dùng khi cần gắn (attach) hoặc gỡ (detach) asset có sẵn (đường liên kết trang web, chú thích, cuộc gọi, đoạn nội dung có cấu trúc, giá, khuyến mãi) ở cấp chiến dịch (truyền campaign_id) hoặc cấp tài khoản (bỏ trống campaign_id - áp dụng cho mọi chiến dịch đủ điều kiện chưa có asset cấp chiến dịch cùng loại). " +
      "Mỗi mục: asset_id + field_type trùng loại asset. Asset có liên kết cấp chiến dịch đang bật thì asset cấp tài khoản cùng loại không hiển thị cho chiến dịch đó. " +
      "Gỡ chỉ bỏ liên kết - Google Ads không cho xoá asset. Asset do Google tự tạo không gắn/gỡ được. Luôn cần xác nhận. " +
      "Gọi trước: google_ads_list_assets để lấy asset_id (tạo mới bằng google_ads_create_assets), ads_list_objects để lấy campaign_id.",
    input: linkAssetsInput,
    write: true,
    alwaysConfirm: true,
    run: (ctx, input: LinkAssetsInput, opts) => runLinkAssets(ctx, input, opts),
  },
]
