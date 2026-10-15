// Threads (Meta) tasks — public, logged-out data only (no Actor here takes cookies / accounts). 16-apify.md §6.
// Input schemas checked on the Apify Store 2026-10-16 (providers/apify.md §16).
// - futurizerush~meta-threads-scraper: memory fixed at 4096 MB (min = max) and its synthetic start event is charged
//   once per GB ($0.08 per run on FREE) → listed in APIFY_ACTOR_MIN_CHARGE_USD; max_posts has a schema minimum of 10
//   (cap per user / keyword).
// - lergassy~threads-scraper: maxItems (default 10000) is the hard row cap of the run → always pinned;
//   monitoringStoreName (state shared across runs) is never set.
// - logical_scrapers~threads-post-scraper: replies come nested inside one item → capped at 50 (apify_get_results
//   keeps ≤ 50 array elements).
// - scraping_solutions~threads-followers-following-scraper: maxResultsPerUser 0 means "all" → never sent as 0.
import { z } from "zod"

import {
  defineTask,
  httpsUrl,
  HOSTS,
  isThreadsPostUrl,
  singleLine,
  strictInput,
  threadsHandle,
} from "./common"

const threadsProfileRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (v) => threadsHandle(v) !== null,
    'Cần tên tài khoản Threads (vd. "@tenthuonghieu") hoặc link https://www.threads.com/@tenthuonghieu.'
  )

function handle(ref: string): string {
  return threadsHandle(ref) ?? ref.trim().replace(/^@/, "")
}

const threadsPostUrl = httpsUrl("bài viết Threads", HOSTS.threads, {
  test: isThreadsPostUrl,
  message:
    "Cần link bài viết Threads (dạng https://www.threads.com/@kenh/post/ABC123).",
})

const FUTURIZERUSH_POST_FIELDS = [
  "username",
  "display_name",
  "text_content",
  "created_at",
  "like_count",
  "reply_count",
  "repost_count",
  "quote_count",
  "share_count",
  "view_count",
  "hashtags",
  "topic_tag",
  "media_type",
  "is_paid_partnership",
  "followers_count",
  "post_url",
]
const AUTOMATIONLAB_POST_FIELDS = [
  "username",
  "text",
  "date",
  "likeCount",
  "replyCount",
  "repostCount",
  "quoteCount",
  "mediaType",
  "hashtags",
  "url",
]

export const THREADS_TASKS = [
  defineTask({
    key: "threads_profile_posts",
    group: "threads",
    titleVi: "Bài viết gần đây của một tài khoản Threads",
    descriptionVi:
      "Dùng khi cần bài viết của một tài khoản Threads (đối thủ, KOL, thương hiệu): nội dung, lượt thích, trả lời, đăng lại, trích dẫn, chia sẻ, lượt xem, hashtag / chủ đề, số người theo dõi.",
    input: strictInput({
      username: threadsProfileRef.describe(
        'Tên tài khoản (có hoặc không có @) hoặc link hồ sơ, vd. "@tenthuonghieu"'
      ),
    }),
    example: { username: "@tenthuonghieu" },
    limit: { default: 30, max: 100 },
    // FREE tier: start $0.02 × 4 GB + 30 × $0.0025
    estimatedCostUsd: 0.16,
    noteVi:
      "Chỉ dữ liệu công khai (không đăng nhập). Actor chính lấy tối thiểu 10 bài mỗi lần và cần trần mỗi lần chạy ≥ 0,1 USD.",
    actors: [
      {
        actorId: "futurizerush~meta-threads-scraper",
        timeoutSecs: 600,
        memoryMbytes: 4096, // schema min = max = 4096
        buildInput: (p, limit) => ({
          mode: "user",
          usernames: [handle(p.username)],
          max_posts: Math.max(10, limit), // schema minimum 10
        }),
        resultFields: FUTURIZERUSH_POST_FIELDS,
        noteVi: "Tối thiểu 10 bài mỗi lần (tính phí theo số bài thực nhận).",
      },
      {
        actorId: "automation-lab~threads-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          mode: "posts",
          usernames: [handle(p.username)],
          maxPosts: limit, // 1–200
          includeProfile: false, // the profile row is a paid event
        }),
        resultFields: AUTOMATIONLAB_POST_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "threads_search",
    group: "threads",
    titleVi: "Tìm bài viết Threads theo từ khoá / hashtag",
    descriptionVi:
      "Dùng khi cần bài viết Threads theo từ khoá hoặc #hashtag (lắng nghe mạng xã hội, phản hồi về thương hiệu / sản phẩm, xu hướng): nội dung, tác giả, lượt thích, trả lời, đăng lại, lượt xem.",
    input: strictInput({
      keyword: singleLine().describe(
        'Từ khoá hoặc hashtag (có thể có #), vd. "kem chống nắng" hoặc "#skincare"'
      ),
      sort: z
        .enum(["top", "recent"])
        .default("top")
        .describe("top = nổi bật, recent = mới nhất"),
      since_days: z
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Chỉ lấy bài trong N ngày gần đây (chỉ Actor chính)"),
    }),
    example: { keyword: "#skincare", sort: "recent", since_days: 7 },
    limit: { default: 30, max: 100 },
    estimatedCostUsd: 0.16,
    noteVi:
      "Threads chỉ hiện một phần kết quả cho khách chưa đăng nhập - số bài có thể ít hơn limit. Không lọc được theo ngôn ngữ tiếng Việt. Actor chính cần trần mỗi lần chạy ≥ 0,1 USD.",
    actors: [
      {
        actorId: "futurizerush~meta-threads-scraper",
        timeoutSecs: 600,
        memoryMbytes: 4096, // schema min = max = 4096
        buildInput: (p, limit) => ({
          mode: "search",
          keywords: [p.keyword],
          max_posts: Math.max(10, limit), // schema minimum 10
          search_filter: p.sort,
          ...(p.since_days ? { start_date: `${p.since_days} days` } : {}),
        }),
        resultFields: [
          ...FUTURIZERUSH_POST_FIELDS,
          "search_keyword",
          "keyword_match",
        ],
        noteVi: "Tối thiểu 10 bài mỗi lần (tính phí theo số bài thực nhận).",
      },
      {
        actorId: "logical_scrapers~threads-search-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          searchQueries: [p.keyword],
          // "all" = top + recent + tags, de-duplicated (one logged-out tab shows ~15–35 posts)
          searchType: p.sort === "recent" ? "recent" : "all",
          maxItems: limit,
          includeReplies: false,
        }),
        resultFields: [
          "searchQuery",
          "username",
          "text",
          "likeCount",
          "replyCount",
          "repostCount",
          "mediaType",
          "createdAt",
          "url",
        ],
        noteVi:
          "Không hỗ trợ lọc theo số ngày (since_days bị bỏ qua); mỗi tab ~15–35 bài.",
      },
    ],
  }),

  defineTask({
    key: "threads_replies",
    group: "threads",
    titleVi: "Trả lời (bình luận) của bài viết Threads",
    descriptionVi:
      "Dùng khi cần đọc các trả lời của một bài viết Threads (phản hồi khách hàng, câu hỏi thường gặp, cảm xúc về sản phẩm / chiến dịch).",
    input: strictInput({
      url: threadsPostUrl.describe(
        "Link bài viết Threads (https://www.threads.com/@kenh/post/…)"
      ),
    }),
    example: { url: "https://www.threads.com/@tenthuonghieu/post/DAbc123xyz" },
    limit: { default: 50, max: 200 },
    // FREE tier: (1 post row + 50 replies) × $0.002
    estimatedCostUsd: 0.11,
    noteVi:
      "Chỉ các trả lời công khai Threads hiện cho khách chưa đăng nhập. Trả lời có tên người dùng (dữ liệu cá nhân) - chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "lergassy~threads-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          mode: "thread",
          postUrls: [p.url],
          maxRepliesPerPost: limit,
          maxPosts: limit,
          maxItems: limit + 1, // hard row cap of the run: the post row + its replies
          maxUsersPerKeyword: 1,
          includeProfile: false,
          concurrency: 1,
        }),
        resultFields: [
          "type",
          "username",
          "text",
          "createdAt",
          "likeCount",
          "replyCount",
          "isReply",
          "replyToUsername",
          "parentPostUrl",
          "positionInThread",
          "language",
          "url",
        ],
      },
      {
        actorId: "logical_scrapers~threads-post-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.url }],
          includeReplies: true,
          // replies are nested in one item: apify_get_results keeps ≤ 50 array elements
          maxReplies: Math.min(limit, 50),
        }),
        resultFields: ["thread", "replies"],
        noteVi:
          "Trả 1 dòng { thread, replies[] }: tối đa 50 trả lời, nội dung dài có thể bị cắt; cần link dạng /@kenh/post/….",
      },
    ],
  }),

  defineTask({
    key: "threads_profile",
    group: "threads",
    titleVi: "Thông tin tài khoản Threads",
    descriptionVi:
      "Dùng khi cần thông tin tài khoản Threads công khai (đối thủ, KOL): số người theo dõi, tiểu sử, đã xác minh, riêng tư. Tối đa 5 tài khoản mỗi lần.",
    input: strictInput({
      usernames: z
        .array(threadsProfileRef)
        .min(1)
        .max(5)
        .describe('1–5 tên tài khoản hoặc link hồ sơ, vd. ["@tenthuonghieu"]'),
    }),
    example: { usernames: ["@tenthuonghieu"] },
    limit: { default: 5, max: 5 },
    // FREE tier: 5 × $0.005
    estimatedCostUsd: 0.03,
    noteVi: "limit = số tài khoản được xử lý (theo thứ tự).",
    actors: [
      {
        actorId: "apify~threads-profile-api-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024, // schema max 1024
        buildInput: (p, limit) => ({
          usernames: p.usernames.slice(0, limit).map(handle),
        }),
        resultFields: [
          "username",
          "full_name",
          "biography",
          "follower_count",
          "is_verified",
          "is_private",
          "url",
        ],
      },
      {
        actorId: "automation-lab~threads-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          mode: "profile",
          usernames: p.usernames.slice(0, limit).map(handle),
          maxPosts: 1, // profile mode returns profile rows only; pinned anyway
        }),
        resultFields: [
          "username",
          "fullName",
          "biography",
          "followerCount",
          "isVerified",
          "url",
        ],
      },
    ],
  }),

  defineTask({
    key: "threads_followers",
    group: "threads",
    beta: true,
    titleVi: "Người theo dõi / đang theo dõi của tài khoản Threads",
    descriptionVi:
      "Dùng khi cần danh sách người theo dõi (hoặc đang theo dõi) công khai của một tài khoản Threads để tìm KOL / khách hàng tiềm năng: tên, số người theo dõi, đã xác minh.",
    input: strictInput({
      username: threadsProfileRef.describe(
        'Tên tài khoản hoặc link hồ sơ, vd. "@tenthuonghieu"'
      ),
      relation: z
        .enum(["followers", "following"])
        .default("followers")
        .describe("followers = người theo dõi, following = đang theo dõi"),
    }),
    example: { username: "@tenthuonghieu", relation: "followers" },
    limit: { default: 100, max: 500 },
    // FREE tier: 100 × $0.001
    estimatedCostUsd: 0.1,
    noteVi:
      "Thử nghiệm: Actor ít người dùng (10/2026). Gói Apify Free: ~1.000 kết quả/ngày. Danh sách là dữ liệu cá nhân - chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "scraping_solutions~threads-followers-following-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          usernames: [handle(p.username)],
          type: p.relation,
          maxResultsPerUser: Math.max(1, limit), // 0 = every follower → never sent
        }),
        resultFields: [
          "sourceUsername",
          "relation",
          "username",
          "fullName",
          "followersCount",
          "isVerified",
          "isPrivate",
          "profileUrl",
        ],
      },
    ],
  }),
]
