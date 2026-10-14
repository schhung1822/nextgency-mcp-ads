// Instagram tasks (public data only). 16-apify.md §6. Input schemas checked on the Apify Store 2026-10-14.
// apify~instagram-scraper returns as many results as possible when resultsLimit / searchLimit are empty → always
// set. apify~instagram-profile-scraper's "about account" section is a paid add-on → off.
import { z } from "zod"

import {
  defineTask,
  hashtagField,
  httpsUrl,
  HOSTS,
  instagramHandle,
  strictInput,
  stripHash,
} from "./common"

const instagramProfileRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (v) => instagramHandle(v) !== null,
    'Cần tên tài khoản Instagram (vd. "@tenthuonghieu") hoặc link https://www.instagram.com/tenthuonghieu/.'
  )

const instagramUrl = httpsUrl("Instagram", HOSTS.instagram)

const PROFILE_FIELDS = [
  "username",
  "fullName",
  "biography",
  "followersCount",
  "followsCount",
  "postsCount",
  "private",
  "verified",
  "isBusinessAccount",
  "businessCategoryName",
  "externalUrl",
  "url",
]
const POST_FIELDS = [
  "type",
  "shortCode",
  "url",
  "caption",
  "hashtags",
  "timestamp",
  "likesCount",
  "commentsCount",
  "videoViewCount",
  "videoPlayCount",
  "productType",
  "ownerUsername",
  "displayUrl",
]

function profileHandle(ref: string): string {
  return instagramHandle(ref) ?? ref.trim().replace(/^@/, "")
}

export const INSTAGRAM_TASKS = [
  defineTask({
    key: "instagram_profile",
    group: "instagram",
    titleVi: "Thông tin tài khoản Instagram",
    descriptionVi:
      "Dùng khi cần thông tin tài khoản Instagram công khai (đối thủ, KOL): người theo dõi, đang theo dõi, số bài, tiểu sử, tài khoản doanh nghiệp, link ngoài. Tối đa 5 tài khoản mỗi lần.",
    input: strictInput({
      usernames: z
        .array(instagramProfileRef)
        .min(1)
        .max(5)
        .describe('1–5 tên tài khoản hoặc link hồ sơ, vd. ["@tenthuonghieu"]'),
    }),
    example: { usernames: ["@tenthuonghieu"] },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.01,
    noteVi: "limit = số tài khoản được xử lý (theo thứ tự).",
    actors: [
      {
        actorId: "apify~instagram-profile-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          usernames: p.usernames.slice(0, limit).map(profileHandle),
          includeAboutSection: false,
        }),
        resultFields: PROFILE_FIELDS,
      },
      {
        actorId: "apify~instagram-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          directUrls: p.usernames
            .slice(0, limit)
            .map((u) => `https://www.instagram.com/${profileHandle(u)}/`),
          resultsType: "details",
          resultsLimit: 1,
          searchLimit: 1,
          addParentData: false,
        }),
        resultFields: PROFILE_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "instagram_posts",
    group: "instagram",
    titleVi: "Bài viết / reel / bình luận Instagram",
    descriptionVi:
      "Dùng khi cần bài viết hoặc reel của một tài khoản Instagram (link hồ sơ), hoặc bình luận của một bài (link /p/… hoặc /reel/…): nội dung, hashtag, lượt thích, bình luận, lượt xem.",
    input: strictInput({
      url: instagramUrl.describe(
        "Link hồ sơ (https://www.instagram.com/tenthuonghieu/) hoặc link bài /p/… /reel/…"
      ),
      content: z
        .enum(["posts", "reels", "comments"])
        .default("posts")
        .describe("posts, reels hoặc comments (comments cần link bài viết)"),
      since_days: z
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Chỉ lấy bài trong N ngày gần đây"),
    }).refine(
      (v) => v.content !== "comments" || /\/(p|reel|tv)\//.test(v.url),
      {
        message: "Lấy bình luận cần link bài viết (/p/…) hoặc reel (/reel/…).",
        path: ["url"],
      }
    ),
    example: {
      url: "https://www.instagram.com/tenthuonghieu/",
      content: "posts",
    },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.05,
    noteVi:
      "Gói Apify Free chỉ lấy được ~15 bình luận mới nhất mỗi bài. Bình luận có tên người dùng (dữ liệu cá nhân).",
    actors: [
      {
        actorId: "apify~instagram-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          directUrls: [p.url],
          resultsType: p.content,
          resultsLimit: limit,
          ...(p.since_days
            ? { onlyPostsNewerThan: `${p.since_days} days` }
            : {}),
          searchLimit: 1,
          addParentData: false,
        }),
        resultFields: [
          ...POST_FIELDS,
          // comment rows
          "text",
          "repliesCount",
          "postUrl",
        ],
      },
    ],
  }),

  defineTask({
    key: "instagram_hashtag",
    group: "instagram",
    titleVi: "Bài viết Instagram theo hashtag",
    descriptionVi:
      "Dùng khi cần bài viết Instagram gắn một hashtag (độ phủ chiến dịch, nội dung người dùng tạo): caption, lượt thích, bình luận, tác giả.",
    input: strictInput({
      hashtag: hashtagField().describe(
        'Hashtag, có hoặc không có #, vd. "skincare"'
      ),
    }),
    example: { hashtag: "skincarevietnam" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.06,
    actors: [
      {
        actorId: "apify~instagram-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          search: stripHash(p.hashtag),
          searchType: "hashtag",
          searchLimit: 1,
          resultsType: "posts",
          resultsLimit: limit,
          addParentData: false,
        }),
        resultFields: POST_FIELDS,
      },
      {
        actorId: "apify~instagram-hashtag-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          hashtags: [stripHash(p.hashtag)],
          keywordSearch: false,
          resultsType: "posts",
          resultsLimit: limit,
        }),
        resultFields: [
          "type",
          "url",
          "caption",
          "hashtags",
          "timestamp",
          "likesCount",
          "commentsCount",
          "ownerUsername",
          "ownerFullName",
          "queryTag",
        ],
        noteVi: "Actor có đánh giá thấp (★3.5) — chỉ dùng khi Actor chính lỗi.",
      },
    ],
  }),
]
