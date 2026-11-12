// ads_lookup for Meta: secondary assets needed to create ads/targeting.
import { createHash } from "node:crypto"
import { LRUCache } from "lru-cache"
import { isProviderError, ProviderError } from "../errors"
import { sanitizeExternalLabel } from "../../../lib/text-safety"
import type { LookupItem, LookupKind, LookupQuery, ProviderContext } from "../types"
import { actId, graphAll, graphPage, type MetaCredentials } from "./client"
import { readMetaPostCta } from "./pages"
import { callCtx, invalid } from "./shared"

type Raw = Record<string, unknown> & { id?: string }

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))

function filterByName(items: LookupItem[], q: string | undefined, limit: number): LookupItem[] {
  const needle = q?.trim().toLowerCase()
  const out = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) || i.id === needle) : items
  return out.slice(0, limit)
}

export interface AdvertisablePage {
  id: string
  name: string
  category: unknown
  isPublished: unknown
  source: "promote_pages" | "me_accounts"
}

// ---------------------------------------------------------------------------
// advertisablePages cache (D4): 2 GETs per call, run by every create / creative change (preview AND execute)
// ---------------------------------------------------------------------------

/**
 * How long a successful advertisablePages answer is reused. The cache only widens the "allowed" side for at most this
 * long after a Page is taken away - Meta still refuses the real create - and a missing Page is always re-read once.
 */
export const ADVERTISABLE_PAGES_TTL_MS = 5 * 60_000

interface AdvPagesEntry {
  pages: readonly AdvertisablePage[]
  /** fetch order: a slow older fetch never overwrites a newer answer */
  seq: number
}

const advState = ((globalThis as unknown as { __adsMcpMetaAdvPages?: AdvPagesState }).__adsMcpMetaAdvPages ??= {
  cache: new LRUCache<string, AdvPagesEntry>({ max: 1_000, ttl: ADVERTISABLE_PAGES_TTL_MS }),
  inflight: new Map(),
  keysByConnection: new Map(),
  seq: 0,
})

interface AdvPagesState {
  cache: LRUCache<string, AdvPagesEntry>
  /** key → the running fetch, so parallel previews share one pair of GETs */
  inflight: Map<string, { seq: number; promise: Promise<readonly AdvertisablePage[]> }>
  /** connection id → cache keys (forgetAdvertisablePages) */
  keysByConnection: Map<string, Set<string>>
  seq: number
}

/**
 * Keyed by a hash of (token, ad account): the raw token is never kept as a key, and a replaced token misses the cache
 * on its own. The answer holds Page ids / names only (no secret).
 */
function advPagesKey(ctx: ProviderContext<MetaCredentials>, account: string): string {
  const key = createHash("sha256").update(`${ctx.credentials.accessToken}\u0000${account}`).digest("hex")
  if (ctx.connectionId) {
    const keys = advState.keysByConnection.get(ctx.connectionId) ?? new Set<string>()
    keys.add(key)
    advState.keysByConnection.set(ctx.connectionId, keys)
    if (advState.keysByConnection.size > 10_000) advState.keysByConnection.clear()
  }
  return key
}

/** Drop the cached Page lists of a connection (disabled, deleted or new credentials) - called by forgetPageTokens. */
export function forgetAdvertisablePages(connectionId: string) {
  for (const key of advState.keysByConnection.get(connectionId) ?? []) {
    advState.cache.delete(key)
    advState.inflight.delete(key)
  }
  advState.keysByConnection.delete(connectionId)
}

export function __clearAdvertisablePagesCache() {
  advState.cache.clear()
  advState.inflight.clear()
  advState.keysByConnection.clear()
}

/**
 * Pages this ad account may run ads for: every Page of `act_x/promote_pages`, plus the Pages of `me/accounts` on
 * which the token's user has the ADVERTISE task (Pages it only moderates / analyses are left out). De-duplicated,
 * promote_pages first. A token that cannot read me/accounts (System User, missing pages_show_list) gets
 * promote_pages only. NOT related to the MCP Page scope (mcp_page_scopes), which only gates the read-only Pages tools.
 *
 * Cached ADVERTISABLE_PAGES_TTL_MS per (token, ad account); concurrent calls share one fetch; failures are never
 * cached. `fresh: true` always reads Meta again (and refreshes the cache): ads_lookup, and the one retry of
 * assertAdvertisablePages when a Page is missing from the cached list.
 */
export async function advertisablePages(
  ctx: ProviderContext<MetaCredentials>,
  opts: { fresh?: boolean } = {}
): Promise<AdvertisablePage[]> {
  const account = actId(ctx.account.externalId)
  const key = advPagesKey(ctx, account)
  if (!opts.fresh) {
    const hit = advState.cache.get(key)
    if (hit) return [...hit.pages]
    const running = advState.inflight.get(key)
    if (running) return [...(await running.promise)]
  }
  const seq = ++advState.seq
  const promise = fetchAdvertisablePages(ctx, account).then((pages) => {
    const frozen = Object.freeze(pages.map((p) => Object.freeze(p)))
    const cur = advState.cache.get(key)
    if (!cur || cur.seq < seq) advState.cache.set(key, { pages: frozen, seq })
    return frozen
  })
  advState.inflight.set(key, { seq, promise })
  try {
    return [...(await promise)]
  } finally {
    // errors are not cached: the next call reads Meta again
    if (advState.inflight.get(key)?.seq === seq) advState.inflight.delete(key)
  }
}

async function fetchAdvertisablePages(ctx: ProviderContext<MetaCredentials>, account: string): Promise<AdvertisablePage[]> {
  const call = callCtx(ctx)
  const out: AdvertisablePage[] = []
  const seen = new Set<string>()
  const push = (p: Raw, source: AdvertisablePage["source"]) => {
    const id = s(p.id)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ id, name: s(p.name), category: p.category ?? null, isPublished: p.is_published ?? null, source })
  }
  const promote = await graphAll<Raw>(call, `${account}/promote_pages`, { fields: "id,name,category,is_published", limit: 100 }, 500)
  for (const p of promote.data) push(p, "promote_pages")
  try {
    const mine = await graphAll<Raw>(call, "me/accounts", { fields: "id,name,category,is_published,tasks", limit: 100 }, 500)
    for (const p of mine.data) if (Array.isArray(p.tasks) && p.tasks.includes("ADVERTISE")) push(p, "me_accounts")
  } catch (e) {
    // System User tokens / missing pages_show_list: promote_pages is enough
    if (!isProviderError(e) || !["permission_denied", "invalid_request"].includes(e.code)) throw e
  }
  return out
}

/**
 * Fields of a Page live video readable with the user token (tested 2026-11-12, meta.md §5 "Quảng cáo video trực
 * tiếp"): is_reference_only → "Copyright API only opens to page users" (#100), dash_preview_url / ingest_streams →
 * stream-key permission (#10); video.post_id is always "0" → object_story_id = <page_id>_<video.id>.
 */
const LIVE_VIDEO_FIELDS =
  "id,title,description,status,creation_time,broadcast_start_time,planned_start_time,permalink_url,live_views,video{id}"

/** Live posts whose button (post call_to_action) is read per lookup call */
const LIVE_CTA_READS = 10

/** kind live_videos: live videos of one advertisable Page, usable as existing_post (object_story_id) in live ads. */
async function liveVideos(
  ctx: ProviderContext<MetaCredentials>,
  pageId: string | undefined,
  q: string | undefined,
  limit: number
): Promise<{ items: LookupItem[]; warnings: string[] }> {
  const page = pageId?.trim() ?? ""
  if (!/^\d{1,30}$/.test(page)) {
    throw invalid("kind live_videos cần parent_id = page_id của Trang (id chỉ gồm chữ số).", "Gọi ads_lookup kind=pages để lấy page_id.")
  }
  // grant boundary: only Pages this ad account may advertise for (same rule as meta_create_ad)
  if (!(await advertisablePages(ctx)).some((p) => p.id === page)) {
    throw invalid(
      `Trang ${page} không dùng được để chạy quảng cáo với tài khoản quảng cáo này.`,
      "Gọi ads_lookup kind=pages để xem các Trang dùng được."
    )
  }
  const res = await graphPage<Raw>(callCtx(ctx), `${page}/live_videos`, { fields: LIVE_VIDEO_FIELDS, limit: Math.min(limit, 100) })
  const items: LookupItem[] = []
  for (const v of res.data) {
    const video = (v.video ?? null) as Raw | null
    const videoId = s(video?.id)
    if (!/^\d+$/.test(videoId)) continue
    const title = sanitizeExternalLabel(s(v.title), 200) || sanitizeExternalLabel(s(v.description), 120) || `Video trực tiếp ${s(v.creation_time)}`
    const link = s(v.permalink_url)
    items.push({
      id: `${page}_${videoId}`,
      name: title,
      extra: {
        objectStoryId: `${page}_${videoId}`,
        liveVideoId: s(v.id),
        videoId,
        status: v.status ?? null,
        broadcastStartTime: v.broadcast_start_time ?? null,
        plannedStartTime: v.planned_start_time ?? null,
        creationTime: v.creation_time ?? null,
        liveViews: v.live_views ?? null,
        permalinkUrl: link.startsWith("/") ? `https://www.facebook.com${link}` : link || null,
      },
    })
  }
  // the button stored on each live post (Page token, a read per post - first LIVE_CTA_READS items only)
  let unread = 0
  for (const item of items.slice(0, LIVE_CTA_READS)) {
    try {
      const cta = await readMetaPostCta(ctx, item.id)
      item.extra!.postButton = cta ? { type: cta.type, link: cta.link ? sanitizeExternalLabel(cta.link, 500) : null } : null
    } catch (e) {
      if (isProviderError(e) && e.code === "auth_invalid") throw e
      unread++
    }
  }
  const warnings = [
    "id = object_story_id: dùng làm meta_create_ad creative existing_post trong chiến dịch có live_video_destination (meta_create_campaign). " +
      "status LIVE = đang phát, VOD = đã phát xong (quảng cáo bản phát lại), SCHEDULED_* = đã lên lịch (chưa có bài để quảng cáo qua API).",
    "postButton = nút đang gắn trên bài live (null = chưa có): bài đã có nút thì MỌI quảng cáo dùng bài đều hiện nút đó - chọn bài có nút hợp với quảng cáo (website / tin nhắn), hoặc bài chưa có nút (nút của quảng cáo đầu tiên sẽ gắn vào bài).",
  ]
  if (unread) warnings.push(`Không đọc được nút của ${unread} bài live (via cần có vai trò trên Trang).`)
  if (items.length === 0) warnings.push("Trang chưa có video trực tiếp nào (hoặc token không đọc được video trực tiếp của Trang).")
  return { items: filterByName(items, q, limit), warnings }
}

export async function metaLookup(
  ctx: ProviderContext<MetaCredentials>,
  kind: LookupKind,
  query: LookupQuery = {}
): Promise<{ items: LookupItem[]; warnings: string[] }> {
  const call = callCtx(ctx)
  const account = actId(ctx.account.externalId)
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), 200)
  const warnings: string[] = []
  const q = query.q?.trim()

  const needQ = () => {
    if (!q) throw invalid("Cần từ khoá tìm kiếm (q).")
    return q
  }

  switch (kind) {
    case "pages": {
      // Pages promotable by this ad account + Pages the token's user (via) may advertise for (task ADVERTISE).
      // Always read fresh: a Page assigned a moment ago must show up (the answer also refreshes the cache).
      const items = (await advertisablePages(ctx, { fresh: true })).map((p) => ({
        id: p.id,
        name: p.name,
        extra: { category: p.category, isPublished: p.isPublished, source: p.source },
      }))
      if (items.length === 0) {
        warnings.push(
          "Không thấy Trang nào dùng được để chạy quảng cáo - kiểm tra token có quyền pages_show_list và via/System User có quyền quảng cáo (ADVERTISE) trên Trang."
        )
      }
      return { items: filterByName(items, q, limit), warnings }
    }
    case "pixels": {
      const res = await graphAll<Raw>(call, `${account}/adspixels`, { fields: "id,name,last_fired_time,is_unavailable", limit: 100 }, 500)
      const items = res.data.map((p) => ({
        id: s(p.id),
        name: s(p.name),
        extra: { lastFiredTime: p.last_fired_time ?? null, isUnavailable: p.is_unavailable ?? null },
      }))
      return { items: filterByName(items, q, limit), warnings }
    }
    case "instagram_accounts": {
      const res = await graphAll<Raw>(call, `${account}/instagram_accounts`, { fields: "id,username", limit: 100 }, 500)
      const items = res.data.map((p) => ({ id: s(p.id), name: s(p.username) || s(p.id), extra: { username: p.username ?? null } }))
      warnings.push("Dùng id này làm instagram_user_id khi tạo quảng cáo.")
      return { items: filterByName(items, q, limit), warnings }
    }
    case "custom_audiences": {
      const res = await graphAll<Raw>(
        call,
        `${account}/customaudiences`,
        {
          fields: "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status",
          limit: 200,
        },
        2000
      )
      const items = res.data.map((a) => ({
        id: s(a.id),
        name: s(a.name),
        extra: {
          subtype: a.subtype ?? null,
          approximateCountLowerBound: a.approximate_count_lower_bound ?? null,
          approximateCountUpperBound: a.approximate_count_upper_bound ?? null,
          deliveryStatus: a.delivery_status ?? null,
        },
      }))
      return { items: filterByName(items, q, limit), warnings }
    }
    case "conversion_events": {
      const res = await graphAll<Raw>(
        call,
        `${account}/customconversions`,
        { fields: "id,name,custom_event_type,rule,is_archived", limit: 100 },
        500
      )
      const items = res.data
        .filter((c) => c.is_archived !== true)
        .map((c) => ({ id: s(c.id), name: s(c.name), extra: { customEventType: c.custom_event_type ?? null } }))
      warnings.push(
        "Sự kiện chuẩn của pixel (PURCHASE, LEAD, COMPLETE_REGISTRATION, ADD_TO_CART, INITIATED_CHECKOUT…) dùng trực tiếp làm custom_event_type, không cần tra cứu."
      )
      return { items: filterByName(items, q, limit), warnings }
    }
    case "interests": {
      const res = await graphPage<Raw>(call, "search", { type: "adinterest", q: needQ(), limit, locale: "vi_VN" })
      return {
        items: res.data.map((i) => ({
          id: s(i.id),
          name: s(i.name),
          extra: {
            audienceSizeLowerBound: i.audience_size_lower_bound ?? null,
            audienceSizeUpperBound: i.audience_size_upper_bound ?? null,
            path: i.path ?? null,
            topic: i.topic ?? null,
          },
        })),
        warnings,
      }
    }
    case "locations": {
      const res = await graphPage<Raw>(call, "search", {
        type: "adgeolocation",
        q: needQ(),
        location_types: ["country", "region", "city"],
        limit,
        locale: "vi_VN",
      })
      warnings.push("Quốc gia dùng country_code (vd VN); tỉnh/thành và thành phố dùng key trong targeting.")
      return {
        items: res.data.map((l) => ({
          id: s(l.type) === "country" ? s(l.country_code || l.key) : s(l.key),
          name: [s(l.name), s(l.region), s(l.country_name)].filter(Boolean).join(", "),
          extra: { type: l.type ?? null, key: l.key ?? null, countryCode: l.country_code ?? null, supportsRegion: l.supports_region ?? null },
        })),
        warnings,
      }
    }
    case "languages": {
      const res = await graphPage<Raw>(call, "search", { type: "adlocale", q: needQ(), limit })
      return { items: res.data.map((l) => ({ id: s(l.key), name: s(l.name) })), warnings }
    }
    case "live_videos":
      return liveVideos(ctx, query.parentId, q, limit)
    case "identities":
    case "tiktok_posts":
      throw new ProviderError({
        platform: "meta",
        code: "unsupported",
        message: `meta: ${kind} lookup is TikTok-only`,
        userMessageVi: `Meta không có “${kind}” (chỉ TikTok) - dùng pages, instagram_accounts hoặc live_videos.`,
      })
  }
}
