// Auxiliary lookups for building ads: identities, pixels, locations, interest categories, custom audiences.
import type { LookupItem, LookupKind, ProviderContext } from "../types"
import { str, ttFromCtx, ttGet, ttPost, unsupportedVi, type Raw, type TT } from "./api"
import type { TikTokCredentials } from "./credentials"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function matches(q: string | undefined, ...vals: unknown[]): boolean {
  if (!q) return true
  const n = q.toLowerCase()
  return vals.some((v) => typeof v === "string" && v.toLowerCase().includes(n))
}

export async function tiktokLookup(
  ctx: ProviderContext<TikTokCredentials>,
  kind: LookupKind,
  query: { q?: string; limit?: number } = {}
): Promise<{ items: LookupItem[]; warnings: string[] }> {
  const tt = ttFromCtx(ctx)
  const q = query.q?.trim() || undefined
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  switch (kind) {
    case "identities":
      return identities(tt, q, limit)
    case "pixels":
      return pixels(tt, q, limit)
    case "locations":
      return locations(tt, q, limit)
    case "interests":
      return interests(tt, q, limit)
    case "custom_audiences":
      return audiences(tt, q, limit)
    default:
      throw unsupportedVi(
        `lookup ${kind}`,
        `TikTok không hỗ trợ tra cứu "${kind}". Dùng: identities, pixels, locations, interests, custom_audiences.`
      )
  }
}

/**
 * Raw /identity/get/ list (all identity types, ≤5 pages of 100). Shared by ads_lookup kind=identities and
 * tiktok_messaging_assets kind=dm_identities (messaging.ts).
 */
export async function fetchIdentityList(tt: TT, maxPages = 5): Promise<Raw[]> {
  const out: Raw[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await ttGet<{ identity_list?: Raw[]; page_info?: { total_page?: number } }>(tt, "identity/get", {
      advertiser_id: tt.advertiserId,
      page,
      page_size: 100,
    })
    const list = res.data.identity_list ?? []
    out.push(...list)
    if (!list.length || page >= Number(res.data.page_info?.total_page ?? 1)) break
  }
  return out
}

async function identities(tt: TT, q: string | undefined, limit: number) {
  const items: LookupItem[] = []
  for (let page = 1; page <= 5 && items.length < limit; page++) {
    const res = await ttGet<{ identity_list?: Raw[]; page_info?: { total_page?: number } }>(tt, "identity/get", {
      advertiser_id: tt.advertiserId,
      page,
      page_size: 100,
    })
    const list = res.data.identity_list ?? []
    for (const i of list) {
      if (!matches(q, i.display_name, i.username, i.identity_id)) continue
      items.push({
        id: String(i.identity_id),
        name: str(i.display_name) ?? str(i.username) ?? String(i.identity_id),
        extra: {
          identity_type: str(i.identity_type),
          identity_authorized_bc_id: str(i.identity_authorized_bc_id),
          username: str(i.username),
          available_status: str(i.available_status),
          can_push_video: i.can_push_video ?? null,
          can_pull_video: i.can_pull_video ?? null,
          // TT_USER / BC_AUTH_TT: may be used for TikTok direct message ads (doc 1740218420781057)
          can_manage_message: typeof i.can_manage_message === "boolean" ? i.can_manage_message : null,
        },
      })
    }
    if (!list.length || page >= Number(res.data.page_info?.total_page ?? 1)) break
  }
  return {
    items: items.slice(0, limit),
    warnings: [
      "Ưu tiên identity TT_USER / BC_AUTH_TT / AUTH_CODE (Spark Ads): Custom Identity (CUSTOMIZED_USER) không còn tạo được quảng cáo mới trên vị trí TikTok cho nhiều tài khoản.",
    ],
  }
}

async function pixels(tt: TT, q: string | undefined, limit: number) {
  const items: LookupItem[] = []
  for (let page = 1; page <= 10 && items.length < limit; page++) {
    const res = await ttGet<{ pixels?: Raw[]; page_info?: { total_page?: number } }>(tt, "pixel/list", {
      advertiser_id: tt.advertiserId,
      page,
      page_size: 20, // TikTok maximum for this endpoint
      ...(q ? { name: q } : {}),
    })
    const list = res.data.pixels ?? []
    for (const p of list) {
      const events = Array.isArray(p.events) ? (p.events as Raw[]) : []
      items.push({
        id: String(p.pixel_id),
        name: str(p.pixel_name) ?? String(p.pixel_id),
        extra: {
          pixel_code: str(p.pixel_code),
          pixel_category: str(p.pixel_category),
          events: events.slice(0, 50).map((e) => ({
            name: str(e.name),
            event_type: str(e.event_type),
            optimization_event: str(e.optimization_event),
            custom_event_type: str(e.custom_event_type),
            statistic_type: str(e.statistic_type),
            deprecated: e.deprecated ?? null,
          })),
        },
      })
    }
    if (!list.length || page >= Number(res.data.page_info?.total_page ?? 1)) break
  }
  return { items: items.slice(0, limit), warnings: [] }
}

async function locations(tt: TT, q: string | undefined, limit: number) {
  if (q) {
    const res = await ttPost<{ targeting_tag_list?: Raw[] }>(
      tt,
      "tool/targeting/search",
      {
        advertiser_id: tt.advertiserId,
        objective_type: "REACH",
        placements: ["PLACEMENT_TIKTOK"],
        search_type: "FUZZY_SEARCH",
        keywords: [q],
      },
      { retries: 2 } // read-only search
    )
    const items: LookupItem[] = []
    for (const t of res.data.targeting_tag_list ?? []) {
      const geo = (t.geo as Raw | undefined) ?? {}
      const status = (t.status_info as Raw | undefined)?.status
      if (!geo.geo_id) continue
      items.push({
        id: String(geo.geo_id),
        name: str(t.name) ?? String(geo.geo_id),
        extra: {
          geo_type: str(geo.geo_type),
          region_code: str(geo.region_code),
          parent_id: str(geo.parent_id),
          description: str(geo.description),
          usable: status ? status === "ENABLED" : null,
        },
      })
    }
    return {
      items: items.slice(0, limit),
      warnings: ["Dùng id số (location_ids) khi tạo nhóm quảng cáo; ZIP_CODE dùng cho zipcode_ids."],
    }
  }
  const res = await ttGet<{ region_info?: Raw[] }>(tt, "tool/region", {
    advertiser_id: tt.advertiserId,
    placements: ["PLACEMENT_TIKTOK"],
    objective_type: "REACH",
    level_range: "TO_COUNTRY",
  })
  const items = (res.data.region_info ?? []).map((r) => ({
    id: String(r.location_id),
    name: str(r.name) ?? String(r.location_id),
    extra: { region_code: str(r.region_code), level: str(r.level) },
  }))
  return {
    items: items.slice(0, limit),
    warnings: ["Danh sách quốc gia (cấp COUNTRY). Truyền q (vd \"Hà Nội\") để tìm tỉnh/thành phố."],
  }
}

async function interests(tt: TT, q: string | undefined, limit: number) {
  const res = await ttGet<{ interest_categories?: Raw[] }>(tt, "tool/interest_category", {
    advertiser_id: tt.advertiserId,
    version: 2,
    placements: ["PLACEMENT_TIKTOK"],
  })
  const items = (res.data.interest_categories ?? [])
    .filter((c) => matches(q, c.interest_category_name))
    .map((c) => ({
      id: String(c.interest_category_id),
      name: str(c.interest_category_name) ?? String(c.interest_category_id),
      extra: { level: c.level ?? null, sub_category_ids: c.sub_category_ids ?? [] },
    }))
  return { items: items.slice(0, limit), warnings: ["Dùng id cho interest_category_ids khi tạo/sửa nhóm quảng cáo."] }
}

async function audiences(tt: TT, q: string | undefined, limit: number) {
  const items: LookupItem[] = []
  for (let page = 1; page <= 10 && items.length < limit; page++) {
    const res = await ttGet<{ list?: Raw[]; page_info?: { total_page?: number } }>(tt, "dmp/custom_audience/list", {
      advertiser_id: tt.advertiserId,
      page,
      page_size: 100,
    })
    const list = res.data.list ?? []
    for (const a of list) {
      if (!matches(q, a.name)) continue
      items.push({
        id: String(a.audience_id),
        name: str(a.name) ?? String(a.audience_id),
        extra: {
          audience_type: str(a.audience_type),
          cover_num: a.cover_num ?? null,
          is_valid: a.is_valid ?? null,
          is_expiring: a.is_expiring ?? null,
          shared: a.shared ?? null,
        },
      })
    }
    if (!list.length || page >= Number(res.data.page_info?.total_page ?? 1)) break
  }
  return { items: items.slice(0, limit), warnings: [] }
}
