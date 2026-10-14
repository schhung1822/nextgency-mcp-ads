// Tiki (tiki.vn) tasks — BETA (hidden unless requested): the Store only has small Actors (logiover: 15 users;
// realletoangt: created 2026-10-14). 16-apify.md §6. Input schemas checked on the Apify Store 2026-10-14.
import { z } from "zod"

import {
  defineTask,
  httpsUrl,
  HOSTS,
  singleLine,
  strictInput,
  urlList,
} from "./common"

/** product pages end with -p<id>.html */
const tikiProductUrl = httpsUrl("Tiki", HOSTS.tiki, {
  test: (u) => /-p\d+\.html$/.test(u.pathname),
  message: "Cần link sản phẩm Tiki (dạng https://tiki.vn/…-p123456.html).",
})

const TIKI_SORT = {
  relevance: "default",
  top_seller: "top_seller",
  newest: "newest",
  price_asc: "price,asc",
  price_desc: "price,desc",
} as const

/** logiover returns up to 48 products per result page */
const LOGIOVER_PAGE_SIZE = 48

const REALLETOANGT_FIELDS = [
  "type",
  "productId",
  "name",
  "price",
  "originalPrice",
  "discountRate",
  "quantitySold",
  "ratingAverage",
  "reviewCount",
  "brandName",
  "sellerName",
  "categoryName",
  "url",
]

export const TIKI_TASKS = [
  defineTask({
    key: "tiki_search",
    group: "tiki",
    beta: true,
    titleVi: "Tìm sản phẩm Tiki theo từ khoá",
    descriptionVi:
      "Dùng khi cần danh sách sản phẩm Tiki theo từ khoá: giá, giá gốc, % giảm, đánh giá, số đã bán, người bán (chính hãng hay không), thương hiệu.",
    input: strictInput({
      keyword: singleLine().describe('Từ khoá tìm kiếm, vd. "sữa rửa mặt"'),
      sort: z
        .enum(["relevance", "top_seller", "newest", "price_asc", "price_desc"])
        .default("relevance")
        .describe("Sắp xếp kết quả"),
    }),
    example: { keyword: "sữa rửa mặt", sort: "top_seller" },
    limit: { default: 40, max: 200 },
    estimatedCostUsd: 0.12,
    noteVi: "Beta: Actor ít người dùng, cần kiểm tra kết quả.",
    actors: [
      {
        actorId: "logiover~tiki-vn-scraper",
        timeoutSecs: 300,
        memoryMbytes: 512,
        buildInput: (p, limit) => ({
          queries: [p.keyword],
          maxPages: Math.ceil(limit / LOGIOVER_PAGE_SIZE),
          maxProductsTotal: limit,
          sortBy: TIKI_SORT[p.sort],
          priceMin: 0,
          priceMax: 0,
          maxConcurrency: 2,
          proxyConfig: { useApifyProxy: true },
        }),
        resultFields: [
          "productId",
          "name",
          "price",
          "originalPrice",
          "discountRate",
          "ratingAverage",
          "reviewCount",
          "quantitySold",
          "sellerName",
          "sellerIsOfficial",
          "brandName",
          "categoryName",
          "inventoryStatus",
          "productUrl",
        ],
      },
      {
        actorId: "realletoangt~tiki-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          keywords: [p.keyword],
          maxProductsPerSource: limit,
          sort: TIKI_SORT[p.sort],
          includeDetails: false,
          maxReviewsPerProduct: 0,
        }),
        resultFields: REALLETOANGT_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiki_product",
    group: "tiki",
    beta: true,
    titleVi: "Chi tiết sản phẩm Tiki từ link",
    descriptionVi:
      "Dùng khi đã có link sản phẩm Tiki và cần chi tiết: mô tả, thông số, tồn kho, giá, các người bán. Tối đa 5 link mỗi lần.",
    input: strictInput({
      urls: urlList(tikiProductUrl, 5).describe(
        "1–5 link sản phẩm Tiki (dạng …-p123456.html)"
      ),
    }),
    example: { urls: ["https://tiki.vn/sua-rua-mat-abc-p123456789.html"] },
    limit: { default: 5, max: 5 },
    estimatedCostUsd: 0.01,
    noteVi: "Beta: Actor mới (10/2026). limit = số link được xử lý.",
    actors: [
      {
        actorId: "realletoangt~tiki-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: p.urls.slice(0, limit).map((url) => ({ url })),
          maxProductsPerSource: 1,
          includeDetails: true,
          maxReviewsPerProduct: 0,
        }),
        resultFields: REALLETOANGT_FIELDS,
      },
    ],
  }),

  defineTask({
    key: "tiki_reviews",
    group: "tiki",
    beta: true,
    titleVi: "Đánh giá sản phẩm Tiki",
    descriptionVi:
      "Dùng khi cần đọc đánh giá của một sản phẩm Tiki: số sao, tiêu đề, nội dung, ngày, ảnh.",
    input: strictInput({
      url: tikiProductUrl.describe("Link sản phẩm Tiki"),
    }),
    example: { url: "https://tiki.vn/sua-rua-mat-abc-p123456789.html" },
    limit: { default: 50, max: 300 },
    estimatedCostUsd: 0.08,
    noteVi:
      "Beta: Actor mới (10/2026). Kết quả gồm 1 dòng sản phẩm + các dòng đánh giá (type = review). Có tên người đánh giá.",
    actors: [
      {
        actorId: "realletoangt~tiki-scraper",
        timeoutSecs: 300,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: [{ url: p.url }],
          maxProductsPerSource: 1,
          includeDetails: false,
          maxReviewsPerProduct: limit,
        }),
        resultFields: [
          "type",
          "productId",
          "name",
          "rating",
          "title",
          "content",
          "createdAt",
          "images",
          "url",
        ],
      },
    ],
  }),
]
