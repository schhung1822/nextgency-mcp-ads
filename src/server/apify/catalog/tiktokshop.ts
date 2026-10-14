// TikTok Shop tasks (16-apify.md §6). Input schemas checked on the Apify Store 2026-10-14.
// pro100chok defaults maxItems to 1,000 (0 = unlimited) and maxReviews to 30 (0 = all) → always overridden;
// coregent (fallback, ~70 % run success) defaults maxResultsTotal to 0 = no cap → always overridden.
import { z } from "zod"

import {
  defineTask,
  httpsUrl,
  HOSTS,
  singleLine,
  strictInput,
  urlList,
} from "./common"

/** markets supported by both pro100chok (region) and coregent (countries) */
const TIKTOKSHOP_COUNTRIES = ["VN", "TH", "MY", "PH", "SG", "US"] as const

const tiktokShopCountry = z
  .enum(TIKTOKSHOP_COUNTRIES)
  .default("VN")
  .describe("Thị trường TikTok Shop (mặc định VN)")

/** www.tiktok.com/shop/pdp/…, shop.tiktok.com/…/pdp/…, shop.tiktok.com/view/product/…, vt.tiktok.com/… */
const tiktokShopProductUrl = httpsUrl("TikTok Shop", HOSTS.tiktok, {
  test: (u) =>
    /\/pdp\//.test(u.pathname) ||
    /\/view\/product\//.test(u.pathname) ||
    u.hostname === "vt.tiktok.com",
  message:
    "Cần link sản phẩm TikTok Shop (dạng https://www.tiktok.com/shop/pdp/… hoặc https://shop.tiktok.com/view/product/…).",
})

const PRO100CHOK_PRODUCT_FIELDS = [
  "productId",
  "storefront",
  "currency",
  "title",
  "currentPrice",
  "originalPrice",
  "discountPercent",
  "rating",
  "reviewCount",
  "salesVolume",
  "sellerName",
  "productUrl",
  "searchRank",
  "tags",
]
const COREGENT_PRODUCT_FIELDS = [
  "productTitle",
  "productUrl",
  "brandName",
  "salePrice",
  "listPrice",
  "discountPercent",
  "currency",
  "soldCount",
  "ratingAverage",
  "reviewCount",
  "sellerName",
  "countryCode",
]

export const TIKTOKSHOP_TASKS = [
  defineTask({
    key: "tiktokshop_search",
    group: "tiktokshop",
    titleVi: "Tìm sản phẩm TikTok Shop theo từ khoá",
    descriptionVi:
      "Dùng khi cần danh sách sản phẩm TikTok Shop (mặc định VN) theo từ khoá: giá, giảm giá, số đã bán, đánh giá, người bán.",
    input: strictInput({
      keyword: singleLine().describe('Từ khoá tìm kiếm, vd. "son kem lì"'),
      country: tiktokShopCountry,
      sort: z
        .enum(["relevance", "best_sellers", "price_asc", "price_desc"])
        .default("relevance")
        .describe("Sắp xếp (chỉ Actor chính áp dụng)"),
    }),
    example: { keyword: "son kem lì", sort: "best_sellers" },
    limit: { default: 40, max: 199 },
    estimatedCostUsd: 0.08,
    noteVi: "TikTok Shop trả tối đa ~199 sản phẩm mỗi từ khoá.",
    actors: [
      {
        actorId: "pro100chok~tiktok-shop-scraper-usage",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          scrapeType: "search",
          region: p.country.toLowerCase(),
          searchKeywords: [p.keyword],
          maxItems: limit,
          sortBy: p.sort,
          includeReviews: false,
          maxReviews: 1,
        }),
        resultFields: PRO100CHOK_PRODUCT_FIELDS,
      },
      {
        actorId: "coregent~tiktok-shop-product-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          keywords: [p.keyword],
          countries: [p.country],
          maxResultsPerQuery: limit,
          maxResultsTotal: limit,
          includeProductDetails: false,
          includeReviews: false,
          maxReviews: 1,
          deduplicateProducts: true,
          includeSummary: false,
        }),
        resultFields: COREGENT_PRODUCT_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiktokshop_product",
    group: "tiktokshop",
    titleVi: "Chi tiết sản phẩm TikTok Shop từ link",
    descriptionVi:
      "Dùng khi đã có link sản phẩm TikTok Shop và cần chi tiết: mô tả, giá, biến thể, số đã bán (cả 30 ngày gần đây), shop. Tối đa 5 link mỗi lần.",
    input: strictInput({
      urls: urlList(tiktokShopProductUrl, 5).describe(
        "1–5 link sản phẩm TikTok Shop"
      ),
      country: tiktokShopCountry,
    }),
    example: {
      urls: ["https://www.tiktok.com/shop/pdp/son-kem-li/1729000000000000000"],
    },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.01,
    noteVi: "limit = số link được xử lý (theo thứ tự).",
    actors: [
      {
        actorId: "pro100chok~tiktok-shop-scraper-usage",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          scrapeType: "product",
          region: p.country.toLowerCase(),
          productUrls: p.urls.slice(0, limit),
          maxItems: limit,
          includeReviews: false,
          maxReviews: 1,
        }),
        resultFields: [
          "productId",
          "storefront",
          "currency",
          "title",
          "description",
          "productUrl",
          "category",
          "currentPrice",
          "maxPrice",
          "originalPrice",
          "discountPercent",
          "salesVolume",
          "soldLast30Days",
          "rating",
          "reviewCount",
          "brand",
          "sellerName",
          "shopRating",
          "shopFollowers",
          "variants",
          "specifications",
          "sellingPoints",
        ],
      },
      {
        actorId: "coregent~tiktok-shop-product-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          productUrls: p.urls.slice(0, limit),
          countries: [p.country],
          maxResultsPerQuery: 1,
          maxResultsTotal: limit,
          includeProductDetails: true,
          includeReviews: false,
          maxReviews: 1,
          deduplicateProducts: true,
          includeSummary: false,
        }),
        resultFields: COREGENT_PRODUCT_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiktokshop_reviews",
    group: "tiktokshop",
    titleVi: "Đánh giá sản phẩm TikTok Shop",
    descriptionVi:
      "Dùng khi cần đọc đánh giá của một sản phẩm TikTok Shop: số sao, nội dung, biến thể, mua hàng đã xác minh.",
    input: strictInput({
      url: tiktokShopProductUrl.describe("Link sản phẩm TikTok Shop"),
      country: tiktokShopCountry,
      star: z
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Chỉ lấy đánh giá đúng số sao này (1–5)"),
    }),
    example: {
      url: "https://www.tiktok.com/shop/pdp/son-kem-li/1729000000000000000",
    },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.2,
    actors: [
      {
        actorId: "pro100chok~tiktok-shop-scraper-usage",
        timeoutSecs: 300,
        memoryMbytes: 256,
        buildInput: (p, limit) => ({
          scrapeType: "reviews",
          region: p.country.toLowerCase(),
          reviewProductUrls: [p.url],
          maxItems: limit,
          maxReviews: limit,
          reviewsSortBy: "recent",
          reviewsFilterType: "all",
          reviewsStarRating: p.star ?? 0,
        }),
        resultFields: [
          "reviewId",
          "productId",
          "productName",
          "productUrl",
          "rating",
          "text",
          "date",
          "variant",
          "country",
          "isVerifiedPurchase",
          "isIncentivizedReview",
          "imageUrls",
          "totalReviews",
        ],
      },
      {
        actorId: "coregent~tiktok-shop-product-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        // reviews are embedded in the product record, at most 100 per product (schema maximum)
        buildInput: (p, limit) => ({
          productUrls: [p.url],
          countries: [p.country],
          maxResultsPerQuery: 1,
          maxResultsTotal: 1,
          includeProductDetails: false,
          includeReviews: true,
          maxReviews: Math.min(limit, 100),
          deduplicateProducts: true,
          includeSummary: false,
        }),
        resultFields: [
          "productTitle",
          "productUrl",
          "ratingAverage",
          "reviewCount",
          "reviews",
          "ratingDistribution",
          "reviewsAccessible",
          "reviewsUnavailableReason",
          "reviewsFetched",
        ],
        noteVi:
          "Tối đa 100 đánh giá, nằm trong trường reviews của bản ghi sản phẩm; không lọc theo sao.",
      },
    ],
  }),
]
