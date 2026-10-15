// Apify catalog (16-apify.md §6): structure, zod inputs (https only, right platform, strict keys), every Actor input
// pins its limit fields from the effective limit, never carries cookie / login / custom JS / webhook / connector /
// proxy URL keys, limit clamping and buildActorRun errors. Pure: no network, no DB.
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  APIFY_ACTOR_MIN_CHARGE_USD,
  APIFY_CATALOG,
  ApifyCatalogInputError,
  buildActorRun,
  clampTaskLimit,
  findForbiddenInputKeys,
  getCatalogTask,
  getCatalogTaskExample,
  listCatalogTasks,
} from "./catalog"
import {
  HOSTS,
  instagramHandle,
  isGoogleMapsUrl,
  isThreadsPostUrl,
  lazadaCountryFromUrl,
  shopeeCountryFromUrl,
  threadsHandle,
  tiktokHandle,
} from "./catalog/common"
import { adLibrarySearchUrl } from "./catalog/facebook"
import type { ApifyCatalogTask } from "./types"

/** the deep scan required by the task brief (catalog.ts uses a stricter superset at runtime) */
const FORBIDDEN_KEY_RE =
  /cookie|login|password|session|pageFunction|Function$|webhook|outputConnector|mcpConnector|proxyUrl/i

const CORE_KEYS = [
  "shopee_search",
  "shopee_product",
  "shopee_shop_products",
  "shopee_reviews",
  "lazada_search",
  "lazada_product",
  "lazada_reviews",
  "tiktokshop_search",
  "tiktokshop_product",
  "tiktokshop_reviews",
  "tiktok_search_videos",
  "tiktok_hashtag_videos",
  "tiktok_profile_videos",
  "tiktok_comments",
  "tiktok_top_ads",
  "facebook_ads_library",
  "facebook_page_posts",
  "facebook_page_info",
  "facebook_group_posts",
  "facebook_comments",
  "instagram_profile",
  "instagram_posts",
  "instagram_hashtag",
  "threads_profile_posts",
  "threads_search",
  "threads_replies",
  "threads_profile",
  "youtube_search",
  "youtube_channel",
  "youtube_comments",
  "google_maps_places",
  "google_maps_reviews",
  "google_serp",
  "google_ads_transparency",
  "web_page_read",
  "website_crawl",
]
const BETA_KEYS = [
  "tiki_search",
  "tiki_product",
  "tiki_reviews",
  "tiktok_trends",
  "google_trends",
  "google_shopping",
  "threads_followers",
]

// ---------------------------------------------------------------------------------------------------------------
// Limit rules: for every task × Actor, the limit-like input fields and the value they must have for an effective
// limit L (URL lists: how many URLs are passed). A new Actor without rules fails the coverage test below.
// ---------------------------------------------------------------------------------------------------------------

type Rule =
  | number // constant
  | "L" // = limit
  | "L10" // = max(10, limit) (schema minimum 10)
  | "L100" // = min(limit, 100) (schema maximum 100)
  | "L50" // = min(limit, 50) (nested array kept whole by apify_get_results)
  | "L+1" // = limit + 1 (hard row cap: the post row + `limit` replies)
  | "P48" // = ceil(limit / 48) (result pages of 48)
  | "S10" // = String(limit * 10) (results enum "10".."50", 10 per page)
  | "NUM" // damilo page size enum: largest of 10/20/30/40/50/100 ≤ limit (min 10)
  | "SLICE" // array of min(limit, URLs given) items

const CLOCKWORKS_SCRAPER: Record<string, Rule> = {
  resultsPerPage: "L",
  maxProfilesPerQuery: 1,
  maxFollowersPerProfile: 0,
  maxFollowingPerProfile: 0,
  commentsPerPost: 0,
  topLevelCommentsPerPost: 0,
  maxRepliesPerComment: 0,
}
const COMPASS_PLACES_EXTRAS: Record<string, Rule> = {
  maxImages: 0,
  maxQuestions: 0,
  maximumLeadsEnrichmentRecords: 0,
  maxCompetitorsToAnalyze: 0,
}
const YOUTUBE_VIDEOS: Record<string, Rule> = {
  maxResults: "L",
  maxResultsShorts: 0,
  maxResultStreams: 0,
}

const LIMIT_RULES: Record<string, Record<string, Rule>> = {
  "shopee_search:gio21~shopee-scraper": { maxItems: "L10" },
  "shopee_search:lergassy~shopee-scraper": { maxItems: "L" },
  "shopee_product:gio21~shopee-product-detail": {
    productUrls: "SLICE",
    reviewsLimit: 1,
  },
  "shopee_product:lergassy~shopee-scraper": { startUrls: "SLICE", maxItems: 1 },
  "shopee_shop_products:xtracto~shopee-shop-scraper": { maxProducts: "L" },
  "shopee_shop_products:gio21~shopee-scraper": { maxItems: "L10" },
  "shopee_reviews:memo23~shopee-reviews-scraper": { maxReviewsPerShop: "L" },
  "shopee_reviews:dami_studio~shopee-shop-reviews-scraper": {
    maxReviewsPerShop: "L",
  },
  "lazada_search:lergassy~lazada-scraper": {
    maxItems: "L",
    maxReviewsPerProduct: 1,
  },
  "lazada_search:fatihtahta~lazada-scraper": { limit: "L10", maxReviews: 1 },
  "lazada_product:lergassy~lazada-scraper": {
    startUrls: "SLICE",
    maxItems: 1,
    maxReviewsPerProduct: 1,
  },
  "lazada_product:fatihtahta~lazada-scraper": {
    startUrls: "SLICE",
    limit: 10,
    maxReviews: 1,
  },
  "lazada_reviews:zen-studio~lazada-reviews-scraper": {
    maxReviewsPerProduct: "L",
    maxReviews: "L",
  },
  "lazada_reviews:lergassy~lazada-scraper": {
    maxItems: 1,
    maxReviewsPerProduct: "L",
  },
  "tiktokshop_search:pro100chok~tiktok-shop-scraper-usage": {
    maxItems: "L",
    maxReviews: 1,
  },
  "tiktokshop_search:coregent~tiktok-shop-product-scraper": {
    maxResultsPerQuery: "L",
    maxResultsTotal: "L",
    maxReviews: 1,
  },
  "tiktokshop_product:pro100chok~tiktok-shop-scraper-usage": {
    productUrls: "SLICE",
    maxItems: "L",
    maxReviews: 1,
  },
  "tiktokshop_product:coregent~tiktok-shop-product-scraper": {
    productUrls: "SLICE",
    maxResultsPerQuery: 1,
    maxResultsTotal: "L",
    maxReviews: 1,
  },
  "tiktokshop_reviews:pro100chok~tiktok-shop-scraper-usage": {
    maxItems: "L",
    maxReviews: "L",
  },
  "tiktokshop_reviews:coregent~tiktok-shop-product-scraper": {
    maxResultsPerQuery: 1,
    maxResultsTotal: 1,
    maxReviews: "L100",
  },
  "tiktok_search_videos:clockworks~tiktok-scraper": CLOCKWORKS_SCRAPER,
  "tiktok_search_videos:apidojo~tiktok-scraper": { maxItems: "L" },
  "tiktok_hashtag_videos:clockworks~tiktok-hashtag-scraper": {
    resultsPerPage: "L",
  },
  "tiktok_hashtag_videos:clockworks~tiktok-scraper": CLOCKWORKS_SCRAPER,
  "tiktok_profile_videos:clockworks~tiktok-profile-scraper": {
    resultsPerPage: "L",
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: 0,
    commentsPerPost: 0,
    topLevelCommentsPerPost: 0,
    maxRepliesPerComment: 0,
  },
  "tiktok_profile_videos:apidojo~tiktok-scraper": { maxItems: "L" },
  "tiktok_comments:clockworks~tiktok-comments-scraper": {
    commentsPerPost: "L",
    topLevelCommentsPerPost: "L",
    maxRepliesPerComment: 0,
    resultsPerPage: 1,
  },
  "tiktok_comments:apidojo~tiktok-comments-scraper": { maxItems: "L" },
  "tiktok_top_ads:automation_craft~tiktok-creative-center-scraper": {
    maxAds: "L",
  },
  "tiktok_top_ads:datapeak~tiktok-creative-center": { maxItems: "L" },
  "tiktok_trends:datapeak~tiktok-creative-center": { maxItems: "L" },
  "facebook_ads_library:automation-lab~facebook-ads-library": { maxAds: "L" },
  "facebook_ads_library:apify~facebook-ads-scraper": { resultsLimit: "L" },
  "facebook_page_posts:apify~facebook-posts-scraper": { resultsLimit: "L" },
  "facebook_page_info:apify~facebook-pages-scraper": { startUrls: "SLICE" },
  "facebook_group_posts:apify~facebook-groups-scraper": { resultsLimit: "L" },
  "facebook_group_posts:memo23~facebook-public-group-posts-scraper": {
    maxItems: "L",
  },
  "facebook_comments:apify~facebook-comments-scraper": { resultsLimit: "L" },
  "instagram_profile:apify~instagram-profile-scraper": { usernames: "SLICE" },
  "instagram_profile:apify~instagram-scraper": {
    directUrls: "SLICE",
    resultsLimit: 1,
    searchLimit: 1,
  },
  "instagram_posts:apify~instagram-scraper": {
    resultsLimit: "L",
    searchLimit: 1,
  },
  "instagram_hashtag:apify~instagram-scraper": {
    resultsLimit: "L",
    searchLimit: 1,
  },
  "instagram_hashtag:apify~instagram-hashtag-scraper": { resultsLimit: "L" },
  "threads_profile_posts:futurizerush~meta-threads-scraper": {
    max_posts: "L10",
  },
  "threads_profile_posts:automation-lab~threads-scraper": { maxPosts: "L" },
  "threads_search:futurizerush~meta-threads-scraper": { max_posts: "L10" },
  "threads_search:logical_scrapers~threads-search-scraper": { maxItems: "L" },
  "threads_replies:lergassy~threads-scraper": {
    maxRepliesPerPost: "L",
    maxPosts: "L",
    maxItems: "L+1",
    maxUsersPerKeyword: 1,
  },
  "threads_replies:logical_scrapers~threads-post-scraper": {
    maxReplies: "L50",
  },
  "threads_profile:apify~threads-profile-api-scraper": { usernames: "SLICE" },
  "threads_profile:automation-lab~threads-scraper": {
    usernames: "SLICE",
    maxPosts: 1,
  },
  "threads_followers:scraping_solutions~threads-followers-following-scraper": {
    maxResultsPerUser: "L",
  },
  "youtube_search:streamers~youtube-scraper": YOUTUBE_VIDEOS,
  "youtube_channel:streamers~youtube-channel-scraper": YOUTUBE_VIDEOS,
  "youtube_channel:streamers~youtube-scraper": YOUTUBE_VIDEOS,
  "youtube_comments:streamers~youtube-comments-scraper": { maxComments: "L" },
  "google_maps_places:compass~crawler-google-places": {
    maxCrawledPlacesPerSearch: "L",
    maxReviews: 0,
    ...COMPASS_PLACES_EXTRAS,
  },
  "google_maps_reviews:compass~Google-Maps-Reviews-Scraper": {
    maxReviews: "L",
  },
  "google_maps_reviews:compass~crawler-google-places": {
    maxCrawledPlacesPerSearch: 1,
    maxReviews: "L",
    ...COMPASS_PLACES_EXTRAS,
  },
  "google_serp:apify~google-search-scraper": {
    maxPagesPerQuery: "L",
    maximumLeadsEnrichmentRecords: 0,
  },
  "google_serp:scraperlink~google-search-results-serp-scraper": {
    limit: "S10",
  },
  "google_ads_transparency:scrapesage~google-ads-transparency-scraper": {
    maxAdsPerSearch: "L",
    maxAdvertisersPerQuery: 1,
  },
  "google_trends:data_xplorer~google-trends-fast-scraper": {
    trendingSearchesMaxItems: "L",
  },
  "google_shopping:damilo~google-shopping-apify": { num: "NUM", max_pages: 1 },
  "google_shopping:burbn~google-shopping-scraper": { limit: "L10", page: 1 },
  "web_page_read:apify~rag-web-browser": { maxResults: "L" },
  "web_page_read:apify~website-content-crawler": {
    maxCrawlPages: "L",
    maxResults: "L",
    maxCrawlDepth: 0,
    maxScrollHeightPixels: 5000,
  },
  // example max_depth = 1
  "website_crawl:apify~website-content-crawler": {
    maxCrawlPages: "L",
    maxResults: "L",
    maxCrawlDepth: 1,
    maxScrollHeightPixels: 5000,
  },
  "tiki_search:logiover~tiki-vn-scraper": {
    maxPages: "P48",
    maxProductsTotal: "L",
  },
  "tiki_search:realletoangt~tiki-scraper": {
    maxProductsPerSource: "L",
    maxReviewsPerProduct: 0,
  },
  "tiki_product:realletoangt~tiki-scraper": {
    startUrls: "SLICE",
    maxProductsPerSource: 1,
    maxReviewsPerProduct: 0,
  },
  "tiki_reviews:realletoangt~tiki-scraper": {
    maxProductsPerSource: 1,
    maxReviewsPerProduct: "L",
  },
}

function expected(rule: Rule, limit: number): unknown {
  switch (rule) {
    case "L":
      return limit
    case "L10":
      return Math.max(10, limit)
    case "L100":
      return Math.min(limit, 100)
    case "L50":
      return Math.min(limit, 50)
    case "L+1":
      return limit + 1
    case "P48":
      return Math.ceil(limit / 48)
    case "S10":
      return String(limit * 10)
    case "NUM":
      return String([100, 50, 40, 30, 20, 10].find((s) => s <= limit) ?? 10)
    case "SLICE":
      return undefined // checked separately
    default:
      return rule
  }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

function example(task: ApifyCatalogTask): Record<string, unknown> {
  const ex = getCatalogTaskExample(task.key)
  if (!ex) throw new Error(`no example for ${task.key}`)
  return ex
}

/** Example with every URL array filled up to 5 entries (to exercise URL slicing by the limit). */
function maxedExample(task: ApifyCatalogTask): {
  params: Record<string, unknown>
  urlCount: number
} {
  const params = example(task)
  let urlCount = 0
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      params[k] = Array.from({ length: 5 }, () => v[0])
      urlCount = 5
    }
  }
  return { params, urlCount }
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])
    )
  }
  return value
}

function hasHttpsString(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("https://")
  if (Array.isArray(value)) return value.some(hasHttpsString)
  if (value && typeof value === "object") {
    return Object.values(value).some(hasHttpsString)
  }
  return false
}

function deepKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => deepKeys(v, out))
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      deepKeys(v, out)
    }
  }
  return out
}

const actorCases = APIFY_CATALOG.flatMap((task) =>
  task.actors.map((actor, index) => ({ task, actor, index }))
)

// ---------------------------------------------------------------------------------------------------------------

describe("catalog structure", () => {
  it("has unique snake_case keys and covers the core + beta tasks of 16-apify.md §6", () => {
    const keys = APIFY_CATALOG.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/)
    const core = APIFY_CATALOG.filter((t) => !t.beta).map((t) => t.key)
    const beta = APIFY_CATALOG.filter((t) => t.beta).map((t) => t.key)
    expect(core.sort()).toEqual([...CORE_KEYS].sort())
    expect(beta.sort()).toEqual([...BETA_KEYS].sort())
  })

  it.each(APIFY_CATALOG.map((t) => [t.key, t] as const))(
    "%s: metadata, limits and actors are well-formed",
    (_key, task) => {
      expect(task.titleVi.trim().length).toBeGreaterThan(0)
      expect(task.descriptionVi.startsWith("Dùng khi")).toBe(true)
      expect(task.descriptionVi.length).toBeLessThanOrEqual(300)
      expect(Number.isInteger(task.limit.max)).toBe(true)
      expect(Number.isInteger(task.limit.default)).toBe(true)
      expect(task.limit.default).toBeGreaterThanOrEqual(1)
      expect(task.limit.default).toBeLessThanOrEqual(task.limit.max)
      expect(task.estimatedCostUsd).toBeGreaterThan(0)
      // default run must fit the default per-run cap ($1, 16-apify.md A3)
      expect(task.estimatedCostUsd).toBeLessThan(1)
      expect(task.actors.length).toBeGreaterThanOrEqual(1)
      const ids = task.actors.map((a) => a.actorId)
      expect(new Set(ids).size).toBe(ids.length)
      for (const a of task.actors) {
        expect(a.actorId).toMatch(
          /^[A-Za-z0-9][A-Za-z0-9._-]*~[A-Za-z0-9][A-Za-z0-9._-]*$/
        )
        expect(a.timeoutSecs).toBeGreaterThan(0)
        expect(a.timeoutSecs).toBeLessThanOrEqual(600)
        expect(a.memoryMbytes).toBeDefined()
        const mem = a.memoryMbytes ?? 0
        expect(mem).toBeGreaterThanOrEqual(128)
        expect(mem).toBeLessThanOrEqual(4096)
        expect(mem & (mem - 1)).toBe(0)
        const fields = a.resultFields ?? []
        expect(new Set(fields).size).toBe(fields.length)
        // top-level keys only: usable as ?fields= without ?flatten=
        for (const f of fields) expect(f).not.toContain(".")
      }
    }
  )

  it("lists core tasks by default and beta tasks only on request", () => {
    expect(
      listCatalogTasks()
        .map((t) => t.key)
        .sort()
    ).toEqual([...CORE_KEYS].sort())
    expect(listCatalogTasks({ includeBeta: true })).toHaveLength(
      APIFY_CATALOG.length
    )
  })

  it("finds tasks by key and returns null for unknown keys", () => {
    expect(getCatalogTask("shopee_search")?.group).toBe("shopee")
    expect(getCatalogTask("tiki_search")?.beta).toBe(true)
    expect(getCatalogTask("nope")).toBeNull()
    expect(getCatalogTask("__proto__")).toBeNull()
    expect(getCatalogTask("constructor")).toBeNull()
    expect(getCatalogTaskExample("nope")).toBeNull()
  })

  it("returns a copy of the example", () => {
    const a = getCatalogTaskExample("shopee_search")
    if (a) a.keyword = "changed"
    expect(getCatalogTaskExample("shopee_search")?.keyword).toBe(
      "kem chống nắng"
    )
  })

  it("keeps every task input representable as JSON Schema (apify_list_tasks)", () => {
    for (const task of APIFY_CATALOG) {
      const schema = z.toJSONSchema(task.input, { io: "input" }) as {
        additionalProperties?: boolean
      }
      expect(schema.additionalProperties, task.key).toBe(false)
    }
  })

  it("lists minimum charges only for catalog Actors", () => {
    const ids = new Set(actorCases.map((c) => c.actor.actorId))
    for (const [id, usd] of Object.entries(APIFY_ACTOR_MIN_CHARGE_USD)) {
      expect(ids.has(id), id).toBe(true)
      expect(usd).toBeGreaterThan(0)
      expect(usd).toBeLessThanOrEqual(1)
    }
  })

  it("stays a pure module (no next/*, no DB, no network)", () => {
    const dir = path.resolve(import.meta.dirname)
    const files = [
      path.join(dir, "catalog.ts"),
      ...fs
        .readdirSync(path.join(dir, "catalog"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => path.join(dir, "catalog", f)),
    ]
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/from\s+["']next(\/|["'])/)
      expect(src, f).not.toMatch(/@\/server\/db|drizzle|server-only/)
      expect(src, f).not.toMatch(/\bfetch\(/)
    }
  })
})

describe("task inputs (zod)", () => {
  it.each(APIFY_CATALOG.map((t) => [t.key, t] as const))(
    "%s: accepts its example, rejects unknown keys and bad URLs",
    (_key, task) => {
      const ex = example(task)
      expect(task.input.safeParse(ex).success).toBe(true)
      expect(task.input.safeParse({ ...ex, __extra: 1 }).success).toBe(false)
      if (hasHttpsString(ex)) {
        const http = mapStrings(ex, (s) => s.replace(/^https:\/\//, "http://"))
        expect(task.input.safeParse(http).success).toBe(false)
        const creds = mapStrings(ex, (s) =>
          s.replace(/^https:\/\//, "https://user:secret@")
        )
        expect(task.input.safeParse(creds).success).toBe(false)
        const js = mapStrings(ex, (s) =>
          s.startsWith("https://") ? "javascript:alert(1)" : s
        )
        expect(task.input.safeParse(js).success).toBe(false)
        const otherHost = mapStrings(ex, (s) =>
          s.startsWith("https://") ? "https://evil.example.org/x-i.1.2" : s
        )
        // web tasks accept any https host; platform tasks only their platform
        expect(task.input.safeParse(otherHost).success).toBe(
          task.group === "web"
        )
      }
    }
  )

  it("rejects empty, multi-line or overlong keywords", () => {
    const task = getCatalogTask("shopee_search")!
    expect(task.input.safeParse({ keyword: "" }).success).toBe(false)
    expect(task.input.safeParse({ keyword: "   " }).success).toBe(false)
    expect(task.input.safeParse({ keyword: "a\nb" }).success).toBe(false)
    expect(task.input.safeParse({ keyword: "a\u202eb" }).success).toBe(false)
    expect(task.input.safeParse({ keyword: "x".repeat(121) }).success).toBe(
      false
    )
    expect(task.input.safeParse({ keyword: 12 }).success).toBe(false)
  })

  it("applies defaults (country VN, language vi)", () => {
    expect(
      getCatalogTask("shopee_search")!.input.parse({ keyword: "son" })
    ).toEqual({ keyword: "son", country: "VN", sort: "relevance" })
    expect(
      getCatalogTask("google_serp")!.input.parse({ query: "máy lọc nước" })
    ).toEqual({
      query: "máy lọc nước",
      country: "VN",
      language: "vi",
      include_ads: false,
    })
  })

  it("rejects countries an Actor does not support", () => {
    expect(
      getCatalogTask("shopee_search")!.input.safeParse({
        keyword: "son",
        country: "US",
      }).success
    ).toBe(false)
    expect(
      getCatalogTask("lazada_search")!.input.safeParse({
        keyword: "son",
        country: "BR",
      }).success
    ).toBe(false)
  })

  it("caps URL lists at 5 and requires at least one", () => {
    const task = getCatalogTask("shopee_product")!
    const url = "https://shopee.vn/product/1/2"
    expect(task.input.safeParse({ urls: [] }).success).toBe(false)
    expect(task.input.safeParse({ urls: Array(5).fill(url) }).success).toBe(
      true
    )
    expect(task.input.safeParse({ urls: Array(6).fill(url) }).success).toBe(
      false
    )
  })

  it("requires product pages where a product is expected", () => {
    const shopee = getCatalogTask("shopee_product")!
    expect(
      shopee.input.safeParse({ urls: ["https://shopee.vn/ten-sp-i.123.456"] })
        .success
    ).toBe(true)
    expect(
      shopee.input.safeParse({ urls: ["https://shopee.vn/shop/123"] }).success
    ).toBe(false)
    const lazada = getCatalogTask("lazada_reviews")!
    expect(
      lazada.input.safeParse({ url: "https://www.lazada.vn/shop/abc" }).success
    ).toBe(false)
    const tiki = getCatalogTask("tiki_reviews")!
    expect(
      tiki.input.safeParse({ url: "https://tiki.vn/sua-rua-mat-p123.html" })
        .success
    ).toBe(true)
    expect(
      tiki.input.safeParse({ url: "https://tiki.vn/search?q=a" }).success
    ).toBe(false)
  })

  it("needs exactly one of keyword / page_url for the Ad Library", () => {
    const task = getCatalogTask("facebook_ads_library")!
    expect(task.input.safeParse({}).success).toBe(false)
    expect(
      task.input.safeParse({
        keyword: "son",
        page_url: "https://www.facebook.com/brand",
      }).success
    ).toBe(false)
    expect(
      task.input.safeParse({ page_url: "https://www.facebook.com/brand" })
        .success
    ).toBe(true)
  })

  it("needs exactly one of place_url / place_id for Maps reviews", () => {
    const task = getCatalogTask("google_maps_reviews")!
    expect(task.input.safeParse({}).success).toBe(false)
    expect(
      task.input.safeParse({ place_id: "ChIJreV9aqYWdkgROM_boL6YbwA" }).success
    ).toBe(true)
    expect(task.input.safeParse({ place_id: "abc" }).success).toBe(false)
    expect(
      task.input.safeParse({ place_url: "https://maps.app.goo.gl/AbCdEf" })
        .success
    ).toBe(true)
    expect(
      task.input.safeParse({ place_url: "https://www.google.com/search?q=x" })
        .success
    ).toBe(false)
  })

  it("accepts TikTok / Instagram handles or profile links only", () => {
    const tt = getCatalogTask("tiktok_profile_videos")!
    for (const ok of ["@brand.vn", "brand_vn", "https://www.tiktok.com/@brand"])
      expect(tt.input.safeParse({ username: ok }).success, ok).toBe(true)
    for (const bad of [
      "a b",
      "http://www.tiktok.com/@brand",
      "https://evil.com/@brand",
    ])
      expect(tt.input.safeParse({ username: bad }).success, bad).toBe(false)
    const ig = getCatalogTask("instagram_profile")!
    expect(
      ig.input.safeParse({ usernames: ["https://www.instagram.com/brand/"] })
        .success
    ).toBe(true)
    expect(
      ig.input.safeParse({ usernames: ["https://www.instagram.com/p/Cxyz/"] })
        .success
    ).toBe(false)
  })

  it("requires a post link to read Instagram comments", () => {
    const task = getCatalogTask("instagram_posts")!
    expect(
      task.input.safeParse({
        url: "https://www.instagram.com/brand/",
        content: "comments",
      }).success
    ).toBe(false)
    expect(
      task.input.safeParse({
        url: "https://www.instagram.com/p/Cxyz123/",
        content: "comments",
      }).success
    ).toBe(true)
  })

  it("accepts Threads handles or https threads.com / threads.net profile links only", () => {
    const posts = getCatalogTask("threads_profile_posts")!
    for (const ok of [
      "@brand.vn",
      "brand_vn",
      "https://www.threads.com/@brand",
      "https://www.threads.net/@brand/",
      "https://threads.com/@brand?xmt=abc",
    ])
      expect(posts.input.safeParse({ username: ok }).success, ok).toBe(true)
    for (const bad of [
      "",
      "a b",
      "@" + "x".repeat(31),
      "http://www.threads.com/@brand",
      "https://evil.com/@brand",
      "https://threads.com.evil.com/@brand",
      "https://evilthreads.net/@brand",
      "https://www.instagram.com/brand/",
      "https://www.threads.com/brand",
      "https://www.threads.com/search?q=brand",
      "https://user:pw@www.threads.com/@brand",
      "javascript:alert(1)",
    ])
      expect(posts.input.safeParse({ username: bad }).success, bad).toBe(false)
    const profile = getCatalogTask("threads_profile")!
    expect(
      profile.input.safeParse({ usernames: Array(5).fill("@brand") }).success
    ).toBe(true)
    expect(
      profile.input.safeParse({ usernames: Array(6).fill("@brand") }).success
    ).toBe(false)
    expect(profile.input.safeParse({ usernames: [] }).success).toBe(false)
  })

  it("requires a Threads post link (https, threads host) for replies", () => {
    const task = getCatalogTask("threads_replies")!
    for (const ok of [
      "https://www.threads.com/@brand/post/DAbc123xyz",
      "https://www.threads.net/@brand/post/Dcy_A8pGo-m/",
      "https://www.threads.com/@brand/post/Dcy_A8pGo-m/media",
      "https://www.threads.com/@brand/post/DAbc123?xmt=share",
      "https://www.threads.net/t/CuW6-7KyXme",
      "https://www.threads.com/share/AbC123",
    ])
      expect(task.input.safeParse({ url: ok }).success, ok).toBe(true)
    for (const bad of [
      "https://www.threads.com/@brand",
      "https://www.threads.com/@brand/post/",
      "https://www.threads.com/search?q=x",
      "http://www.threads.com/@brand/post/DAbc123",
      "https://www.instagram.com/p/DAbc123/",
      "https://threads.com.evil.com/@brand/post/DAbc123",
      "https://user:pw@www.threads.com/@brand/post/DAbc123",
    ])
      expect(task.input.safeParse({ url: bad }).success, bad).toBe(false)
  })

  it("validates Threads search and followers params", () => {
    const search = getCatalogTask("threads_search")!
    expect(search.input.parse({ keyword: "kem chống nắng" })).toEqual({
      keyword: "kem chống nắng",
      sort: "top",
    })
    expect(search.input.safeParse({ keyword: "a\nb" }).success).toBe(false)
    expect(search.input.safeParse({ keyword: "x".repeat(121) }).success).toBe(
      false
    )
    expect(
      search.input.safeParse({ keyword: "son", sort: "popular" }).success
    ).toBe(false)
    expect(
      search.input.safeParse({ keyword: "son", since_days: 0 }).success
    ).toBe(false)
    const followers = getCatalogTask("threads_followers")!
    expect(followers.beta).toBe(true)
    expect(followers.input.parse({ username: "@brand" })).toEqual({
      username: "@brand",
      relation: "followers",
    })
    expect(
      followers.input.safeParse({ username: "@brand", relation: "friends" })
        .success
    ).toBe(false)
  })
})

describe("Actor inputs", () => {
  it("has limit rules for every task × Actor (and no stale rule)", () => {
    const cases = actorCases.map((c) => `${c.task.key}:${c.actor.actorId}`)
    expect(cases.filter((k) => !LIMIT_RULES[k])).toEqual([])
    expect(Object.keys(LIMIT_RULES).filter((k) => !cases.includes(k))).toEqual(
      []
    )
  })

  it.each(
    actorCases.map(
      (c) => [`${c.task.key} #${c.index} ${c.actor.actorId}`, c] as const
    )
  )("%s: limit fields pinned, no forbidden keys", (_name, c) => {
    const { task, actor, index } = c
    const rules = LIMIT_RULES[`${task.key}:${actor.actorId}`]
    const { params, urlCount } = maxedExample(task)
    const limits = [
      ...new Set([1, 2, task.limit.default, task.limit.max]),
    ].filter((l) => l <= task.limit.max)
    const inputs = new Map<number, string>()
    for (const limit of limits) {
      const raw = actor.buildInput(task.input.parse(params), limit)
      const plan = buildActorRun(task, index, params, limit)
      expect(plan.limit).toBe(limit)
      expect(plan.actorId).toBe(actor.actorId)
      expect(plan.timeoutSecs).toBeLessThanOrEqual(600)
      expect(plan.memoryMbytes).toBe(actor.memoryMbytes)
      // forbidden keys: none, anywhere (raw output and the plan sent to Apify)
      expect(deepKeys(raw).filter((k) => FORBIDDEN_KEY_RE.test(k))).toEqual([])
      expect(findForbiddenInputKeys(plan.input)).toEqual([])
      for (const [key, rule] of Object.entries(rules)) {
        expect(plan.input, `${key} missing`).toHaveProperty([key])
        const value = plan.input[key]
        if (rule === "SLICE") {
          expect(Array.isArray(value)).toBe(true)
          expect((value as unknown[]).length).toBe(Math.min(limit, urlCount))
        } else {
          expect(value, `${key} @ limit ${limit}`).toEqual(
            expected(rule, limit)
          )
        }
      }
      // no other count-like number may exceed the hard maximum (or a schema minimum of 10); units that are not
      // result counts (pixels, concurrency, retries, delays, timeouts) are out of scope
      for (const [key, value] of Object.entries(plan.input)) {
        if (
          typeof value === "number" &&
          !(key in rules) &&
          /max|limit|results|per|items|total|pages|ads|comments|reviews/i.test(
            key
          ) &&
          !/pixels|concurrency|retries|delay|timeout|wait|secs|ms$/i.test(key)
        ) {
          expect(value, key).toBeLessThanOrEqual(Math.max(task.limit.max, 10))
        }
      }
      inputs.set(limit, JSON.stringify(plan.input))
    }
    // the limit is actually wired into the input
    if (task.limit.max > 1) {
      expect(inputs.get(1)).not.toBe(inputs.get(task.limit.max))
    }
  })

  it("switches the paid add-ons of Google Maps / Search off", () => {
    const maps = buildActorRun(
      getCatalogTask("google_maps_places")!,
      0,
      { query: "spa", location: "Quận 1, Hồ Chí Minh" },
      20
    )
    expect(maps.input).toMatchObject({
      searchStringsArray: ["spa"],
      locationQuery: "Quận 1, Hồ Chí Minh",
      maxCrawledPlacesPerSearch: 20,
      language: "vi",
      scrapePlaceDetailPage: false,
      scrapeContacts: false,
      maximumLeadsEnrichmentRecords: 0,
      verifyLeadsEnrichmentEmails: false,
      enableCompetitorAnalysis: false,
      scrapeReviewsPersonalData: false,
      scrapeSocialMediaProfiles: {
        facebooks: false,
        instagrams: false,
        youtubes: false,
        tiktoks: false,
        twitters: false,
      },
    })
    expect(maps.input).not.toHaveProperty("countryCode")
    const noLocation = buildActorRun(getCatalogTask("google_maps_places")!, 0, {
      query: "spa",
    })
    expect(noLocation.input).toMatchObject({ countryCode: "vn" })
    expect(noLocation.input).not.toHaveProperty("locationQuery")

    const serp = buildActorRun(
      getCatalogTask("google_serp")!,
      0,
      { query: "máy lọc nước" },
      2
    )
    expect(serp.input).toMatchObject({
      queries: "máy lọc nước",
      maxPagesPerQuery: 2,
      countryCode: "vn",
      languageCode: "vi",
      focusOnPaidAds: false,
      aiModeSearch: { enableAiMode: false },
      chatGptSearch: { enableChatGpt: false },
      geminiSearch: { enableGemini: false },
      copilotSearch: { enableCopilot: false },
      perplexitySearch: { enablePerplexity: false },
      websiteContentScraper: { enable: false },
      saveHtmlToKeyValueStore: false,
    })
  })

  it("never downloads media or transcribes on TikTok / YouTube", () => {
    const tiktok = buildActorRun(getCatalogTask("tiktok_search_videos")!, 0, {
      keyword: "son",
    })
    expect(tiktok.input).toMatchObject({
      searchQueries: ["son"],
      searchSection: "/video",
      resultsPerPage: 30,
      shouldDownloadVideos: false,
      downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
      aiVideoDescription: false,
      aiVideoSummary: false,
      proxyCountryCode: "None",
    })
    const yt = buildActorRun(getCatalogTask("youtube_search")!, 0, {
      keyword: "review",
    })
    expect(yt.input).toMatchObject({
      transcriptionAndSubtitle: "NONE",
      aiVideoDescription: false,
      aiVideoSummary: false,
    })
    expect(yt.input).not.toHaveProperty("dateFilter")
  })

  it("crawls websites politely with a datacenter proxy and no AI summary", () => {
    const run = buildActorRun(
      getCatalogTask("website_crawl")!,
      0,
      { url: "https://example.com/blog/" },
      30
    )
    expect(run.input).toMatchObject({
      startUrls: [{ url: "https://example.com/blog/" }],
      crawlerType: "playwright:adaptive",
      maxCrawlPages: 30,
      maxResults: 30,
      maxCrawlDepth: 2,
      respectRobotsTxtFile: true,
      proxyConfiguration: { useApifyProxy: true },
      summarize: false,
      saveScreenshots: false,
    })
    expect(run.timeoutSecs).toBe(600)
    expect(run.memoryMbytes).toBe(4096)
  })

  it("builds the Ad Library search URL for the fallback Actor", () => {
    const run = buildActorRun(
      getCatalogTask("facebook_ads_library")!,
      1,
      { keyword: "kem chống nắng" },
      10
    )
    const url = new URL((run.input.startUrls as { url: string }[])[0].url)
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/ads/library/"
    )
    expect(url.searchParams.get("q")).toBe("kem chống nắng")
    expect(url.searchParams.get("country")).toBe("VN")
    expect(url.searchParams.get("active_status")).toBe("active")
    expect(run.input).toMatchObject({
      resultsLimit: 10,
      isDetailsPerAd: false,
      enrichWithEcommerceData: false,
    })
  })

  it("omits optional filters that were not asked for", () => {
    const run = buildActorRun(getCatalogTask("shopee_reviews")!, 0, {
      url: "https://shopee.vn/shop/1",
    })
    expect(run.input).not.toHaveProperty("reviewsSince")
    expect(run.input.starRatings).toEqual(["5", "4", "3", "2", "1"])
    const withSince = buildActorRun(getCatalogTask("shopee_reviews")!, 0, {
      url: "https://shopee.vn/shop/1",
      stars: [1, 1, 2],
      since_days: 30,
    })
    expect(withSince.input).toMatchObject({
      reviewsSince: "30 days",
      starRatings: ["2", "1"],
    })
  })
})

describe("Threads Actor inputs", () => {
  it("normalises handles and profile links for every Threads Actor", () => {
    const posts = getCatalogTask("threads_profile_posts")!
    const fromUrl = buildActorRun(
      posts,
      0,
      { username: "https://www.threads.net/@brand.vn/" },
      5
    )
    // schema minimum of max_posts is 10, memory fixed at 4 GB
    expect(fromUrl.input).toEqual({
      mode: "user",
      usernames: ["brand.vn"],
      max_posts: 10,
    })
    expect(fromUrl.memoryMbytes).toBe(4096)
    expect(buildActorRun(posts, 1, { username: "@brand" }, 500).input).toEqual({
      mode: "posts",
      usernames: ["brand"],
      maxPosts: 100,
      includeProfile: false,
    })
    const profile = buildActorRun(
      getCatalogTask("threads_profile")!,
      0,
      { usernames: ["@a", "https://www.threads.com/@b", "c", "@d", "@e"] },
      3
    )
    expect(profile.input).toEqual({ usernames: ["a", "b", "c"] })
    const profileFallback = buildActorRun(
      getCatalogTask("threads_profile")!,
      1,
      { usernames: ["@a", "b"] }
    )
    expect(profileFallback.input).toEqual({
      mode: "profile",
      usernames: ["a", "b"],
      maxPosts: 1,
    })
  })

  it("maps Threads search sort / since_days and keeps #hashtags", () => {
    const task = getCatalogTask("threads_search")!
    expect(
      buildActorRun(task, 0, { keyword: "#skincare", since_days: 7 }, 50).input
    ).toEqual({
      mode: "search",
      keywords: ["#skincare"],
      max_posts: 50,
      search_filter: "top",
      start_date: "7 days",
    })
    const noSince = buildActorRun(task, 0, { keyword: "son", sort: "recent" })
    expect(noSince.input).not.toHaveProperty("start_date")
    expect(noSince.input).toMatchObject({
      search_filter: "recent",
      max_posts: 30,
    })
    expect(buildActorRun(task, 1, { keyword: "son" }, 999).input).toEqual({
      searchQueries: ["son"],
      searchType: "all",
      maxItems: 100,
      includeReplies: false,
    })
    expect(
      buildActorRun(task, 1, { keyword: "son", sort: "recent" }).input
    ).toMatchObject({ searchType: "recent" })
  })

  it("always pins maxItems for Threads replies and never sets monitoring state", () => {
    const task = getCatalogTask("threads_replies")!
    const url = "https://www.threads.com/@brand/post/DAbc123xyz"
    for (const [requested, limit] of [
      [undefined, 50],
      [0, 1],
      [10_000, 200],
    ] as const) {
      const run = buildActorRun(task, 0, { url }, requested)
      expect(run.input).toMatchObject({
        mode: "thread",
        postUrls: [url],
        maxRepliesPerPost: limit,
        maxPosts: limit,
        maxItems: limit + 1,
        includeProfile: false,
      })
      expect(run.input).not.toHaveProperty("monitoringStoreName")
      expect(deepKeys(run.input).filter((k) => /monitor/i.test(k))).toEqual([])
    }
    const fallback = buildActorRun(task, 1, { url }, 200)
    expect(fallback.input).toEqual({
      startUrls: [{ url }],
      includeReplies: true,
      maxReplies: 50,
    })
  })

  it("never asks the followers Actor for every follower (maxResultsPerUser 0)", () => {
    const task = getCatalogTask("threads_followers")!
    for (const requested of [0, -3, 0.4, undefined, 9_999]) {
      const run = buildActorRun(
        task,
        0,
        { username: "https://www.threads.com/@brand", relation: "following" },
        requested
      )
      expect(run.input.maxResultsPerUser).toBeGreaterThanOrEqual(1)
      expect(run.input.maxResultsPerUser).toBeLessThanOrEqual(500)
      expect(run.input).toMatchObject({
        usernames: ["brand"],
        type: "following",
      })
    }
  })

  it("needs a run cap of at least $0.10 for the 4 GB Threads Actor", () => {
    expect(
      APIFY_ACTOR_MIN_CHARGE_USD["futurizerush~meta-threads-scraper"]
    ).toBe(0.1)
  })
})

describe("buildActorRun / clampTaskLimit", () => {
  const task = getCatalogTask("shopee_search")!

  it("clamps the limit to [1, max] and falls back to the default", () => {
    expect(clampTaskLimit(task)).toBe(40)
    expect(clampTaskLimit(task, null)).toBe(40)
    expect(clampTaskLimit(task, Number.NaN)).toBe(40)
    expect(clampTaskLimit(task, Number.POSITIVE_INFINITY)).toBe(40)
    expect(clampTaskLimit(task, 0)).toBe(1)
    expect(clampTaskLimit(task, -5)).toBe(1)
    expect(clampTaskLimit(task, 2.9)).toBe(2)
    expect(clampTaskLimit(task, 99_999)).toBe(150)
    expect(
      buildActorRun(task, 1, { keyword: "son" }, 99_999).input.maxItems
    ).toBe(150)
    expect(buildActorRun(task, 1, { keyword: "son" }, 0).input.maxItems).toBe(1)
  })

  it("throws ApifyCatalogInputError with Vietnamese details on invalid params", () => {
    let err: unknown
    try {
      buildActorRun(task, 0, { keyword: "", foo: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApifyCatalogInputError)
    const e = err as ApifyCatalogInputError
    expect(e.taskKey).toBe("shopee_search")
    expect(e.message).toContain("shopee_search")
    expect(e.issues.some((i) => i.path === "keyword")).toBe(true)
    expect(e.issues.some((i) => i.message.includes("foo"))).toBe(true)
    expect(() => buildActorRun(task, 0, null)).toThrow(ApifyCatalogInputError)
    expect(() => buildActorRun(task, 0, "x")).toThrow(ApifyCatalogInputError)
  })

  it("throws RangeError for a missing Actor index", () => {
    expect(() => buildActorRun(task, 2, { keyword: "son" })).toThrow(RangeError)
    expect(() => buildActorRun(task, -1, { keyword: "son" })).toThrow(
      RangeError
    )
    expect(() => buildActorRun(task, 0.5, { keyword: "son" })).toThrow(
      RangeError
    )
  })

  it("returns plain JSON (undefined fields dropped)", () => {
    const run = buildActorRun(getCatalogTask("lazada_reviews")!, 0, {
      url: "https://www.lazada.vn/products/abc-i123.html",
    })
    expect(run.input).not.toHaveProperty("starRatings")
    expect(JSON.parse(JSON.stringify(run.input))).toEqual(run.input)
  })
})

describe("forbidden key scan", () => {
  it("finds nested and array keys", () => {
    expect(
      findForbiddenInputKeys({
        a: 1,
        startUrls: [{ url: "x", initialCookies: [] }],
        nested: { pageFunction: "x", customMapFunction: "y" },
        webhooks: [],
        proxyConfiguration: { proxyUrls: ["http://p"] },
      }).sort()
    ).toEqual(
      [
        "nested.customMapFunction",
        "nested.pageFunction",
        "proxyConfiguration.proxyUrls",
        "startUrls[0].initialCookies",
        "webhooks",
      ].sort()
    )
    expect(findForbiddenInputKeys({ maxItems: 1, country: "VN" })).toEqual([])
  })
})

describe("URL / handle helpers", () => {
  it("maps marketplace hosts to countries", () => {
    expect(shopeeCountryFromUrl("https://shopee.vn/a")).toBe("VN")
    expect(shopeeCountryFromUrl("https://shopee.co.id/a")).toBe("ID")
    expect(shopeeCountryFromUrl("https://shopee.com.br/a")).toBe("BR")
    expect(shopeeCountryFromUrl("https://example.com")).toBeNull()
    expect(lazadaCountryFromUrl("https://www.lazada.vn/products/x")).toBe("VN")
    expect(lazadaCountryFromUrl("https://www.lazada.co.th/products/x")).toBe(
      "TH"
    )
    expect(lazadaCountryFromUrl("not a url")).toBeNull()
  })

  it("extracts TikTok / Instagram handles", () => {
    expect(tiktokHandle("@brand.vn")).toBe("brand.vn")
    expect(tiktokHandle("https://www.tiktok.com/@brand?lang=vi")).toBe("brand")
    expect(tiktokHandle("https://www.tiktok.com/brand")).toBeNull()
    expect(tiktokHandle("https://evil.com/@brand")).toBeNull()
    expect(instagramHandle("@brand")).toBe("brand")
    expect(instagramHandle("https://www.instagram.com/brand/")).toBe("brand")
    expect(instagramHandle("https://www.instagram.com/reel/abc/")).toBeNull()
    expect(threadsHandle("@brand.vn")).toBe("brand.vn")
    expect(threadsHandle("brand")).toBe("brand")
    expect(threadsHandle(" https://www.threads.com/@brand/post/X1 ")).toBe(
      "brand"
    )
    expect(threadsHandle("https://threads.net/@brand?hl=vi")).toBe("brand")
    expect(threadsHandle("https://www.threads.com/brand")).toBeNull()
    expect(threadsHandle("https://www.threads.com/")).toBeNull()
    expect(threadsHandle("https://evil.com/@brand")).toBeNull()
    expect(threadsHandle("https://a:b@www.threads.com/@brand")).toBeNull()
    expect(threadsHandle("http://www.threads.com/@brand")).toBeNull()
  })

  it("recognises Threads hosts and post paths", () => {
    for (const h of [
      "threads.com",
      "www.threads.com",
      "threads.net",
      "www.threads.net",
    ])
      expect(HOSTS.threads.test(h), h).toBe(true)
    for (const h of ["threads.org", "evilthreads.com", "threads.com.evil.com"])
      expect(HOSTS.threads.test(h), h).toBe(false)
    const post = (p: string) =>
      isThreadsPostUrl(new URL(`https://www.threads.com${p}`))
    expect(post("/@brand/post/DAbc_1-2")).toBe(true)
    expect(post("/t/CuW6-7KyXme")).toBe(true)
    expect(post("/share/AbC123/")).toBe(true)
    expect(post("/@brand")).toBe(false)
    expect(post("/@brand/post/A/replies")).toBe(false)
    expect(post("/t/")).toBe(false)
  })

  it("recognises Google Maps URLs", () => {
    const ok = [
      "https://www.google.com/maps/place/X",
      "https://www.google.com.vn/maps/place/X",
      "https://maps.google.com/?cid=123",
      "https://maps.app.goo.gl/AbC",
      "https://goo.gl/maps/AbC",
    ]
    for (const u of ok) expect(isGoogleMapsUrl(new URL(u)), u).toBe(true)
    const bad = [
      "https://www.google.com/search?q=x",
      "https://goo.gl/abc",
      "https://maps.example.com/maps",
    ]
    for (const u of bad) expect(isGoogleMapsUrl(new URL(u)), u).toBe(false)
  })

  it("encodes Ad Library search URLs", () => {
    const u = new URL(adLibrarySearchUrl("a&b=c", "TH", "all"))
    expect(u.searchParams.get("q")).toBe("a&b=c")
    expect(u.searchParams.get("country")).toBe("TH")
    expect(u.searchParams.get("active_status")).toBe("all")
  })
})
