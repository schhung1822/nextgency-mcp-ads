// Shopee tasks (16-apify.md §6). Shopee VN is best-effort: since mid-2026 product pages are client-rendered with
// signed tokens, gio21~* returns MOCK rows on the Apify Free plan (`_mock: true`) and no Actor is proven stable on
// shopee.vn yet → smoke-test with a real (Starter+) token. Input schemas checked on the Apify Store 2026-10-14.
import { z } from "zod"

import {
  defineTask,
  httpsUrl,
  HOSTS,
  shopeeCountryFromUrl,
  singleLine,
  starsField,
  starStrings,
  strictInput,
  urlList,
} from "./common"

/** markets supported by both gio21~shopee-scraper and lergassy~shopee-scraper */
const SHOPEE_COUNTRIES = [
  "VN",
  "ID",
  "TH",
  "MY",
  "SG",
  "PH",
  "BR",
  "MX",
] as const
const GIO21_COUNTRIES = new Set<string>(SHOPEE_COUNTRIES)

const shopeeCountry = z
  .enum(SHOPEE_COUNTRIES)
  .default("VN")
  .describe("Thị trường Shopee (mặc định VN = shopee.vn)")

const shopeeUrl = httpsUrl("Shopee", HOSTS.shopee)

/** …-i.SHOPID.ITEMID or /product/SHOPID/ITEMID */
function isShopeeProductUrl(u: URL): boolean {
  return (
    /-i\.\d+\.\d+/.test(u.pathname) || /^\/product\/\d+\/\d+/.test(u.pathname)
  )
}
const shopeeProductUrl = httpsUrl("Shopee", HOSTS.shopee, {
  test: isShopeeProductUrl,
  message:
    "Cần link sản phẩm Shopee (dạng …-i.SHOPID.ITEMID hoặc /product/SHOPID/ITEMID).",
})

const LERGASSY_SORT = {
  relevance: "relevancy",
  sales: "sales",
  newest: "latest",
  price_asc: "price_asc",
  price_desc: "price_desc",
} as const

const GIO21_SEARCH_FIELDS = [
  "_mock",
  "_notice",
  "name",
  "price",
  "priceMax",
  "currency",
  "originalPrice",
  "discountPercent",
  "isOnSale",
  "historicalSoldEstimated",
  "favorites",
  "reviewCount",
  "rating",
  "shopName",
  "brand",
  "location",
  "itemId",
  "shopId",
  "url",
]
const LERGASSY_PRODUCT_FIELDS = [
  "type",
  "title",
  "price",
  "originalPrice",
  "discountPercent",
  "currency",
  "rating",
  "ratingCount",
  "brand",
  "shopName",
  "shopRating",
  "location",
  "country",
  "shopId",
  "itemId",
  "url",
]
const GIO21_MOCK_NOTE =
  "Gói Apify Free: Actor này chỉ trả ~20 sản phẩm thật, phần còn lại là dữ liệu MẪU (_mock = true) — bỏ qua các dòng _mock."

export const SHOPEE_TASKS = [
  defineTask({
    key: "shopee_search",
    group: "shopee",
    titleVi: "Tìm sản phẩm Shopee theo từ khoá",
    descriptionVi:
      "Dùng khi cần danh sách sản phẩm Shopee (mặc định shopee.vn) theo từ khoá: tên, giá, giá gốc, % giảm, đánh giá, lượt thích, shop. Hợp để khảo sát giá và đối thủ.",
    input: strictInput({
      keyword: singleLine().describe('Từ khoá tìm kiếm, vd. "kem chống nắng"'),
      country: shopeeCountry,
      sort: z
        .enum(["relevance", "sales", "newest", "price_asc", "price_desc"])
        .default("relevance")
        .describe("Sắp xếp (chỉ Actor dự phòng áp dụng)"),
    }),
    example: { keyword: "kem chống nắng", country: "VN" },
    limit: { default: 40, max: 150 },
    estimatedCostUsd: 0.34,
    noteVi:
      'Shopee VN chỉ ở mức best-effort (Shopee chặn bot mạnh). Số đã bán chỉ là ước lượng dạng "1k+".',
    actors: [
      {
        actorId: "gio21~shopee-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        // maxItems: minimum 10 in the Actor schema; ~150 items per keyword is Shopee's own cap
        buildInput: (p, limit) => ({
          keywords: [p.keyword],
          shopUrls: [],
          categoryUrls: [],
          country: p.country,
          maxItems: Math.max(10, limit),
          priceSlicing: false,
          debug: false,
        }),
        resultFields: GIO21_SEARCH_FIELDS,
        noteVi: GIO21_MOCK_NOTE,
      },
      {
        actorId: "lergassy~shopee-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          mode: "search",
          country: p.country,
          searchTerms: [p.keyword],
          startUrls: [],
          maxItems: limit,
          enrichProducts: false,
          includeShopAndReviews: true,
          sortBy: LERGASSY_SORT[p.sort],
          maxConcurrency: 3,
        }),
        resultFields: LERGASSY_PRODUCT_FIELDS,
        noteVi: "Không có số đã bán (Shopee ẩn với khách chưa đăng nhập).",
      },
    ],
  }),

  defineTask({
    key: "shopee_product",
    group: "shopee",
    titleVi: "Chi tiết sản phẩm Shopee từ link",
    descriptionVi:
      "Dùng khi đã có link sản phẩm Shopee và cần chi tiết: mô tả, giá, biến thể, tồn kho, đánh giá, số đã bán, shop. Tối đa 5 link mỗi lần.",
    input: strictInput({
      urls: urlList(shopeeProductUrl, 5).describe(
        "1–5 link sản phẩm Shopee (dạng …-i.SHOPID.ITEMID hoặc /product/SHOPID/ITEMID)"
      ),
    }),
    example: { urls: ["https://shopee.vn/product/123456789/987654321"] },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.1,
    noteVi:
      "limit = số link được xử lý (theo thứ tự). Giá ~$0.02/sản phẩm. Shopee VN best-effort.",
    actors: [
      {
        actorId: "gio21~shopee-product-detail",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          productUrls: p.urls.slice(0, limit),
          country: "",
          includeReviews: false,
          reviewsLimit: 1,
          pdpViaPage: true,
          debug: false,
        }),
        resultFields: [
          "_mock",
          "_notice",
          "name",
          "price",
          "originalPrice",
          "discountPercent",
          "isOnSale",
          "currency",
          "stock",
          "rating",
          "reviewCount",
          "historicalSold",
          "shopName",
          "shopRating",
          "brand",
          "modelsCount",
          "url",
        ],
        noteVi:
          "Gói Apify Free không lấy được dữ liệu thật (trả _mock = true); cần gói trả phí.",
      },
      {
        actorId: "lergassy~shopee-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          mode: "product",
          country: shopeeCountryFromUrl(p.urls[0]) ?? "VN",
          searchTerms: [],
          startUrls: p.urls.slice(0, limit),
          // one product per product URL
          maxItems: 1,
          enrichProducts: false,
          includeShopAndReviews: true,
          maxConcurrency: 3,
        }),
        resultFields: [
          "type",
          "title",
          "brand",
          "price",
          "originalPrice",
          "discountPercent",
          "currency",
          "rating",
          "ratingCount",
          "availability",
          "description",
          "breadcrumb",
          "seller",
          "url",
        ],
        noteVi: "Không có số đã bán.",
      },
    ],
  }),

  defineTask({
    key: "shopee_shop_products",
    group: "shopee",
    titleVi: "Danh sách sản phẩm của một shop Shopee",
    descriptionVi:
      "Dùng khi cần liệt kê sản phẩm đang bán của một shop Shopee (đối thủ): tên, giá, giảm giá, đánh giá, số đã bán.",
    input: strictInput({
      shop_url: shopeeUrl.describe(
        "Link shop Shopee, vd. https://shopee.vn/tenshop hoặc https://shopee.vn/shop/123456789"
      ),
    }),
    example: { shop_url: "https://shopee.vn/shop/123456789" },
    limit: { default: 40, max: 200 },
    estimatedCostUsd: 0.37,
    noteVi:
      "Với shopee.vn chỉ có dữ liệu mức cơ bản (không có mô tả/biến thể đầy đủ). Shopee VN best-effort.",
    actors: [
      {
        actorId: "xtracto~shopee-shop-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          country: (shopeeCountryFromUrl(p.shop_url) ?? "VN").toLowerCase(),
          shop: p.shop_url,
          maxProducts: limit,
          fetchDetail: false,
          delay: 1,
        }),
        resultFields: [
          "name",
          "price",
          "original_price",
          "discount_pct",
          "currency",
          "rating",
          "rating_count",
          "sold_count",
          "location",
          "is_mall",
          "url",
          "item_id",
          "shop_id",
        ],
      },
      {
        actorId: "gio21~shopee-scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => {
          const c = shopeeCountryFromUrl(p.shop_url)
          return {
            keywords: [],
            shopUrls: [p.shop_url],
            categoryUrls: [],
            country: c && GIO21_COUNTRIES.has(c) ? c : "VN",
            maxItems: Math.max(10, limit),
            priceSlicing: false,
            debug: false,
          }
        },
        resultFields: GIO21_SEARCH_FIELDS,
        noteVi: GIO21_MOCK_NOTE,
      },
    ],
  }),

  defineTask({
    key: "shopee_reviews",
    group: "shopee",
    titleVi: "Đánh giá của shop / sản phẩm Shopee",
    descriptionVi:
      "Dùng khi cần đọc đánh giá khách hàng trên Shopee (lọc theo sao, chỉ đánh giá có nội dung, N ngày gần đây) để tìm điểm khen/chê của sản phẩm hoặc shop đối thủ.",
    input: strictInput({
      url: shopeeUrl.describe("Link shop hoặc link sản phẩm Shopee"),
      stars: starsField,
      only_with_text: z
        .boolean()
        .default(false)
        .describe("Chỉ lấy đánh giá có viết nội dung"),
      since_days: z
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Chỉ lấy đánh giá trong N ngày gần đây (chỉ Actor chính)"),
    }),
    example: {
      url: "https://shopee.vn/shop/123456789",
      stars: [1, 2, 3],
      only_with_text: true,
    },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.36,
    noteVi:
      "Shopee không có luồng đánh giá riêng từng sản phẩm: link sản phẩm chỉ trả phần đánh giá của sản phẩm đó trong luồng đánh giá của cả shop (có thể ít). Có tên người mua — chỉ dùng để phân tích.",
    actors: [
      {
        actorId: "memo23~shopee-reviews-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          startUrls: [p.url],
          // 0 would mean "everything" (~5,000 per shop): always the effective limit
          maxReviewsPerShop: limit,
          starRatings: starStrings(p.stars),
          onlyWithText: p.only_with_text,
          onlyWithMedia: false,
          ...(p.since_days ? { reviewsSince: `${p.since_days} days` } : {}),
          includeShopSummary: true,
          maxConcurrency: 1,
        }),
        resultFields: [
          "rating",
          "text",
          "productName",
          "variation",
          "createdAt",
          "sellerReply",
          "imageUrls",
          "productQuality",
          "sellerService",
          "deliveryService",
          "country",
          "productUrl",
        ],
      },
      {
        actorId: "dami_studio~shopee-shop-reviews-scraper",
        timeoutSecs: 300,
        memoryMbytes: 256,
        // startUrls is always set: without it the Actor scrapes its demo shop and still charges
        buildInput: (p, limit) => ({
          startUrls: [p.url],
          maxReviewsPerShop: limit,
          starRatings: starStrings(p.stars),
          onlyWithText: p.only_with_text,
          onlyWithMedia: false,
          includeShopSummary: true,
          requestDelayMs: 250,
        }),
        resultFields: [
          "rating_star",
          "comment",
          "product_name",
          "model_name",
          "review_date",
          "image_count",
          "product_url",
        ],
        noteVi: "Không hỗ trợ lọc theo số ngày (since_days bị bỏ qua).",
      },
    ],
  }),
]
