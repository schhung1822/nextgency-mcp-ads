// Google Ads campaign targeting: geo target type (PRESENCE vs PRESENCE_OR_INTEREST), proximity (radius) targeting and
// ad schedule. Shared schemas are reused by google_ads_create_search_campaign (extensions.ts).
// Criteria (location / proximity / ad schedule) are immutable → a change is remove + create in ONE atomic
// googleAds:mutate. https://developers.google.com/google-ads/api/reference/rpc/v25/CampaignCriterion
import { z } from "zod"
import { isProviderError, withErrorAudit } from "../errors"
import type {
  FieldChange,
  MutationOptions,
  MutationResult,
  ProviderExtension,
} from "../types"
import { field, resourceId, str, type GoogleAdsRow } from "./client"
import {
  clientFor,
  customerIdOf,
  invalidRequest,
  notFound,
  type GCtx,
} from "./context"
import type { GoogleAdsCredentials } from "./credentials"
import { assertId, idList } from "./gaql"
import { safeText } from "./text"
import { assertNotVideo } from "./youtube"

// ---------------------------------------------------------------------------
// Shared schemas + helpers
// ---------------------------------------------------------------------------

const idStr = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Id chỉ gồm chữ số.")

/** SEARCH_INTEREST is blocked by Google for Search/Shopping/Display since 2023 → not exposed. */
export const GEO_TARGET_TYPES = ["PRESENCE", "PRESENCE_OR_INTEREST"] as const
export type GeoTargetType = (typeof GEO_TARGET_TYPES)[number]
export const geoTargetTypeSchema = z.enum(GEO_TARGET_TYPES)

export const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const
export type DayOfWeek = (typeof DAYS)[number]
export const DAY_VI: Record<DayOfWeek, string> = {
  MONDAY: "Thứ 2",
  TUESDAY: "Thứ 3",
  WEDNESDAY: "Thứ 4",
  THURSDAY: "Thứ 5",
  FRIDAY: "Thứ 6",
  SATURDAY: "Thứ 7",
  SUNDAY: "Chủ nhật",
}

const MINUTES = [0, 15, 30, 45] as const
const MINUTE_ENUM: Record<number, string> = {
  0: "ZERO",
  15: "FIFTEEN",
  30: "THIRTY",
  45: "FORTY_FIVE",
}
const MINUTE_FROM_ENUM: Record<string, number> = {
  ZERO: 0,
  FIFTEEN: 15,
  THIRTY: 30,
  FORTY_FIVE: 45,
}

/** Our own radius caps (Google: min 1 km; max unverified). */
export const RADIUS_LIMITS = {
  KILOMETERS: { min: 1, max: 800 },
  MILES: { min: 0.7, max: 500 },
} as const
export const MAX_PROXIMITIES_PER_REQUEST = 100
export const MAX_AD_SCHEDULES = 42
export const MAX_SCHEDULES_PER_DAY = 6
export const MAX_CAMPAIGN_LOCATIONS = 10_000
export const MAX_CAMPAIGN_PROXIMITIES = 500

const minuteSchema = z
  .number()
  .int()
  .refine(
    (m) => (MINUTES as readonly number[]).includes(m),
    "Phút chỉ nhận 0, 15, 30 hoặc 45."
  )

export const proximitySchema = z
  .object({
    latitude: z
      .number()
      .finite()
      .min(-90, "Vĩ độ (latitude) phải từ -90 đến 90.")
      .max(90, "Vĩ độ (latitude) phải từ -90 đến 90."),
    longitude: z
      .number()
      .finite()
      .min(-180, "Kinh độ (longitude) phải từ -180 đến 180.")
      .max(180, "Kinh độ (longitude) phải từ -180 đến 180."),
    radius: z
      .number()
      .finite()
      .positive("Bán kính phải lớn hơn 0.")
      .refine(
        (r) => /^\d+(\.\d{1,2})?$/.test(String(r)),
        "Bán kính tối đa 2 chữ số thập phân."
      ),
    radius_unit: z.enum(["KILOMETERS", "MILES"]).default("KILOMETERS"),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80, "Nhãn địa chỉ tối đa 80 ký tự.")
      .optional()
      .describe(
        "Nhãn để đọc (vd tên cửa hàng) - chỉ hiển thị trong kết quả, không gửi lên Google"
      ),
  })
  .superRefine((p, ctx) => {
    const lim = RADIUS_LIMITS[p.radius_unit]
    if (p.radius < lim.min || p.radius > lim.max) {
      ctx.addIssue({
        code: "custom",
        path: ["radius"],
        message: `Bán kính phải từ ${lim.min} đến ${lim.max} ${p.radius_unit === "KILOMETERS" ? "km" : "dặm"}.`,
      })
    }
  })
export type ProximityInput = z.infer<typeof proximitySchema>

export const proximitiesSchema = z
  .array(proximitySchema)
  .max(
    MAX_PROXIMITIES_PER_REQUEST,
    `Tối đa ${MAX_PROXIMITIES_PER_REQUEST} bán kính mỗi lần.`
  )
  .superRefine((list, ctx) => {
    const seen = new Set<string>()
    list.forEach((p, i) => {
      const k = proximityKey(proximityPoint(p))
      if (seen.has(k))
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: `Bán kính thứ ${i + 1} bị trùng (cùng tọa độ và bán kính).`,
        })
      seen.add(k)
    })
  })

export const adScheduleSchema = z
  .object({
    day_of_week: z.enum(DAYS),
    start_hour: z
      .number()
      .int()
      .min(0, "start_hour từ 0 đến 23.")
      .max(23, "start_hour từ 0 đến 23."),
    start_minute: minuteSchema.default(0),
    end_hour: z
      .number()
      .int()
      .min(0, "end_hour từ 0 đến 24.")
      .max(24, "end_hour từ 0 đến 24."),
    end_minute: minuteSchema.default(0),
  })
  .superRefine((s, ctx) => {
    for (const msg of scheduleItemProblems(s))
      ctx.addIssue({ code: "custom", path: ["end_hour"], message: msg })
  })
export type AdScheduleInput = z.infer<typeof adScheduleSchema>

export interface AdSchedule {
  day_of_week: DayOfWeek
  start_hour: number
  start_minute: number
  end_hour: number
  end_minute: number
}

const pad2 = (n: number) => String(n).padStart(2, "0")
const startOf = (s: AdSchedule) => s.start_hour * 60 + s.start_minute
const endOf = (s: AdSchedule) => s.end_hour * 60 + s.end_minute

function scheduleItemProblems(s: AdSchedule): string[] {
  const out: string[] = []
  const day = DAY_VI[s.day_of_week] ?? s.day_of_week
  if (s.end_hour === 24 && s.end_minute !== 0)
    out.push(`${day}: giờ kết thúc 24 chỉ đi với phút 0 (24:00 = hết ngày).`)
  else if (endOf(s) <= startOf(s)) {
    out.push(
      `${day}: giờ kết thúc (${pad2(s.end_hour)}:${pad2(s.end_minute)}) phải sau giờ bắt đầu (${pad2(s.start_hour)}:${pad2(s.start_minute)}). Khung qua nửa đêm phải tách thành 2 ngày.`
    )
  }
  return out
}

/** List-level checks (Google: ≤6 windows per day, no overlap, end exclusive). Returns Vietnamese problems. */
export function validateAdSchedules(list: AdSchedule[]): string[] {
  const out: string[] = []
  if (list.length > MAX_AD_SCHEDULES)
    out.push(`Tối đa ${MAX_AD_SCHEDULES} khung giờ cho một chiến dịch.`)
  for (const s of list) out.push(...scheduleItemProblems(s))
  for (const day of DAYS) {
    const items = list
      .filter((s) => s.day_of_week === day)
      .sort((a, b) => startOf(a) - startOf(b))
    if (items.length > MAX_SCHEDULES_PER_DAY)
      out.push(
        `${DAY_VI[day]}: tối đa ${MAX_SCHEDULES_PER_DAY} khung giờ mỗi ngày (đang có ${items.length}).`
      )
    for (let i = 1; i < items.length; i++) {
      if (startOf(items[i]!) < endOf(items[i - 1]!)) {
        out.push(
          `${DAY_VI[day]}: khung ${timeRange(items[i - 1]!)} và ${timeRange(items[i]!)} chồng lên nhau.`
        )
      }
    }
  }
  return out
}

export const adSchedulesSchema = z
  .array(adScheduleSchema)
  .max(
    MAX_AD_SCHEDULES,
    `Tối đa ${MAX_AD_SCHEDULES} khung giờ cho một chiến dịch.`
  )
  .superRefine((list, ctx) => {
    // item-level problems are already reported by adScheduleSchema
    const items = new Set(list.flatMap((s) => scheduleItemProblems(s)))
    for (const msg of validateAdSchedules(list))
      if (!items.has(msg)) ctx.addIssue({ code: "custom", message: msg })
  })

function timeRange(s: AdSchedule): string {
  return `${pad2(s.start_hour)}:${pad2(s.start_minute)}–${pad2(s.end_hour)}:${pad2(s.end_minute)}`
}

/** "Thứ 2 08:00–12:00" */
export function scheduleText(s: AdSchedule): string {
  return `${DAY_VI[s.day_of_week] ?? s.day_of_week} ${timeRange(s)}`
}

export function scheduleKey(s: AdSchedule): string {
  return `${s.day_of_week}|${startOf(s)}|${endOf(s)}`
}

const dayIndex = (d: string) => {
  const i = (DAYS as readonly string[]).indexOf(d)
  return i < 0 ? 99 : i
}
export function sortSchedules<T extends AdSchedule>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      dayIndex(a.day_of_week) - dayIndex(b.day_of_week) ||
      startOf(a) - startOf(b)
  )
}

export const ALL_DAY_VI = "Cả ngày, mọi ngày"

/** Readable schedule list (Monday → Sunday); no window = runs all day every day. */
export function schedulesText(list: AdSchedule[]): string[] | string {
  return list.length ? sortSchedules(list).map(scheduleText) : ALL_DAY_VI
}

/** campaignCriterion.adSchedule body. */
export function adScheduleBody(s: AdSchedule): Record<string, unknown> {
  return {
    dayOfWeek: s.day_of_week,
    startHour: s.start_hour,
    startMinute: MINUTE_ENUM[s.start_minute] ?? "ZERO",
    endHour: s.end_hour,
    endMinute: MINUTE_ENUM[s.end_minute] ?? "ZERO",
  }
}

/** Degrees → integer micro-degrees from the decimal representation (no float noise: 21.0285 → 21028500). */
export function toMicroDegrees(x: number): number {
  if (!Number.isFinite(x))
    throw invalidRequest("Invalid coordinate", "Tọa độ không hợp lệ.")
  const s = String(x)
  if (/e/i.test(s)) return Math.round(x * 1e6) || 0
  const neg = s.startsWith("-")
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".")
  const f = (frac + "0000000").slice(0, 7)
  let v = Number(int) * 1_000_000 + Number(f.slice(0, 6))
  if (Number(f[6]) >= 5) v += 1 // half away from zero
  return neg && v !== 0 ? -v : v
}

/** Integer micro-degrees → decimal string ("21.0285"). */
export function microToDegreesText(n: number): string {
  const abs = Math.abs(Math.trunc(n))
  const frac = String(abs % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 1_000_000)}${frac ? `.${frac}` : ""}`
}

export interface ProximityPoint {
  latMicro: number
  lngMicro: number
  radius: number
  unit: "KILOMETERS" | "MILES"
  label?: string | null
}

export function proximityPoint(p: ProximityInput): ProximityPoint {
  return {
    latMicro: toMicroDegrees(p.latitude),
    lngMicro: toMicroDegrees(p.longitude),
    radius: p.radius,
    unit: p.radius_unit,
    label: safeText(p.label),
  }
}

export function proximityKey(p: ProximityPoint): string {
  return `${p.latMicro}|${p.lngMicro}|${Number(p.radius)}|${p.unit}`
}

/** campaignCriterion.proximity body: geo point (integers) + radius. No address is sent (the label stays local). */
export function proximityBody(p: ProximityPoint): Record<string, unknown> {
  return {
    geoPoint: {
      latitudeInMicroDegrees: p.latMicro,
      longitudeInMicroDegrees: p.lngMicro,
    },
    radius: p.radius,
    radiusUnits: p.unit,
  }
}

/** "Bán kính 5 km quanh 21.0285, 105.8542" */
export function proximityText(p: ProximityPoint): string {
  const unit = p.unit === "MILES" ? "dặm" : "km"
  const label = p.label ? ` (${p.label})` : ""
  return `Bán kính ${p.radius} ${unit} quanh ${microToDegreesText(p.latMicro)}, ${microToDegreesText(p.lngMicro)}${label}`
}

const SMART_BIDDING = new Set([
  "TARGET_CPA",
  "TARGET_ROAS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
])

// ---------------------------------------------------------------------------
// Reading campaign + criteria
// ---------------------------------------------------------------------------

type CritType = "LOCATION" | "PROXIMITY" | "AD_SCHEDULE"

interface Criterion {
  criterionId: string
  type: CritType
  negative: boolean
  bidModifier: number | null
  locationId?: string
  proximity?: ProximityPoint & { address: Record<string, string> | null }
  schedule?: AdSchedule
}

const CRITERION_FIELDS = [
  "campaign_criterion.criterion_id",
  "campaign_criterion.type",
  "campaign_criterion.negative",
  "campaign_criterion.bid_modifier",
  "campaign_criterion.location.geo_target_constant",
  "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees",
  "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees",
  "campaign_criterion.proximity.radius",
  "campaign_criterion.proximity.radius_units",
  "campaign_criterion.proximity.address.city_name",
  "campaign_criterion.proximity.address.province_name",
  "campaign_criterion.proximity.address.country_code",
  "campaign_criterion.proximity.address.postal_code",
  "campaign_criterion.ad_schedule.day_of_week",
  "campaign_criterion.ad_schedule.start_hour",
  "campaign_criterion.ad_schedule.start_minute",
  "campaign_criterion.ad_schedule.end_hour",
  "campaign_criterion.ad_schedule.end_minute",
]

const num = (v: unknown, dflt: number): number => {
  const n = Number(v)
  return v === undefined || v === null || v === "" || !Number.isFinite(n)
    ? dflt
    : n
}

async function loadCampaign(
  ctx: GCtx,
  cid: string,
  campaignId: string
): Promise<GoogleAdsRow> {
  const { rows } = await clientFor(ctx).searchAll(
    cid,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, ` +
      `campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type ` +
      `FROM campaign WHERE campaign.id = ${campaignId}`,
    { maxRows: 1 }
  )
  const row = rows[0]
  if (!row || str(row, "campaign.status") === "REMOVED")
    throw notFound("chiến dịch", campaignId)
  return row
}

async function readCriteria(
  ctx: GCtx,
  cid: string,
  campaignId: string
): Promise<Criterion[]> {
  const { rows, truncated } = await clientFor(ctx).searchAll(
    cid,
    `SELECT ${CRITERION_FIELDS.join(", ")} FROM campaign_criterion WHERE campaign.id = ${campaignId} ` +
      `AND campaign_criterion.status != 'REMOVED' AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'AD_SCHEDULE')`,
    { maxRows: 20_000 }
  )
  if (truncated)
    throw invalidRequest(
      "Too many criteria",
      "Chiến dịch có quá nhiều tiêu chí nhắm mục tiêu để đọc hết - hãy chỉnh trong giao diện Google Ads."
    )
  const out: Criterion[] = []
  for (const r of rows) {
    const type = str(r, "campaign_criterion.type") as CritType | null
    const criterionId = str(r, "campaign_criterion.criterion_id")
    if (
      !criterionId ||
      (type !== "LOCATION" && type !== "PROXIMITY" && type !== "AD_SCHEDULE")
    )
      continue
    const bm = field(r, "campaign_criterion.bid_modifier")
    const c: Criterion = {
      criterionId,
      type,
      negative: field(r, "campaign_criterion.negative") === true,
      bidModifier: bm === undefined || bm === null ? null : Number(bm),
    }
    if (type === "LOCATION") {
      c.locationId =
        resourceId(str(r, "campaign_criterion.location.geo_target_constant")) ??
        criterionId
    } else if (type === "PROXIMITY") {
      const address: Record<string, string> = {}
      for (const [k, f] of [
        ["city", "city_name"],
        ["province", "province_name"],
        ["country", "country_code"],
        ["postal_code", "postal_code"],
      ] as const) {
        const v = safeText(field(r, `campaign_criterion.proximity.address.${f}`))
        if (v) address[k] = v
      }
      c.proximity = {
        latMicro: num(
          field(
            r,
            "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees"
          ),
          0
        ),
        lngMicro: num(
          field(
            r,
            "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees"
          ),
          0
        ),
        radius: num(field(r, "campaign_criterion.proximity.radius"), 0),
        unit:
          str(r, "campaign_criterion.proximity.radius_units") === "MILES"
            ? "MILES"
            : "KILOMETERS",
        address: Object.keys(address).length ? address : null,
      }
    } else {
      // Google omits zero values (start_hour 0)
      c.schedule = {
        day_of_week: (str(r, "campaign_criterion.ad_schedule.day_of_week") ??
          "MONDAY") as DayOfWeek,
        start_hour: num(
          field(r, "campaign_criterion.ad_schedule.start_hour"),
          0
        ),
        start_minute:
          MINUTE_FROM_ENUM[
            str(r, "campaign_criterion.ad_schedule.start_minute") ?? "ZERO"
          ] ?? 0,
        end_hour: num(field(r, "campaign_criterion.ad_schedule.end_hour"), 24),
        end_minute:
          MINUTE_FROM_ENUM[
            str(r, "campaign_criterion.ad_schedule.end_minute") ?? "ZERO"
          ] ?? 0,
      }
    }
    out.push(c)
  }
  return out
}

interface GeoInfo {
  name: string | null
  canonical_name: string | null
  target_type: string | null
}

async function geoNames(
  ctx: GCtx,
  cid: string,
  ids: string[]
): Promise<Map<string, GeoInfo>> {
  const out = new Map<string, GeoInfo>()
  const uniq = [...new Set(ids)]
  for (let i = 0; i < uniq.length; i += 1_000) {
    const chunk = uniq.slice(i, i + 1_000)
    const { rows } = await clientFor(ctx).searchAll(
      cid,
      `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type ` +
        `FROM geo_target_constant WHERE geo_target_constant.id IN ${idList(chunk, "location_id")}`,
      { maxRows: chunk.length }
    )
    for (const r of rows) {
      const id = str(r, "geo_target_constant.id")
      if (id) {
        out.set(id, {
          name: safeText(field(r, "geo_target_constant.name")),
          canonical_name: safeText(
            field(r, "geo_target_constant.canonical_name")
          ),
          target_type: safeText(field(r, "geo_target_constant.target_type")),
        })
      }
    }
  }
  return out
}

const TARGETING_NOTE =
  "Giờ trong lịch quảng cáo theo múi giờ tài khoản. Không có vị trí / bán kính nào = chiến dịch hiển thị ở mọi quốc gia. Không có lịch = chạy cả ngày, mọi ngày."

/** Snapshot of the campaign targeting (output of google_ads_get_campaign_targeting). */
async function readTargeting(
  ctx: GCtx,
  cid: string,
  campaignId: string,
  row?: GoogleAdsRow
) {
  const camp = row ?? (await loadCampaign(ctx, cid, campaignId))
  const crits = await readCriteria(ctx, cid, campaignId)
  const locIds = crits
    .filter((c) => c.type === "LOCATION")
    .map((c) => c.locationId!)
  const names = locIds.length
    ? await geoNames(ctx, cid, locIds)
    : new Map<string, GeoInfo>()
  return {
    campaign_id: campaignId,
    campaign_name: safeText(field(camp, "campaign.name")),
    channel_type: str(camp, "campaign.advertising_channel_type"),
    status: str(camp, "campaign.status"),
    timezone: ctx.account.timezone,
    positive_geo_target_type: str(
      camp,
      "campaign.geo_target_type_setting.positive_geo_target_type"
    ),
    negative_geo_target_type: str(
      camp,
      "campaign.geo_target_type_setting.negative_geo_target_type"
    ),
    locations: crits
      .filter((c) => c.type === "LOCATION")
      .map((c) => {
        const g = names.get(c.locationId!)
        return {
          criterion_id: c.criterionId,
          location_id: c.locationId!,
          name: g?.name ?? null,
          canonical_name: g?.canonical_name ?? null,
          target_type: g?.target_type ?? null,
          negative: c.negative,
          bid_modifier: c.bidModifier,
        }
      }),
    proximities: crits
      .filter((c) => c.type === "PROXIMITY")
      .map((c) => ({
        criterion_id: c.criterionId,
        latitude: Number(microToDegreesText(c.proximity!.latMicro)),
        longitude: Number(microToDegreesText(c.proximity!.lngMicro)),
        radius: c.proximity!.radius,
        radius_unit: c.proximity!.unit,
        address: c.proximity!.address,
        text: proximityText(c.proximity!),
        bid_modifier: c.bidModifier,
      })),
    ad_schedules: sortSchedules(
      crits
        .filter((c) => c.type === "AD_SCHEDULE")
        .map((c) => ({
          ...c.schedule!,
          criterionId: c.criterionId,
          bm: c.bidModifier,
        }))
    ).map((s) => ({
      criterion_id: s.criterionId,
      day_of_week: s.day_of_week,
      start_hour: s.start_hour,
      start_minute: s.start_minute,
      end_hour: s.end_hour,
      end_minute: s.end_minute,
      text: scheduleText(s),
      bid_modifier: s.bm,
    })),
    note: TARGETING_NOTE,
  }
}

// ---------------------------------------------------------------------------
// google_ads_get_campaign_targeting
// ---------------------------------------------------------------------------

export const getCampaignTargetingInput = z.object({
  campaign_id: idStr.describe(
    "ID chiến dịch (lấy từ ads_list_objects level=campaign)"
  ),
})

async function runGetCampaignTargeting(
  ctx: GCtx,
  input: z.infer<typeof getCampaignTargetingInput>
) {
  const cid = customerIdOf(ctx)
  return readTargeting(ctx, cid, assertId(input.campaign_id, "campaign_id"))
}

// ---------------------------------------------------------------------------
// google_ads_update_campaign_targeting
// ---------------------------------------------------------------------------

export const updateCampaignTargetingInput = z
  .object({
    campaign_id: idStr.describe("ID chiến dịch"),
    positive_geo_target_type: geoTargetTypeSchema
      .optional()
      .describe(
        "PRESENCE = người đang ở / thường ở khu vực; PRESENCE_OR_INTEREST = thêm người quan tâm tới khu vực (mặc định Google)"
      ),
    add_location_ids: z
      .array(idStr)
      .max(1000)
      .optional()
      .describe("ID vị trí cần nhắm thêm (ads_lookup kind=locations)"),
    add_excluded_location_ids: z
      .array(idStr)
      .max(1000)
      .optional()
      .describe("ID vị trí cần loại trừ thêm"),
    add_proximities: proximitiesSchema
      .optional()
      .describe("Bán kính quanh 1 tọa độ cần nhắm thêm"),
    remove_criterion_ids: z
      .array(idStr)
      .max(1000)
      .optional()
      .describe(
        "criterion_id của vị trí / bán kính cần gỡ (từ google_ads_get_campaign_targeting)"
      ),
    ad_schedules: adSchedulesSchema
      .optional()
      .describe(
        "THAY TOÀN BỘ lịch quảng cáo (giờ theo múi giờ tài khoản); [] = bỏ lịch, chạy cả ngày mọi ngày"
      ),
    allow_no_location: z
      .boolean()
      .default(false)
      .describe(
        "true = chấp nhận gỡ hết vị trí / bán kính (hiển thị ở mọi quốc gia)"
      ),
  })
  .superRefine((v, ctx) => {
    const any =
      v.positive_geo_target_type !== undefined ||
      !!v.add_location_ids?.length ||
      !!v.add_excluded_location_ids?.length ||
      !!v.add_proximities?.length ||
      !!v.remove_criterion_ids?.length ||
      v.ad_schedules !== undefined
    if (!any)
      ctx.addIssue({
        code: "custom",
        path: ["campaign_id"],
        message:
          "Cần ít nhất một thay đổi (loại nhắm vị trí, vị trí, bán kính, gỡ tiêu chí hoặc lịch quảng cáo).",
      })
    const both = (v.add_location_ids ?? []).filter((id) =>
      (v.add_excluded_location_ids ?? []).includes(id)
    )
    if (both.length) {
      ctx.addIssue({
        code: "custom",
        path: ["add_excluded_location_ids"],
        message: `Vị trí ${[...new Set(both)].join(", ")} vừa nhắm vừa loại trừ - chỉ chọn một.`,
      })
    }
  })
export type UpdateCampaignTargetingInput = z.infer<
  typeof updateCampaignTargetingInput
>

const LIST_CAP = 100
function capList(list: string[], what: string): string[] {
  return list.length > LIST_CAP
    ? [
        ...list.slice(0, LIST_CAP),
        `… và ${list.length - LIST_CAP} ${what} khác`,
      ]
    : list
}

function isUncertain(e: unknown): boolean {
  return (
    isProviderError(e) && (e.code === "timeout" || e.code === "upstream_error")
  )
}

async function runUpdateCampaignTargeting(
  ctx: GCtx,
  input: UpdateCampaignTargetingInput,
  opts: MutationOptions
): Promise<MutationResult & Record<string, unknown>> {
  const cid = customerIdOf(ctx)
  const client = clientFor(ctx)
  const campaignId = assertId(input.campaign_id, "campaign_id")
  const camp = await loadCampaign(ctx, cid, campaignId)
  assertNotVideo([camp], "update_campaign_targeting")
  const channel = str(camp, "campaign.advertising_channel_type")
  if (channel === "SMART") {
    throw invalidRequest(
      "SMART campaign targeting is not supported",
      "Chiến dịch Thông minh (Smart) không chỉnh nhắm mục tiêu qua MCP - hãy chỉnh trong giao diện Google Ads."
    )
  }
  const campaignName = safeText(field(camp, "campaign.name"))
  const crits = await readCriteria(ctx, cid, campaignId)
  const warnings: string[] = []
  const campRn = `customers/${cid}/campaigns/${campaignId}`
  const critRn = (id: string) =>
    `customers/${cid}/campaignCriteria/${campaignId}~${id}`

  // --- removals of LOCATION / PROXIMITY criteria
  const byId = new Map(crits.map((c) => [c.criterionId, c]))
  const removeIds = [...new Set(input.remove_criterion_ids ?? [])]
  const bad = removeIds.filter((id) => {
    const c = byId.get(id)
    return !c || (c.type !== "LOCATION" && c.type !== "PROXIMITY")
  })
  if (bad.length) {
    throw invalidRequest(
      "Unknown criterion ids",
      `Không gỡ được tiêu chí ${bad.join(", ")}: chỉ gỡ được vị trí / bán kính đang có của chiến dịch này (lấy criterion_id từ google_ads_get_campaign_targeting). Lịch quảng cáo thì sửa qua ad_schedules.`
    )
  }
  const removed = new Set(removeIds)
  // a location removed and re-added with the same polarity → keep the existing criterion (no-op)
  const kept: string[] = []
  for (const [ids, negative] of [
    [input.add_location_ids ?? [], false],
    [input.add_excluded_location_ids ?? [], true],
  ] as const) {
    for (const c of crits) {
      if (
        c.type === "LOCATION" &&
        removed.has(c.criterionId) &&
        c.negative === negative &&
        ids.includes(c.locationId!)
      ) {
        removed.delete(c.criterionId)
        kept.push(c.locationId!)
      }
    }
  }
  if (kept.length)
    warnings.push(
      `Vị trí ${kept.join(", ")} vừa gỡ vừa thêm lại y hệt - giữ nguyên tiêu chí cũ.`
    )
  const remaining = crits.filter((c) => !removed.has(c.criterionId))

  // --- locations
  const locNow = new Map(
    remaining
      .filter((c) => c.type === "LOCATION")
      .map((c) => [c.locationId!, c])
  )
  const addLoc: { id: string; negative: boolean }[] = []
  const already: string[] = []
  const opposite: string[] = []
  const planLoc = (ids: string[] | undefined, negative: boolean) => {
    for (const id of [...new Set(ids ?? [])]) {
      const cur = locNow.get(id)
      if (kept.includes(id) && cur?.negative === negative) continue
      if (cur && cur.negative === negative) already.push(id)
      else if (cur) opposite.push(id)
      else addLoc.push({ id, negative })
    }
  }
  planLoc(input.add_location_ids, false)
  planLoc(input.add_excluded_location_ids, true)
  if (opposite.length) {
    throw invalidRequest(
      "Location already targeted with the opposite polarity",
      `Vị trí ${opposite.join(", ")} đã có trong chiến dịch với kiểu ngược lại (nhắm ↔ loại trừ). Google không cho vừa nhắm vừa loại trừ một vị trí (CANNOT_TARGET_AND_EXCLUDE) - hãy gỡ tiêu chí cũ (remove_criterion_ids) trước rồi thêm lại.`
    )
  }
  if (already.length)
    warnings.push(
      `Vị trí ${already.join(", ")} đã có trong chiến dịch - bỏ qua.`
    )

  // --- proximities
  const proxNow = new Set(
    remaining
      .filter((c) => c.type === "PROXIMITY")
      .map((c) => proximityKey(c.proximity!))
  )
  const addProx: ProximityPoint[] = []
  for (const p of input.add_proximities ?? []) {
    const pt = proximityPoint(p)
    if (proxNow.has(proximityKey(pt)))
      warnings.push(`${proximityText(pt)} đã có - bỏ qua.`)
    else addProx.push(pt)
  }
  if (addProx.length && channel === "PERFORMANCE_MAX") {
    warnings.push(
      "Nhắm theo bán kính trên chiến dịch Performance Max chưa được Google xác nhận chính thức - bước xem trước sẽ kiểm tra; nếu Google từ chối hãy dùng vị trí (location)."
    )
  }

  // --- ad schedules (replace the whole set; identical windows are kept with their bid modifiers)
  const schedNow = crits.filter((c) => c.type === "AD_SCHEDULE")
  let schedRemove: Criterion[] = []
  let schedAdd: AdSchedule[] = []
  if (input.ad_schedules !== undefined) {
    const want = new Map(
      input.ad_schedules.map((s) => [scheduleKey(s), s as AdSchedule])
    )
    const have = new Set(schedNow.map((c) => scheduleKey(c.schedule!)))
    schedRemove = schedNow.filter((c) => !want.has(scheduleKey(c.schedule!)))
    schedAdd = [...want.values()].filter((s) => !have.has(scheduleKey(s)))
    const lost = schedRemove.filter(
      (c) =>
        c.bidModifier !== null && c.bidModifier !== 1 && c.bidModifier !== 0
    )
    if (lost.length) {
      warnings.push(
        `Khung giờ bị bỏ có điều chỉnh giá thầu riêng sẽ mất điều chỉnh đó: ${lost.map((c) => `${scheduleText(c.schedule!)} (×${c.bidModifier})`).join(", ")}.`
      )
    }
    if (!schedRemove.length && !schedAdd.length)
      warnings.push("Lịch quảng cáo không đổi - bỏ qua.")
  }

  // --- totals + safety
  const locAfter =
    remaining.filter((c) => c.type === "LOCATION").length + addLoc.length
  const proxAfter =
    remaining.filter((c) => c.type === "PROXIMITY").length + addProx.length
  if (locAfter > MAX_CAMPAIGN_LOCATIONS)
    throw invalidRequest(
      "Too many locations",
      `Chiến dịch tối đa ${MAX_CAMPAIGN_LOCATIONS.toLocaleString("vi-VN")} vị trí (sau thay đổi: ${locAfter}).`
    )
  if (proxAfter > MAX_CAMPAIGN_PROXIMITIES)
    throw invalidRequest(
      "Too many proximities",
      `Chiến dịch tối đa ${MAX_CAMPAIGN_PROXIMITIES} bán kính (sau thay đổi: ${proxAfter}).`
    )
  const positiveGeo = (list: Criterion[]) =>
    list.filter(
      (c) => (c.type === "LOCATION" || c.type === "PROXIMITY") && !c.negative
    ).length
  const hadPositive = positiveGeo(crits) > 0
  const positiveAfter =
    positiveGeo(remaining) +
    addLoc.filter((l) => !l.negative).length +
    addProx.length
  if (hadPositive && positiveAfter === 0 && !input.allow_no_location) {
    throw invalidRequest(
      "Would remove every positive location",
      "Sau thay đổi chiến dịch không còn vị trí / bán kính nào được nhắm - chiến dịch sẽ hiển thị ở mọi quốc gia. Nếu thật sự muốn vậy, truyền allow_no_location=true."
    )
  }
  if (hadPositive && positiveAfter === 0)
    warnings.push(
      "Chiến dịch không còn vị trí / bán kính nào được nhắm - sẽ hiển thị ở mọi quốc gia."
    )

  // --- geo target type
  const geoBefore = str(
    camp,
    "campaign.geo_target_type_setting.positive_geo_target_type"
  )
  let geoAfter: string | null = null
  if (input.positive_geo_target_type !== undefined) {
    if (input.positive_geo_target_type === geoBefore)
      warnings.push(`Loại nhắm vị trí đã là ${geoBefore} - bỏ qua.`)
    else {
      geoAfter = input.positive_geo_target_type
      warnings.push(
        geoAfter === "PRESENCE"
          ? "PRESENCE: chỉ hiển thị cho người đang ở hoặc thường ở khu vực nhắm - phạm vi hẹp hơn, hợp kinh doanh tại chỗ."
          : "PRESENCE_OR_INTEREST (mặc định Google): hiển thị cả cho người ở ngoài nhưng quan tâm tới khu vực nhắm - phạm vi rộng hơn."
      )
    }
  }

  // --- names for readable changes (+ unknown location ids)
  const locIdsNeeded = [
    ...crits.filter((c) => c.type === "LOCATION").map((c) => c.locationId!),
    ...addLoc.map((l) => l.id),
  ]
  const locChanged =
    addLoc.length > 0 ||
    crits.some((c) => c.type === "LOCATION" && removed.has(c.criterionId))
  const names =
    locChanged && locIdsNeeded.length
      ? await geoNames(ctx, cid, locIdsNeeded)
      : new Map<string, GeoInfo>()
  const unknown = addLoc.filter((l) => !names.has(l.id)).map((l) => l.id)
  if (unknown.length) {
    throw invalidRequest(
      "Unknown location ids",
      `Không tìm thấy ID vị trí ${unknown.join(", ")}. Dùng ads_lookup kind=locations để lấy đúng ID.`
    )
  }

  // --- operations: removes → creates → campaign update (one atomic mutate)
  const ops: Record<string, unknown>[] = []
  for (const c of crits)
    if (removed.has(c.criterionId))
      ops.push({
        campaignCriterionOperation: { remove: critRn(c.criterionId) },
      })
  for (const c of schedRemove)
    ops.push({ campaignCriterionOperation: { remove: critRn(c.criterionId) } })
  for (const l of addLoc) {
    const create: Record<string, unknown> = {
      campaign: campRn,
      location: {
        geoTargetConstant: `geoTargetConstants/${assertId(l.id, "location_id")}`,
      },
    }
    if (l.negative) create.negative = true
    ops.push({ campaignCriterionOperation: { create } })
  }
  for (const p of addProx)
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: campRn, proximity: proximityBody(p) },
      },
    })
  for (const s of schedAdd)
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: campRn, adSchedule: adScheduleBody(s) },
      },
    })
  if (geoAfter) {
    // exact nested mask: a top-level "geo_target_type_setting" mask would clear negative_geo_target_type
    ops.push({
      campaignOperation: {
        update: {
          resourceName: campRn,
          geoTargetTypeSetting: { positiveGeoTargetType: geoAfter },
        },
        updateMask: "geo_target_type_setting.positive_geo_target_type",
      },
    })
  }

  // --- readable changes (same on preview and execute)
  const changes: FieldChange[] = []
  const change = (fieldName: string, before: unknown, after: unknown) =>
    changes.push({
      objectId: campaignId,
      objectName: campaignName,
      level: "campaign",
      field: fieldName,
      before,
      after,
    })
  if (geoAfter) change("positive_geo_target_type", geoBefore, geoAfter)
  if (locChanged) {
    const label = (id: string, negative: boolean) => {
      const g = names.get(id)
      return `${negative ? "loại trừ: " : ""}${g?.canonical_name ?? g?.name ?? "?"} (${id})`
    }
    const before = crits
      .filter((c) => c.type === "LOCATION")
      .map((c) => label(c.locationId!, c.negative))
    const after = [
      ...remaining
        .filter((c) => c.type === "LOCATION")
        .map((c) => label(c.locationId!, c.negative)),
      ...addLoc.map((l) => label(l.id, l.negative)),
    ]
    change("locations", capList(before, "vị trí"), capList(after, "vị trí"))
  }
  const proxRemoved = crits.some(
    (c) => c.type === "PROXIMITY" && removed.has(c.criterionId)
  )
  if (addProx.length || proxRemoved) {
    const before = crits
      .filter((c) => c.type === "PROXIMITY")
      .map((c) => proximityText(c.proximity!))
    const after = [
      ...remaining
        .filter((c) => c.type === "PROXIMITY")
        .map((c) => proximityText(c.proximity!)),
      ...addProx.map(proximityText),
    ]
    change("proximities", before, after)
  }
  if (schedRemove.length || schedAdd.length) {
    const before = schedNow.map((c) => c.schedule!)
    const removedKeys = new Set(
      schedRemove.map((c) => scheduleKey(c.schedule!))
    )
    const after = [
      ...before.filter((s) => !removedKeys.has(scheduleKey(s))),
      ...schedAdd,
    ]
    change("ad_schedules", schedulesText(before), schedulesText(after))
    if (after.length) {
      warnings.push(
        `Giờ trong lịch tính theo múi giờ tài khoản (${ctx.account.timezone}). Khung qua nửa đêm phải tách thành 2 khung ở 2 ngày (vd Thứ 2 22:00–24:00 và Thứ 3 00:00–02:00).`
      )
      if (
        SMART_BIDDING.has(str(camp, "campaign.bidding_strategy_type") ?? "")
      ) {
        warnings.push(
          "Chiến dịch dùng chiến lược giá thầu thông minh (Smart Bidding): điều chỉnh giá thầu theo khung giờ bị bỏ qua - lịch chỉ quyết định giờ hiển thị."
        )
      }
    } else
      warnings.push(
        "Đã bỏ toàn bộ lịch quảng cáo - quảng cáo chạy cả ngày, mọi ngày."
      )
  }

  if (!ops.length) {
    return {
      preview: !!opts.dryRun,
      changes: [],
      warnings: [...warnings, "Không có thay đổi nào cần thực hiện."],
      createdIds: [],
    }
  }
  /** After an uncertain write: true = applied, false = not applied, null = cannot tell. */
  const planApplied = async (): Promise<boolean | null> => {
    const nowCamp = await loadCampaign(ctx, cid, campaignId)
    const now = await readCriteria(ctx, cid, campaignId)
    const has = (pred: (c: Criterion) => boolean) => now.some(pred)
    const l = addLoc[0]
    if (l) {
      return has(
        (c) =>
          c.type === "LOCATION" &&
          c.locationId === l.id &&
          c.negative === l.negative
      )
    }
    const before = new Set(
      crits
        .filter((c) => c.type === "PROXIMITY")
        .map((c) => proximityKey(c.proximity!))
    )
    const p = addProx.find((x) => !before.has(proximityKey(x)))
    if (p) {
      const k = proximityKey(p)
      return has(
        (c) => c.type === "PROXIMITY" && proximityKey(c.proximity!) === k
      )
    }
    const sAdd = schedAdd[0]
    if (sAdd) {
      const k = scheduleKey(sAdd)
      return has(
        (c) => c.type === "AD_SCHEDULE" && scheduleKey(c.schedule!) === k
      )
    }
    const gone = [...removed, ...schedRemove.map((c) => c.criterionId)][0]
    if (gone) return !has((c) => c.criterionId === gone)
    if (geoAfter) {
      return (
        str(nowCamp, "campaign.geo_target_type_setting.positive_geo_target_type") ===
        geoAfter
      )
    }
    return null
  }

  if (opts.dryRun) {
    await client.googleAdsMutate(cid, ops, { validateOnly: true })
    return { preview: true, changes, warnings, createdIds: [] }
  }
  try {
    await client.googleAdsMutate(cid, ops, { idempotent: false })
  } catch (e) {
    // Outcome unknown: never retry blindly. The mutate is atomic → one signature of the plan tells all.
    if (!isUncertain(e)) throw e
    const applied = await planApplied().catch(() => null)
    if (applied === false) throw e
    if (applied === null) {
      throw withErrorAudit(e, "google_ads", {
        errorCode: "partial_failure_unknown",
        changes,
      })
    }
    return {
      preview: false,
      changes,
      warnings: [
        ...warnings,
        "Mất kết nối khi ghi nhưng đã kiểm tra lại: thay đổi đã có trên Google Ads - không cần thử lại.",
      ],
      createdIds: [],
      campaign_id: campaignId,
    }
  }
  return {
    preview: false,
    changes,
    warnings,
    createdIds: [],
    campaign_id: campaignId,
  }
}

// ---------------------------------------------------------------------------

type Ext = ProviderExtension<GoogleAdsCredentials>

export const campaignTargetingExtensions: Ext[] = [
  {
    name: "google_ads_get_campaign_targeting",
    permission: "read",
    title: "Xem nhắm mục tiêu chiến dịch Google",
    description:
      "Dùng khi cần xem nhắm mục tiêu vị trí và lịch của một chiến dịch Google Ads: loại nhắm vị trí (PRESENCE / PRESENCE_OR_INTEREST), các vị trí nhắm / loại trừ, bán kính quanh tọa độ, lịch quảng cáo theo khung giờ (múi giờ tài khoản). " +
      "Trả về criterion_id để dùng với google_ads_update_campaign_targeting (remove_criterion_ids). Gọi trước: ads_list_objects level=campaign để lấy campaign_id.",
    input: getCampaignTargetingInput,
    write: false,
    run: (ctx, input: z.infer<typeof getCampaignTargetingInput>) =>
      runGetCampaignTargeting(ctx, input),
  },
  {
    name: "google_ads_update_campaign_targeting",
    permission: "update",
    title: "Sửa nhắm mục tiêu chiến dịch Google",
    description:
      "Dùng khi cần đổi nhắm mục tiêu vị trí / lịch của chiến dịch Google Ads (không áp dụng Video/YouTube và Smart): " +
      "positive_geo_target_type = PRESENCE (chỉ người đang ở / thường ở khu vực - hợp kinh doanh tại chỗ) hoặc PRESENCE_OR_INTEREST (mặc định Google, thêm người quan tâm tới khu vực); " +
      "thêm vị trí nhắm / loại trừ (ID từ ads_lookup kind=locations); thêm bán kính quanh tọa độ (km 1–800 hoặc dặm 0,7–500); gỡ vị trí / bán kính bằng criterion_id; " +
      "ad_schedules THAY TOÀN BỘ lịch (tối đa 6 khung/ngày, không chồng nhau, phút 0/15/30/45, giờ theo múi giờ tài khoản; [] = chạy cả ngày). " +
      "Gọi trước google_ads_get_campaign_targeting để xem hiện trạng và lấy criterion_id. Mọi thay đổi ghi nguyên khối trong 1 lần và LUÔN cần người dùng xác nhận; gỡ hết vị trí cần allow_no_location=true.",
    input: updateCampaignTargetingInput,
    write: true,
    // targeting decides where money is spent (all countries / PRESENCE_OR_INTEREST widen reach) → never auto-run
    alwaysConfirm: true,
    run: (ctx, input: UpdateCampaignTargetingInput, opts) =>
      runUpdateCampaignTargeting(ctx, input, opts),
  },
]
