// ads_lookup for OpenAI Ads: locations (geo lookup), conversion event settings (gated), custom audiences.
import { isProviderError, ProviderError, unsupported } from "../errors"
import type { LookupItem, LookupKind } from "../types"
import { listAll, oaRequest, PLATFORM } from "./client"
import type { Ctx } from "./objects"

interface GeoLookupEntry {
  id: string
  name: string
  canonical_name: string
  region_code?: string | null
  type: string
  country_code: string
  parent_id: string | null
  parent_country: string | null
}

interface ConversionEventSetting {
  id: string
  name: string
  event_type: string
  custom_event_name: string | null
  attribution_window_days: number
  archived: boolean
  campaigns?: unknown[]
}

interface CustomAudience {
  id: string
  name: string
  description: string | null
  status: string
  matched_user_count_range?: string
}

export async function lookup(
  ctx: Ctx,
  kind: LookupKind,
  query: { q?: string; limit?: number } = {}
): Promise<{ items: LookupItem[]; warnings: string[] }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), 500)
  const needle = query.q?.trim().toLowerCase() || null
  switch (kind) {
    case "locations": {
      const q = query.q?.trim()
      if (!q) {
        throw new ProviderError({
          platform: PLATFORM,
          code: "invalid_request",
          message: "q is required for locations",
          userMessageVi: "Cần nhập từ khoá địa danh (q), vd \"Ho Chi Minh\" - dùng đúng chính tả bản địa.",
        })
      }
      const res = await oaRequest<{ results: GeoLookupEntry[] }>(ctx, {
        method: "GET",
        path: "/geo_lookup/search",
        query: { q, limit: Math.min(limit, 100) },
      })
      return {
        items: (res.results ?? []).map((g) => ({
          id: g.id,
          name: g.canonical_name || g.name,
          extra: {
            type: g.type,
            country_code: g.country_code,
            region_code: g.region_code ?? null,
            parent_id: g.parent_id,
            parent_country: g.parent_country,
          },
        })),
        warnings: ["Dùng id địa điểm cho targeting.locations.include; quốc gia có thể dùng mã ISO-2 (countries)."],
      }
    }
    case "conversion_events": {
      try {
        const res = await listAll<ConversionEventSetting>(ctx, "/conversions/event_settings", {}, { maxItems: 500, gated: true })
        const items = res.items
          .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.event_type.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((s) => ({
            id: s.id,
            name: s.name,
            extra: {
              event_type: s.event_type,
              custom_event_name: s.custom_event_name,
              attribution_window_days: s.attribution_window_days,
              archived: s.archived,
              campaigns_count: s.campaigns?.length ?? 0,
            },
          }))
        return {
          items,
          warnings: ["Chiến dịch tối ưu chuyển đổi chỉ chọn được 1 sự kiện chuẩn (standard), đang hoạt động (archived=false)."],
        }
      } catch (e) {
        if (isProviderError(e) && e.code === "feature_not_enabled") {
          return { items: [], warnings: ["Tài khoản chưa bật Conversions (theo dõi chuyển đổi) trên OpenAI Ads."] }
        }
        throw e
      }
    }
    case "custom_audiences": {
      const res = await listAll<CustomAudience>(ctx, "/custom_audiences", {}, { maxItems: 1_000 })
      const items = res.items
        .filter((a) => !needle || a.name.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((a) => ({
          id: a.id,
          name: a.name,
          extra: { status: a.status, description: a.description, matched_user_count_range: a.matched_user_count_range ?? null },
        }))
      return {
        items,
        warnings: ["Tệp đối tượng dùng để nhắm (include) cần tối thiểu ~25.000 người dùng khớp; tệp loại trừ có thể nhỏ hơn."],
      }
    }
    default:
      throw unsupported(PLATFORM, `tra cứu "${kind}" (OpenAI Ads không có targeting theo ${kind})`)
  }
}
