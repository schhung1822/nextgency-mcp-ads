// ads_lookup for Google Ads: locations (geoTargetConstants:suggest), languages, conversion actions, user lists.
import { unsupported } from "../errors"
import type { LookupItem, LookupKind } from "../types"
import { field, resourceId, str } from "./client"
import { clientFor, customerIdOf, type GCtx } from "./context"

interface GeoSuggestion {
  geoTargetConstant?: { resourceName?: string; id?: string; name?: string; canonicalName?: string; countryCode?: string; targetType?: string; status?: string }
  reach?: string
  locale?: string
  searchTerm?: string
}

function matches(q: string | undefined, ...vals: (string | null)[]): boolean {
  if (!q) return true
  const needle = q.toLocaleLowerCase("vi")
  return vals.some((v) => v?.toLocaleLowerCase("vi").includes(needle))
}

export async function lookup(ctx: GCtx, kind: LookupKind, query: { q?: string; limit?: number } = {}): Promise<{ items: LookupItem[]; warnings: string[] }> {
  const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
  const q = query.q?.trim() || undefined
  const client = clientFor(ctx)
  const warnings: string[] = []

  switch (kind) {
    case "locations": {
      if (!q) return { items: [], warnings: ["Nhập tên địa điểm cần tìm (vd “Hà Nội”, “Vietnam”)."] }
      const body = { locale: "vi", locationNames: { names: [q.slice(0, 200)] } }
      const r = await client.post<{ geoTargetConstantSuggestions?: GeoSuggestion[] }>("geoTargetConstants:suggest", body)
      const items = (r?.geoTargetConstantSuggestions ?? [])
        .filter((s) => s.geoTargetConstant?.status !== "REMOVAL_PLANNED")
        .slice(0, limit)
        .map((s) => {
          const g = s.geoTargetConstant ?? {}
          return {
            id: g.id ?? resourceId(g.resourceName) ?? "",
            name: g.canonicalName ?? g.name ?? "",
            extra: { resource_name: g.resourceName, target_type: g.targetType, country_code: g.countryCode, reach: s.reach ? Number(s.reach) : null },
          }
        })
      return { items, warnings }
    }
    case "languages": {
      const cid = customerIdOf(ctx)
      const { rows } = await client.searchAll(
        cid,
        "SELECT language_constant.id, language_constant.code, language_constant.name, language_constant.targetable FROM language_constant WHERE language_constant.targetable = TRUE",
        { maxRows: 1_000 }
      )
      const items = rows
        .map((r) => ({
          id: str(r, "language_constant.id") ?? "",
          name: str(r, "language_constant.name") ?? "",
          extra: { code: str(r, "language_constant.code"), resource_name: `languageConstants/${str(r, "language_constant.id")}` },
        }))
        .filter((i) => matches(q, i.name, i.extra.code))
        .slice(0, limit)
      return { items, warnings }
    }
    case "conversion_events": {
      const cid = customerIdOf(ctx)
      const { rows } = await client.searchAll(
        cid,
        "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, " +
          "conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
        { maxRows: 2_000 }
      )
      const items = rows
        .map((r) => ({
          id: str(r, "conversion_action.id") ?? "",
          name: str(r, "conversion_action.name") ?? "",
          extra: {
            status: str(r, "conversion_action.status"),
            type: str(r, "conversion_action.type"),
            category: str(r, "conversion_action.category"),
            primary_for_goal: field(r, "conversion_action.primary_for_goal") === true,
          },
        }))
        .filter((i) => matches(q, i.name))
        .slice(0, limit)
      return { items, warnings }
    }
    case "custom_audiences": {
      const cid = customerIdOf(ctx)
      const { rows } = await client.searchAll(
        cid,
        "SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status, user_list.eligible_for_search, " +
          "user_list.eligible_for_display, user_list.size_range_for_search, user_list.size_range_for_display FROM user_list",
        { maxRows: 2_000 }
      )
      const items = rows
        .map((r) => ({
          id: str(r, "user_list.id") ?? "",
          name: str(r, "user_list.name") ?? "",
          extra: {
            type: str(r, "user_list.type"),
            membership_status: str(r, "user_list.membership_status"),
            eligible_for_search: field(r, "user_list.eligible_for_search") === true,
            eligible_for_display: field(r, "user_list.eligible_for_display") === true,
            size_range_for_search: str(r, "user_list.size_range_for_search"),
            size_range_for_display: str(r, "user_list.size_range_for_display"),
          },
        }))
        .filter((i) => matches(q, i.name))
        .slice(0, limit)
      return { items, warnings }
    }
    default:
      throw unsupported("google_ads", `tra cứu “${kind}” trên Google Ads`)
  }
}
