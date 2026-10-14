// Lazada tasks (16-apify.md §6). Input schemas checked on the Apify Store 2026-10-14.
// fatihtahta~lazada-scraper defaults `limit` / `maxReviews` to 50,000 → always overridden.
import { z } from "zod"

import {
  defineTask,
  httpsUrl,
  HOSTS,
  lazadaCountryFromUrl,
  singleLine,
  starsField,
  starStrings,
  strictInput,
  urlList,
} from "./common"

const LAZADA_COUNTRIES = ["VN", "ID", "MY", "SG", "PH", "TH"] as const

const lazadaCountry = z
  .enum(LAZADA_COUNTRIES)
  .default("VN")
  .describe("Thị trường Lazada (mặc định VN = lazada.vn)")

/** product pages: /products/…-i123456.html (also …-i123-s456.html) */
function isLazadaProductUrl(u: URL): boolean {
  return /^\/products\/.*i\d+/.test(u.pathname)
}
const lazadaProductUrl = httpsUrl("Lazada", HOSTS.lazada, {
  test: isLazadaProductUrl,
  message: "Cần link sản phẩm Lazada (dạng /products/…-i123456789.html).",
})

const LERGASSY_SORT = {
  relevance: "relevance",
  price_asc: "price_asc",
  price_desc: "price_desc",
} as const
const FATIHTAHTA_SORT = {
  relevance: "best",
  price_asc: "priceasc",
  price_desc: "pricedesc",
} as const

const LERGASSY_PRODUCT_FIELDS = [
  "type",
  "title",
  "price",
  "originalPrice",
  "discountPercent",
  "currency",
  "rating",
  "reviewCount",
  "soldQuantity",
  "brand",
  "sellerName",
  "location",
  "isLazMall",
  "country",
  "itemId",
  "url",
]
const FATIHTAHTA_FIELDS = [
  "record_type",
  "title",
  "pricing",
  "seller",
  "metrics",
  "availability",
  "product",
  "url",
]

export const LAZADA_TASKS = [
  defineTask({
    key: "lazada_search",
    group: "lazada",
    titleVi: "Tìm sản phẩm Lazada theo từ khoá",
    descriptionVi:
      "Dùng khi cần danh sách sản phẩm Lazada (mặc định lazada.vn) theo từ khoá: giá, giảm giá, đánh giá, số đã bán, người bán, LazMall.",
    input: strictInput({
      keyword: singleLine().describe(
        'Từ khoá tìm kiếm, vd. "tai nghe bluetooth"'
      ),
      country: lazadaCountry,
      sort: z
        .enum(["relevance", "price_asc", "price_desc"])
        .default("relevance")
        .describe("Sắp xếp kết quả"),
    }),
    example: { keyword: "tai nghe bluetooth" },
    limit: { default: 40, max: 200 },
    estimatedCostUsd: 0.08,
    actors: [
      {
        actorId: "lergassy~lazada-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          mode: "search",
          country: p.country,
          searchTerms: [p.keyword],
          startUrls: [],
          maxItems: limit,
          enrichProducts: false,
          // reviews mode only; pinned to the minimum
          maxReviewsPerProduct: 1,
          sortBy: LERGASSY_SORT[p.sort],
        }),
        resultFields: LERGASSY_PRODUCT_FIELDS,
      },
      {
        actorId: "fatihtahta~lazada-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        // limit: minimum 10 in the Actor schema
        buildInput: (p, limit) => ({
          country: p.country.toLowerCase(),
          queries: [p.keyword],
          startUrls: [],
          sort: FATIHTAHTA_SORT[p.sort],
          limit: Math.max(10, limit),
          enrich_data: false,
          getReviews: false,
          maxReviews: 1,
        }),
        resultFields: FATIHTAHTA_FIELDS,
        noteVi: "Chạy chậm hơn (2–3 phút).",
      },
    ],
  }),

  defineTask({
    key: "lazada_product",
    group: "lazada",
    titleVi: "Chi tiết sản phẩm Lazada từ link",
    descriptionVi:
      "Dùng khi đã có link sản phẩm Lazada và cần chi tiết: mô tả, giá, biến thể, thương hiệu, tình trạng hàng. Tối đa 5 link mỗi lần.",
    input: strictInput({
      urls: urlList(lazadaProductUrl, 5).describe(
        "1–5 link sản phẩm Lazada (dạng /products/…-i123456789.html)"
      ),
    }),
    example: {
      urls: [
        "https://www.lazada.vn/products/tai-nghe-bluetooth-i123456789.html",
      ],
    },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.02,
    noteVi: "limit = số link được xử lý (theo thứ tự).",
    actors: [
      {
        actorId: "lergassy~lazada-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          mode: "product",
          country: lazadaCountryFromUrl(p.urls[0]) ?? "VN",
          searchTerms: [],
          startUrls: p.urls.slice(0, limit),
          // one product per product URL
          maxItems: 1,
          enrichProducts: false,
          maxReviewsPerProduct: 1,
        }),
        resultFields: [
          "type",
          "title",
          "brand",
          "category",
          "price",
          "availability",
          "description",
          "highlights",
          "variantCount",
          "variants",
          "country",
          "url",
        ],
      },
      {
        actorId: "fatihtahta~lazada-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          country: (lazadaCountryFromUrl(p.urls[0]) ?? "VN").toLowerCase(),
          startUrls: p.urls.slice(0, limit),
          queries: [],
          // per target; a product URL yields one listing (schema minimum 10)
          limit: 10,
          enrich_data: false,
          getReviews: false,
          maxReviews: 1,
        }),
        resultFields: FATIHTAHTA_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "lazada_reviews",
    group: "lazada",
    titleVi: "Đánh giá sản phẩm Lazada",
    descriptionVi:
      "Dùng khi cần đọc đánh giá của một sản phẩm Lazada: số sao, nội dung, ảnh, phản hồi của shop, điểm sản phẩm/người bán/giao hàng.",
    input: strictInput({
      url: lazadaProductUrl.describe("Link sản phẩm Lazada"),
      stars: starsField,
    }),
    example: {
      url: "https://www.lazada.vn/products/tai-nghe-bluetooth-i123456789.html",
      stars: [1, 2, 3],
    },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.16,
    actors: [
      {
        actorId: "zen-studio~lazada-reviews-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.url }],
          maxReviewsPerProduct: limit,
          maxReviews: limit,
          ...(p.stars ? { starRatings: starStrings(p.stars) } : {}),
          includeRatingSummary: true,
        }),
        resultFields: [
          "record_type",
          "url",
          "product",
          "review",
          "seller_reply",
          "attributes",
          "average_rating",
          "review_count",
          "rating_histogram",
        ],
      },
      {
        actorId: "lergassy~lazada-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => {
          const stars = p.stars ? starStrings(p.stars) : []
          return {
            mode: "reviews",
            country: lazadaCountryFromUrl(p.url) ?? "VN",
            searchTerms: [],
            startUrls: [p.url],
            maxItems: 1,
            maxReviewsPerProduct: limit,
            reviewsRating: stars.length === 1 ? stars[0] : "all",
            enrichProducts: false,
          }
        },
        resultFields: [
          "type",
          "rating",
          "text",
          "variant",
          "reviewTime",
          "likes",
          "images",
          "itemId",
          "country",
          "productUrl",
        ],
        noteVi: "Chỉ lọc được đúng 1 mức sao; chọn nhiều mức sao = lấy tất cả.",
      },
    ],
  }),
]
