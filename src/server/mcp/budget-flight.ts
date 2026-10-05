// Flight (start → end) that governs a campaign-level LIFETIME budget (04-mcp-design.md §6).
// Meta CBO: a campaign often has no stop_time - the budget is spent over the flights of its ad sets, so the
// lifetime cap (daily cap × days) must be computed from the ad sets that will deliver, not from the campaign
// alone (which would fall back to 30 days and let a short ad-set flight spend far more per day than the cap).
// Other platforms keep the campaign dates. No imports from "next/*" under src/server/mcp.
import type { AdObjectSummary, AdsProvider, Platform, ProviderContext } from "../providers/types"
import { denied } from "./errors"
import { parseFlightTime, type Flight } from "./guardrails"

export const CHILD_PAGE_SIZE = 200
export const CHILD_MAX_PAGES = 3

/** Platforms whose ad groups carry their own flight / budget under a campaign (Meta ad sets). */
export function adGroupFlightsMatter(platform: Platform): boolean {
  return platform === "meta"
}

const GONE = new Set(["ARCHIVED", "DELETED"])

function isGone(o: AdObjectSummary): boolean {
  if (o.status === "archived" || o.status === "deleted" || o.status === "removed") return true
  const configured = o.extra?.configuredStatus
  return typeof configured === "string" && GONE.has(configured.toUpperCase())
}

/**
 * Non-archived / non-deleted ad groups of a campaign (at most CHILD_MAX_PAGES × CHILD_PAGE_SIZE).
 * null when there are more (the flight cannot be verified).
 */
export async function listChildAdGroups(
  provider: AdsProvider,
  ctx: ProviderContext,
  campaignId: string
): Promise<AdObjectSummary[] | null> {
  const out: AdObjectSummary[] = []
  let cursor: string | null = null
  for (let page = 0; page < CHILD_MAX_PAGES; page++) {
    const r = await provider.listObjects(ctx, { level: "ad_group", parentId: campaignId, cursor, limit: CHILD_PAGE_SIZE })
    for (const o of r.items) if (!isGone(o)) out.push(o)
    cursor = r.nextCursor
    if (!cursor) return out
  }
  return null
}

/** The object is switched on by its owner (configured status), even if it does not deliver right now (e.g. campaign paused). */
export function isConfiguredOn(o: AdObjectSummary): boolean {
  return String(o.extra?.configuredStatus ?? o.statusRaw ?? "").toUpperCase() !== "PAUSED"
}

export type ChildrenSource = AdObjectSummary[] | null | (() => Promise<AdObjectSummary[] | null>)

export interface CampaignFlightOptions {
  /** ad group ids being switched on in the same call (they deliver too) */
  activating?: readonly string[]
  /** a pending schedule change of one ad group (new flight = changed values over the current ones) */
  override?: { adGroupId: string } & Flight
  /** already listed children (or a lazy loader); default: listChildAdGroups */
  children?: ChildrenSource
}

type CampaignLike = Pick<AdObjectSummary, "id" | "startTime" | "endTime">

/**
 * Flight of a campaign-level lifetime budget: Meta → from the ad sets that will deliver (configured on or being
 * activated; none → all), capped by the campaign's own start/stop time; other platforms → campaign dates.
 * "unknown" when the ad sets cannot be listed (too many) or a delivering ad set has no end and the campaign no stop_time.
 */
export async function campaignBudgetFlight(o: {
  provider: AdsProvider
  ctx: ProviderContext
  campaign: CampaignLike
} & CampaignFlightOptions): Promise<Flight | "unknown"> {
  const base: Flight = { startTime: o.campaign.startTime ?? null, endTime: o.campaign.endTime ?? null }
  if (!adGroupFlightsMatter(o.provider.platform)) return base
  const src = o.children === undefined ? () => listChildAdGroups(o.provider, o.ctx, o.campaign.id) : o.children
  let kids = typeof src === "function" ? await src() : src
  if (kids === null) return "unknown"
  const ov = o.override
  if (ov) {
    kids = kids.map((k) =>
      k.id === ov.adGroupId
        ? {
            ...k,
            ...("startTime" in ov ? { startTime: ov.startTime ?? null } : {}),
            ...("endTime" in ov ? { endTime: ov.endTime ?? null } : {}),
          }
        : k
    )
  }
  const activating = new Set(o.activating ?? [])
  let pool = kids.filter((k) => isConfiguredOn(k) || activating.has(k.id))
  if (pool.length === 0) pool = kids
  if (pool.length === 0) return base

  const campaignStart = parseFlightTime(o.campaign.startTime, "start")
  const campaignEnd = parseFlightTime(o.campaign.endTime, "end")
  let end = -Infinity
  // earliest start; null = already started / starts now
  let start: number | null | undefined
  for (const k of pool) {
    // an ad set without its own end runs until the campaign stops
    const e = parseFlightTime(k.endTime, "end") ?? campaignEnd
    if (e === null) return "unknown"
    end = Math.max(end, e)
    // an ad set without its own start starts with the campaign (or now)
    const s = parseFlightTime(k.startTime, "start") ?? campaignStart
    start = start === undefined ? s : start === null || s === null ? null : Math.min(start, s)
  }
  // nothing delivers outside the campaign's own start/stop time
  if (campaignEnd !== null) end = Math.min(end, campaignEnd)
  if (typeof start === "number" && campaignStart !== null) start = Math.max(start, campaignStart)
  return {
    startTime: typeof start === "number" ? new Date(start).toISOString() : null,
    endTime: new Date(end).toISOString(),
  }
}

/** campaignBudgetFlight, refusing the write when the flight cannot be determined. */
export async function campaignFlightOrDeny(
  provider: AdsProvider,
  ctx: ProviderContext,
  campaign: CampaignLike & { name?: string | null },
  opts: CampaignFlightOptions = {}
): Promise<Flight> {
  const f = await campaignBudgetFlight({ provider, ctx, campaign, ...opts })
  if (f !== "unknown") return f
  throw denied(
    "budget_flight_unknown",
    `Không xác định được lịch chạy của chiến dịch "${String(campaign.name ?? campaign.id).slice(0, 80)}" (${campaign.id}) - ngân sách trọn đời ở cấp chiến dịch phụ thuộc ngày kết thúc của các nhóm quảng cáo - nên chưa thể kiểm tra trần ngân sách.`,
    "Đặt end_time cho các nhóm quảng cáo đang chạy (ads_update_object) hoặc stop_time cho chiến dịch rồi thử lại."
  )
}
