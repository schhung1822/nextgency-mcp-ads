// ads_lookup for Meta: secondary assets needed to create ads/targeting.
import { isProviderError, ProviderError } from "../errors"
import type { LookupItem, LookupKind, ProviderContext } from "../types"
import { actId, graphAll, graphPage, type MetaCredentials } from "./client"
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

/**
 * Pages this ad account may run ads for: every Page of `act_x/promote_pages`, plus the Pages of `me/accounts` on
 * which the token's user has the ADVERTISE task (Pages it only moderates / analyses are left out). De-duplicated,
 * promote_pages first. A token that cannot read me/accounts (System User, missing pages_show_list) gets
 * promote_pages only. NOT related to the MCP Page scope (mcp_page_scopes), which only gates the read-only Pages tools.
 */
export async function advertisablePages(ctx: ProviderContext<MetaCredentials>): Promise<AdvertisablePage[]> {
  const call = callCtx(ctx)
  const account = actId(ctx.account.externalId)
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

export async function metaLookup(
  ctx: ProviderContext<MetaCredentials>,
  kind: LookupKind,
  query: { q?: string; limit?: number } = {}
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
      // Pages promotable by this ad account + Pages the token's user (via) may advertise for (task ADVERTISE)
      const items = (await advertisablePages(ctx)).map((p) => ({
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
    case "identities":
      throw new ProviderError({
        platform: "meta",
        code: "unsupported",
        message: "meta: identities lookup is TikTok-only",
        userMessageVi: "Meta không có “identities” - dùng pages hoặc instagram_accounts.",
      })
  }
}
