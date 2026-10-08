// YouTube Ads inside Google Ads (there is no separate YouTube Ads API - providers/google-ads.md §9).
// - Channel-type filter (SEARCH / VIDEO / DEMAND_GEN / PERFORMANCE_MAX… or "youtube" = VIDEO + DEMAND_GEN) for
//   report + list. It travels as an optional, Google-only field `channelTypes` on ReportFilters / ListQuery
//   (structurally typed here until the shared contract declares it; other adapters ignore it).
// - VIDEO campaigns are read-only through the API (mutates need a reservation / are not permitted for the campaign
//   type): every write on a VIDEO campaign or one of its children is refused before anything is sent.
// - YouTube video ids / URLs → YoutubeVideoAsset (no file upload).
import { ProviderError } from "../errors"
import type { ListQuery, ReportFilters } from "../types"
import { str, type GoogleAdsRow } from "./client"
import { invalidRequest } from "./context"

/** campaign.advertising_channel_type values accepted by the filter (AdvertisingChannelType, v25). */
export const CHANNEL_TYPES = [
  "SEARCH",
  "DISPLAY",
  "SHOPPING",
  "HOTEL",
  "VIDEO",
  "MULTI_CHANNEL",
  "LOCAL",
  "SMART",
  "PERFORMANCE_MAX",
  "LOCAL_SERVICES",
  "TRAVEL",
  "DEMAND_GEN",
] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

/** Campaign types that deliver on YouTube and are reported under "YouTube" (PMax only has a YouTube slice). */
export const YOUTUBE_CHANNELS: readonly ChannelType[] = ["VIDEO", "DEMAND_GEN"]

/** Value accepted in `channelTypes`: a channel type (case-insensitive) or the alias "youtube". */
export type ChannelFilterValue = ChannelType | "youtube"

/** Google-only optional fields carried by the shared report filters / list query. */
export interface GoogleChannelFilter {
  /** campaign.advertising_channel_type values or "youtube" (= VIDEO + DEMAND_GEN); empty/absent = all */
  channelTypes?: readonly string[] | null
}
export type GoogleReportFilters = ReportFilters &
  GoogleChannelFilter & {
    /** segments.ad_network_type values (YOUTUBE, SEARCH, SEARCH_PARTNERS, CONTENT…) - e.g. the YouTube slice of PMax */
    adNetworkTypes?: readonly string[] | null
  }
export type GoogleListQuery = ListQuery & GoogleChannelFilter

/** segments.ad_network_type values accepted by the network filter (AdNetworkType, v25 - YOUTUBE UNVERIFIED for PMax). */
export const AD_NETWORK_TYPES = [
  "SEARCH",
  "SEARCH_PARTNERS",
  "CONTENT",
  "MIXED",
  "YOUTUBE",
  "GOOGLE_TV",
] as const

/** Validate + expand the channel filter. null = no filter. Throws invalid_request on unknown values. */
export function resolveChannelTypes(
  values: readonly string[] | null | undefined
): ChannelType[] | null {
  if (!values?.length) return null
  const out = new Set<ChannelType>()
  for (const raw of values) {
    const v = String(raw).trim()
    if (v.toLowerCase() === "youtube") {
      for (const c of YOUTUBE_CHANNELS) out.add(c)
      continue
    }
    const up = v.toUpperCase() as ChannelType
    if (!(CHANNEL_TYPES as readonly string[]).includes(up)) {
      throw invalidRequest(
        `Unknown channel type ${v.slice(0, 40)}`,
        `Loại chiến dịch không hợp lệ: “${v.slice(0, 40)}”. Dùng: youtube, ${CHANNEL_TYPES.join(", ")}.`
      )
    }
    out.add(up)
  }
  return [...out]
}

export function resolveAdNetworkTypes(
  values: readonly string[] | null | undefined
): string[] | null {
  if (!values?.length) return null
  const out = new Set<string>()
  for (const raw of values) {
    const up = String(raw).trim().toUpperCase()
    if (!(AD_NETWORK_TYPES as readonly string[]).includes(up)) {
      throw invalidRequest(
        `Unknown ad network type ${up.slice(0, 40)}`,
        `Mạng quảng cáo không hợp lệ: “${up.slice(0, 40)}”. Dùng: ${AD_NETWORK_TYPES.join(", ")}.`
      )
    }
    out.add(up)
  }
  return [...out]
}

/** GAQL condition on the campaign channel (values come from the allow-list above, never from user text). */
export function channelCondition(
  types: readonly ChannelType[] | null
): string | null {
  if (!types?.length) return null
  return `campaign.advertising_channel_type IN (${types.map((t) => `'${t}'`).join(", ")})`
}

export function isYoutubeChannel(channel: string | null | undefined): boolean {
  return channel === "VIDEO" || channel === "DEMAND_GEN"
}

/** Channel info exposed in summaries/report rows so the AI can tell YouTube campaigns apart. */
export function channelInfo(row: GoogleAdsRow): Record<string, unknown> {
  const channel = str(row, "campaign.advertising_channel_type")
  return {
    advertising_channel_type: channel,
    advertising_channel_sub_type: str(
      row,
      "campaign.advertising_channel_sub_type"
    ),
    youtube: isYoutubeChannel(channel),
  }
}

// ---------------------------------------------------------------------------
// VIDEO campaigns: read-only
// ---------------------------------------------------------------------------

export const VIDEO_READ_ONLY_VI =
  "Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads."

export function videoReadOnlyError(what = "write"): ProviderError {
  return new ProviderError({
    platform: "google_ads",
    code: "unsupported",
    message: `Google Ads VIDEO campaigns are read-only via the API (${what})`,
    userMessageVi: VIDEO_READ_ONLY_VI,
    hint: "Xem số liệu bằng ads_get_report / ads_list_objects (lọc YouTube); bật/tắt, ngân sách, nội dung chỉnh trong giao diện Google Ads.",
  })
}

/** Refuse when any row belongs to a VIDEO campaign (rows must select campaign.advertising_channel_type). */
export function assertNotVideo(
  rows: Iterable<GoogleAdsRow | undefined>,
  what = "write"
): void {
  for (const r of rows)
    if (r && str(r, "campaign.advertising_channel_type") === "VIDEO")
      throw videoReadOnlyError(what)
}

// ---------------------------------------------------------------------------
// YouTube video id / URL
// ---------------------------------------------------------------------------

const YT_ID = /^[A-Za-z0-9_-]{11}$/
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
])

/** 11-char YouTube video id from an id or a youtube.com / youtu.be URL (watch, shorts, embed, live). null otherwise. */
export function parseYoutubeVideoId(
  input: string | null | undefined
): string | null {
  const s = (input ?? "").trim()
  if (YT_ID.test(s)) return s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  const host = u.hostname.toLowerCase()
  if (!YT_HOSTS.has(host)) return null
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? ""
    return YT_ID.test(id) ? id : null
  }
  const v = u.searchParams.get("v")
  if (u.pathname === "/watch" && v && YT_ID.test(v)) return v
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(
    u.pathname
  )
  return m ? m[1]! : null
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}
