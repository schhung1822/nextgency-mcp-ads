// TikTok Social - read operations on TikTok's Social MCP tools + normalisation (17-tiktok-social.md §6). Response
// shapes from the live probe of 2026-11-15 (scripts/dev-probe-tiktok-social.ts). Every text written by other people
// (comments, replies, mentioned posts) is untrusted: sanitised, phone numbers / e-mails masked (doc 17 TS3), cut.
// Profile pictures (signed CDN links) and TikTok's hashed user ids are never returned.
import { maskContactInfo } from "@/lib/pii-mask"
import { cutText, sanitizeExternalLabel, UNSAFE_TEXT_CHARS } from "@/lib/text-safety"

import { callTiktokSocialTool } from "./api"

type Raw = Record<string, unknown>
export interface MaskCounts {
  phones: number
  emails: number
}

export const COMMENT_TEXT_MAX = 1500
export const CAPTION_MAX = 600

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}
const str = (v: unknown, max = 200): string | null => (typeof v === "string" ? sanitizeExternalLabel(v, max) : null)
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null)
const id = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : v
  return typeof s === "string" && /^[\w-]{1,64}$/.test(s) ? s : null
}
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 2000) return null
  try {
    const u = new URL(v)
    return u.protocol === "https:" ? u.toString() : null
  } catch {
    return null
  }
}

/** epoch seconds ("1790565631") or "YYYY-MM-DD HH:MM:SS" (UTC, replies) → ISO */
export function tiktokTime(v: unknown): string | null {
  const n = num(v)
  if (n !== null && n > 1_000_000_000 && n < 10_000_000_000) return new Date(n * 1000).toISOString()
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
    const d = new Date(`${v.replace(" ", "T")}Z`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

/** untrusted multi-line text: unsafe characters removed, contacts masked, cut */
export function maskedText(raw: unknown, counts: MaskCounts, max = COMMENT_TEXT_MAX): string | null {
  if (typeof raw !== "string") return null
  const cleaned = raw.replace(UNSAFE_TEXT_CHARS, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  if (!cleaned) return null
  const m = maskContactInfo(cleaned)
  counts.phones += m.phones
  counts.emails += m.emails
  return cutText(m.text, max)
}

type Call = (name: string, args: Record<string, unknown>) => Promise<Raw>
/** binds an access token: the store's withTiktokSocialToken wraps it (refresh + retry) */
export function caller(accessToken: string, signal?: AbortSignal): Call {
  return async (name, args) => (await callTiktokSocialTool(accessToken, name, args, signal)).data
}

// ---- account -------------------------------------------------------------------------------------------------

export interface TiktokProfile {
  username: string | null
  displayName: string | null
  profileUrl: string | null
  isBusinessAccount: boolean | null
  hasAdvancedAccess: boolean | null
  isVerified: boolean | null
  followersCount: number | null
}

export const PROFILE_FIELDS = [
  "username",
  "display_name",
  "profile_deep_link",
  "is_business_account",
  "has_advanced_access",
  "is_verified",
  "followers_count",
]

export function toProfile(d: Raw): TiktokProfile {
  const u = typeof d.username === "string" ? d.username.trim().replace(/^@/, "") : ""
  return {
    username: /^[\w.]{1,64}$/.test(u) ? u.toLowerCase() : null,
    displayName: str(d.display_name, 80),
    profileUrl: httpsUrl(d.profile_deep_link),
    isBusinessAccount: bool(d.is_business_account),
    hasAdvancedAccess: bool(d.has_advanced_access),
    isVerified: bool(d.is_verified),
    followersCount: num(d.followers_count),
  }
}

export async function getProfile(call: Call): Promise<TiktokProfile> {
  return toProfile(await call("account_user_get", { fields: PROFILE_FIELDS }))
}

/** account_user_get fields that need no Business account (live 2026-11-15 on a Creator account) */
const INSIGHT_FIELDS = [
  ...PROFILE_FIELDS,
  "bio_description",
  "following_count",
  "total_likes",
  "videos_count",
  "video_views",
  "unique_video_views",
  "profile_views",
  "likes",
  "comments",
  "shares",
  "daily_total_followers",
  "daily_new_followers",
  "daily_lost_followers",
  "audience_ages",
  "audience_genders",
  "audience_countries",
  "audience_cities",
  "audience_activity",
  "engaged_audience",
  "phone_number_clicks",
  "lead_submissions",
  "app_download_clicks",
  "bio_link_clicks",
  "email_clicks",
  "address_clicks",
]

const share = (v: unknown, key: string) =>
  Array.isArray(v)
    ? (v as Raw[])
        .map((x) => ({ [key]: str(x?.[key], 40), percentage: num(x?.percentage) }))
        .filter((x) => x[key] !== null)
        .sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))
        .slice(0, 20)
    : null

export async function getAccountInsights(call: Call, range: { startDate?: string; endDate?: string }) {
  const d = await call("account_user_get", {
    fields: INSIGHT_FIELDS,
    ...(range.startDate ? { start_date: range.startDate } : {}),
    ...(range.endDate ? { end_date: range.endDate } : {}),
  })
  const daily = (Array.isArray(d.metrics) ? (d.metrics as Raw[]) : [])
    .map((m) => {
      const o: Record<string, string | number | null> = { date: typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : null }
      for (const [k, v] of Object.entries(m)) if (k !== "date" && /^[a-z_]{1,40}$/.test(k) && typeof v === "number") o[k] = v
      return o
    })
    .filter((m) => m.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  return {
    profile: { ...toProfile(d), bio: str(d.bio_description, 300) },
    totals: {
      followers: num(d.followers_count),
      following: num(d.following_count),
      total_likes: num(d.total_likes),
      videos: num(d.videos_count),
    },
    daily,
    audience: {
      ages: share(d.audience_ages, "age"),
      genders: share(d.audience_genders, "gender"),
      countries: share(d.audience_countries, "country"),
      cities: share(d.audience_cities, "city_name") ?? share(d.audience_cities, "city"),
    },
  }
}

export const BUSINESS_CATEGORIES = [
  "ART_AND_CRAFTS",
  "AUTOMOTIVE_AND_TRANSPORTATION",
  "BABY",
  "BEAUTY",
  "CLOTHING_AND_ACCESSORIES",
  "EDUCATION_AND_TRAINING",
  "ELECTRONICS",
  "FINANCE_AND_INVESTING",
  "FOOD_AND_BEVERAGE",
  "GAMING",
  "HEALTH_AND_WELLNESS",
  "HOME_FURNITURE_AND_APPLIANCES",
  "MACHINERY_AND_EQUIPMENT",
  "MEDIA_AND_ENTERTAINMENT",
  "PERSONAL_BLOG",
  "PETS",
  "PROFESSIONAL_SERVICES",
  "PUBLIC_ADMINISTRATION",
  "REAL_ESTATE",
  "RESTAURANTS_AND_BARS",
  "SHOPPING_AND_RETAIL",
  "SOFTWARE_AND_APPS",
  "SPORTS_FITNESS_AND_OUTDOORS",
  "TRAVEL_AND_TOURISM",
  "OTHERS",
] as const

export async function getBenchmark(call: Call, category: string) {
  const d = await call("account_user_benchmark_get", { business_category: category })
  // numbers only, flat (benchmark shape not yet seen live)
  const out: Record<string, number | string> = {}
  const walk = (o: Raw, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue
      if (typeof v === "number") out[prefix + k] = v
      else if (typeof v === "string" && v.length <= 40) out[prefix + k] = sanitizeExternalLabel(v, 40) ?? ""
      else if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) walk(v as Raw, `${prefix}${k}.`, depth + 1)
    }
  }
  walk(d, "", 0)
  return out
}

// ---- videos --------------------------------------------------------------------------------------------------

const VIDEO_FIELDS = [
  "item_id",
  "media_type",
  "is_ad",
  "share_url",
  "caption",
  "video_duration",
  "create_time",
  "likes",
  "comments",
  "shares",
  "favorites",
  "reach",
  "video_views",
  "total_time_watched",
  "average_time_watched",
  "full_video_watched_rate",
  "new_followers",
  "profile_views",
  "website_clicks",
]

export async function listVideos(call: Call, a: { limit: number; cursor: number | null; videoIds?: string[] }) {
  const d = await call("account_user_post_list_get", {
    fields: VIDEO_FIELDS,
    max_count: a.limit,
    ...(a.cursor !== null ? { cursor: a.cursor } : {}),
    ...(a.videoIds?.length ? { filters: { video_ids: a.videoIds } } : {}),
  })
  const videos = (Array.isArray(d.videos) ? (d.videos as Raw[]) : [])
    .map((v) => ({
      video_id: id(v.item_id),
      media_type: str(v.media_type, 20),
      created_at: tiktokTime(v.create_time),
      caption: typeof v.caption === "string" ? cutText(v.caption.replace(UNSAFE_TEXT_CHARS, "").trim(), CAPTION_MAX) : null,
      url: httpsUrl(v.share_url)?.split("?")[0] ?? null,
      duration_s: num(v.video_duration),
      is_ad: bool(v.is_ad),
      views: num(v.video_views),
      reach: num(v.reach),
      likes: num(v.likes),
      comments: num(v.comments),
      shares: num(v.shares),
      favorites: num(v.favorites),
      avg_watch_s: num(v.average_time_watched),
      total_watch_s: num(v.total_time_watched),
      full_watch_rate: num(v.full_video_watched_rate),
      new_followers: num(v.new_followers),
      profile_views: num(v.profile_views),
      website_clicks: num(v.website_clicks),
    }))
    .filter((v) => v.video_id)
  return { videos, nextCursor: d.has_more === true ? num(d.cursor) : null }
}

// ---- comments ------------------------------------------------------------------------------------------------

export interface TiktokComment {
  comment_id: string
  parent_comment_id: string | null
  created_at: string | null
  author: { username: string | null; display_name: string | null; is_owner: boolean }
  text: string | null
  likes: number | null
  reply_count: number | null
  status: string | null
  pinned: boolean | null
  liked_by_owner: boolean | null
  replies?: TiktokComment[]
  owner_replied?: boolean
}

function toComment(c: Raw, counts: MaskCounts): TiktokComment | null {
  const cid = id(c.comment_id)
  if (!cid) return null
  const replyList = Array.isArray(c.reply_list) ? (c.reply_list as Raw[]) : null
  const out: TiktokComment = {
    comment_id: cid,
    parent_comment_id: id(c.parent_comment_id),
    created_at: tiktokTime(c.create_time),
    author: { username: str(c.username, 64), display_name: str(c.display_name, 80), is_owner: c.owner === true },
    text: maskedText(c.text, counts),
    likes: num(c.likes),
    reply_count: num(c.replies) ?? (replyList ? replyList.length : null),
    status: str(c.status, 20),
    pinned: bool(c.pinned),
    liked_by_owner: bool(c.liked),
  }
  if (replyList) {
    out.replies = replyList.map((r) => toComment(r, counts)).filter((r): r is TiktokComment => r !== null)
    out.owner_replied = out.replies.some((r) => r.author.is_owner)
  }
  return out
}

export const COMMENT_SORTS = {
  newest: { sort_field: "create_time", sort_order: "desc" },
  oldest: { sort_field: "create_time", sort_order: "asc" },
  most_liked: { sort_field: "likes", sort_order: "desc" },
  most_replied: { sort_field: "replies", sort_order: "desc" },
} as const
export type CommentSort = keyof typeof COMMENT_SORTS

export async function listComments(
  call: Call,
  a: { videoId: string; sort: CommentSort; includeReplies: boolean; includeHidden: boolean; limit: number; cursor: number | null; commentId?: string }
) {
  const counts: MaskCounts = { phones: 0, emails: 0 }
  const common = {
    video_id: a.videoId,
    max_count: a.limit,
    status: a.includeHidden ? "ALL" : "PUBLIC",
    ...COMMENT_SORTS[a.sort],
    ...(a.cursor !== null ? { cursor: a.cursor } : {}),
  }
  const d = a.commentId
    ? await call("account_user_comment_reply_list_get", { ...common, comment_id: a.commentId })
    : await call("account_user_comment_list_get", { ...common, include_replies: a.includeReplies })
  const list = Array.isArray(d.comments) ? (d.comments as Raw[]) : []
  const comments = list.map((c) => toComment(c, counts)).filter((c): c is TiktokComment => c !== null)
  // a top-level comment without any reply carries no reply_list (live): say "not replied" explicitly
  if (a.includeReplies && !a.commentId) {
    for (const c of comments) {
      c.replies ??= []
      c.owner_replied ??= false
    }
  }
  return { comments, nextCursor: d.has_more === true ? num(d.cursor) : null, masked: counts }
}

// ---- mentions (Business Accounts) ----------------------------------------------------------------------------

export const MENTION_KINDS = ["posts", "comments", "top_words", "top_hashtags", "brand_hashtag_posts", "brand_hashtags"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

const MENTION_POST_FIELDS = ["item_id", "create_time", "video_link", "caption", "likes", "comments", "shares", "views", "reach", "creator_handle_name"]
/** allowed values (TikTok error message, live 2026-11-15): item_id, video_link, caption, video_likes, commenter_display_name,
 * comment_id, comment_type, comment_text, comment_create_time, comment_likes, thumbnail_url */
const MENTION_COMMENT_FIELDS = ["item_id", "comment_id", "comment_type", "comment_text", "comment_create_time", "comment_likes", "video_likes", "commenter_display_name", "video_link"]

function toMentionPost(p: Raw, counts: MaskCounts) {
  return {
    video_id: id(p.item_id),
    created_at: tiktokTime(p.create_time),
    url: httpsUrl(p.video_link),
    creator: str(p.creator_handle_name, 64),
    caption: maskedText(p.caption, counts, CAPTION_MAX),
    views: num(p.views),
    reach: num(p.reach),
    likes: num(p.likes),
    comments: num(p.comments),
    shares: num(p.shares),
  }
}

/** list of posts / comments: TikTok uses different array keys per endpoint - take the first array found */
function firstArray(d: Raw): Raw[] {
  for (const v of Object.values(d)) if (Array.isArray(v)) return v as Raw[]
  return []
}

export async function listMentions(
  call: Call,
  a: { kind: MentionKind; username: string; days: number; limit: number; cursor: number | null; hashtag?: string; regions?: string[] }
) {
  const counts: MaskCounts = { phones: 0, emails: 0 }
  const page = { max_count: a.limit, number_of_days: a.days, ...(a.cursor !== null ? { cursor: a.cursor } : {}), ...(a.regions?.length ? { regions: a.regions } : {}) }
  let items: unknown[] = []
  let d: Raw = {}
  switch (a.kind) {
    case "posts":
      d = await call("account_user_mention_post_list_get", { ...page, fields: MENTION_POST_FIELDS })
      items = firstArray(d).map((p) => toMentionPost(p, counts))
      break
    case "brand_hashtag_posts":
      d = await call("account_user_mention_hashtag_video_list_get", { ...page, fields: MENTION_POST_FIELDS, ...(a.hashtag ? { hashtag: a.hashtag } : {}) })
      items = firstArray(d).map((p) => toMentionPost(p, counts))
      break
    case "comments":
      d = await call("account_user_mention_comment_list_get", { ...page, fields: MENTION_COMMENT_FIELDS })
      items = firstArray(d).map((c) => ({
        video_id: id(c.item_id),
        comment_id: id(c.comment_id),
        created_at: tiktokTime(c.comment_create_time),
        commenter: str(c.commenter_display_name, 80),
        comment_type: str(c.comment_type, 20),
        text: maskedText(c.comment_text, counts),
        likes: num(c.comment_likes),
        video_likes: num(c.video_likes),
        url: httpsUrl(c.video_link),
      }))
      break
    case "top_words":
    case "top_hashtags": {
      d = await call(a.kind === "top_words" ? "account_user_mention_top_word_list_get" : "account_user_mention_top_hashtag_list_get", a.regions?.length ? { regions: a.regions } : {})
      items = firstArray(d)
        .map((w) => {
          const text = str(w.word ?? w.hashtag ?? w.name ?? w.keyword, 100)
          const count = num(w.count ?? w.post_count ?? w.video_count ?? w.mentions)
          return text ? { text, count } : null
        })
        .filter(Boolean)
      break
    }
    case "brand_hashtags": {
      const [enabled, valid] = await Promise.all([
        call("account_user_mention_hashtag_manage_list_get", { username: a.username }).catch(() => ({}) as Raw),
        call("account_user_mention_hashtag_verify_list_get", { username: a.username }).catch(() => ({}) as Raw),
      ])
      const names = (r: Raw) =>
        firstArray(r)
          .map((h) => str(typeof h === "string" ? h : (h.hashtag ?? h.name), 100))
          .filter((x): x is string => !!x)
      items = [{ enabled: names(enabled), can_enable: names(valid) }]
      break
    }
  }
  const more = d.has_more === true || (d.page_info as Raw | undefined)?.has_more === true
  const cur = num(d.cursor ?? (d.page_info as Raw | undefined)?.cursor)
  return { items, nextCursor: more ? cur : null, masked: counts }
}

// ---- trends --------------------------------------------------------------------------------------------------

export const TREND_KINDS = ["trending_keywords", "keyword_suggestions", "trending_music", "music_videos", "hashtag_suggestions"] as const
export type TrendKind = (typeof TREND_KINDS)[number]

export async function getTrends(
  call: Call,
  a: { kind: TrendKind; query?: string; personalized: boolean; countryCode: string; dateRange: string; genre?: string; musicId?: string; language: string; limit: number }
) {
  switch (a.kind) {
    case "trending_keywords": {
      const d = await call("discovery_search", { is_personalized: a.personalized })
      return { items: kw(d) }
    }
    case "keyword_suggestions": {
      const d = await call("discovery_search_recommend_get", { query: a.query, is_personalized: a.personalized })
      return { items: kw(d) }
    }
    case "hashtag_suggestions": {
      // TikTok refuses spaces (live 2026-11-15: "Keyword cannot contain blank space.")
      const d = await call("account_user_hashtag_suggestion_get", { keyword: (a.query ?? "").replace(/\s+/g, ""), language: a.language })
      return {
        items: firstArray(d)
          .map((h) => ({ hashtag: str(h.name, 100), posts: num(h.post_count), views: num(h.view_count) }))
          .filter((h) => h.hashtag)
          .slice(0, a.limit),
      }
    }
    case "trending_music": {
      const d = await call("discovery_cml_list_get", { country_code: a.countryCode, date_range: a.dateRange, ...(a.genre ? { genre: a.genre } : {}) })
      return {
        items: firstArray(d)
          .map((m) => ({
            music_id: id(m.commercial_music_id),
            name: str(m.commercial_music_name, 120),
            artist: str(m.artist, 80),
            rank: num(m.rank_position),
            duration_s: num(m.duration),
            genres: Array.isArray(m.genres) ? (m.genres as unknown[]).map((g) => str(g, 40)).filter(Boolean).slice(0, 5) : [],
            preview_url: httpsUrl(m.preview_url),
          }))
          .filter((m) => m.music_id)
          .slice(0, a.limit),
      }
    }
    case "music_videos": {
      const d = await call("discovery_cml_post_list_get", { commercial_music_id: a.musicId, country_code: a.countryCode })
      return {
        items: firstArray(d)
          .map((v) => ({
            video_id: id(v.item_id ?? v.video_id),
            url: httpsUrl(v.video_link ?? v.share_url ?? v.url),
            likes: num(v.likes),
            views: num(v.views ?? v.video_views),
            comments: num(v.comments),
            shares: num(v.shares),
          }))
          .slice(0, a.limit),
      }
    }
  }
}

function kw(d: Raw): { keyword: string; rank: number }[] {
  const list = Array.isArray(d.search_keywords) ? (d.search_keywords as unknown[]) : firstArray(d)
  return list
    .map((k) => str(typeof k === "string" ? k : (k as Raw)?.keyword, 120))
    .filter((k): k is string => !!k)
    .map((keyword, i) => ({ keyword, rank: i + 1 }))
}
