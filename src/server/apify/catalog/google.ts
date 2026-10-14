// Google tasks: Maps places / reviews, Search (SERP), Ads Transparency (+ beta Trends / Shopping). 16-apify.md §6.
// Input schemas checked on the Apify Store 2026-10-14. compass~crawler-google-places has many paid add-ons (leads
// $0.10/lead and social profiles $0.10 on the Free tier, contacts, details, reviews, images, AI competitor
// analysis…) → all switched off; reviewer personal data off. Google-Maps-Reviews-Scraper defaults maxReviews to
// 10,000,000 → always set. apify~google-search-scraper: AI Mode / ChatGPT / Perplexity / Gemini / Copilot cost
// $0.20 per result on the Free tier, leads $0.10 → all off.
import { z } from "zod"

import {
  CATALOG_MESSAGES,
  countryField,
  defineTask,
  httpsUrl,
  isGoogleMapsUrl,
  languageField,
  singleLine,
  strictInput,
} from "./common"

const googleMapsUrl = httpsUrl("Google Maps", undefined, {
  test: isGoogleMapsUrl,
  message:
    "Cần link địa điểm Google Maps (https://www.google.com/maps/place/… hoặc https://maps.app.goo.gl/…).",
})

const placeIdField = z
  .string()
  .trim()
  .regex(
    /^(ChIJ|GhIJ)[A-Za-z0-9_-]{10,200}$/,
    'Place ID có dạng "ChIJ…" (27 ký tự trở lên).'
  )

/** compass~crawler-google-places: every add-on / extra limit pinned off (places-only run). */
const COMPASS_PLACES_ADDONS_OFF = {
  searchMatching: "all",
  placeMinimumStars: "",
  website: "allPlaces",
  skipClosedPlaces: false,
  scrapePlaceDetailPage: false,
  scrapeTableReservationProvider: false,
  scrapeOrderOnline: false,
  includeWebResults: false,
  scrapeDirectories: false,
  maxQuestions: 0,
  scrapeContacts: false,
  scrapeSocialMediaProfiles: {
    facebooks: false,
    instagrams: false,
    youtubes: false,
    tiktoks: false,
    twitters: false,
  },
  maximumLeadsEnrichmentRecords: 0,
  verifyLeadsEnrichmentEmails: false,
  maxImages: 0,
  scrapeImageAuthors: false,
  enableCompetitorAnalysis: false,
  maxCompetitorsToAnalyze: 0,
  scrapeReviewsPersonalData: false,
  allPlacesNoSearchAction: "",
}

/** apify~google-search-scraper: AI engines, leads, website content, HTML snapshots all off. */
const GOOGLE_SEARCH_ADDONS_OFF = {
  aiOverview: { scrapeFullAiOverview: false },
  aiModeSearch: { enableAiMode: false },
  geminiSearch: { enableGemini: false },
  perplexitySearch: {
    enablePerplexity: false,
    returnImages: false,
    returnRelatedQuestions: false,
  },
  chatGptSearch: { enableChatGpt: false },
  copilotSearch: { enableCopilot: false },
  maximumLeadsEnrichmentRecords: 0,
  verifyLeadsEnrichmentEmails: false,
  websiteContentScraper: { enable: false },
  mobileResults: false,
  includeUnfilteredResults: false,
  saveHtml: false,
  saveHtmlToKeyValueStore: false,
  includeIcons: false,
}

/** damilo~google-shopping-apify `num` enum: largest page size ≤ limit (at least 10). */
function shoppingPageSize(limit: number): string {
  const sizes = [100, 50, 40, 30, 20, 10]
  return String(sizes.find((s) => s <= limit) ?? 10)
}

export const GOOGLE_TASKS = [
  defineTask({
    key: "google_maps_places",
    group: "google",
    titleVi: "Tìm địa điểm / doanh nghiệp trên Google Maps",
    descriptionVi:
      "Dùng khi cần danh sách doanh nghiệp/địa điểm trên Google Maps theo từ khoá và khu vực (vd. spa ở Quận 1): tên, danh mục, địa chỉ, điện thoại, website, điểm đánh giá, số đánh giá.",
    input: strictInput({
      query: singleLine().describe(
        'Từ khoá như gõ trên Google Maps, vd. "spa"'
      ),
      location: singleLine(150)
        .optional()
        .describe(
          'Khu vực dạng chữ, vd. "Quận 1, Hồ Chí Minh, Việt Nam"; bỏ trống = cả Việt Nam'
        ),
      language: languageField,
    }),
    example: { query: "spa", location: "Quận 1, Hồ Chí Minh, Việt Nam" },
    limit: { default: 20, max: 100 },
    estimatedCostUsd: 0.08,
    noteVi:
      "Trần chi phí tối thiểu của Actor: $0.50/lần chạy. Không lấy email/lead (add-on đắt đã tắt).",
    actors: [
      {
        actorId: "compass~crawler-google-places",
        timeoutSecs: 600,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          searchStringsArray: [p.query],
          ...(p.location
            ? { locationQuery: p.location }
            : { countryCode: "vn" }),
          maxCrawledPlacesPerSearch: limit,
          language: p.language,
          maxReviews: 0,
          ...COMPASS_PLACES_ADDONS_OFF,
        }),
        resultFields: [
          "title",
          "categoryName",
          "address",
          "city",
          "phone",
          "website",
          "totalScore",
          "reviewsCount",
          "price",
          "openingHours",
          "location",
          "placeId",
          "url",
        ],
      },
    ],
  }),

  defineTask({
    key: "google_maps_reviews",
    group: "google",
    titleVi: "Đánh giá Google Maps của một địa điểm",
    descriptionVi:
      "Dùng khi cần đọc đánh giá Google Maps của một cửa hàng/địa điểm (của mình hoặc đối thủ): số sao, nội dung, ngày, phản hồi của chủ.",
    input: strictInput({
      place_url: googleMapsUrl.optional().describe("Link địa điểm Google Maps"),
      place_id: placeIdField
        .optional()
        .describe('Place ID dạng "ChIJ…" (thay cho link)'),
      sort: z
        .enum(["newest", "mostRelevant", "highestRanking", "lowestRanking"])
        .default("newest")
        .describe("newest, mostRelevant, highestRanking, lowestRanking"),
      language: languageField,
    }).refine(
      (v) => (v.place_url === undefined) !== (v.place_id === undefined),
      {
        message: CATALOG_MESSAGES.exactlyOne("place_url", "place_id"),
        path: ["place_url"],
      }
    ),
    example: {
      place_url:
        "https://www.google.com/maps/place/Ben+Thanh+Market/@10.772,106.698,17z",
      sort: "newest",
    },
    limit: { default: 100, max: 500 },
    estimatedCostUsd: 0.06,
    noteVi: "Không lấy thông tin cá nhân của người đánh giá.",
    actors: [
      {
        actorId: "compass~Google-Maps-Reviews-Scraper",
        timeoutSecs: 300,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          startUrls: p.place_url ? [{ url: p.place_url }] : [],
          placeIds: p.place_id ? [p.place_id] : [],
          maxReviews: limit,
          reviewsSort: p.sort,
          reviewsOrigin: "all",
          language: p.language,
          personalData: false,
        }),
        resultFields: [
          "title",
          "url",
          "stars",
          "text",
          "textTranslated",
          "publishedAtDate",
          "likesCount",
          "responseFromOwnerText",
          "reviewImageUrls",
          "reviewUrl",
        ],
      },
      {
        actorId: "compass~crawler-google-places",
        timeoutSecs: 600,
        memoryMbytes: 4096,
        buildInput: (p, limit) => ({
          startUrls: p.place_url ? [{ url: p.place_url }] : [],
          placeIds: p.place_id ? [p.place_id] : [],
          maxCrawledPlacesPerSearch: 1,
          language: p.language,
          ...COMPASS_PLACES_ADDONS_OFF,
          maxReviews: limit,
          reviewsSort: p.sort,
          reviewsOrigin: "all",
        }),
        resultFields: ["title", "url", "totalScore", "reviewsCount", "reviews"],
        noteVi:
          "Đắt hơn Actor chính (tính thêm phí địa điểm + trang chi tiết); trần chi phí tối thiểu $0.50/lần chạy.",
      },
    ],
  }),

  defineTask({
    key: "google_serp",
    group: "google",
    titleVi: "Kết quả tìm kiếm Google",
    descriptionVi:
      "Dùng khi cần kết quả Google Search (mặc định google.com.vn, tiếng Việt) cho một truy vấn: kết quả tự nhiên, People Also Ask, tìm kiếm liên quan, tuỳ chọn quảng cáo Google Ads đang hiện — cho SEO và soi đối thủ.",
    input: strictInput({
      query: singleLine(200).describe(
        'Truy vấn như gõ trên Google, vd. "máy lọc nước tốt nhất"'
      ),
      country: countryField,
      language: languageField,
      include_ads: z
        .boolean()
        .default(false)
        .describe(
          "Lấy cả quảng cáo Google Ads trên trang kết quả (tính thêm phí nhỏ)"
        ),
    }),
    example: { query: "máy lọc nước tốt nhất", include_ads: true },
    limit: { default: 1, max: 5 },
    estimatedCostUsd: 0.01,
    noteVi:
      "limit = số TRANG kết quả (~10 kết quả/trang). Trần chi phí tối thiểu của Actor chính: $0.50/lần chạy. Actor dự phòng không lấy quảng cáo.",
    actors: [
      {
        actorId: "apify~google-search-scraper",
        timeoutSecs: 180,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          queries: p.query,
          maxPagesPerQuery: limit,
          countryCode: p.country.toLowerCase(),
          languageCode: p.language,
          searchLanguage: "",
          forceExactMatch: false,
          focusOnPaidAds: p.include_ads,
          ...GOOGLE_SEARCH_ADDONS_OFF,
        }),
        resultFields: [
          "searchQuery",
          "organicResults",
          "paidResults",
          "paidProducts",
          "peopleAlsoAsk",
          "relatedQueries",
          "aiOverview",
        ],
      },
      {
        actorId: "scraperlink~google-search-results-serp-scraper",
        timeoutSecs: 120,
        memoryMbytes: 128,
        // `limit` is a result count enum ("10".."50"): 10 results per page
        buildInput: (p, limit) => ({
          keyword: p.query,
          limit: String(Math.min(limit, 5) * 10),
          country: p.country,
          hl: p.language,
          include_merged: false,
        }),
      },
    ],
  }),

  defineTask({
    key: "google_ads_transparency",
    group: "google",
    titleVi: "Quảng cáo Google / YouTube của đối thủ",
    descriptionVi:
      "Dùng khi cần xem quảng cáo Google (Search, YouTube, Shopping, Maps, Play) mà một thương hiệu/tên miền đang hoặc đã chạy (Google Ads Transparency Center): định dạng, ngày hiển thị, link xem trước.",
    input: strictInput({
      advertiser: singleLine(100).describe(
        'Tên thương hiệu hoặc tên miền, vd. "thegioididong.com"'
      ),
      region: countryField,
      platform: z
        .enum(["SEARCH", "YOUTUBE", "SHOPPING", "MAPS", "PLAY"])
        .optional()
        .describe("Chỉ quảng cáo trên một nền tảng (bỏ trống = tất cả)"),
      format: z
        .enum(["ALL", "TEXT", "IMAGE", "VIDEO"])
        .default("ALL")
        .describe("Định dạng quảng cáo"),
    }),
    example: { advertiser: "thegioididong.com", region: "VN" },
    limit: { default: 30, max: 200 },
    estimatedCostUsd: 0.06,
    noteVi:
      "Lấy 1 nhà quảng cáo khớp nhất với tên; nhập tên miền cho kết quả chính xác hơn. Bộ lọc nền tảng chỉ áp dụng cho quảng cáo từ 04/09/2023.",
    actors: [
      {
        actorId: "scrapesage~google-ads-transparency-scraper",
        timeoutSecs: 300,
        memoryMbytes: 2048,
        buildInput: (p, limit) => ({
          queries: [p.advertiser],
          resultType: "ads",
          region: p.region,
          platforms: p.platform ? [p.platform] : [],
          adFormat: p.format,
          maxAdsPerSearch: limit,
          maxAdvertisersPerQuery: 1,
          includeDetails: false,
          detailConcurrency: 1,
          onlyNewAds: false,
          includeRawData: false,
        }),
        resultFields: [
          "creativeId",
          "advertiserName",
          "advertiserId",
          "domain",
          "format",
          "firstShown",
          "lastShown",
          "shownForDays",
          "imageUrl",
          "previewUrl",
          "adUrl",
          "region",
        ],
      },
    ],
  }),

  defineTask({
    key: "google_trends",
    group: "google",
    beta: true,
    titleVi: "Xu hướng tìm kiếm Google Trends",
    descriptionVi:
      "Dùng khi cần mức độ quan tâm theo thời gian (và theo tỉnh/thành) của một từ khoá trên Google Trends, hoặc danh sách tìm kiếm đang thịnh hành nếu bỏ trống từ khoá.",
    input: strictInput({
      keyword: singleLine(100)
        .optional()
        .describe(
          "Từ khoá cần xem xu hướng; bỏ trống = tìm kiếm thịnh hành 24 giờ qua"
        ),
      country: countryField,
      timeframe: z
        .enum(["now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y"])
        .default("today 3-m")
        .describe("Khoảng thời gian (chế độ từ khoá)"),
    }),
    example: { keyword: "kem chống nắng", country: "VN" },
    limit: { default: 20, max: 50 },
    estimatedCostUsd: 0.05,
    noteVi:
      "Beta. Chế độ từ khoá trả 1 bản ghi (timeline + vùng); limit chỉ áp cho danh sách thịnh hành. Phí khởi chạy $0.025/lần.",
    actors: [
      {
        actorId: "data_xplorer~google-trends-fast-scraper",
        timeoutSecs: 180,
        memoryMbytes: 256,
        buildInput: (p, limit) =>
          p.keyword
            ? {
                mode: "keyword",
                keyword: p.keyword,
                geo: p.country,
                predefinedTimeframe: p.timeframe,
                fetchRegionalData: true,
                trendingSearchesMaxItems: limit,
              }
            : {
                mode: "trending",
                trendingSearchesCountry: p.country,
                trendingSearchesTimeframe: "24",
                trendingSearchesCategories: [],
                trendingSearchesMaxItems: limit,
              },
        resultFields: [
          "keyword",
          "geo",
          "timeframe",
          "timeline_data",
          "region_data",
          "trending_searches",
          "trends_url",
        ],
      },
    ],
  }),

  defineTask({
    key: "google_shopping",
    group: "google",
    beta: true,
    titleVi: "Giá sản phẩm trên Google Shopping",
    descriptionVi:
      "Dùng khi cần so sánh giá một sản phẩm giữa các cửa hàng trên Google Shopping: tên, giá, cửa hàng, đánh giá, quảng cáo.",
    input: strictInput({
      keyword: singleLine().describe('Tên sản phẩm, vd. "nồi chiên không dầu"'),
      country: countryField,
      language: languageField,
    }),
    example: { keyword: "nồi chiên không dầu" },
    limit: { default: 20, max: 50 },
    estimatedCostUsd: 0.07,
    noteVi:
      "Beta: chưa xác minh độ phủ Google Shopping tại VN. Actor dự phòng đắt hơn nhiều trên gói Free ($0.02/kết quả).",
    actors: [
      {
        actorId: "damilo~google-shopping-apify",
        timeoutSecs: 180,
        memoryMbytes: 1024,
        buildInput: (p, limit) => ({
          query: p.keyword,
          queries: [p.keyword],
          country: p.country.toLowerCase(),
          language: p.language,
          num: shoppingPageSize(limit),
          max_pages: 1,
          date_range: "anytime",
        }),
        resultFields: [
          "query",
          "title",
          "source",
          "link",
          "sponsored",
          "price",
          "delivery",
          "rating",
          "ratingCount",
          "offers",
          "position",
        ],
      },
      {
        actorId: "burbn~google-shopping-scraper",
        timeoutSecs: 180,
        memoryMbytes: 4096,
        // `limit` = products per call (schema 10..100), one call from page 1
        buildInput: (p, limit) => ({
          searchQuery: p.keyword,
          country: p.country.toLowerCase(),
          language: p.language,
          page: 1,
          limit: Math.max(10, Math.min(limit, 100)),
        }),
        resultFields: [
          "product_title",
          "price",
          "original_price",
          "store_name",
          "product_rating",
          "product_num_reviews",
          "on_sale",
          "shipping",
          "product_page_url",
        ],
      },
    ],
  }),
]
