// TikTok tasks: videos, hashtag, profile, comments, Creative Center top ads (+ beta trends). 16-apify.md §6.
// Input schemas checked on the Apify Store 2026-10-14. clockworks~* charge per add-on (date / popularity filters,
// search sorting, "scrape as in country", downloads, transcripts, AI description/summary, comments, followers)
// → every add-on is switched off explicitly. apidojo~* expose `customMapFunction` (custom JS) and MCP output
// connectors (`outputConnector`, `deliverTarget`…) → never set. The TikTok Ads Library only covers EEA/UK/CH, so
// ads research for VN goes through the Creative Center (tiktok_top_ads).
import { z } from "zod"

import {
  defineTask,
  hashtagField,
  httpsUrl,
  HOSTS,
  singleLine,
  strictInput,
  stripHash,
  tiktokHandle,
} from "./common"

/** Creative Center markets present in both automation_craft (enum) and datapeak (free text). */
const CREATIVE_CENTER_COUNTRIES = [
  "VN",
  "TH",
  "ID",
  "MY",
  "PH",
  "SG",
  "KH",
  "US",
  "GB",
  "AU",
  "CA",
  "JP",
  "KR",
  "TW",
  "DE",
  "FR",
] as const

const creativeCenterCountry = z
  .enum(CREATIVE_CENTER_COUNTRIES)
  .default("VN")
  .describe("Quốc gia (mặc định VN)")

/** video / photo post URL (…/@user/video/ID, …/@user/photo/ID) or a vt.tiktok.com / vm.tiktok.com short link */
const tiktokPostUrl = httpsUrl("video TikTok", HOSTS.tiktok, {
  test: (u) =>
    /\/(video|photo)\/\d+/.test(u.pathname) ||
    u.hostname === "vt.tiktok.com" ||
    u.hostname === "vm.tiktok.com",
  message:
    "Cần link video TikTok (dạng https://www.tiktok.com/@kenh/video/123…).",
})

const tiktokProfileRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (v) => tiktokHandle(v) !== null,
    'Cần tên kênh TikTok (vd. "@tenkenh") hoặc link https://www.tiktok.com/@tenkenh.'
  )

/** validated by tiktokProfileRef, so the fallback never applies in practice */
function profileHandle(ref: string): string {
  return tiktokHandle(ref) ?? ref.trim().replace(/^@/, "")
}

/** clockworks~tiktok-scraper: every limit / add-on field pinned (results-only run). */
function clockworksScraperBase(limit: number) {
  return {
    resultsPerPage: limit,
    maxProfilesPerQuery: 1,
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: 0,
    commentsPerPost: 0,
    topLevelCommentsPerPost: 0,
    maxRepliesPerComment: 0,
    scrapeRelatedSearchWords: false,
    scrapeRelatedVideos: false,
    scrapeAdditionalAuthorMeta: false,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
    aiVideoDescription: false,
    aiVideoSummary: false,
    proxyCountryCode: "None",
  }
}

const CLOCKWORKS_VIDEO_FIELDS = [
  "text",
  "createTimeISO",
  "webVideoUrl",
  "playCount",
  "diggCount",
  "shareCount",
  "commentCount",
  "collectCount",
  "authorMeta",
  "videoMeta",
  "musicMeta",
  "hashtags",
  "isAd",
  "locationCreated",
]
const APIDOJO_VIDEO_FIELDS = [
  "id",
  "title",
  "views",
  "likes",
  "comments",
  "shares",
  "bookmarks",
  "uploadedAt",
  "uploadedAtFormatted",
  "postPage",
  "channel",
]

export const TIKTOK_TASKS = [
  defineTask({
    key: "tiktok_search_videos",
    group: "tiktok",
    titleVi: "Tìm video TikTok theo từ khoá",
    descriptionVi:
      "Dùng khi cần video TikTok theo từ khoá (review sản phẩm, trend, đối thủ): nội dung, lượt xem, thích, chia sẻ, bình luận, tác giả, có gắn TikTok Shop/quảng cáo không.",
    input: strictInput({
      keyword: singleLine().describe(
        'Từ khoá tìm kiếm, vd. "review kem chống nắng"'
      ),
    }),
    example: { keyword: "review kem chống nắng" },
    limit: { default: 30, max: 100 },
    estimatedCostUsd: 0.11,
    actors: [
      {
        actorId: "clockworks~tiktok-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          searchQueries: [p.keyword],
          searchSection: "/video",
          videoSearchSorting: "MOST_RELEVANT",
          videoSearchDateFilter: "ALL_TIME",
          ...clockworksScraperBase(limit),
        }),
        resultFields: CLOCKWORKS_VIDEO_FIELDS,
        noteVi: "Trần chi phí tối thiểu của Actor: $0.50/lần chạy.",
      },
      {
        actorId: "apidojo~tiktok-scraper",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          keywords: [p.keyword],
          location: "VN",
          sortType: "RELEVANCE",
          dateRange: "DEFAULT",
          maxItems: limit,
          includeSearchKeywords: false,
        }),
        resultFields: APIDOJO_VIDEO_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiktok_hashtag_videos",
    group: "tiktok",
    titleVi: "Video TikTok theo hashtag",
    descriptionVi:
      "Dùng khi cần video TikTok gắn một hashtag (đo độ phủ chiến dịch, tìm KOC): nội dung, lượt xem, thích, chia sẻ, tác giả.",
    input: strictInput({
      hashtag: hashtagField().describe(
        'Hashtag, có hoặc không có #, vd. "skincarevietnam"'
      ),
    }),
    example: { hashtag: "skincarevietnam" },
    limit: { default: 30, max: 200 },
    estimatedCostUsd: 0.09,
    actors: [
      {
        actorId: "clockworks~tiktok-hashtag-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          hashtags: [stripHash(p.hashtag)],
          resultsPerPage: limit,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSlideshowImages: false,
          downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
        }),
        resultFields: CLOCKWORKS_VIDEO_FIELDS,
      },
      {
        actorId: "clockworks~tiktok-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          hashtags: [stripHash(p.hashtag)],
          ...clockworksScraperBase(limit),
        }),
        resultFields: CLOCKWORKS_VIDEO_FIELDS,
        noteVi: "Trần chi phí tối thiểu của Actor: $0.50/lần chạy.",
      },
    ],
  }),

  defineTask({
    key: "tiktok_profile_videos",
    group: "tiktok",
    titleVi: "Video gần đây của một kênh TikTok",
    descriptionVi:
      "Dùng khi cần video của một kênh TikTok (đối thủ, KOL) kèm chỉ số từng video và thông tin kênh (follower, tổng tim) trong trường authorMeta.",
    input: strictInput({
      username: tiktokProfileRef.describe(
        'Tên kênh (có hoặc không có @) hoặc link kênh, vd. "@tenthuonghieu"'
      ),
      sort: z
        .enum(["latest", "popular"])
        .default("latest")
        .describe(
          "latest = mới nhất, popular = nhiều tương tác nhất (chỉ Actor chính)"
        ),
    }),
    example: { username: "@tenthuonghieu" },
    limit: { default: 30, max: 100 },
    estimatedCostUsd: 0.09,
    actors: [
      {
        actorId: "clockworks~tiktok-profile-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          profiles: [profileHandle(p.username)],
          profileScrapeSections: ["videos"],
          profileSorting: p.sort,
          resultsPerPage: limit,
          excludePinnedPosts: false,
          maxFollowersPerProfile: 0,
          maxFollowingPerProfile: 0,
          commentsPerPost: 0,
          topLevelCommentsPerPost: 0,
          maxRepliesPerComment: 0,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSlideshowImages: false,
          shouldDownloadAvatars: false,
          downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
        }),
        resultFields: CLOCKWORKS_VIDEO_FIELDS,
      },
      {
        actorId: "apidojo~tiktok-scraper",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          startUrls: [`https://www.tiktok.com/@${profileHandle(p.username)}`],
          maxItems: limit,
          includeSearchKeywords: false,
        }),
        resultFields: APIDOJO_VIDEO_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiktok_comments",
    group: "tiktok",
    titleVi: "Bình luận của video TikTok",
    descriptionVi:
      "Dùng khi cần đọc bình luận của một video TikTok (phản hồi khách hàng, câu hỏi thường gặp, cảm xúc về sản phẩm).",
    input: strictInput({
      url: tiktokPostUrl.describe("Link video TikTok"),
    }),
    example: {
      url: "https://www.tiktok.com/@tenkenh/video/7400000000000000000",
    },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.13,
    noteVi:
      "Bình luận chứa tên người dùng (dữ liệu cá nhân) — chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "clockworks~tiktok-comments-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          postURLs: [p.url],
          commentsPerPost: limit,
          topLevelCommentsPerPost: limit,
          maxRepliesPerComment: 0,
          // profile mode only (videos per profile); pinned to the minimum
          resultsPerPage: 1,
        }),
        resultFields: [
          "text",
          "diggCount",
          "replyCommentTotal",
          "createTimeISO",
          "uniqueId",
          "videoWebUrl",
          "cid",
        ],
      },
      {
        actorId: "apidojo~tiktok-comments-scraper",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          startUrls: [p.url],
          maxItems: limit,
          includeReplies: false,
        }),
        resultFields: [
          "id",
          "text",
          "createdAt",
          "likeCount",
          "replyCount",
          "commentLanguage",
        ],
      },
    ],
  }),

  defineTask({
    key: "tiktok_top_ads",
    group: "tiktok",
    titleVi: "Quảng cáo TikTok nổi bật (Creative Center)",
    descriptionVi:
      "Dùng khi cần xem quảng cáo TikTok hiệu quả cao tại VN (TikTok Creative Center – Top Ads): thương hiệu, tiêu đề, lượt thích, CTR, ngành, mục tiêu, landing page, link video.",
    input: strictInput({
      country: creativeCenterCountry,
      period: z
        .enum(["7", "30", "180"])
        .default("30")
        .describe("Khoảng thời gian: 7, 30 hoặc 180 ngày gần đây"),
      order_by: z
        .enum(["for_you", "ctr", "like"])
        .default("for_you")
        .describe("Xếp hạng: for_you (mặc định của TikTok), ctr, like"),
    }),
    example: { country: "VN", period: "30", order_by: "ctr" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.03,
    noteVi:
      "Nguồn: TikTok Creative Center (không cần đăng nhập). TikTok Ads Library chính thức chỉ phủ EU/UK/Thuỵ Sĩ nên không dùng cho VN. Link video/ảnh có hạn dùng (mediaExpiresAt).",
    actors: [
      {
        actorId: "automation_craft~tiktok-creative-center-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        // sweeps off: one filter combination, maxAds caps the charged ads (0 would mean no cap)
        buildInput: (p, limit) => ({
          countries: [p.country],
          periods: [p.period],
          orderBy: [p.order_by],
          adFormat: "",
          sweepIndustries: false,
          sweepObjectives: false,
          maxAds: limit,
          includeDetails: true,
          includeKeyframes: false,
          maxConcurrency: 2,
        }),
        resultFields: [
          "materialId",
          "brandName",
          "adTitle",
          "likes",
          "comments",
          "shares",
          "ctr",
          "costTier",
          "industry",
          "objective",
          "landingPage",
          "videoDuration",
          "videoUrl",
          "coverUrl",
          "mediaExpiresAt",
          "country",
          "period",
          "creativeCenterUrl",
        ],
      },
      {
        actorId: "datapeak~tiktok-creative-center",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          mode: "topAds",
          region: p.country,
          period: p.period,
          orderBy: p.order_by,
          maxItems: limit,
          fetchAdDetails: true,
        }),
        resultFields: [
          "brandName",
          "adTitle",
          "likes",
          "comments",
          "shares",
          "ctr",
          "costTier",
          "objective",
          "industryKey",
          "landingPage",
          "videoUrl",
          "coverUrl",
          "detailsUrl",
          "region",
          "periodDays",
        ],
      },
    ],
  }),

  defineTask({
    key: "tiktok_trends",
    group: "tiktok",
    beta: true,
    titleVi: "Hashtag / bài hát TikTok đang thịnh hành",
    descriptionVi:
      "Dùng khi cần bảng xếp hạng hashtag hoặc bài hát đang thịnh hành trên TikTok tại một quốc gia (Creative Center) để lên ý tưởng nội dung.",
    input: strictInput({
      kind: z
        .enum(["hashtags", "songs"])
        .default("hashtags")
        .describe("hashtags hoặc songs"),
      country: creativeCenterCountry,
      period: z
        .enum(["7", "30", "180"])
        .default("7")
        .describe("7, 30 hoặc 180 ngày (180 tự đổi thành 120 với xu hướng)"),
    }),
    example: { kind: "hashtags", country: "VN", period: "7" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.02,
    noteVi: "Beta: Actor ít người dùng, cập nhật lần cuối 07/2026.",
    actors: [
      {
        actorId: "datapeak~tiktok-creative-center",
        timeoutSecs: 180,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          mode: p.kind,
          region: p.country,
          period: p.period,
          maxItems: limit,
          fetchAdDetails: false,
        }),
        resultFields: [
          "type",
          "rank",
          "hashtagName",
          "title",
          "author",
          "posts",
          "views",
          "rankDiff",
          "hashtagUrl",
          "link",
          "region",
          "periodDays",
        ],
      },
    ],
  }),
]
