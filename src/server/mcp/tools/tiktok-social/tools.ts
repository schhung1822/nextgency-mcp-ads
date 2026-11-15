// TikTok Social tools (17-tiktok-social.md §6) - all read only. Data from TikTok's Social MCP server for the TikTok
// accounts picked for this MCP. Comments / mentions are third-party text: contacts masked (TS3), call logs keep counts
// and ids only (logResponse).
import { z } from "zod"

import {
  BUSINESS_CATEGORIES,
  COMMENT_SORTS,
  getAccountInsights,
  getBenchmark,
  getTrends,
  listComments,
  listMentions,
  listVideos,
  MENTION_KINDS,
  TREND_KINDS,
  type TiktokComment,
} from "../../../tiktok-social/data"
import type { CursorBinding } from "../../cursor"
import { invalid } from "../../errors"
import { jsonLength, MAX_STRUCTURED_CHARS, READ_ANNOTATIONS, registerToolSpec, type ToolContext } from "../../tool"
import {
  accountIdSchema,
  accountRef,
  assertTiktokSocialAccount,
  notBusinessWarning,
  readCursor,
  UNTRUSTED_NOTE,
  withAccount,
  writeCursor,
} from "./shared"

type Server = Parameters<typeof registerToolSpec>[0]
const OPEN_READ = { ...READ_ANNOTATIONS, openWorldHint: true }
const anyObj = z.record(z.string(), z.unknown())
const masked = z.object({ phones: z.number(), emails: z.number() })
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày dạng YYYY-MM-DD")

/** cut a list until its JSON fits the structured budget */
function fit<T>(list: T[], budget = MAX_STRUCTURED_CHARS - 3_000): { list: T[]; cut: boolean } {
  let out = list
  let cut = false
  while (out.length > 1 && jsonLength(out) > budget) {
    out = out.slice(0, Math.max(1, Math.floor(out.length * 0.8)))
    cut = true
  }
  return { list: out, cut }
}

// ---- tiktok_social_list_accounts -----------------------------------------------------------------------------

export const LIST_ACCOUNTS = "tiktok_social_list_accounts"

function registerListAccounts(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: LIST_ACCOUNTS,
    title: "Tài khoản TikTok (TikTok Social)",
    description:
      "Dùng khi cần biết MCP được đọc những tài khoản TikTok (kênh đăng video, không phải tài khoản quảng cáo) nào: " +
      "account_id, @username, tên, có phải Business Account không, trạng thái kết nối. Gọi trước mọi tool tiktok_social_*. " +
      "Không gọi TikTok.",
    kind: "read",
    annotations: READ_ANNOTATIONS,
    input: z.object({}),
    output: z.object({
      accounts: z.array(
        z.object({
          account_id: z.string(),
          username: z.string(),
          name: z.string(),
          display_name: z.string().nullable(),
          is_business_account: z.boolean().nullable(),
          status: z.string(),
        })
      ),
    }),
    async handler(_args, env) {
      const accounts = env.grant.tiktokSocialAccounts.map((a) => ({
        account_id: a.id,
        username: a.username,
        name: a.name,
        display_name: a.displayName,
        is_business_account: a.isBusinessAccount,
        status: a.status,
      }))
      return { structured: { accounts }, summary: `${accounts.length} tài khoản TikTok trong MCP.` }
    },
  })
}

// ---- tiktok_social_get_account -------------------------------------------------------------------------------

export const GET_ACCOUNT = "tiktok_social_get_account"

function registerGetAccount(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: GET_ACCOUNT,
    title: "Chỉ số kênh TikTok",
    description:
      "Dùng khi cần thông tin + chỉ số của một kênh TikTok: người theo dõi, tổng lượt thích, số video, chỉ số theo ngày " +
      "(lượt xem video, xem hồ sơ, thích, bình luận, chia sẻ, người theo dõi mới / mất), khán giả (tuổi, giới tính, quốc gia, " +
      "thành phố). Ngày theo UTC, mặc định 7 ngày gần nhất; TikTok trễ 24–48 giờ và chỉ giữ ~60 ngày. benchmark_category = " +
      "so sánh với chỉ số chuẩn của ngành (vd BEAUTY, ELECTRONICS). Chỉ có dữ liệu TikTok Analytics đã bật trên kênh.",
    kind: "read",
    annotations: OPEN_READ,
    input: z.object({
      account_id: accountIdSchema,
      start_date: dateSchema.optional().describe("YYYY-MM-DD (UTC), mặc định 7 ngày trước"),
      end_date: dateSchema.optional().describe("YYYY-MM-DD (UTC), mặc định hôm qua"),
      benchmark_category: z.enum(BUSINESS_CATEGORIES).optional().describe("Ngành để lấy chỉ số chuẩn so sánh"),
    }),
    output: z.object({
      account_id: z.string(),
      username: z.string(),
      profile: anyObj,
      totals: anyObj,
      daily: z.array(anyObj),
      audience: anyObj,
      benchmark: anyObj.nullable(),
      warnings: z.array(z.string()),
    }),
    async handler(args, env) {
      const a = assertTiktokSocialAccount(env.grant, args.account_id)
      const warnings: string[] = []
      const { insights, benchmark } = await withAccount(env, a, async (call) => {
        const insights = await getAccountInsights(call, { startDate: args.start_date, endDate: args.end_date })
        let benchmark: Record<string, unknown> | null = null
        if (args.benchmark_category) {
          try {
            benchmark = await getBenchmark(call, args.benchmark_category)
          } catch {
            warnings.push("TikTok không trả chỉ số chuẩn của ngành này (có thể chỉ dành cho Business Account).")
          }
        }
        return { insights, benchmark }
      })
      // TikTok fills the newest day(s) late (24-48 h): a trailing day with followers_count 0 is not real data yet
  const last = insights.daily.at(-1)
      if (last && last.followers_count === 0 && insights.daily.some((d) => typeof d.followers_count === "number" && d.followers_count > 0)) warnings.push(`Ngày ${String(last.date)} TikTok chưa cập nhật đủ (trễ 24–48 giờ) - các số = 0 của ngày đó không phải số thật.`)
      if (insights.daily.length === 0) warnings.push("Không có chỉ số theo ngày (Analytics chưa bật, chưa có video, hoặc khoảng ngày quá xa).")
      return {
        structured: { ...accountRef(a), ...insights, benchmark, warnings },
        summary: `Kênh @${a.username}: ${insights.totals.followers ?? "?"} người theo dõi, ${insights.daily.length} ngày chỉ số.`,
      }
    },
  })
}

// ---- tiktok_social_list_videos -------------------------------------------------------------------------------

export const LIST_VIDEOS = "tiktok_social_list_videos"

function registerListVideos(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: LIST_VIDEOS,
    title: "Video của kênh TikTok",
    description:
      "Dùng khi cần danh sách video / bài ảnh công khai của kênh TikTok (mới nhất trước) kèm chỉ số trọn đời: lượt xem, " +
      "reach, thích, bình luận, chia sẻ, lưu, thời gian xem trung bình, tỉ lệ xem hết, người theo dõi mới, is_ad (đang chạy " +
      "quảng cáo). video_id dùng cho tiktok_social_list_comments; tạo quảng cáo Spark bằng tiktok_create_ads (nếu MCP có " +
      "TikTok Ads) cần mã ủy quyền Spark của video. video_ids = chỉ lấy các video này. Dùng next_cursor để lấy tiếp.",
    kind: "read",
    annotations: OPEN_READ,
    input: z.object({
      account_id: accountIdSchema,
      limit: z.number().int().min(1).max(20).default(10),
      video_ids: z.array(z.string().regex(/^\d{1,30}$/)).max(20).optional(),
      cursor: z.string().max(2_000).optional().describe("next_cursor của lần gọi trước (giữ nguyên tham số khác)"),
    }),
    output: z.object({
      account_id: z.string(),
      username: z.string(),
      videos: z.array(anyObj),
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
    async handler(args, env) {
      const a = assertTiktokSocialAccount(env.grant, args.account_id)
      const { cursor: _c, ...query } = args
      const bind: CursorBinding = { mcpId: env.grant.mcpId, tool: LIST_VIDEOS, accountIds: [a.id], query }
      const cursor = readCursor(args.cursor, bind)
      const res = await withAccount(env, a, (call) => listVideos(call, { limit: args.limit, cursor, videoIds: args.video_ids }))
      const { list, cut } = fit(res.videos)
      const next = cut ? null : writeCursor(res.nextCursor, bind)
      return {
        structured: {
          ...accountRef(a),
          videos: list,
          has_more: next !== null,
          next_cursor: next,
          warnings: cut ? [`Kết quả quá dài: chỉ trả ${list.length} video - gọi lại với limit=${list.length}.`] : [],
        },
        summary: `${list.length} video của @${a.username}${next ? " (còn tiếp)" : ""}.`,
      }
    },
  })
}

// ---- tiktok_social_list_comments -----------------------------------------------------------------------------

export const LIST_COMMENTS = "tiktok_social_list_comments"

export function commentsLogResponse(s: Record<string, unknown>): Record<string, unknown> {
  const list = Array.isArray(s.comments) ? (s.comments as { comment_id?: unknown; replies?: unknown[] }[]) : []
  return {
    account_id: s.account_id,
    video_id: s.video_id,
    comments: list.length,
    replies: list.reduce((n, c) => n + (Array.isArray(c.replies) ? c.replies.length : 0), 0),
    comment_ids: list.map((c) => c.comment_id),
    masked: s.masked,
    has_more: s.has_more,
  }
}

function registerListComments(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: LIST_COMMENTS,
    title: "Bình luận video TikTok",
    description:
      "Dùng khi cần đọc bình luận của một video trên kênh TikTok (chỉ đọc, không trả lời / ẩn): nội dung, thời gian, " +
      "người viết (username, tên hiển thị, is_owner = chủ kênh), lượt thích, số trả lời, ghim, kèm trả lời và owner_replied " +
      "= chủ kênh đã trả lời chưa (lọc khách hỏi mà chưa ai trả lời). sort: newest (mặc định) / oldest / most_liked / " +
      "most_replied. Xem hết trả lời của một bình luận: comment_id. include_hidden = cả bình luận bị ẩn. video_id lấy từ " +
      "tiktok_social_list_videos. Số điện thoại / email trong bình luận đã được che. " +
      UNTRUSTED_NOTE,
    kind: "read",
    annotations: OPEN_READ,
    input: z.object({
      account_id: accountIdSchema,
      video_id: z.string().regex(/^\d{1,30}$/, "video_id là dãy số"),
      sort: z.enum(Object.keys(COMMENT_SORTS) as [keyof typeof COMMENT_SORTS, ...(keyof typeof COMMENT_SORTS)[]]).default("newest"),
      include_replies: z.boolean().default(true),
      include_hidden: z.boolean().default(false),
      comment_id: z.string().regex(/^\d{1,30}$/).optional().describe("Chỉ lấy trả lời của bình luận này"),
      limit: z.number().int().min(1).max(30).default(20),
      cursor: z.string().max(2_000).optional(),
    }),
    output: z.object({
      account_id: z.string(),
      username: z.string(),
      video_id: z.string(),
      comment_id: z.string().nullable(),
      comments: z.array(anyObj),
      masked,
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
    logResponse: commentsLogResponse,
    async handler(args, env) {
      const a = assertTiktokSocialAccount(env.grant, args.account_id)
      const { cursor: _c, ...query } = args
      const bind: CursorBinding = { mcpId: env.grant.mcpId, tool: LIST_COMMENTS, accountIds: [a.id], query }
      const cursor = readCursor(args.cursor, bind)
      env.log.setTarget({ objectIds: [args.video_id, ...(args.comment_id ? [args.comment_id] : [])] })
      const res = await withAccount(env, a, (call) =>
        listComments(call, {
          videoId: args.video_id,
          sort: args.sort,
          includeReplies: args.include_replies,
          includeHidden: args.include_hidden,
          limit: args.limit,
          cursor,
          commentId: args.comment_id,
        })
      )
      const { list, cut } = fit<TiktokComment>(res.comments)
      const next = cut ? null : writeCursor(res.nextCursor, bind)
      const warnings: string[] = []
      if (cut) warnings.push(`Kết quả quá dài: chỉ trả ${list.length} bình luận - gọi lại với limit=${list.length} (hoặc include_replies=false).`)
      if (res.masked.phones || res.masked.emails) warnings.push(`Đã che ${res.masked.phones} số điện thoại và ${res.masked.emails} email.`)
      return {
        structured: {
          ...accountRef(a),
          video_id: args.video_id,
          comment_id: args.comment_id ?? null,
          comments: list as unknown as Record<string, unknown>[],
          masked: res.masked,
          has_more: next !== null,
          next_cursor: next,
          warnings,
        },
        summary: `${list.length} ${args.comment_id ? "trả lời" : "bình luận"} của video ${args.video_id}${next ? " (còn tiếp)" : ""}.`,
      }
    },
  })
}

// ---- tiktok_social_list_mentions -----------------------------------------------------------------------------

export const LIST_MENTIONS = "tiktok_social_list_mentions"

export function mentionsLogResponse(s: Record<string, unknown>): Record<string, unknown> {
  const list = Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : []
  return {
    account_id: s.account_id,
    kind: s.kind,
    items: list.length,
    video_ids: list.map((i) => i.video_id).filter(Boolean).slice(0, 100),
    masked: s.masked,
    has_more: s.has_more,
  }
}

function registerListMentions(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: LIST_MENTIONS,
    title: "Nhắc tên thương hiệu trên TikTok",
    description:
      "Dùng khi cần theo dõi người khác nhắc tới thương hiệu (chỉ Business Account, 90 ngày gần nhất, tối đa 1.000 mục): " +
      "kind posts = video @nhắc tên kênh trong chú thích; comments = bình luận @nhắc tên kênh; top_words / top_hashtags = " +
      "20 từ / hashtag hay đi kèm; brand_hashtags = hashtag thương hiệu đã bật + có thể bật; brand_hashtag_posts = video " +
      "dùng hashtag thương hiệu (hashtag). Số điện thoại / email đã được che. " +
      UNTRUSTED_NOTE,
    kind: "read",
    annotations: OPEN_READ,
    input: z.object({
      account_id: accountIdSchema,
      kind: z.enum(MENTION_KINDS),
      days: z.number().int().min(1).max(90).default(30),
      hashtag: z.string().trim().max(100).optional().describe("brand_hashtag_posts: một hashtag thương hiệu đã bật"),
      regions: z.array(z.string().regex(/^[A-Z]{2}$/)).max(20).optional().describe("Mã quốc gia, vd [\"VN\"]"),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().max(2_000).optional(),
    }),
    output: z.object({
      account_id: z.string(),
      username: z.string(),
      kind: z.string(),
      items: z.array(z.unknown()),
      masked,
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
      warnings: z.array(z.string()),
    }),
    logResponse: mentionsLogResponse,
    async handler(args, env) {
      const a = assertTiktokSocialAccount(env.grant, args.account_id)
      const { cursor: _c, ...query } = args
      const bind: CursorBinding = { mcpId: env.grant.mcpId, tool: LIST_MENTIONS, accountIds: [a.id], query }
      const cursor = readCursor(args.cursor, bind)
      const res = await withAccount(env, a, (call) =>
        listMentions(call, {
          kind: args.kind,
          username: a.username,
          days: args.days,
          limit: args.limit,
          cursor,
          hashtag: args.hashtag?.replace(/^#/, ""),
          regions: args.regions,
        })
      )
      const { list, cut } = fit(res.items)
      const next = cut ? null : writeCursor(res.nextCursor, bind)
      const warnings = [...notBusinessWarning(a)]
      if (cut) warnings.push(`Kết quả quá dài: chỉ trả ${list.length} mục - gọi lại với limit=${list.length}.`)
      if (list.length === 0 && a.isBusinessAccount !== false) warnings.push("Không có dữ liệu trong khoảng này.")
      return {
        structured: { ...accountRef(a), kind: args.kind, items: list, masked: res.masked, has_more: next !== null, next_cursor: next, warnings },
        summary: `${list.length} mục (${args.kind}) cho @${a.username}.`,
      }
    },
  })
}

// ---- tiktok_social_trends ------------------------------------------------------------------------------------

export const TRENDS = "tiktok_social_trends"

function registerTrends(server: Server, tctx: ToolContext) {
  registerToolSpec(server, tctx, {
    name: TRENDS,
    title: "Xu hướng TikTok",
    description:
      "Dùng khi cần ý tưởng nội dung từ xu hướng TikTok: trending_keywords = 20 từ khoá tìm kiếm đang thịnh hành " +
      "(personalized = theo kênh); keyword_suggestions = 20 từ khoá gợi ý cho query (sản phẩm / dịch vụ / thương hiệu); " +
      "hashtag_suggestions = hashtag gợi ý kèm số bài / lượt xem cho query (1 từ, không dấu cách); trending_music = nhạc " +
      "thương mại (dùng được cho video + quảng cáo) đang hot theo quốc gia (country_code, mặc định VN) và date_range; " +
      "music_videos = video nổi bật dùng một bài nhạc (music_id từ trending_music). account_id = kênh dùng để gọi TikTok.",
    kind: "read",
    annotations: OPEN_READ,
    input: z.object({
      account_id: accountIdSchema,
      kind: z.enum(TREND_KINDS),
      query: z.string().trim().min(1).max(255).optional(),
      personalized: z.boolean().default(false),
      country_code: z.string().regex(/^[A-Z]{2}$/).default("VN"),
      date_range: z.enum(["1DAY", "7DAY", "30DAY", "90DAY"]).default("7DAY"),
      genre: z.string().trim().max(40).optional(),
      music_id: z.string().regex(/^\d{1,30}$/).optional(),
      language: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?(-[A-Z]{2})?$/).default("vi-VN").describe("hashtag_suggestions: ngôn ngữ, vd vi-VN, en"),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    output: z.object({ account_id: z.string(), username: z.string(), kind: z.string(), items: z.array(z.unknown()), warnings: z.array(z.string()) }),
    async handler(args, env) {
      const a = assertTiktokSocialAccount(env.grant, args.account_id)
      if ((args.kind === "keyword_suggestions" || args.kind === "hashtag_suggestions") && !args.query) {
        throw invalid("invalid_input", "Cần query cho loại này.")
      }
      if (args.kind === "music_videos" && !args.music_id) {
        throw invalid("invalid_input", "Cần music_id (lấy từ trending_music).")
      }
      const res = await withAccount(env, a, (call) =>
        getTrends(call, {
          kind: args.kind,
          query: args.query,
          personalized: args.personalized,
          countryCode: args.country_code,
          dateRange: args.date_range,
          genre: args.genre,
          musicId: args.music_id,
          language: args.language,
          limit: args.limit,
        })
      )
      const { list } = fit<unknown>(res.items)
      return {
        structured: { ...accountRef(a), kind: args.kind, items: list, warnings: list.length ? [] : ["TikTok không trả kết quả."] },
        summary: `${list.length} kết quả (${args.kind}).`,
      }
    },
  })
}

export const TIKTOK_SOCIAL_TOOLS = [
  { NAME: LIST_ACCOUNTS, register: registerListAccounts },
  { NAME: GET_ACCOUNT, register: registerGetAccount },
  { NAME: LIST_VIDEOS, register: registerListVideos },
  { NAME: LIST_COMMENTS, register: registerListComments },
  { NAME: LIST_MENTIONS, register: registerListMentions },
  { NAME: TRENDS, register: registerTrends },
]
