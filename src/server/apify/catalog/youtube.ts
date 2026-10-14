// YouTube tasks. 16-apify.md §6. Input schemas checked on the Apify Store 2026-10-14.
// streamers~youtube-*: 0 in maxResultsShorts / maxResultStreams means "none of that type"; AI description /
// summary and transcripts are paid add-ons → off. youtube-comments defaults maxComments to 1 → always set.
import { z } from "zod"

import { defineTask, httpsUrl, HOSTS, singleLine, strictInput } from "./common"

const youtubeChannelUrl = httpsUrl("kênh YouTube", HOSTS.youtube, {
  test: (u) =>
    /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname),
  message:
    "Cần link kênh YouTube (dạng https://www.youtube.com/@tenkenh hoặc /channel/UC…).",
})

const youtubeVideoUrl = httpsUrl("video YouTube", HOSTS.youtube, {
  test: (u) =>
    (u.pathname === "/watch" && u.searchParams.has("v")) ||
    /^\/(shorts|live)\/[^/]+/.test(u.pathname) ||
    (u.hostname === "youtu.be" && u.pathname.length > 1),
  message:
    "Cần link video YouTube (dạng https://www.youtube.com/watch?v=… hoặc https://youtu.be/…).",
})

const VIDEO_FIELDS = [
  "title",
  "id",
  "url",
  "type",
  "viewCount",
  "likes",
  "commentsCount",
  "date",
  "duration",
  "channelName",
  "channelUrl",
  "numberOfSubscribers",
  "text",
]

/** streamers~youtube-scraper: no transcript, no AI add-on. */
const YOUTUBE_ADDONS_OFF = {
  transcriptionAndSubtitle: "NONE",
  aiVideoDescription: false,
  aiVideoSummary: false,
}

export const YOUTUBE_TASKS = [
  defineTask({
    key: "youtube_search",
    group: "youtube",
    titleVi: "Tìm video YouTube theo từ khoá",
    descriptionVi:
      "Dùng khi cần video YouTube theo từ khoá (review, đối thủ, xu hướng): tiêu đề, lượt xem, thích, bình luận, ngày đăng, kênh.",
    input: strictInput({
      keyword: singleLine().describe(
        'Từ khoá tìm kiếm, vd. "review máy lọc không khí"'
      ),
      upload_date: z
        .enum(["hour", "today", "week", "month", "year"])
        .optional()
        .describe("Chỉ video đăng trong: hour, today, week, month, year"),
      sort: z
        .enum(["relevance", "date", "views", "rating"])
        .optional()
        .describe("Sắp xếp: relevance, date, views, rating"),
    }),
    example: { keyword: "review máy lọc không khí", upload_date: "month" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.08,
    noteVi: "Chỉ video thường (không lấy Shorts / livestream).",
    actors: [
      {
        actorId: "streamers~youtube-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          searchQueries: [p.keyword],
          startUrls: [],
          maxResults: limit,
          maxResultsShorts: 0,
          maxResultStreams: 0,
          ...(p.upload_date ? { dateFilter: p.upload_date } : {}),
          ...(p.sort ? { sortingOrder: p.sort } : {}),
          ...YOUTUBE_ADDONS_OFF,
        }),
        resultFields: VIDEO_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "youtube_channel",
    group: "youtube",
    titleVi: "Video và chỉ số của một kênh YouTube",
    descriptionVi:
      "Dùng khi cần danh sách video của một kênh YouTube (đối thủ, KOL) kèm lượt xem, ngày đăng và chỉ số kênh (người đăng ký, tổng video, tổng lượt xem).",
    input: strictInput({
      channel_url: youtubeChannelUrl.describe(
        "Link kênh, vd. https://www.youtube.com/@tenkenh"
      ),
      sort: z
        .enum(["NEWEST", "POPULAR", "OLDEST"])
        .default("NEWEST")
        .describe(
          "NEWEST = mới nhất, POPULAR = phổ biến nhất, OLDEST = cũ nhất"
        ),
    }),
    example: { channel_url: "https://www.youtube.com/@tenkenh" },
    limit: { default: 30, max: 200 },
    estimatedCostUsd: 0.04,
    noteVi: "Chỉ video thường (không lấy Shorts / livestream).",
    actors: [
      {
        actorId: "streamers~youtube-channel-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.channel_url }],
          maxResults: limit,
          maxResultsShorts: 0,
          maxResultStreams: 0,
          sortVideosBy: p.sort,
        }),
        resultFields: [
          "title",
          "url",
          "type",
          "viewCount",
          "date",
          "duration",
          "channelName",
          "channelUrl",
          "numberOfSubscribers",
          "channelTotalVideos",
          "channelTotalViews",
        ],
      },
      {
        actorId: "streamers~youtube-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.channel_url }],
          searchQueries: [],
          maxResults: limit,
          maxResultsShorts: 0,
          maxResultStreams: 0,
          sortVideosBy: p.sort,
          ...YOUTUBE_ADDONS_OFF,
        }),
        resultFields: VIDEO_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "youtube_comments",
    group: "youtube",
    titleVi: "Bình luận video YouTube",
    descriptionVi:
      "Dùng khi cần đọc bình luận của một video YouTube (phản hồi người xem, câu hỏi, cảm xúc về sản phẩm).",
    input: strictInput({
      video_url: youtubeVideoUrl.describe("Link video YouTube"),
      sort: z
        .enum(["top", "newest"])
        .default("top")
        .describe("top = nổi bật, newest = mới nhất"),
    }),
    example: { video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.2,
    noteVi:
      "Trần chi phí tối thiểu của Actor: $0.50/lần chạy. Bình luận có tên người dùng (dữ liệu cá nhân).",
    actors: [
      {
        actorId: "streamers~youtube-comments-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.video_url }],
          maxComments: limit,
          sortCommentsBy: p.sort === "top" ? "TOP_COMMENTS" : "NEWEST_FIRST",
        }),
        resultFields: [
          "comment",
          "voteCount",
          "replyCount",
          "publishedTimeText",
          "hasCreatorHeart",
          "authorIsChannelOwner",
          "title",
          "pageUrl",
          "type",
        ],
      },
    ],
  }),
]
