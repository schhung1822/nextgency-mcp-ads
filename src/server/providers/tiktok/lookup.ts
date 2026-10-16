// Auxiliary lookups for building ads: identities, pixels, locations, interest categories, custom audiences, TikTok
// posts of an identity (tiktok_posts, Spark Ads).
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import type { LookupItem, LookupKind, LookupQuery, LookupResult, ProviderContext } from "../types"
import { invalid, normalizeStatus, str, tiktokTimeToIso, ttFromCtx, ttGet, ttGetAll, ttPost, unsupportedVi, type Raw, type TT } from "./api"
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
  query: LookupQuery = {}
): Promise<LookupResult> {
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
    case "tiktok_posts":
      return tiktokPosts(tt, query, q, limit)
    default:
      throw unsupportedVi(
        `lookup ${kind}`,
        `TikTok không hỗ trợ tra cứu "${kind}". Dùng: identities, pixels, locations, interests, custom_audiences, tiktok_posts.`
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

// ---------------------------------------------------------------------------
// tiktok_posts: posts of a TikTok identity (GET /identity/video/get/, doc 1740218475032577) for Spark Ads
// ---------------------------------------------------------------------------

const POST_IDENTITY_TYPES = ["AUTH_CODE", "TT_USER", "BC_AUTH_TT"] as const
const POST_ITEM_TYPES = ["VIDEO", "CAROUSEL"] as const
type PostItemType = (typeof POST_ITEM_TYPES)[number]
/** TikTok returns at most 20 posts per call */
const POSTS_PAGE = 20
const MAX_POST_PAGES_PER_CALL = 10
/** /ad/get/ rows scanned to flag posts already used in ads (5 pages of 1000) */
export const POSTS_AD_SCAN_MAX = 5000
const MAX_ADS_PER_POST = 5

const POST_STATUS_VI: Record<string, string> = {
  ITEM_STATUS_HESITATE_RECOMMEND: "công khai",
  STATUS_ONLY_FRIEND_SEE: "chỉ bạn bè",
  ITEM_STATUS_ONLY_AUTHOR_SEE: "riêng tư",
}

interface PostsCursor {
  /** item type being paged */
  t: PostItemType
  /** TikTok cursor of that type (numeric string; a time value for TT_USER / BC_AUTH_TT) - null = first page */
  c: string | null
  /** fingerprint of the query (identity + q) */
  f: string
}

function postsFingerprint(identityId: string, identityType: string, bcId: string | null, q: string | undefined): string {
  return JSON.stringify([identityId, identityType, bcId, q ?? null])
}

function decodePostsCursor(raw: string, fp: string): PostsCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PostsCursor
    if (c.f !== fp || !POST_ITEM_TYPES.includes(c.t) || (c.c !== null && !/^\d{1,30}$/.test(String(c.c)))) throw new Error("mismatch")
    return c
  } catch {
    throw invalid("Cursor không hợp lệ hoặc không khớp với truy vấn.", "Gọi lại ads_lookup kind=tiktok_posts không kèm cursor.")
  }
}

const postText = (v: unknown, max: number) => (typeof v === "string" ? sanitizeExternalLabel(v, max) : null)

/** identity_type + identity_authorized_bc_id of `identityId` (explicit values win; missing ones come from /identity/get/). */
async function resolvePostIdentity(
  tt: TT,
  identityId: string,
  query: LookupQuery,
  warnings: string[]
): Promise<{ type: (typeof POST_IDENTITY_TYPES)[number]; bcId: string | null }> {
  let type = query.identityType?.trim() || null
  let bcId = query.identityAuthorizedBcId?.trim() || null
  // Always check the identity belongs to this ad account (defence in depth, even when the caller passes the type / BC id)
  const sameIdentity = (i: Raw) => String(i.identity_id) === identityId && (!type || i.identity_type === type)
  let found = (await fetchIdentityList(tt)).find(sameIdentity)
  // /identity/get/ without identity_type may not list every BC_AUTH_TT identity (doc 1740218420781057) → ask the given BC
  if (!found && bcId && (!type || type === "BC_AUTH_TT")) {
    const res = await ttGet<{ identity_list?: Raw[] }>(tt, "identity/get", {
      advertiser_id: tt.advertiserId,
      identity_type: "BC_AUTH_TT",
      identity_authorized_bc_id: bcId,
      page: 1,
      page_size: 100,
    })
    found = (res.data.identity_list ?? []).find((i) => String(i.identity_id) === identityId && i.identity_type === "BC_AUTH_TT")
  }
  if (!found) {
    throw invalid(
      `Không tìm thấy identity ${identityId.slice(0, 64)} trong tài khoản quảng cáo này${type ? ` (loại ${type.slice(0, 40)})` : ""}.`,
      "Gọi ads_lookup kind=identities để lấy identity_id, identity_type và identity_authorized_bc_id; tài khoản ủy quyền qua Business Center: truyền thêm identity_type=BC_AUTH_TT và identity_authorized_bc_id."
    )
  }
  type = type ?? str(found.identity_type)
  const listedBc = str(found.identity_authorized_bc_id)
  if (bcId && listedBc && bcId !== listedBc) {
    throw invalid(
      "identity_authorized_bc_id không khớp với Business Center của identity này trong tài khoản quảng cáo.",
      "Lấy đúng identity_authorized_bc_id từ ads_lookup kind=identities."
    )
  }
  bcId = bcId ?? listedBc
  if (found.can_pull_video === false) {
    warnings.push("Identity này có can_pull_video = false: TikTok có thể không trả đủ bài đăng của tài khoản.")
  }
  if (found.is_gpppa === true) warnings.push("Identity này có is_gpppa = true: không tạo được Spark Ads từ bài đăng của nó.")
  if (type === "CUSTOMIZED_USER") {
    throw invalid(
      "Custom Identity (CUSTOMIZED_USER) không có bài đăng TikTok để chạy Spark Ads.",
      "Dùng identity TT_USER, BC_AUTH_TT hoặc AUTH_CODE (ads_lookup kind=identities)."
    )
  }
  if (!type || !(POST_IDENTITY_TYPES as readonly string[]).includes(type)) {
    throw invalid(`identity_type "${String(type).slice(0, 40)}" không hợp lệ - chỉ AUTH_CODE, TT_USER hoặc BC_AUTH_TT.`)
  }
  if (type === "BC_AUTH_TT" && !bcId) {
    throw invalid("Identity BC_AUTH_TT cần identity_authorized_bc_id (ID Business Center).", "Lấy từ ads_lookup kind=identities.")
  }
  return { type: type as (typeof POST_IDENTITY_TYPES)[number], bcId: type === "BC_AUTH_TT" ? bcId : null }
}

/**
 * tiktok_item_id → ads using it, from at most POSTS_AD_SCAN_MAX non-deleted /ad/get/ rows (no item filter exists in
 * /ad/get/, doc 1735735588640770). An estimate: Spark Push ads before approval, Promote and GMV Max ads carry no
 * tiktok_item_id there. null = the scan failed.
 */
async function adsByItem(tt: TT): Promise<{ map: Map<string, Raw[]>; capped: boolean } | null> {
  try {
    const rows = await ttGetAll<Raw>(
      tt,
      "ad/get",
      {
        advertiser_id: tt.advertiserId,
        filtering: { primary_status: "STATUS_NOT_DELETE" },
        fields: ["ad_id", "ad_id_v2", "smart_plus_ad_id", "ad_name", "tiktok_item_id", "operation_status", "secondary_status", "campaign_automation_type"],
        exclude_field_types_in_response: ["NULL_FIELD"],
      },
      { pageSize: 1000, max: POSTS_AD_SCAN_MAX }
    )
    const map = new Map<string, Raw[]>()
    for (const r of rows) {
      const item = typeof r.tiktok_item_id === "string" ? r.tiktok_item_id.trim() : null
      if (!item) continue
      const list = map.get(item) ?? []
      list.push(r)
      map.set(item, list)
    }
    return { map, capped: rows.length >= POSTS_AD_SCAN_MAX }
  } catch {
    return null
  }
}

function postItem(v: Raw, identityType: string): LookupItem | null {
  // item_id is a 19-digit string; a JSON number has already lost digits → unusable as tiktok_item_id
  const id = typeof v.item_id === "string" ? v.item_id.trim() : typeof v.item_id === "number" && Number.isSafeInteger(v.item_id) ? String(v.item_id) : null
  if (!id || !/^\d{1,30}$/.test(id)) return null
  const text = postText(v.text, 500)
  const status = postText(v.status, 40)
  const extra: Raw = {
    item_type: postText(v.item_type, 40),
    text,
    status,
    visibility: status ? (POST_STATUS_VI[status] ?? null) : null,
  }
  const video = v.video_info && typeof v.video_info === "object" ? (v.video_info as Raw) : null
  if (video) {
    const d = Number(video.duration)
    if (Number.isFinite(d) && d > 0) extra.duration_s = Math.round(d * 10) / 10
    if (Number.isFinite(Number(video.width))) extra.width = Number(video.width)
    if (Number.isFinite(Number(video.height))) extra.height = Number(video.height)
  }
  const carousel = v.carousel_info && typeof v.carousel_info === "object" ? (v.carousel_info as Raw) : null
  if (carousel) {
    const images = Array.isArray(carousel.image_info) ? carousel.image_info : []
    extra.image_count = images.length
    const music = carousel.music_info && typeof carousel.music_info === "object" ? (carousel.music_info as Raw) : null
    extra.has_music = !!music
  }
  // authorization window: returned for AUTH_CODE (UTC "YYYY-MM-DD HH:MM:SS" → ISO)
  const auth = v.auth_info && typeof v.auth_info === "object" ? (v.auth_info as Raw) : null
  if (auth && identityType === "AUTH_CODE") {
    extra.ad_auth_status = postText(auth.ad_auth_status, 40)
    extra.auth_start_time = tiktokTimeToIso(auth.auth_start_time)
    extra.auth_end_time = tiktokTimeToIso(auth.auth_end_time)
  }
  // URLs (video / poster / image / music, all temporary) are never returned
  return { id, name: postText(v.text, 120) ?? `Bài đăng ${id}`, extra }
}

async function tiktokPosts(tt: TT, query: LookupQuery, q: string | undefined, limit: number): Promise<LookupResult> {
  const identityId = query.parentId?.trim()
  if (!identityId) {
    throw invalid(
      "kind tiktok_posts cần parent_id = identity_id của tài khoản TikTok.",
      "Gọi ads_lookup kind=identities để lấy identity_id (TT_USER, BC_AUTH_TT hoặc AUTH_CODE)."
    )
  }
  if (!/^[\w.:-]{1,128}$/.test(identityId)) throw invalid("parent_id (identity_id) không hợp lệ.")
  const warnings: string[] = []
  const identity = await resolvePostIdentity(tt, identityId, query, warnings)
  const keyword = q && identity.type === "AUTH_CODE" ? q.slice(0, 500) : undefined
  const fp = postsFingerprint(identityId, identity.type, identity.bcId, q)
  let state: PostsCursor | null = query.cursor ? decodePostsCursor(query.cursor, fp) : { t: "VIDEO", c: null, f: fp }
  const raws: Raw[] = []
  let fetched = 0
  for (let page = 0; state && page < MAX_POST_PAGES_PER_CALL && raws.length < limit; page++) {
    const params = {
      advertiser_id: tt.advertiserId,
      identity_id: identityId,
      identity_type: identity.type,
      ...(identity.bcId ? { identity_authorized_bc_id: identity.bcId } : {}),
      item_type: state.t,
      ...(keyword ? { keyword } : {}),
      ...(state.c ? { cursor: state.c } : {}),
      count: Math.min(POSTS_PAGE, limit - raws.length),
    }
    let res: Awaited<ReturnType<typeof ttGet<{ cursor?: unknown; has_more?: unknown; video_list?: Raw[] }>>>
    try {
      res = await ttGet<{ cursor?: unknown; has_more?: unknown; video_list?: Raw[] }>(tt, "identity/video/get", params)
    } catch (e) {
      // photo posts are a second pass: a failure there keeps the video posts already read
      if (state.t !== "CAROUSEL") throw e
      warnings.push("Không đọc được bài đăng ảnh (CAROUSEL) - chỉ có bài video.")
      state = null
      break
    }
    const list = Array.isArray(res.data.video_list) ? res.data.video_list : []
    fetched += list.length
    for (const v of list) {
      if (!v || typeof v !== "object") continue
      if (q && !keyword) {
        const text = typeof v.text === "string" ? v.text.toLowerCase() : ""
        if (!text.includes(q.toLowerCase()) && String(v.item_id ?? "") !== q) continue
      }
      raws.push(v)
    }
    // cursor comes back as a numeric string (a time value for TT_USER / BC_AUTH_TT): sent back unchanged
    const next = typeof res.data.cursor === "string" || typeof res.data.cursor === "number" ? String(res.data.cursor) : null
    const more = res.data.has_more === true && list.length > 0 && !!next && /^\d{1,30}$/.test(next) && next !== state.c
    if (more) state = { t: state.t, c: next, f: fp }
    else state = state.t === "VIDEO" ? { t: "CAROUSEL", c: null, f: fp } : null
  }

  const items: LookupItem[] = []
  let dropped = 0
  for (const v of raws) {
    const it = postItem(v, identity.type)
    if (it) items.push(it)
    else dropped++
  }
  if (dropped) warnings.push(`Bỏ qua ${dropped} bài đăng có item_id không hợp lệ.`)

  if (items.length) {
    const scan = await adsByItem(tt)
    if (!scan) {
      warnings.push("Không đối chiếu được bài đăng nào đã dùng làm quảng cáo (lỗi khi đọc danh sách quảng cáo) - used_in_ads = null.")
    } else {
      for (const it of items) {
        const ads = scan.map.get(it.id) ?? []
        it.extra = {
          ...it.extra,
          used_in_ads: ads.length,
          ads: ads.slice(0, MAX_ADS_PER_POST).map((a) => ({
            ad_id: String(a.smart_plus_ad_id ?? a.ad_id_v2 ?? a.ad_id),
            ad_name: postText(a.ad_name, 80),
            status: normalizeStatus(a.operation_status, a.secondary_status),
          })),
        }
      }
      warnings.push(
        `used_in_ads là ước lượng: đối chiếu tiktok_item_id với tối đa ${POSTS_AD_SCAN_MAX.toLocaleString("vi-VN")} quảng cáo chưa xoá${scan.capped ? " (tài khoản có nhiều hơn - có thể thiếu)" : ""}; quảng cáo Spark Push chưa duyệt, Promote và GMV Max không có tiktok_item_id nên không đếm được.`
      )
    }
  }
  if (q && !keyword && fetched > raws.length) {
    warnings.push("Lọc theo q được áp dụng sau khi lấy dữ liệu (TikTok chỉ tìm theo từ khoá với identity AUTH_CODE) nên trang này có thể ít hơn giới hạn; dùng next_cursor để xem tiếp.")
  }
  warnings.push("Dùng id (tiktok_item_id) cho Spark Ads cùng identity_id / identity_type này. Không trả link video / ảnh (link tạm của TikTok).")
  return {
    items,
    warnings,
    nextCursor: state ? Buffer.from(JSON.stringify(state)).toString("base64url") : null,
  }
}
