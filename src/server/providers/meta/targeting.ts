// Targeting input schema (shared by meta_create_adset and meta_update_targeting) and the Graph payload builder.
// Always emits targeting_automation.advantage_audience explicitly (v23 default ON; v26 requires it for special
// ad categories) - meta.md §1, §5.
import { z } from "zod"

import { isEuCountry } from "./shared"

const digits = z.string().regex(/^\d{1,30}$/, "Id chỉ gồm chữ số.")

export const PUBLISHER_PLATFORMS = ["facebook", "instagram", "messenger", "audience_network"] as const

/** Placements removed by Meta (v24 Facebook Video Feeds, v26 Instagram Explore). [M] exact enum names */
const REMOVED_POSITIONS: Record<string, string> = {
  video_feeds: "Facebook Video Feeds đã bị Meta bỏ từ v24.",
  explore: "Instagram Explore Feed bị Meta bỏ từ v26 (áp dụng mọi version từ 2026-10-27).",
  explore_home: "Instagram Explore bị Meta bỏ từ v26 (áp dụng mọi version từ 2026-10-27).",
}

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
      .describe("Bỏ trống = Advantage+ placements (Meta tự chọn vị trí)"),
    facebook_positions: z.array(z.string().regex(/^[a-z_]+$/)).max(20).optional(),
    instagram_positions: z.array(z.string().regex(/^[a-z_]+$/)).max(20).optional(),
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
  for (const pos of [...(t.facebook_positions ?? []), ...(t.instagram_positions ?? [])]) {
    if (REMOVED_POSITIONS[pos]) p.push(`Vị trí "${pos}" không còn hỗ trợ: ${REMOVED_POSITIONS[pos]}`)
  }
  return p
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
    if (t.publisher_platforms.length) out.publisher_platforms = t.publisher_platforms
    else {
      // empty → Advantage+ placements: drop every manual placement key
      for (const k of ["publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions"]) {
        delete out[k]
      }
    }
  }
  if (t.facebook_positions !== undefined) out.facebook_positions = t.facebook_positions
  if (t.instagram_positions !== undefined) out.instagram_positions = t.instagram_positions
  if (t.device_platforms !== undefined) out.device_platforms = t.device_platforms

  const currentAuto = (out.targeting_automation as Record<string, unknown> | undefined) ?? {}
  const currentAdv = currentAuto.advantage_audience
  const adv = t.advantage_audience !== undefined ? (t.advantage_audience ? 1 : 0) : Number(currentAdv) === 1 ? 1 : 0
  out.targeting_automation = { ...currentAuto, advantage_audience: adv }
  if (!out.age_min && !base) out.age_min = 18
  return out
}
