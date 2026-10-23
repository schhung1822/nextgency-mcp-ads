// google_ads_create_demand_gen_campaign: a complete Google Ads Demand Gen campaign (YouTube video ads / multi-asset
// image ads) in ONE atomic googleAds:mutate (nothing is created when any operation fails).
// API facts (v25 reference + Demand Gen guides, verified 2026-10-23):
// - campaign: advertisingChannelType DEMAND_GEN, no sub type, created PAUSED, contains_eu_political_advertising
//   required; demandGenCampaignSettings.upgradedTargeting left at Google's default (true) → location / language
//   criteria go on the AD GROUP. No networkSettings / geoTargetTypeSetting (not part of any DG guide).
// - budget: explicitlyShared MUST be false; daily = amountMicros, total = period CUSTOM_PERIOD + totalAmountMicros
//   + campaign start/end date time. Minimum 5 USD/day equivalent (CampaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM).
// - ad group: created WITHOUT type; channel controls = channelStrategy XOR selectedChannels (all 7 booleans);
//   channelConfig is output only. audienceSetting.useAudienceGrouped (immutable) must be true to attach an Audience.
// - ads: demandGenVideoResponsiveAd (businessName = AdTextAsset {text}) / demandGenMultiAssetAd (businessName =
//   string). Images are referenced by asset resource name; YouTube videos become YoutubeVideoAssets (temp ids in the
//   same mutate when the account has none for that video). Call to action = CALL_TO_ACTION asset.
import { z } from "zod"
import { addDays, isIsoDate, todayInTz } from "../dates"
import { ProviderError, isProviderError } from "../errors"
import type {
  ExtensionMoneyItem,
  FieldChange,
  MutationOptions,
  MutationResult,
  ProviderExtension,
} from "../types"
import { cleanText, hasUnsafeChars, textWidth } from "./assets"
import { field, resourceId, str, type GoogleAdsRow } from "./client"
import { clientFor, customerIdOf, invalidRequest, type GCtx } from "./context"
import type { GoogleAdsCredentials } from "./credentials"
import { assertId, gaqlString, idList } from "./gaql"
import { moneyToMicros, primeBillableUnit } from "./units"
import { parseYoutubeVideoId } from "./youtube"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DemandGenSelectedChannels booleans (v25, `maps` since v24.2) in input naming. */
export const DG_CHANNELS = [
  "youtube_in_feed",
  "youtube_in_stream",
  "youtube_shorts",
  "discover",
  "gmail",
  "display",
  "maps",
] as const
export type DgChannel = (typeof DG_CHANNELS)[number]
const CHANNEL_FIELD: Record<DgChannel, string> = {
  youtube_in_feed: "youtubeInFeed",
  youtube_in_stream: "youtubeInStream",
  youtube_shorts: "youtubeShorts",
  discover: "discover",
  gmail: "gmail",
  display: "display",
  maps: "maps",
}
const CHANNEL_VI: Record<DgChannel, string> = {
  youtube_in_feed: "YouTube In-feed",
  youtube_in_stream: "YouTube In-stream",
  youtube_shorts: "YouTube Shorts",
  discover: "Discover",
  gmail: "Gmail",
  display: "Mạng Hiển thị",
  maps: "Google Maps",
}
const YOUTUBE_ONLY: readonly DgChannel[] = [
  "youtube_in_feed",
  "youtube_in_stream",
  "youtube_shorts",
]

/** CallToActionType (v25 = v26). */
export const DG_CALL_TO_ACTIONS = [
  "LEARN_MORE",
  "GET_QUOTE",
  "APPLY_NOW",
  "SIGN_UP",
  "CONTACT_US",
  "SUBSCRIBE",
  "DOWNLOAD",
  "BOOK_NOW",
  "SHOP_NOW",
  "BUY_NOW",
  "DONATE_NOW",
  "ORDER_NOW",
  "PLAY_NOW",
  "SEE_MORE",
  "START_NOW",
  "VISIT_SITE",
  "WATCH_NOW",
] as const

/** Image slots of DG ads: aspect ratio ±1% and API minimum size (v25 DemandGen*AdInfo reference). */
export const DG_IMAGE_SLOTS = {
  logo: {
    label: "logo (logo_images, 1:1)",
    ratioLabel: "1:1",
    ratio: 1,
    minW: 128,
    minH: 128,
  },
  marketing: {
    label: "ảnh ngang (marketing_images, 1.91:1)",
    ratioLabel: "1.91:1",
    ratio: 1.91,
    minW: 600,
    minH: 314,
  },
  square: {
    label: "ảnh vuông (square_marketing_images, 1:1)",
    ratioLabel: "1:1",
    ratio: 1,
    minW: 300,
    minH: 300,
  },
  portrait: {
    label: "ảnh dọc (portrait_marketing_images, 4:5)",
    ratioLabel: "4:5",
    ratio: 4 / 5,
    minW: 480,
    minH: 600,
  },
  tall: {
    label: "ảnh dọc cao (tall_portrait_marketing_images, 9:16)",
    ratioLabel: "9:16",
    ratio: 9 / 16,
    minW: 600,
    minH: 1067,
  },
} as const
export type DgImageSlot = keyof typeof DG_IMAGE_SLOTS
const RATIO_TOLERANCE = 0.01
/** Help: logo file ≤150 KB (warning only - the API limit is not documented). */
const LOGO_MAX_BYTES = 150 * 1024
/** Help: logo ≥144×144 recommended (the API accepts 128×128) → warning only. */
const LOGO_RECOMMENDED_MIN = 144
const MAX_TOTAL_BUDGET_DAYS = 365
const MIN_TOTAL_BUDGET_DAYS = 3
const UPLOAD_HINT =
  "Tải ảnh đúng tỉ lệ bằng ads_upload_media rồi dùng resource name asset trả về."

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const idStr = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Id chỉ gồm chữ số.")
const money = z.number().positive().finite()
const isoDate = z.string().refine(isIsoDate, "Ngày phải có dạng YYYY-MM-DD.")

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

const uniqueText = (a: string[]) =>
  new Set(a.map((x) => cleanText(x).toLowerCase())).size === a.length

const textList = (min: number, max: number, maxLen: number, what: string) =>
  z
    .array(adText(maxLen, what))
    .min(min, `Cần ít nhất ${min} ${what.toLowerCase()}.`)
    .max(max, `Tối đa ${max} ${what.toLowerCase()}.`)
    .refine(uniqueText, `Các ${what.toLowerCase()} không được trùng nhau.`)

const httpsUrl = z
  .string()
  .trim()
  .max(2048, "final_url tối đa 2048 ký tự.")
  .refine((s) => {
    if (/\s/.test(s) || hasUnsafeChars(s)) return false
    try {
      const u = new URL(s)
      return u.protocol === "https:" && !!u.hostname
    } catch {
      return false
    }
  }, "final_url phải là URL đầy đủ bắt đầu bằng https://")

const IMAGE_REF = /^(\d{1,19}|customers\/\d{10}\/assets\/\d{1,19})$/
const ASSET_RN = /^customers\/(\d{10})\/assets\/(\d{1,19})$/
const imageRef = z
  .string()
  .trim()
  .regex(
    IMAGE_REF,
    "Ảnh phải là id asset (chỉ chữ số) hoặc resource name customers/<customer_id>/assets/<id> (từ ads_upload_media)."
  )
const uniqueRefs = (a: string[]) =>
  new Set(a.map((x) => x.replace(/^customers\/\d{10}\/assets\//, ""))).size ===
  a.length
const imageList = (max: number, what: string) =>
  z
    .array(imageRef)
    .max(max, `Tối đa ${max} ${what}.`)
    .refine(uniqueRefs, `Các ${what} không được trùng nhau.`)

const videoRef = z
  .string()
  .trim()
  .min(11)
  .max(300)
  .describe(
    "Link YouTube (watch / youtu.be / shorts), ID video 11 ký tự, hoặc resource name asset YOUTUBE_VIDEO có sẵn"
  )

const channelsSchema = z
  .union([
    z.enum(["youtube", "all", "google_owned"]),
    z
      .array(z.enum(DG_CHANNELS))
      .min(1, "Chọn ít nhất 1 kênh.")
      .max(DG_CHANNELS.length)
      .refine(
        (a) => new Set(a).size === a.length,
        "Các kênh không được trùng nhau."
      ),
  ])
  .describe(
    "youtube = chỉ YouTube (In-feed, In-stream, Shorts); all = mọi kênh Google kể cả Mạng Hiển thị; google_owned = kênh của Google (YouTube, Discover, Gmail, Maps; không Mạng Hiển thị); hoặc danh sách: youtube_in_feed, youtube_in_stream, youtube_shorts, discover, gmail, display, maps"
  )
export type DgChannelsInput = z.infer<typeof channelsSchema>

const adName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .optional()
  .describe("Tên quảng cáo (tùy chọn, chỉ hiển thị nội bộ)")
const logoImages = imageList(5, "logo")
  .min(1, "Cần ít nhất 1 logo (Google bắt buộc).")
  .describe("1–5 logo vuông 1:1 ≥128×128 (id / resource name asset ảnh)")
const businessName = adText(25, "Tên doanh nghiệp").describe(
  "Tên doanh nghiệp / thương hiệu ≤25 ký tự (Google bắt buộc)"
)

const videoAdSchema = z.object({
  type: z.literal("video"),
  name: adName,
  videos: z
    .array(videoRef)
    .min(1, "Cần ít nhất 1 video YouTube.")
    .max(5, "Tối đa 5 video."),
  logo_images: logoImages,
  headlines: textList(1, 5, 40, "Tiêu đề").describe("1–5 tiêu đề ≤40 ký tự"),
  long_headlines: textList(1, 5, 90, "Tiêu đề dài").describe(
    "1–5 tiêu đề dài ≤90 ký tự"
  ),
  descriptions: textList(1, 5, 90, "Mô tả").describe("1–5 mô tả ≤90 ký tự"),
  business_name: businessName,
  final_url: httpsUrl.describe("Trang đích https://…"),
  call_to_action: z
    .enum(DG_CALL_TO_ACTIONS)
    .optional()
    .describe("Nút kêu gọi hành động; bỏ trống = Google tự chọn"),
})

const imageAdSchema = z.object({
  type: z.literal("image"),
  name: adName,
  marketing_images: imageList(20, "ảnh ngang")
    .optional()
    .describe("Ảnh ngang 1.91:1 ≥600×314"),
  square_marketing_images: imageList(20, "ảnh vuông")
    .optional()
    .describe("Ảnh vuông 1:1 ≥300×300"),
  portrait_marketing_images: imageList(20, "ảnh dọc 4:5")
    .optional()
    .describe("Ảnh dọc 4:5 ≥480×600"),
  tall_portrait_marketing_images: imageList(20, "ảnh dọc 9:16")
    .optional()
    .describe("Ảnh dọc 9:16 ≥600×1067"),
  logo_images: logoImages,
  headlines: textList(1, 5, 40, "Tiêu đề").describe(
    "1–5 tiêu đề ≤40 ký tự (nên có ít nhất 1 tiêu đề ≤30 ký tự)"
  ),
  descriptions: textList(1, 5, 90, "Mô tả").describe("1–5 mô tả ≤90 ký tự"),
  business_name: businessName,
  final_url: httpsUrl.describe("Trang đích https://…"),
})

const adSchema = z.discriminatedUnion("type", [videoAdSchema, imageAdSchema])
export type DgVideoAdInput = z.infer<typeof videoAdSchema>
export type DgImageAdInput = z.infer<typeof imageAdSchema>

const AUDIENCE_REF = /^(\d{1,19}|customers\/\d{10}\/audiences\/\d{1,19})$/

const adGroupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  location_ids: z
    .array(idStr)
    .min(1)
    .max(1000)
    .optional()
    .describe("Ghi đè location_ids chung cho nhóm này"),
  language_ids: z
    .array(idStr)
    .min(1)
    .max(100)
    .optional()
    .describe("Ghi đè language_ids chung cho nhóm này"),
  channels: channelsSchema
    .optional()
    .describe("Ghi đè channels chung cho nhóm này"),
  audience_id: z
    .string()
    .trim()
    .regex(
      AUDIENCE_REF,
      "audience_id phải là id (chữ số) hoặc customers/<customer_id>/audiences/<id>."
    )
    .optional()
    .describe(
      "Đối tượng (Audience) có sẵn trong tài khoản; bỏ trống = không giới hạn đối tượng"
    ),
  optimized_targeting: z
    .boolean()
    .optional()
    .describe("Nhắm mục tiêu tối ưu (Google mở rộng ngoài đối tượng đã chọn)"),
  ads: z
    .array(adSchema)
    .min(1, "Mỗi nhóm cần ít nhất 1 quảng cáo.")
    .max(5, "Tối đa 5 quảng cáo mỗi nhóm."),
})

export const createDemandGenCampaignInput = z
  .object({
    name: z.string().trim().min(1).max(255),
    daily_budget: money
      .optional()
      .describe(
        "Ngân sách ngày, đơn vị chính của tiền tệ tài khoản (tối thiểu ~5 USD/ngày quy đổi)"
      ),
    total_budget: money
      .optional()
      .describe(
        "Ngân sách tổng cho cả thời gian chạy (cần end_date, 3 ngày – 1 năm); chọn 1 trong daily_budget / total_budget"
      ),
    bidding_strategy: z
      .enum([
        "maximize_clicks",
        "maximize_conversions",
        "maximize_conversion_value",
        "target_cpc",
      ])
      .default("maximize_clicks"),
    max_cpc_bid_limit: money
      .optional()
      .describe("Trần CPC cho maximize_clicks"),
    target_cpa: money
      .optional()
      .describe("CPA mục tiêu cho maximize_conversions"),
    target_roas: z
      .number()
      .min(0.01)
      .max(1000)
      .optional()
      .describe(
        "ROAS mục tiêu (tỉ lệ, vd 3.5 = 350%) cho maximize_conversion_value"
      ),
    target_cpc: money
      .optional()
      .describe("CPC mục tiêu (bắt buộc với target_cpc)"),
    start_date: isoDate
      .optional()
      .describe("YYYY-MM-DD theo múi giờ tài khoản, mặc định hôm nay"),
    end_date: isoDate
      .optional()
      .describe(
        "YYYY-MM-DD theo múi giờ tài khoản (bắt buộc khi dùng total_budget)"
      ),
    contains_eu_political_advertising: z.boolean().default(false),
    location_ids: z
      .array(idStr)
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "ID geo target (ads_lookup kind=locations), vd 2704 = Việt Nam; áp dụng cho mọi nhóm"
      ),
    language_ids: z
      .array(idStr)
      .min(1)
      .max(100)
      .optional()
      .describe(
        "ID ngôn ngữ (ads_lookup kind=languages); bỏ trống = mọi ngôn ngữ"
      ),
    channels: channelsSchema.default("youtube"),
    ad_groups: z.array(adGroupSchema).min(1).max(10),
  })
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message })
    if ((v.daily_budget === undefined) === (v.total_budget === undefined)) {
      issue(
        ["daily_budget"],
        "Chọn đúng 1 loại ngân sách: daily_budget (ngân sách ngày) hoặc total_budget (ngân sách tổng)."
      )
    }
    if (v.total_budget !== undefined && !v.end_date)
      issue(
        ["end_date"],
        "total_budget cần end_date (ngân sách tổng chạy trong 3 ngày – 1 năm)."
      )
    if (v.start_date && v.end_date && v.end_date < v.start_date)
      issue(["end_date"], "end_date phải sau start_date.")
    if (
      v.max_cpc_bid_limit !== undefined &&
      v.bidding_strategy !== "maximize_clicks"
    )
      issue(
        ["max_cpc_bid_limit"],
        "max_cpc_bid_limit chỉ dùng với maximize_clicks."
      )
    if (
      v.target_cpa !== undefined &&
      v.bidding_strategy !== "maximize_conversions"
    )
      issue(["target_cpa"], "target_cpa chỉ dùng với maximize_conversions.")
    if (
      v.target_roas !== undefined &&
      v.bidding_strategy !== "maximize_conversion_value"
    ) {
      issue(
        ["target_roas"],
        "target_roas chỉ dùng với maximize_conversion_value."
      )
    }
    if (v.bidding_strategy === "target_cpc" && v.target_cpc === undefined)
      issue(["target_cpc"], "Chiến lược target_cpc cần target_cpc.")
    if (v.target_cpc !== undefined && v.bidding_strategy !== "target_cpc")
      issue(["target_cpc"], "target_cpc chỉ dùng với chiến lược target_cpc.")
    const names = v.ad_groups.map((g) => g.name.toLowerCase())
    if (new Set(names).size !== names.length)
      issue(["ad_groups"], "Tên nhóm quảng cáo không được trùng.")
    v.ad_groups.forEach((g, i) => {
      if (!(g.location_ids ?? v.location_ids)?.length) {
        issue(
          ["ad_groups", i, "location_ids"],
          `Nhóm “${g.name}” chưa có vị trí: truyền location_ids chung hoặc của nhóm (Demand Gen không có vị trí = hiển thị toàn cầu).`
        )
      }
      g.ads.forEach((ad, j) => {
        const path = ["ad_groups", i, "ads", j]
        if (ad.type === "video") {
          const ids = ad.videos.map((x) =>
            ASSET_RN.test(x) ? x : parseYoutubeVideoId(x)
          )
          ad.videos.forEach((x, k) => {
            if (!ids[k])
              issue(
                [...path, "videos", k],
                `Không nhận ra video YouTube “${x.slice(0, 60)}”: dùng link youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, ID 11 ký tự hoặc resource name asset video.`
              )
          })
          const ok = ids.filter(Boolean)
          if (new Set(ok).size !== ok.length)
            issue([...path, "videos"], "Các video không được trùng nhau.")
        } else {
          const n = (a?: string[]) => a?.length ?? 0
          if (!n(ad.marketing_images) && !n(ad.square_marketing_images)) {
            issue(
              [...path, "marketing_images"],
              "Quảng cáo ảnh cần ít nhất 1 ảnh ngang (marketing_images) hoặc 1 ảnh vuông (square_marketing_images)."
            )
          }
          if (
            n(ad.marketing_images) +
              n(ad.square_marketing_images) +
              n(ad.portrait_marketing_images) +
              n(ad.tall_portrait_marketing_images) >
            20
          ) {
            issue(
              [...path],
              "Tổng số ảnh (ngang + vuông + dọc) của 1 quảng cáo tối đa 20."
            )
          }
        }
      })
    })
  })
export type CreateDemandGenCampaignInput = z.infer<
  typeof createDemandGenCampaignInput
>

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** demandGenAdGroupSettings.channelControls body: channelStrategy XOR selectedChannels with all 7 booleans. */
export function channelControlsBody(
  ch: DgChannelsInput
): Record<string, unknown> {
  if (ch === "all") return { channelStrategy: "ALL_CHANNELS" }
  if (ch === "google_owned")
    return { channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS" }
  const on = new Set<DgChannel>(ch === "youtube" ? YOUTUBE_ONLY : ch)
  const selected: Record<string, boolean> = {}
  for (const c of DG_CHANNELS) selected[CHANNEL_FIELD[c]] = on.has(c)
  return { selectedChannels: selected }
}

export function channelLabelVi(ch: DgChannelsInput): string {
  if (ch === "all") return "Mọi kênh Google (gồm Mạng Hiển thị)"
  if (ch === "google_owned")
    return "Các kênh của Google: YouTube, Discover, Gmail, Maps (không Mạng Hiển thị)"
  if (ch === "youtube") return "Chỉ YouTube (In-feed, In-stream, Shorts)"
  return ch.map((c) => CHANNEL_VI[c]).join(", ")
}

/** Inclusive number of calendar days between two YYYY-MM-DD dates. */
function daysInclusive(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000
    ) + 1
  )
}

/** Asset id of an image / video reference; a resource name of another customer is refused. */
export function assetIdOf(ref: string, cid: string, what: string): string {
  const s = ref.trim()
  const m = ASSET_RN.exec(s)
  if (m) {
    if (m[1] !== cid) {
      throw invalidRequest(
        "Asset of another customer",
        `${what} “${s}” thuộc tài khoản Google Ads khác (${m[1]}), không phải tài khoản đang chọn (${cid}).`,
        "Tải lại ảnh vào đúng tài khoản bằng ads_upload_media."
      )
    }
    return m[2]!
  }
  return assertId(s, what)
}

const audienceRn = (ref: string, cid: string): string => {
  const m = /^customers\/(\d{10})\/audiences\/(\d{1,19})$/.exec(ref.trim())
  if (m) {
    if (m[1] !== cid) {
      throw invalidRequest(
        "Audience of another customer",
        `Đối tượng “${ref}” thuộc tài khoản Google Ads khác (${m[1]}), không phải tài khoản đang chọn (${cid}).`
      )
    }
    return ref.trim()
  }
  return `customers/${cid}/audiences/${assertId(ref, "audience_id")}`
}

export interface DgAssetInfo {
  /** AssetType (IMAGE, YOUTUBE_VIDEO, …) */
  type: string | null
  width: number | null
  height: number | null
  fileSize: number | null
}

/** Existing assets read before building (DemandGenResolved) - all keyed in the current account. */
export interface DemandGenResolved {
  /** asset id → info (every image asset + every video given as an asset resource name) */
  assets: Map<string, DgAssetInfo>
  /** YouTube video id → existing YOUTUBE_VIDEO asset resource name */
  youtubeAssets: Map<string, string>
  /** CallToActionType → existing CALL_TO_ACTION asset resource name */
  ctaAssets: Map<string, string>
}

export interface DemandGenPlan {
  ops: Record<string, unknown>[]
  campaignIndex: number
  adGroupIndexes: number[]
  warnings: string[]
  videos: { reused: number; created: number }
  callToActions: { reused: number; created: number }
  start: string
  /** daily amount (daily budget, or total ÷ days) in major units - for warnings */
  dailyEquivalent: number
}

function imageAssetRn(
  cid: string,
  ref: string,
  slot: DgImageSlot,
  resolved: DemandGenResolved,
  warnings: string[],
  warned: Set<string>
): string {
  const spec = DG_IMAGE_SLOTS[slot]
  const id = assetIdOf(ref, cid, `Ảnh ${spec.label}`)
  const info = resolved.assets.get(id)
  if (!info) {
    throw invalidRequest(
      `Image asset ${id} not found`,
      `Không tìm thấy asset ảnh ${id} (${spec.label}) trong tài khoản này.`,
      UPLOAD_HINT
    )
  }
  if (info.type !== "IMAGE") {
    throw invalidRequest(
      `Asset ${id} is ${info.type}`,
      `Asset ${id} không phải ảnh (loại ${info.type ?? "không rõ"}) - ${spec.label} cần asset ảnh.`,
      UPLOAD_HINT
    )
  }
  const { width: w, height: h } = info
  if (!w || !h) {
    if (!warned.has(`dim:${id}`)) {
      warned.add(`dim:${id}`)
      warnings.push(
        `Google không trả về kích thước ảnh ${id} - chưa kiểm tra được tỉ lệ ${spec.ratioLabel}; nếu sai tỉ lệ Google sẽ từ chối.`
      )
    }
  } else {
    if (Math.abs(w / h / spec.ratio - 1) > RATIO_TOLERANCE) {
      throw invalidRequest(
        `Image ${id} ratio ${w}x${h} not ${spec.ratioLabel}`,
        `Ảnh ${id} dùng làm ${spec.label} có kích thước ${w}×${h} px (tỉ lệ ${(w / h).toFixed(2)}:1), không đúng tỉ lệ ${spec.ratioLabel} (sai số cho phép ±1%).`,
        UPLOAD_HINT
      )
    }
    if (w < spec.minW || h < spec.minH) {
      throw invalidRequest(
        `Image ${id} too small ${w}x${h}`,
        `Ảnh ${id} dùng làm ${spec.label} chỉ ${w}×${h} px, nhỏ hơn mức tối thiểu ${spec.minW}×${spec.minH} px.`,
        UPLOAD_HINT
      )
    }
  }
  // API minimum is 128×128; Google's Help pages recommend ≥144×144
  if (slot === "logo" && w && h && (w < LOGO_RECOMMENDED_MIN || h < LOGO_RECOMMENDED_MIN) && !warned.has(`small:${id}`)) {
    warned.add(`small:${id}`)
    warnings.push(`Logo ${id} chỉ ${w}×${h} px - Google khuyên logo ≥144×144 (nên 1200×1200).`)
  }
  if (
    slot === "logo" &&
    info.fileSize !== null &&
    info.fileSize > LOGO_MAX_BYTES &&
    !warned.has(`size:${id}`)
  ) {
    warned.add(`size:${id}`)
    warnings.push(
      `Logo ${id} nặng ${Math.round(info.fileSize / 1024)} KB - Google khuyên logo ≤150 KB.`
    )
  }
  return `customers/${cid}/assets/${id}`
}

function biddingBody(
  input: CreateDemandGenCampaignInput,
  currency: string,
  warnings: string[]
): Record<string, unknown> {
  switch (input.bidding_strategy) {
    case "maximize_conversions":
      return {
        maximizeConversions:
          input.target_cpa !== undefined
            ? {
                targetCpaMicros: moneyToMicros(
                  input.target_cpa,
                  currency,
                  warnings,
                  "CPA mục tiêu"
                ),
              }
            : {},
      }
    case "maximize_conversion_value":
      // a ratio (not money): rounded to 4 decimals to keep float noise out of the request
      return {
        maximizeConversionValue:
          input.target_roas !== undefined
            ? { targetRoas: Math.round(input.target_roas * 10_000) / 10_000 }
            : {},
      }
    case "target_cpc":
      if (input.target_cpc === undefined)
        throw invalidRequest(
          "target_cpc missing",
          "Chiến lược target_cpc cần target_cpc."
        )
      return {
        targetCpc: {
          targetCpcMicros: moneyToMicros(
            input.target_cpc,
            currency,
            warnings,
            "CPC mục tiêu"
          ),
        },
      }
    default:
      // Maximize clicks = TargetSpend (targetSpendMicros is deprecated → never sent)
      return {
        targetSpend:
          input.max_cpc_bid_limit !== undefined
            ? {
                cpcBidCeilingMicros: moneyToMicros(
                  input.max_cpc_bid_limit,
                  currency,
                  warnings,
                  "Trần CPC"
                ),
              }
            : {},
      }
  }
}

const textAssets = (a: string[]) => a.map((text) => ({ text: cleanText(text) }))

/**
 * Pure builder: one atomic googleAds:mutate with temp ids declared before use (parents first):
 * budget → campaign → new YouTube video / call-to-action assets → ad groups → ad group criteria → ads.
 */
export function buildDemandGenCampaignOps(
  cid: string,
  input: CreateDemandGenCampaignInput,
  o: {
    currency: string
    today: string
    budgetSuffix?: string
    resolved: DemandGenResolved
  }
): DemandGenPlan {
  const warnings: string[] = []
  const warned = new Set<string>()
  let tmp = 0
  const nextId = () => String(--tmp)
  const ops: Record<string, unknown>[] = []
  const { resolved } = o

  const start = input.start_date ?? o.today
  if (start < o.today)
    throw invalidRequest(
      "start in past",
      `start_date (${start}) không được ở quá khứ (hôm nay: ${o.today}).`
    )
  const end = input.end_date ?? null
  if (end && end < start)
    throw invalidRequest(
      "end before start",
      `end_date (${end}) phải sau ngày bắt đầu (${start}).`
    )
  if (input.daily_budget === undefined && input.total_budget === undefined) {
    throw invalidRequest(
      "budget missing",
      "Chọn đúng 1 loại ngân sách: daily_budget hoặc total_budget."
    )
  }

  // --- budget (never shared: Demand Gen rejects shared budgets) ---
  const budgetRn = `customers/${cid}/campaignBudgets/${nextId()}`
  const budget: Record<string, unknown> = {
    resourceName: budgetRn,
    name: `${input.name} - ngân sách ${o.budgetSuffix ?? Date.now().toString(36)}`.slice(
      0,
      255
    ),
    deliveryMethod: "STANDARD",
    explicitlyShared: false,
  }
  let dailyEquivalent: number
  if (input.total_budget !== undefined) {
    if (!end)
      throw invalidRequest(
        "end_date required",
        "total_budget cần end_date (ngân sách tổng chạy trong 3 ngày – 1 năm)."
      )
    const days = daysInclusive(start, end)
    if (days < MIN_TOTAL_BUDGET_DAYS) {
      throw invalidRequest(
        "total budget flight too short",
        `Ngân sách tổng cần thời gian chạy ít nhất ${MIN_TOTAL_BUDGET_DAYS} ngày (hiện ${days} ngày: ${start} → ${end}).`
      )
    }
    if (days > MAX_TOTAL_BUDGET_DAYS) {
      throw invalidRequest(
        "total budget flight too long",
        `Ngân sách tổng chỉ dùng cho thời gian chạy tối đa 1 năm (${MAX_TOTAL_BUDGET_DAYS} ngày; hiện ${days} ngày).`
      )
    }
    budget.period = "CUSTOM_PERIOD"
    budget.totalAmountMicros = moneyToMicros(
      input.total_budget,
      o.currency,
      warnings,
      "Ngân sách tổng"
    )
    dailyEquivalent = input.total_budget / days
  } else {
    budget.amountMicros = moneyToMicros(
      input.daily_budget!,
      o.currency,
      warnings,
      "Ngân sách ngày"
    )
    dailyEquivalent = input.daily_budget!
  }
  ops.push({ campaignBudgetOperation: { create: budget } })

  // --- campaign (PAUSED, no sub type / networkSettings / geoTargetTypeSetting; upgradedTargeting = Google default) ---
  const campaignRn = `customers/${cid}/campaigns/${nextId()}`
  const campaign: Record<string, unknown> = {
    resourceName: campaignRn,
    name: input.name,
    status: "PAUSED",
    advertisingChannelType: "DEMAND_GEN",
    campaignBudget: budgetRn,
    ...biddingBody(input, o.currency, warnings),
    containsEuPoliticalAdvertising: input.contains_eu_political_advertising
      ? "CONTAINS_EU_POLITICAL_ADVERTISING"
      : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    startDateTime: `${start} 00:00:00`,
  }
  if (end) campaign.endDateTime = `${end} 23:59:59`
  const campaignIndex = ops.length
  ops.push({ campaignOperation: { create: campaign } })

  // --- assets created in the same mutate: YouTube videos without an asset, call-to-action assets ---
  const videoRn = new Map<string, string>() // YouTube id → asset rn (existing or temp)
  const ctaRn = new Map<string, string>()
  const stats = {
    videos: { reused: 0, created: 0 },
    callToActions: { reused: 0, created: 0 },
  }
  for (const g of input.ad_groups) {
    for (const ad of g.ads) {
      if (ad.type !== "video") continue
      for (const v of ad.videos) {
        if (ASSET_RN.test(v.trim())) continue
        const id = parseYoutubeVideoId(v)
        if (!id)
          throw invalidRequest(
            "Invalid YouTube video",
            `Không nhận ra video YouTube “${v.slice(0, 60)}”.`,
            "Dùng link youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/… hoặc ID 11 ký tự."
          )
        if (videoRn.has(id)) continue
        const existing = resolved.youtubeAssets.get(id)
        if (existing) {
          videoRn.set(id, existing)
          stats.videos.reused++
          continue
        }
        const rn = `customers/${cid}/assets/${nextId()}`
        videoRn.set(id, rn)
        stats.videos.created++
        ops.push({
          assetOperation: {
            create: {
              resourceName: rn,
              name: `YouTube ${id}`,
              youtubeVideoAsset: { youtubeVideoId: id },
            },
          },
        })
      }
      if (ad.call_to_action && !ctaRn.has(ad.call_to_action)) {
        const existing = resolved.ctaAssets.get(ad.call_to_action)
        if (existing) {
          ctaRn.set(ad.call_to_action, existing)
          stats.callToActions.reused++
        } else {
          const rn = `customers/${cid}/assets/${nextId()}`
          ctaRn.set(ad.call_to_action, rn)
          stats.callToActions.created++
          ops.push({
            assetOperation: {
              create: {
                resourceName: rn,
                callToActionAsset: { callToAction: ad.call_to_action },
              },
            },
          })
        }
      }
    }
  }

  // --- ad groups (no type; channel controls; audience grouping when an audience is attached) ---
  const adGroupRns: string[] = []
  const adGroupIndexes: number[] = []
  for (const g of input.ad_groups) {
    const rn = `customers/${cid}/adGroups/${nextId()}`
    adGroupRns.push(rn)
    const ag: Record<string, unknown> = {
      resourceName: rn,
      campaign: campaignRn,
      name: g.name,
      status: "ENABLED",
      demandGenAdGroupSettings: {
        channelControls: channelControlsBody(g.channels ?? input.channels),
      },
    }
    if (g.audience_id) ag.audienceSetting = { useAudienceGrouped: true }
    if (g.optimized_targeting !== undefined)
      ag.optimizedTargetingEnabled = g.optimized_targeting
    adGroupIndexes.push(ops.length)
    ops.push({ adGroupOperation: { create: ag } })
  }

  // --- ad group criteria: locations (required), languages, audience ---
  input.ad_groups.forEach((g, i) => {
    const agRn = adGroupRns[i]!
    const locations = g.location_ids ?? input.location_ids ?? []
    // fail closed: a Demand Gen ad group without a location serves worldwide
    if (!locations.length)
      throw invalidRequest(
        "Ad group without location",
        `Nhóm “${g.name}” chưa có vị trí (location_ids).`
      )
    for (const id of new Set(locations)) {
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: agRn,
            location: {
              geoTargetConstant: `geoTargetConstants/${assertId(id, "location_id")}`,
            },
          },
        },
      })
    }
    for (const id of new Set(g.language_ids ?? input.language_ids ?? [])) {
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: agRn,
            language: {
              languageConstant: `languageConstants/${assertId(id, "language_id")}`,
            },
          },
        },
      })
    }
    if (g.audience_id)
      ops.push({
        adGroupCriterionOperation: {
          create: {
            adGroup: agRn,
            audience: { audience: audienceRn(g.audience_id, cid) },
          },
        },
      })
  })

  // --- ads ---
  input.ad_groups.forEach((g, i) => {
    const agRn = adGroupRns[i]!
    for (const ad of g.ads) {
      const logos = ad.logo_images.map((r) => ({
        asset: imageAssetRn(cid, r, "logo", resolved, warnings, warned),
      }))
      let body: Record<string, unknown>
      if (ad.type === "video") {
        const videos = ad.videos.map((v) => {
          const s = v.trim()
          if (ASSET_RN.test(s)) {
            const id = assetIdOf(s, cid, "Video")
            const info = resolved.assets.get(id)
            if (!info)
              throw invalidRequest(
                `Video asset ${id} not found`,
                `Không tìm thấy asset video ${id} trong tài khoản này.`,
                "Dùng link YouTube thay cho resource name."
              )
            if (info.type !== "YOUTUBE_VIDEO")
              throw invalidRequest(
                `Asset ${id} is ${info.type}`,
                `Asset ${id} không phải video YouTube (loại ${info.type ?? "không rõ"}).`
              )
            return { asset: `customers/${cid}/assets/${id}` }
          }
          return { asset: videoRn.get(parseYoutubeVideoId(s)!)! }
        })
        const dg: Record<string, unknown> = {
          videos,
          logoImages: logos,
          headlines: textAssets(ad.headlines),
          longHeadlines: textAssets(ad.long_headlines),
          descriptions: textAssets(ad.descriptions),
          businessName: { text: cleanText(ad.business_name) },
        }
        if (ad.call_to_action)
          dg.callToActions = [{ asset: ctaRn.get(ad.call_to_action)! }]
        body = { demandGenVideoResponsiveAd: dg }
      } else {
        const imgs = (refs: string[] | undefined, slot: DgImageSlot) =>
          (refs ?? []).map((r) => ({
            asset: imageAssetRn(cid, r, slot, resolved, warnings, warned),
          }))
        const dg: Record<string, unknown> = {}
        const marketing = imgs(ad.marketing_images, "marketing")
        const square = imgs(ad.square_marketing_images, "square")
        const portrait = imgs(ad.portrait_marketing_images, "portrait")
        const tall = imgs(ad.tall_portrait_marketing_images, "tall")
        if (!marketing.length && !square.length)
          throw invalidRequest(
            "No landscape/square image",
            "Quảng cáo ảnh cần ít nhất 1 ảnh ngang hoặc 1 ảnh vuông."
          )
        if (marketing.length) dg.marketingImages = marketing
        if (square.length) dg.squareMarketingImages = square
        if (portrait.length) dg.portraitMarketingImages = portrait
        if (tall.length) dg.tallPortraitMarketingImages = tall
        dg.logoImages = logos
        dg.headlines = textAssets(ad.headlines)
        dg.descriptions = textAssets(ad.descriptions)
        dg.businessName = cleanText(ad.business_name) // plain string in DemandGenMultiAssetAdInfo
        body = { demandGenMultiAssetAd: dg }
        if (
          !ad.headlines.some((h) => textWidth(h) <= 30) &&
          !warned.has(`h30:${i}`)
        ) {
          warned.add(`h30:${i}`)
          warnings.push(
            `Nhóm “${g.name}”: quảng cáo ảnh nên có ít nhất 1 tiêu đề ≤30 ký tự (để hiển thị trên Mạng Hiển thị và tránh trạng thái “Chưa đầy đủ”).`
          )
        }
      }
      const adBody: Record<string, unknown> = {
        finalUrls: [ad.final_url.trim()],
        ...body,
      }
      if (ad.name) adBody.name = ad.name
      ops.push({
        adGroupAdOperation: {
          create: { adGroup: agRn, status: "ENABLED", ad: adBody },
        },
      })
    }
  })

  if (input.start_date && input.start_date > addDays(o.today, 365))
    warnings.push("Ngày bắt đầu cách hơn 1 năm.")
  return {
    ops,
    campaignIndex,
    adGroupIndexes,
    warnings,
    ...stats,
    start,
    dailyEquivalent,
  }
}

// ---------------------------------------------------------------------------
// Reads before building
// ---------------------------------------------------------------------------

const optNum = (row: GoogleAdsRow, path: string): number | null => {
  const v = field(row, path)
  if (v === undefined || v === null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Read every referenced asset (images, video assets, YouTube ids, call-to-action types) in ≤3 GAQL queries. */
export async function resolveDemandGenAssets(
  ctx: GCtx,
  cid: string,
  input: CreateDemandGenCampaignInput
): Promise<DemandGenResolved> {
  const client = clientFor(ctx)
  const assetIds = new Set<string>()
  const youtubeIds = new Set<string>()
  const ctas = new Set<string>()
  for (const g of input.ad_groups) {
    for (const ad of g.ads) {
      for (const r of ad.logo_images) assetIds.add(assetIdOf(r, cid, "Logo"))
      if (ad.type === "video") {
        for (const v of ad.videos) {
          if (ASSET_RN.test(v.trim())) assetIds.add(assetIdOf(v, cid, "Video"))
          else {
            const id = parseYoutubeVideoId(v)
            if (id) youtubeIds.add(id)
          }
        }
        if (ad.call_to_action) ctas.add(ad.call_to_action)
      } else {
        for (const r of [
          ...(ad.marketing_images ?? []),
          ...(ad.square_marketing_images ?? []),
          ...(ad.portrait_marketing_images ?? []),
          ...(ad.tall_portrait_marketing_images ?? []),
        ]) {
          assetIds.add(assetIdOf(r, cid, "Ảnh"))
        }
      }
    }
  }
  const assets = new Map<string, DgAssetInfo>()
  if (assetIds.size) {
    const { rows } = await client.searchAll(
      cid,
      `SELECT asset.id, asset.resource_name, asset.type, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels, asset.image_asset.file_size FROM asset WHERE asset.id IN ${idList([...assetIds], "asset_id")}`,
      { maxRows: 5_000 }
    )
    for (const r of rows) {
      const id = str(r, "asset.id") ?? resourceId(str(r, "asset.resource_name"))
      if (!id) continue
      assets.set(id, {
        type: str(r, "asset.type"),
        width: optNum(r, "asset.image_asset.full_size.width_pixels"),
        height: optNum(r, "asset.image_asset.full_size.height_pixels"),
        fileSize: optNum(r, "asset.image_asset.file_size"),
      })
    }
  }
  const youtubeAssets = new Map<string, string>()
  if (youtubeIds.size) {
    const { rows } = await client.searchAll(
      cid,
      `SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id IN (${[...youtubeIds].map(gaqlString).join(", ")})`,
      { maxRows: 1_000 }
    )
    for (const r of rows) {
      const vid = str(r, "asset.youtube_video_asset.youtube_video_id")
      const rn = str(r, "asset.resource_name")
      if (vid && rn && !youtubeAssets.has(vid)) youtubeAssets.set(vid, rn)
    }
  }
  const ctaAssets = new Map<string, string>()
  if (ctas.size) {
    const { rows } = await client.searchAll(
      cid,
      `SELECT asset.resource_name, asset.call_to_action_asset.call_to_action FROM asset WHERE asset.type = 'CALL_TO_ACTION' AND asset.call_to_action_asset.call_to_action IN (${DG_CALL_TO_ACTIONS.filter((c) => ctas.has(c))
        .map((c) => `'${c}'`)
        .join(", ")})`,
      { maxRows: 1_000 }
    )
    for (const r of rows) {
      const cta = str(r, "asset.call_to_action_asset.call_to_action")
      const rn = str(r, "asset.resource_name")
      if (cta && rn && ctas.has(cta) && !ctaAssets.has(cta))
        ctaAssets.set(cta, rn)
    }
  }
  return { assets, youtubeAssets, ctaAssets }
}

async function campaignNameExists(
  ctx: GCtx,
  cid: string,
  name: string
): Promise<string | null> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT campaign.id FROM campaign WHERE campaign.name = ${gaqlString(name)} AND campaign.status != 'REMOVED'`,
    { maxRows: 1 }
  )
  return rows[0] ? str(rows[0], "campaign.id") : null
}

/** resourceName of one MutateOperationResponse ({campaignResult: {resourceName}}, …). */
function responseRn(resp: Record<string, unknown> | undefined): string | null {
  for (const v of Object.values(resp ?? {})) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { resourceName?: unknown }).resourceName === "string"
    )
      return (v as { resourceName: string }).resourceName
  }
  return null
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const BIDDING_VI: Record<
  CreateDemandGenCampaignInput["bidding_strategy"],
  string
> = {
  maximize_clicks: "Tối đa hóa lượt nhấp",
  maximize_conversions: "Tối đa hóa lượt chuyển đổi",
  maximize_conversion_value: "Tối đa hóa giá trị chuyển đổi",
  target_cpc: "CPC mục tiêu",
}

function created(
  objectId: string,
  objectName: string,
  after: unknown
): FieldChange {
  return {
    objectId,
    objectName,
    level: "campaign",
    field: "create",
    before: null,
    after,
  }
}

async function runCreateDemandGen(
  ctx: GCtx,
  input: CreateDemandGenCampaignInput,
  opts: MutationOptions
) {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const currency = ctx.account.currency
  const today = todayInTz(ctx.account.timezone)
  const existing = await campaignNameExists(ctx, cid, input.name)
  if (existing) {
    throw new ProviderError({
      platform: "google_ads",
      code: "conflict",
      message: `Campaign name exists: ${existing}`,
      userMessageVi: `Đã có chiến dịch tên “${input.name}” (id ${existing}). Tên chiến dịch phải duy nhất - hãy đặt tên khác.`,
    })
  }
  const resolved = await resolveDemandGenAssets(ctx, cid, input)
  await primeBillableUnit(client, cid, currency)
  const plan = buildDemandGenCampaignOps(cid, input, {
    currency,
    today,
    resolved,
  })

  const conversionBased =
    input.bidding_strategy === "maximize_conversions" ||
    input.bidding_strategy === "maximize_conversion_value"
  const hasVideo = input.ad_groups.some((g) =>
    g.ads.some((a) => a.type === "video")
  )
  const warnings = [
    ...plan.warnings,
    "Chiến dịch được tạo ở trạng thái TẠM DỪNG - dùng ads_set_status để bật khi đã kiểm tra.",
    currency.toUpperCase() === "USD" && plan.dailyEquivalent < 5
      ? `Ngân sách tương đương ${Math.round(plan.dailyEquivalent * 100) / 100} USD/ngày, thấp hơn mức tối thiểu 5 USD/ngày của Demand Gen - Google sẽ từ chối.`
      : "Demand Gen cần ngân sách tối thiểu tương đương 5 USD/ngày (quy đổi theo tiền tệ tài khoản); thấp hơn Google sẽ từ chối và báo mức tối thiểu.",
    ...(conversionBased
      ? [
          "Chiến lược theo chuyển đổi cần tài khoản đã thiết lập theo dõi chuyển đổi (conversion tracking), nếu không chiến dịch khó tối ưu.",
        ]
      : []),
    ...(input.target_cpa !== undefined &&
    plan.dailyEquivalent < input.target_cpa * 15
      ? [
          `Google khuyên ngân sách ngày ≥ 15 lần CPA mục tiêu (≥ ${new Intl.NumberFormat("vi-VN").format(input.target_cpa * 15)} ${currency}/ngày) để chiến dịch học nhanh.`,
        ]
      : []),
    ...(hasVideo
      ? [
          "Video phải ở chế độ Công khai hoặc Không công khai trên YouTube (video Riêng tư không chạy được quảng cáo).",
        ]
      : []),
    "Quảng cáo sẽ được Google xét duyệt trước khi phân phát.",
    ...(input.contains_eu_political_advertising
      ? [
          "Đã khai báo chiến dịch CÓ chứa quảng cáo chính trị EU - có thể bị hạn chế phân phát tại EU.",
        ]
      : []),
  ]
  const summary = {
    name: input.name,
    budget:
      input.total_budget !== undefined
        ? { type: "total", amount: input.total_budget }
        : { type: "daily", amount: input.daily_budget },
    currency,
    bidding_strategy: input.bidding_strategy,
    bidding_strategy_vi: BIDDING_VI[input.bidding_strategy],
    ...(input.max_cpc_bid_limit !== undefined
      ? { max_cpc_bid_limit: input.max_cpc_bid_limit }
      : {}),
    ...(input.target_cpa !== undefined ? { target_cpa: input.target_cpa } : {}),
    ...(input.target_roas !== undefined
      ? { target_roas: input.target_roas }
      : {}),
    ...(input.target_cpc !== undefined ? { target_cpc: input.target_cpc } : {}),
    start_date: plan.start,
    end_date: input.end_date ?? null,
    contains_eu_political_advertising: input.contains_eu_political_advertising,
    ad_groups: input.ad_groups.map((g) => ({
      name: g.name,
      channels: channelLabelVi(g.channels ?? input.channels),
      locations: new Set(g.location_ids ?? input.location_ids ?? []).size,
      languages: new Set(g.language_ids ?? input.language_ids ?? []).size,
      audience: g.audience_id ?? null,
      ...(g.optimized_targeting !== undefined
        ? { optimized_targeting: g.optimized_targeting }
        : {}),
      ads: {
        video: g.ads.filter((a) => a.type === "video").length,
        image: g.ads.filter((a) => a.type === "image").length,
      },
    })),
    youtube_videos: { reused: plan.videos.reused, new: plan.videos.created },
    operations: plan.ops.length,
  }
  if (opts.dryRun) {
    await client.googleAdsMutate(cid, plan.ops, { validateOnly: true })
    return {
      preview: true,
      changes: [created("(mới)", input.name, summary)],
      warnings,
      createdIds: [],
    } satisfies MutationResult
  }
  let res
  try {
    res = await client.googleAdsMutate(cid, plan.ops, { idempotent: false })
  } catch (e) {
    // Outcome unknown (timeout / 5xx): the atomic mutate either applied fully or not at all → look the campaign up by name.
    if (
      isProviderError(e) &&
      (e.code === "timeout" || e.code === "upstream_error")
    ) {
      const found = await campaignNameExists(ctx, cid, input.name).catch(
        () => null
      )
      if (found) {
        return {
          preview: false,
          changes: [created(found, input.name, summary)],
          warnings: [
            ...warnings,
            "Mất kết nối khi tạo nhưng chiến dịch đã có trên Google Ads - kiểm tra lại bằng ads_get_object, không tạo lại.",
          ],
          createdIds: [found],
          campaign_id: found,
        }
      }
    }
    throw e
  }
  const campaignId = resourceId(responseRn(res.results[plan.campaignIndex]))
  const adGroupIds = plan.adGroupIndexes.map((i) =>
    resourceId(responseRn(res.results[i]))
  )
  return {
    preview: false,
    changes: [created(campaignId ?? "?", input.name, summary)],
    warnings,
    createdIds: [campaignId, ...adGroupIds].filter((x): x is string => !!x),
    campaign_id: campaignId,
    ad_group_ids: adGroupIds,
  }
}

/** Money of google_ads_create_demand_gen_campaign for the MCP caps (MAJOR units). target_roas is a ratio, not money. */
export function demandGenCampaignMoney(
  input: CreateDemandGenCampaignInput
): ExtensionMoneyItem[] {
  const items: ExtensionMoneyItem[] = []
  if (input.daily_budget !== undefined)
    items.push({
      kind: "daily_budget",
      amount: input.daily_budget,
      field: "daily_budget",
    })
  if (input.total_budget !== undefined) {
    items.push({
      kind: "lifetime_budget",
      amount: input.total_budget,
      field: "total_budget",
      startTime: input.start_date ?? null,
      endTime: input.end_date ?? null,
    })
  }
  if (input.max_cpc_bid_limit !== undefined)
    items.push({
      kind: "bid",
      amount: input.max_cpc_bid_limit,
      field: "max_cpc_bid_limit",
    })
  if (input.target_cpa !== undefined)
    items.push({ kind: "bid", amount: input.target_cpa, field: "target_cpa" })
  if (input.target_cpc !== undefined)
    items.push({ kind: "bid", amount: input.target_cpc, field: "target_cpc" })
  return items
}

// ---------------------------------------------------------------------------

export const demandGenExtensions: ProviderExtension<GoogleAdsCredentials>[] = [
  {
    name: "google_ads_create_demand_gen_campaign",
    permission: "create",
    title: "Tạo chiến dịch Demand Gen (YouTube)",
    description:
      "Dùng khi cần tạo trọn bộ một chiến dịch Google Ads Demand Gen (vd quảng cáo video YouTube dẫn về landing page): ngân sách → chiến dịch → nhóm quảng cáo (vị trí, ngôn ngữ, kênh, đối tượng) → quảng cáo video hoặc quảng cáo ảnh, trong 1 lần ghi nguyên khối (lỗi thì không tạo gì). " +
      "Chiến dịch luôn được tạo ở trạng thái TẠM DỪNG. Kênh mặc định chỉ YouTube (In-feed, In-stream, Shorts); channels = all | google_owned | danh sách kênh. " +
      "Gọi trước: ads_list_accounts (account_id, tiền tệ); ads_lookup kind=locations (mỗi nhóm cần ≥1 vị trí) và kind=languages; ads_upload_media để tải logo / ảnh (trả về resource name asset Google; logo vuông 1:1 ≥128×128, ảnh ngang 1.91:1 ≥600×314, vuông ≥300×300, dọc 4:5 ≥480×600, dọc 9:16 ≥600×1067). " +
      "Video YouTube truyền link hoặc ID (không cần tải lên; video phải Công khai hoặc Không công khai). Google bắt buộc logo + tên doanh nghiệp (≤25 ký tự). " +
      "Quảng cáo video: 1–5 video, 1–5 tiêu đề ≤40, 1–5 tiêu đề dài ≤90, 1–5 mô tả ≤90, call_to_action tùy chọn. Quảng cáo ảnh: 1–5 tiêu đề ≤40, 1–5 mô tả ≤90, cần ảnh ngang hoặc vuông (tổng ≤20 ảnh). " +
      "Ngân sách: daily_budget hoặc total_budget (cần end_date, 3 ngày – 1 năm); tối thiểu khoảng 5 USD/ngày quy đổi. Giá thầu: maximize_clicks (tùy chọn max_cpc_bid_limit), maximize_conversions (tùy chọn target_cpa), maximize_conversion_value (tùy chọn target_roas), target_cpc (cần target_cpc). Tiền theo đơn vị chính của tiền tệ tài khoản.",
    input: createDemandGenCampaignInput,
    write: true,
    moneyOf: (input: CreateDemandGenCampaignInput) =>
      demandGenCampaignMoney(input),
    run: (ctx, input: CreateDemandGenCampaignInput, opts) =>
      runCreateDemandGen(ctx, input, opts),
  },
]
