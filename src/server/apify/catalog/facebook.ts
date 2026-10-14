// Facebook tasks (public data only): Ad Library, page posts / info, public group posts, comments. 16-apify.md §6.
// Input schemas checked on the Apify Store 2026-10-14. apify~facebook-*-scraper charge a "date filter" add-on and
// leave results unlimited when `resultsLimit` is empty → resultsLimit is always set, date filters never.
// The team's OWN pages / ads go through the official meta_* tools, not Apify.
import { z } from "zod"

import {
  CATALOG_MESSAGES,
  countryField,
  defineTask,
  httpsUrl,
  HOSTS,
  singleLine,
  strictInput,
  urlList,
} from "./common"

const facebookUrl = (what: string) => httpsUrl(what, HOSTS.facebook)

const facebookGroupUrl = httpsUrl("group Facebook", HOSTS.facebook, {
  test: (u) => /^\/groups\/[^/]+/.test(u.pathname),
  message: "Cần link group Facebook (dạng https://www.facebook.com/groups/…).",
})

/** Meta Ad Library keyword search URL (the format apify~facebook-ads-scraper documents for startUrls). */
export function adLibrarySearchUrl(
  keyword: string,
  country: string,
  activeStatus: "active" | "inactive" | "all"
): string {
  const q = new URLSearchParams({
    active_status: activeStatus,
    ad_type: "all",
    country,
    q: keyword,
    search_type: "keyword_unordered",
    media_type: "all",
  })
  return `https://www.facebook.com/ads/library/?${q.toString()}`
}

export const FACEBOOK_TASKS = [
  defineTask({
    key: "facebook_ads_library",
    group: "facebook",
    titleVi: "Quảng cáo Meta trong Thư viện quảng cáo",
    descriptionVi:
      "Dùng khi cần xem quảng cáo Facebook/Instagram của đối thủ theo từ khoá HOẶC theo Trang (Meta Ad Library): nội dung, CTA, link đích, ngày bắt đầu, nền tảng, ảnh/video.",
    input: strictInput({
      keyword: singleLine()
        .optional()
        .describe('Từ khoá tìm quảng cáo, vd. "kem chống nắng"'),
      page_url: facebookUrl("Trang Facebook")
        .optional()
        .describe("Link Trang Facebook của nhà quảng cáo"),
      country: countryField,
      active_status: z
        .enum(["active", "inactive", "all"])
        .default("active")
        .describe("active = đang chạy, inactive = đã dừng, all = tất cả"),
    }).refine((v) => (v.keyword === undefined) !== (v.page_url === undefined), {
      message: CATALOG_MESSAGES.exactlyOne("keyword", "page_url"),
      path: ["keyword"],
    }),
    example: { keyword: "kem chống nắng", country: "VN" },
    limit: { default: 30, max: 200 },
    estimatedCostUsd: 0.02,
    noteVi:
      "Với VN chỉ thấy mẫu quảng cáo (nội dung, ngày chạy, nền tảng). Chi tiêu / reach / nhân khẩu học CHỈ có với quảng cáo nhắm EU hoặc quảng cáo chính trị/xã hội.",
    actors: [
      {
        actorId: "automation-lab~facebook-ads-library",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          searchQueries: p.keyword ? [p.keyword] : [],
          pageUrls: p.page_url ? [p.page_url] : [],
          adsLibraryUrls: [],
          country: p.country,
          activeStatus: p.active_status,
          mediaType: "all",
          onlyAdsNewerThan: "",
          onlyAdsOlderThan: "",
          maxAds: limit,
        }),
        resultFields: [
          "pageName",
          "bodyText",
          "title",
          "ctaText",
          "linkUrl",
          "platforms",
          "isActive",
          "startDate",
          "endDate",
          "displayFormat",
          "imageUrls",
          "videoUrls",
          "adLibraryUrl",
        ],
      },
      {
        actorId: "apify~facebook-ads-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: [
            {
              url: p.keyword
                ? adLibrarySearchUrl(p.keyword, p.country, p.active_status)
                : p.page_url,
            },
          ],
          resultsLimit: limit,
          activeStatus: p.active_status === "all" ? "" : p.active_status,
          sorting: "",
          onlyTotal: false,
          isDetailsPerAd: false,
          includeAboutPage: false,
          enrichWithEcommerceData: false,
        }),
        resultFields: [
          "pageName",
          "pageId",
          "adArchiveId",
          "isActive",
          "startDateFormatted",
          "endDateFormatted",
          "publisherPlatform",
          "snapshot",
          "collationCount",
          "spend",
          "reachEstimate",
          "impressions",
        ],
        noteVi:
          "Với link Trang, quốc gia lấy theo mặc định của Ad Library (không lọc theo country).",
      },
    ],
  }),

  defineTask({
    key: "facebook_page_posts",
    group: "facebook",
    titleVi: "Bài viết gần đây của Trang Facebook",
    descriptionVi:
      "Dùng khi cần bài viết gần đây của một Trang Facebook công khai (đối thủ): nội dung, thời gian, lượt thích, bình luận, chia sẻ, media.",
    input: strictInput({
      page_url: facebookUrl("Trang Facebook").describe(
        "Link Trang Facebook công khai, vd. https://www.facebook.com/tenfanpage"
      ),
    }),
    example: { page_url: "https://www.facebook.com/tenfanpage" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.1,
    noteVi:
      "Chỉ Trang công khai (không phải trang cá nhân). Trang của chính bạn nên dùng tool meta_* chính thức.",
    actors: [
      {
        actorId: "apify~facebook-posts-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.page_url }],
          resultsLimit: limit,
          captionText: false,
        }),
        resultFields: [
          "postId",
          "url",
          "time",
          "text",
          "likes",
          "comments",
          "shares",
          "media",
          "link",
          "pageName",
        ],
      },
    ],
  }),

  defineTask({
    key: "facebook_page_info",
    group: "facebook",
    titleVi: "Thông tin Trang Facebook",
    descriptionVi:
      "Dùng khi cần thông tin tổng quan của Trang Facebook công khai: tên, danh mục, lượt thích, người theo dõi, đánh giá, liên hệ, website. Tối đa 5 Trang mỗi lần.",
    input: strictInput({
      page_urls: urlList(facebookUrl("Trang Facebook"), 5).describe(
        "1–5 link Trang Facebook công khai"
      ),
    }),
    example: { page_urls: ["https://www.facebook.com/tenfanpage"] },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.06,
    noteVi:
      "limit = số Trang được xử lý (theo thứ tự). ~$0.012/Trang. Không dùng được cho trang cá nhân.",
    actors: [
      {
        actorId: "apify~facebook-pages-scraper",
        timeoutSecs: 180,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: p.page_urls.slice(0, limit).map((url) => ({ url })),
        }),
        resultFields: [
          "title",
          "pageUrl",
          "pageId",
          "categories",
          "likes",
          "followers",
          "rating",
          "intro",
          "info",
          "email",
          "phone",
          "address",
          "website",
        ],
      },
    ],
  }),

  defineTask({
    key: "facebook_group_posts",
    group: "facebook",
    titleVi: "Bài viết trong group Facebook công khai",
    descriptionVi:
      "Dùng khi cần bài viết mới trong một group Facebook CÔNG KHAI (nghiên cứu nhu cầu, phản hồi về thương hiệu). Group kín không lấy được.",
    input: strictInput({
      group_url: facebookGroupUrl.describe(
        "Link group công khai, vd. https://www.facebook.com/groups/123456789"
      ),
    }),
    example: { group_url: "https://www.facebook.com/groups/123456789" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.1,
    noteVi:
      "Bài viết có tên người đăng (dữ liệu cá nhân) — chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "apify~facebook-groups-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.group_url }],
          resultsLimit: limit,
          viewOption: "CHRONOLOGICAL",
        }),
        resultFields: [
          "facebookUrl",
          "url",
          "time",
          "text",
          "user",
          "likesCount",
          "commentsCount",
          "attachments",
        ],
      },
      {
        actorId: "memo23~facebook-public-group-posts-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          startUrls: [p.group_url],
          viewOption: "CHRONOLOGICAL",
          maxItems: limit,
          includeComments: false,
          fetchAllComments: false,
          includeCommentReplies: false,
          enrichMarketplaceListings: false,
          monitoringMode: false,
          postsPerRequest: 3,
          maxConcurrency: 2,
        }),
        resultFields: [
          "groupTitle",
          "url",
          "time",
          "text",
          "user",
          "likesCount",
          "commentsCount",
          "sharesCount",
          "attachments",
        ],
      },
    ],
  }),

  defineTask({
    key: "facebook_comments",
    group: "facebook",
    titleVi: "Bình luận của bài viết Facebook",
    descriptionVi:
      "Dùng khi cần đọc bình luận của một bài viết / reel / video Facebook công khai (phản hồi khách hàng, câu hỏi, cảm xúc).",
    input: strictInput({
      post_url: facebookUrl("bài viết Facebook").describe(
        "Link bài viết, reel hoặc video Facebook công khai"
      ),
    }),
    example: {
      post_url: "https://www.facebook.com/tenfanpage/posts/pfbid0abcDEF123",
    },
    limit: { default: 50, max: 300 },
    estimatedCostUsd: 0.13,
    noteVi:
      "Bình luận có tên người dùng (dữ liệu cá nhân) — chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "apify~facebook-comments-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.post_url }],
          resultsLimit: limit,
          includeNestedComments: false,
          viewOption: "RANKED_UNFILTERED",
        }),
        resultFields: [
          "postTitle",
          "text",
          "date",
          "likesCount",
          "commentsCount",
          "commentUrl",
          "facebookUrl",
        ],
      },
    ],
  }),
]
