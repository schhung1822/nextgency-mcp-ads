// Targeting input schema (shared by meta_create_adset and meta_update_targeting) and the Graph payload builder.
// Always emits targeting_automation.advantage_audience explicitly (v23 default ON; v26 requires it for special
// ad categories) - meta.md §1, §5.
import { z } from "zod"

import { isEuCountry } from "./shared"

const digits = z.string().regex(/^\d{1,30}$/, "Id chỉ gồm chữ số.")

export const PUBLISHER_PLATFORMS = ["facebook", "instagram", "messenger", "audience_network"] as const

/**
 * Placements Meta still accepts (placement-targeting reference, read 2026-10-16, meta.md §5 "Vị trí hiển thị" [H]),
 * minus the ones the changelogs removed: Facebook `video_feeds` (v24), Instagram `explore` / `explore_home` (v26
 * changelog "applies to v26.0+" - the version this adapter pins; which enum value "Explore Feed" is = [L], both
 * treated as removed).
 */
export const FACEBOOK_POSITIONS = [
  "feed",
  "right_hand_column",
  "marketplace",
  "story",
  "search",
  "instream_video",
  "facebook_reels",
  "facebook_reels_overlay",
  "profile_feed",
  "notification",
] as const
export const INSTAGRAM_POSITIONS = ["stream", "story", "reels", "profile_feed", "ig_search", "profile_reels"] as const

/** Placements removed by Meta, keyed by targeting field: still found in the targeting of older ad sets. */
const REMOVED_POSITIONS: Record<string, Record<string, string>> = {
  facebook_positions: { video_feeds: "Facebook Video Feeds (Meta bỏ từ v24, thay bằng facebook_reels)" },
  instagram_positions: {
    explore: "Instagram Explore (Meta bỏ từ API v26)",
    explore_home: "Instagram Explore home (Meta bỏ từ API v26)",
  },
  messenger_positions: { story: "Messenger Stories (Meta bỏ từ API v26, mọi version từ cuối 8/2026 - tự gỡ khỏi vị trí)" },
}

/** Facebook positions that need `feed` next to them (placement-targeting reference [H]). */
const NEEDS_FACEBOOK_FEED = ["marketplace", "search", "profile_feed", "notification"]

export const targetingInput = z
  .object({
    countries: z
      .array(z.string().regex(/^[A-Za-z]{2}$/, "Mã quốc gia 2 chữ cái (ISO 3166-1), vd VN."))
      .max(250)
      .optional()
      .describe("Mã quốc gia ISO-2, vd [\"VN\"]"),
    regions: z.array(z.object({ key: digits })).max(200).optional().describe("Tỉnh/thành: key lấy từ ads_lookup locations"),
    cities: z
      .array(
        z.object({
          key: digits,
          radius: z.number().int().min(10).max(80).optional(),
          distance_unit: z.enum(["kilometer", "mile"]).optional(),
        })
      )
      .max(250)
      .optional()
      .describe("Thành phố: key lấy từ ads_lookup locations"),
    age_min: z.number().int().min(13).max(65).optional(),
    age_max: z.number().int().min(13).max(65).optional(),
    genders: z.array(z.enum(["male", "female"])).max(2).optional().describe("Bỏ trống = mọi giới tính"),
    interests: z
      .array(z.object({ id: digits, name: z.string().max(200).optional() }))
      .max(200)
      .optional()
      .describe("Sở thích: id lấy từ ads_lookup interests"),
    custom_audiences: z.array(digits).max(100).optional().describe("Id đối tượng tuỳ chỉnh để nhắm tới"),
    excluded_custom_audiences: z.array(digits).max(100).optional().describe("Id đối tượng tuỳ chỉnh để loại trừ"),
    locales: z.array(z.number().int()).max(50).optional().describe("Ngôn ngữ: key lấy từ ads_lookup languages"),
    publisher_platforms: z
      .array(z.enum(PUBLISHER_PLATFORMS))
      .max(4)
      .optional()
      .describe(
        "Bỏ trống = Advantage+ placements (Meta tự chọn vị trí). messenger / audience_network: Meta tự chọn mọi vị trí của nền tảng đó; không chạy riêng audience_network."
      ),
    facebook_positions: z
      .array(z.enum(FACEBOOK_POSITIONS))
      .max(20)
      .optional()
      .describe(
        "Vị trí Facebook (cần publisher_platforms có facebook; [] = mọi vị trí Facebook). Luật của Meta: story phải kèm feed (hoặc instagram story) và device_platforms chỉ có mobile; marketplace/search/profile_feed/notification phải kèm feed. video_feeds đã bị Meta bỏ."
      ),
    instagram_positions: z
      .array(z.enum(INSTAGRAM_POSITIONS))
      .max(20)
      .optional()
      .describe(
        "Vị trí Instagram (cần publisher_platforms có instagram; [] = mọi vị trí Instagram). ig_search phải kèm stream. explore/explore_home đã bị Meta bỏ (v26)."
      ),
    device_platforms: z.array(z.enum(["mobile", "desktop"])).max(2).optional(),
    advantage_audience: z
      .boolean()
      .optional()
      .describe("Bật Advantage+ audience (Meta mở rộng đối tượng ngoài nhắm mục tiêu). Mặc định false khi tạo mới."),
  })
  .strict()

export type TargetingInput = z.infer<typeof targetingInput>

export function targetingProblems(t: TargetingInput): string[] {
  const p: string[] = []
  if (t.age_min !== undefined && t.age_max !== undefined && t.age_min > t.age_max) p.push("age_min phải ≤ age_max.")
  return p
}

const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null)

const PLATFORM_OF: Record<string, string> = {
  facebook_positions: "facebook",
  instagram_positions: "instagram",
  messenger_positions: "messenger",
  audience_network_positions: "audience_network",
}

/**
 * Placement rules of Meta (placement-targeting reference + Instagram ads guide, meta.md §5 "Vị trí hiển thị" [H]),
 * checked on the targeting that will really be SENT (create payload, or the merged targeting of an update - the
 * current placements of the ad set count too). Mutates `t`: placements Meta removed that are still in the current
 * targeting (video_feeds, explore, explore_home, Messenger story) are dropped with a warning - sending them back
 * would fail the whole update. Returns the errors (refuse before any POST) and the warnings.
 */
export function placementProblems(t: Record<string, unknown>): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [field, removed] of Object.entries(REMOVED_POSITIONS)) {
    const list = strList(t[field])
    if (!list) continue
    const gone = list.filter((p) => removed[p])
    if (!gone.length) continue
    const kept = list.filter((p) => !removed[p])
    warnings.push(`Đã bỏ vị trí Meta không còn hỗ trợ khỏi ${field}: ${gone.map((p) => removed[p]).join("; ")}.`)
    if (kept.length) t[field] = kept
    else if (field === "messenger_positions") delete t[field]
    else {
      errors.push(
        `Nhóm quảng cáo chỉ còn vị trí Meta đã bỏ trong ${field} (${gone.join(", ")}) - hãy truyền ${field} mới (hoặc publisher_platforms: [] để Meta tự chọn vị trí).`
      )
    }
  }
  const platforms = strList(t.publisher_platforms) ?? []
  const fb = strList(t.facebook_positions) ?? []
  const ig = strList(t.instagram_positions) ?? []
  const devices = strList(t.device_platforms)
  for (const [field, platform] of Object.entries(PLATFORM_OF)) {
    const list = strList(t[field])
    if (list?.length && !platforms.includes(platform)) {
      const now = platforms.length ? platforms.join(", ") : "trống = Meta tự chọn"
      errors.push(`${field} chỉ dùng được khi publisher_platforms có "${platform}" (hiện: ${now}).`)
    }
  }
  if (platforms.length === 1 && platforms[0] === "audience_network") {
    errors.push("Meta không cho chạy riêng Audience Network - thêm facebook hoặc instagram vào publisher_platforms.")
  }
  if (fb.includes("story")) {
    if (!fb.includes("feed") && !(ig.includes("story") && platforms.includes("instagram"))) {
      errors.push(
        "Vị trí Tin Facebook (story) không chọn riêng được - thêm feed vào facebook_positions (hoặc story vào instagram_positions)."
      )
    }
    // [H] "If you select `story`, you must use Facebook `feed` or Instagram `story` and `device_platforms: mobile`
    // because Facebook Stories is mobile-only" - never changed silently: the AI sets it (or it is already mobile-only)
    if (!(devices?.length === 1 && devices[0] === "mobile")) {
      errors.push(
        `Tin Facebook (story) chỉ chạy trên mobile - Meta yêu cầu device_platforms: ["mobile"] (hiện: ${devices?.length ? devices.join(", ") : "không đặt = mọi thiết bị"}). Thêm device_platforms: ["mobile"] vào targeting, hoặc bỏ story.`
      )
    }
  }
  const needFeed = fb.filter((p) => NEEDS_FACEBOOK_FEED.includes(p))
  if (needFeed.length && !fb.includes("feed")) {
    errors.push(`Vị trí Facebook ${needFeed.join(", ")} phải chọn kèm feed - thêm feed vào facebook_positions.`)
  }
  if (ig.includes("ig_search") && !ig.includes("stream")) {
    errors.push("Vị trí kết quả tìm kiếm Instagram (ig_search) phải chọn kèm stream - thêm stream vào instagram_positions.")
  }
  if (fb.includes("instream_video") && !fb.includes("feed")) {
    warnings.push(
      "instream_video không kèm feed chỉ được Meta nhận ở một số nước (US, GB, FR, ES, DE, MX, IN, TH) với mục tiêu xem video / tương tác - không dùng cho chuyển đổi."
    )
  }
  if (fb.length === 1 && fb[0] === "right_hand_column" && !ig.length) {
    warnings.push("Chỉ chọn cột bên phải (right_hand_column): Meta không nhận quảng cáo video, bộ sưu tập hoặc canvas ở vị trí này.")
  }
  return { errors, warnings }
}

export function hasGeo(t: TargetingInput): boolean {
  return !!(t.countries?.length || t.regions?.length || t.cities?.length)
}

export function euCountriesIn(t: { countries?: string[] } | Record<string, unknown>): string[] {
  const countries = (t as { countries?: unknown }).countries
  return Array.isArray(countries) ? countries.map(String).filter(isEuCountry).map((c) => c.toUpperCase()) : []
}

/**
 * Build the Graph `targeting` object. With `base` (merge mode) only the provided keys replace the current ones.
 * targeting_automation.advantage_audience is always present.
 */
export function buildTargeting(t: TargetingInput, base?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = base ? structuredClone(base) : {}
  if (hasGeo(t)) {
    const geo: Record<string, unknown> = {}
    if (t.countries?.length) geo.countries = t.countries.map((c) => c.toUpperCase())
    if (t.regions?.length) geo.regions = t.regions.map((r) => ({ key: r.key }))
    if (t.cities?.length) {
      geo.cities = t.cities.map((c) => ({
        key: c.key,
        ...(c.radius ? { radius: c.radius, distance_unit: c.distance_unit ?? "kilometer" } : {}),
      }))
    }
    out.geo_locations = geo
  }
  if (t.age_min !== undefined) out.age_min = t.age_min
  if (t.age_max !== undefined) out.age_max = t.age_max
  if (t.genders !== undefined) {
    if (t.genders.length === 0 || t.genders.length === 2) delete out.genders
    else out.genders = t.genders.map((g) => (g === "male" ? 1 : 2))
  }
  if (t.interests !== undefined) {
    if (t.interests.length) {
      out.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }]
    } else delete out.flexible_spec
  }
  if (t.custom_audiences !== undefined) out.custom_audiences = t.custom_audiences.map((id) => ({ id }))
  if (t.excluded_custom_audiences !== undefined) {
    out.excluded_custom_audiences = t.excluded_custom_audiences.map((id) => ({ id }))
  }
  if (t.locales !== undefined) out.locales = t.locales
  if (t.publisher_platforms !== undefined) {
    if (t.publisher_platforms.length) {
      out.publisher_platforms = t.publisher_platforms
      // merge: positions of a platform no longer chosen go with it (unless given explicitly - then placementProblems
      // reports the conflict)
      for (const [k, platform] of Object.entries(PLATFORM_OF)) {
        if (!t.publisher_platforms.includes(platform as (typeof PUBLISHER_PLATFORMS)[number]) && !(k in t)) delete out[k]
      }
    } else {
      // empty → Advantage+ placements: drop every manual placement key
      for (const k of ["publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions"]) {
        delete out[k]
      }
    }
  }
  // [] = no manual choice: every position of that platform
  if (t.facebook_positions !== undefined) {
    if (t.facebook_positions.length) out.facebook_positions = t.facebook_positions
    else delete out.facebook_positions
  }
  if (t.instagram_positions !== undefined) {
    if (t.instagram_positions.length) out.instagram_positions = t.instagram_positions
    else delete out.instagram_positions
  }
  if (t.device_platforms !== undefined) out.device_platforms = t.device_platforms

  const currentAuto = (out.targeting_automation as Record<string, unknown> | undefined) ?? {}
  const currentAdv = currentAuto.advantage_audience
  const adv = t.advantage_audience !== undefined ? (t.advantage_audience ? 1 : 0) : Number(currentAdv) === 1 ? 1 : 0
  out.targeting_automation = { ...currentAuto, advantage_audience: adv }
  if (!out.age_min && !base) out.age_min = 18
  return out
}
