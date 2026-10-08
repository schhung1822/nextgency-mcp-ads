// Behaviour changes from the Google Ads API re-check of 2026-10-08 (providers/google-ads.md, research corrections
// 1–10 + 13) and the YouTube (Video / Demand Gen) support.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import type { ReportQuery } from "../types"
import { __clearTokenCache, tokenError } from "./auth"
import { credentialFields, guide } from "./credentials"
import { parseGoogleError, toProviderError } from "./errors"
import {
  addYoutubeVideoInput,
  createSearchCampaignInput,
  googleAdsExtensions,
} from "./extensions"
import { uploadMedia } from "./media"
import { deleteObject, setStatus, updateBudget, updateObject } from "./mutate"
import {
  buildListQuery,
  getObject,
  listObjects,
  summaryFromRow,
} from "./objects"
import {
  buildReportQuery,
  getReport,
  metricFields,
  rowToReport,
  VIDEO_EXTENDED,
} from "./report"
import { parseYoutubeVideoId, resolveChannelTypes } from "./youtube"
import {
  mockFetch,
  oauthCredentials,
  providerCtx,
  queryOf,
  saCredentials,
  searchMatching,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-08T03:00:00Z") })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const ext = (name: string) => googleAdsExtensions.find((e) => e.name === name)!
const mutates = (m: { api: () => RecordedCall[] }) =>
  m.api().filter((c) => c.url.endsWith(":mutate"))
const gfail = (errorCode: Record<string, string>, message = "x") => ({
  error: {
    code: 400,
    status: "INVALID_ARGUMENT",
    message: "Request contains an invalid argument.",
    details: [
      {
        "@type":
          "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
        errors: [{ errorCode, message }],
      },
    ],
  },
})
const map = (errorCode: Record<string, string>, message?: string) =>
  toProviderError(parseGoogleError(400, gfail(errorCode, message), null))

const VIDEO_CAMPAIGN = {
  campaign: {
    id: "70",
    name: "YouTube TrueView",
    status: "ENABLED",
    advertisingChannelType: "VIDEO",
    advertisingChannelSubType: "VIDEO_ACTION",
  },
  campaignBudget: { id: "71", amountMicros: "1000000000000", period: "DAILY" },
}

describe("#1 google_ads_create_search_campaign: không còn nhắm ngôn ngữ", () => {
  it("input không có language_ids, mô tả không nhắc kind=languages", () => {
    const keys = Object.keys(createSearchCampaignInput.shape)
    expect(keys).toContain("location_ids")
    expect(keys).not.toContain("language_ids")
    const d = ext("google_ads_create_search_campaign").description
    expect(d).not.toContain("kind=languages")
    expect(d).toContain("30/09/2026")
  })
})

describe("#3 map lỗi mới", () => {
  it("contextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT → invalid_request, gợi ý bỏ nhắm ngôn ngữ", () => {
    const e = map({ contextError: "OPERATION_NOT_PERMITTED_FOR_CONTEXT" })
    expect(e.code).toBe("invalid_request")
    expect(e.userMessageVi).toContain("ngôn ngữ")
  })
  it("Video: MUTATE_REQUIRES_RESERVATION / OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE → unsupported", () => {
    expect(
      map({ videoCampaignError: "MUTATE_REQUIRES_RESERVATION" })
    ).toMatchObject({
      code: "unsupported",
      userMessageVi:
        "Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads.",
    })
    expect(
      map({
        operationAccessDeniedError: "OPERATION_NOT_PERMITTED_FOR_CAMPAIGN_TYPE",
      }).code
    ).toBe("unsupported")
  })
  it("#10 MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION → khai báo cấp tài khoản trong Google Ads", () => {
    const e = map({
      criterionError: "MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION",
    })
    expect(e.code).toBe("invalid_request")
    expect(e.hint).toContain("cấp tài khoản")
    expect(e.hint).toContain("customer.contains_eu_political_advertising")
    expect(
      map({ mutateError: "EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED" }).hint
    ).toContain("cấp tài khoản")
  })
  it("Demand Gen BUDGET_BELOW_DAILY_MINIMUM → invalid_request nhắc 5 USD/ngày", () => {
    const e = map({ campaignBudgetError: "BUDGET_BELOW_DAILY_MINIMUM" })
    expect(e.code).toBe("invalid_request")
    expect(e.userMessageVi).toContain("5 USD")
  })
  it("DEVELOPER_TOKEN_NOT_APPROVED / CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: mức truy cập thuộc Cloud project", () => {
    for (const code of [
      "DEVELOPER_TOKEN_NOT_APPROVED",
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
    ]) {
      const e = map({ authorizationError: code })
      expect(e.code).toBe("permission_denied")
      expect(e.hint).toMatch(/Cloud project/)
      expect(e.hint).toMatch(/dùng thử/)
      expect(e.hint).toMatch(/09\/09\/2026/)
    }
  })
  it("RESOURCE_EXHAUSTED: hạn mức 24 giờ trượt, Basic 15.000", () => {
    const e = map({ quotaError: "RESOURCE_EXHAUSTED" })
    expect(e.userMessageVi).toContain("15.000")
    expect(e.hint).toContain("24 giờ trượt")
  })
})

describe("#4 developer token bị bỏ", () => {
  it("form không còn trường developer_token nhưng vẫn đọc được giá trị cũ đã lưu", () => {
    expect(credentialFields.map((f) => f.key)).not.toContain("developer_token")
    expect(saCredentials({ developer_token: "OLD" }).developer_token).toBe(
      "OLD"
    )
    expect(guide.warnings!.join(" ")).toContain("không gửi developer token")
  })
})

describe("#9 hướng dẫn xác thực", () => {
  it("invalid_grant (OAuth) nhắc Verify Branding, passkey và service account", () => {
    const e = tokenError(
      oauthCredentials(),
      400,
      { error: "invalid_grant" },
      null
    )
    expect(e.hint).toContain("Verify Branding")
    expect(e.hint).toContain("passkey")
    expect(e.hint).toContain("service account")
  })
  it("TWO_STEP_VERIFICATION_NOT_ENROLLED gợi ý passkey", () => {
    expect(
      map({ authenticationError: "TWO_STEP_VERIFICATION_NOT_ENROLLED" }).hint
    ).toContain("passkey")
  })
  it("guide: hạn mức Explorer/Basic/Standard, tối đa 20 tài khoản mỗi email, passkey", () => {
    const text = guide.steps.map((s) => s.detail).join(" ")
    expect(text).toContain("15.000")
    expect(text).toContain("20 tài khoản")
    expect(text).toContain("passkey")
  })
})

describe("#5 chiến dịch VIDEO chỉ đọc", () => {
  it("setStatus trên chiến dịch VIDEO → unsupported, không gửi mutate", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), {
      body: { results: [VIDEO_CAMPAIGN] },
    })
    await expect(
      setStatus(providerCtx(saCredentials()), "campaign", ["70"], "paused")
    ).rejects.toMatchObject({
      code: "unsupported",
      userMessageVi:
        "Chiến dịch Video (YouTube) chỉ xem được qua API - hãy chỉnh trong Google Ads.",
    })
    expect(mutates(m)).toHaveLength(0)
  })

  it("setStatus cấp ad của chiến dịch VIDEO (đọc trước có campaign.advertising_channel_type) → unsupported", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad/), (c) => {
      expect(queryOf(c)).toContain("campaign.advertising_channel_type")
      return {
        body: {
          results: [
            {
              campaign: { id: "70", advertisingChannelType: "VIDEO" },
              adGroup: { id: "72" },
              adGroupAd: { status: "ENABLED", ad: { id: "73" } },
            },
          ],
        },
      }
    })
    await expect(
      setStatus(providerCtx(saCredentials()), "ad", ["72~73"], "paused")
    ).rejects.toMatchObject({ code: "unsupported" })
    expect(mutates(m)).toHaveLength(0)
  })

  it("updateBudget / updateObject / deleteObject chiến dịch VIDEO → unsupported", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), {
      body: { results: [VIDEO_CAMPAIGN] },
    })
    const ctx = providerCtx(saCredentials())
    await expect(
      updateBudget(ctx, {
        level: "campaign",
        id: "70",
        type: "daily",
        amount: 2_000_000,
      })
    ).rejects.toMatchObject({ code: "unsupported" })
    await expect(
      updateObject(ctx, { level: "campaign", id: "70", changes: { name: "X" } })
    ).rejects.toMatchObject({ code: "unsupported" })
    await expect(deleteObject(ctx, "campaign", "70")).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(mutates(m)).toHaveLength(0)
  })

  it("google_ads_add_keywords / google_ads_create_rsa vào nhóm của chiến dịch VIDEO → unsupported", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE/), {
      body: {
        results: [
          {
            adGroup: {
              id: "72",
              name: "G",
              status: "ENABLED",
              type: "VIDEO_TRUE_VIEW_IN_STREAM",
            },
            campaign: { id: "70", advertisingChannelType: "VIDEO" },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM campaign WHERE/), {
      body: { results: [VIDEO_CAMPAIGN] },
    })
    const ctx = providerCtx(saCredentials())
    const kw = ext("google_ads_add_keywords")
    await expect(
      kw.run(
        ctx,
        kw.input.parse({ ad_group_id: "72", keywords: [{ text: "giày" }] }),
        {}
      )
    ).rejects.toMatchObject({ code: "unsupported" })
    await expect(
      kw.run(
        ctx,
        kw.input.parse({
          campaign_id: "70",
          keywords: [{ text: "rẻ", negative: true }],
        }),
        {}
      )
    ).rejects.toMatchObject({
      code: "unsupported",
    })
    const rsa = ext("google_ads_create_rsa")
    const input = rsa.input.parse({
      ad_group_id: "72",
      final_url: "https://shop.example.vn",
      headlines: ["A1", "B2", "C3"],
      descriptions: ["Mô tả một", "Mô tả hai"],
    })
    await expect(rsa.run(ctx, input, {})).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(mutates(m)).toHaveLength(0)
  })

  it("DEMAND_GEN: đổi ngân sách được nhưng cảnh báo tối thiểu 5 USD/ngày", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), {
      body: {
        results: [
          {
            ...VIDEO_CAMPAIGN,
            campaign: {
              ...VIDEO_CAMPAIGN.campaign,
              advertisingChannelType: "DEMAND_GEN",
            },
            campaignBudget: {
              id: "71",
              amountMicros: "10000000",
              period: "DAILY",
            },
          },
        ],
      },
    })
    m.on((c) => c.url.endsWith("campaignBudgets:mutate"), {
      body: { results: [{}] },
    })
    const ctx = providerCtx(saCredentials(), {
      account: {
        id: "a",
        externalId: "1234567890",
        name: "D",
        currency: "USD",
        timezone: "America/New_York",
      },
    })
    const res = await updateBudget(
      ctx,
      { level: "campaign", id: "70", type: "daily", amount: 4 },
      { dryRun: true }
    )
    expect(res.warnings.join(" ")).toContain("5 USD/ngày")
    expect(mutates(m)).toHaveLength(1)
  })
})

describe("#6 báo cáo YouTube", () => {
  const base: ReportQuery = {
    level: "campaign",
    dateRange: { from: "2026-09-01", to: "2026-09-30" },
    granularity: "total",
    metrics: "video",
    limit: 50,
  }

  it("preset video gồm chỉ số YouTube v25; keyword_view không có", () => {
    const f = metricFields("campaign", "video")
    for (const m of [
      "metrics.video_trueview_views",
      "metrics.video_trueview_view_rate",
      "metrics.trueview_average_cpv",
      "metrics.video_quartile_p100_rate",
      "metrics.youtube_likes",
      "metrics.engagements",
      "metrics.average_video_watch_time_duration_millis",
    ]) {
      expect(f).toContain(m)
    }
    expect(
      metricFields("keyword", "video").some((m) => m.includes("video"))
    ).toBe(false)
    expect(
      metricFields("campaign", "video", { basicVideoOnly: true })
    ).not.toContain("metrics.youtube_likes")
  })

  it("lọc loại chiến dịch: youtube = VIDEO + DEMAND_GEN; giá trị lạ → lỗi; cấp account → lỗi", () => {
    expect(resolveChannelTypes(["youtube", "performance_max"])).toEqual([
      "VIDEO",
      "DEMAND_GEN",
      "PERFORMANCE_MAX",
    ])
    expect(() => resolveChannelTypes(["VIDEO') OR ('1'='1"])).toThrow()
    const q = buildReportQuery({
      ...base,
      filters: { channelTypes: ["youtube"] } as ReportQuery["filters"],
    }).query
    expect(q).toContain(
      "campaign.advertising_channel_type IN ('VIDEO', 'DEMAND_GEN')"
    )
    expect(() =>
      buildReportQuery({
        ...base,
        level: "account",
        filters: { channelTypes: ["VIDEO"] } as ReportQuery["filters"],
      })
    ).toThrow()
  })

  it("lọc mạng (PMax phần YouTube): chọn + lọc segments.ad_network_type", () => {
    const q = buildReportQuery({
      ...base,
      filters: {
        channelTypes: ["PERFORMANCE_MAX"],
        adNetworkTypes: ["youtube"],
      } as ReportQuery["filters"],
    }).query
    expect(q).toContain("segments.ad_network_type,")
    expect(q).toContain("segments.ad_network_type IN ('YOUTUBE')")
    expect(() =>
      buildReportQuery({
        ...base,
        filters: { adNetworkTypes: ["TIKTOK"] } as ReportQuery["filters"],
      })
    ).toThrow()
  })

  it("dòng báo cáo: loại kênh, cờ youtube, tỉ lệ %, CPV đơn vị chính", () => {
    const row = rowToReport(
      {
        campaign: {
          id: "70",
          name: "YT",
          status: "ENABLED",
          advertisingChannelType: "VIDEO",
          advertisingChannelSubType: "VIDEO_ACTION",
        },
        segments: { adNetworkType: "YOUTUBE" },
        metrics: {
          costMicros: "2000000000",
          impressions: "1000",
          videoTrueviewViews: "400",
          videoTrueviewViewRate: 0.4,
          trueviewAverageCpv: 5000000,
          videoQuartileP25Rate: 0.8,
          videoQuartileP100Rate: 0.25,
          youtubeLikes: "12",
          engagements: "30",
        },
      },
      base
    )
    expect(row.metrics.video_views).toBe(400)
    expect(row.extra).toMatchObject({
      advertising_channel_type: "VIDEO",
      advertising_channel_sub_type: "VIDEO_ACTION",
      youtube: true,
      ad_network_type: "YOUTUBE",
      video_view_rate_pct: 40,
      average_cpv: 5,
      cost_per_view: 5,
      video_quartile_p25_pct: 80,
      video_quartile_p100_pct: 25,
      youtube_likes: 12,
      engagements: 30,
    })
  })

  it("Google từ chối chỉ số YouTube mở rộng → thử lại 1 lần chỉ với lượt xem + cảnh báo; cursor tiếp theo khớp", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), (c) =>
      queryOf(c).includes("metrics.youtube_likes")
        ? {
            status: 400,
            body: gfail(
              { queryError: "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE" },
              "Cannot select metrics.youtube_likes for this resource"
            ),
          }
        : {
            body: {
              results: [
                {
                  campaign: {
                    id: "70",
                    name: "YT",
                    status: "ENABLED",
                    advertisingChannelType: "VIDEO",
                  },
                  metrics: { videoTrueviewViews: "9" },
                },
                {
                  campaign: {
                    id: "71",
                    name: "YT2",
                    status: "ENABLED",
                    advertisingChannelType: "VIDEO",
                  },
                  metrics: {},
                },
              ],
            },
          }
    )
    const ctx = providerCtx(saCredentials())
    const res = await getReport(ctx, { ...base, limit: 1 })
    const calls = m.api().filter((c) => c.url.endsWith("googleAds:search"))
    expect(calls).toHaveLength(2)
    expect(queryOf(calls[1]!)).not.toContain("youtube_likes")
    expect(queryOf(calls[1]!)).toContain("metrics.video_trueview_views")
    expect(res.rows[0]!.metrics.video_views).toBe(9)
    expect(res.warnings.join(" ")).toContain("chỉ còn lượt xem video")
    // next page reuses the reduced query without a new failure
    const next = await getReport(ctx, {
      ...base,
      limit: 1,
      cursor: res.nextCursor,
    })
    expect(next.rows[0]!.campaignId).toBe("71")
    expect(
      m.api().filter((c) => c.url.endsWith("googleAds:search"))
    ).toHaveLength(3)
  })

  it("lỗi khác (không nêu chỉ số YouTube) → không thử lại", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign/), {
      status: 400,
      body: gfail(
        { queryError: "INVALID_VALUE_WITH_BETWEEN_OPERATOR" },
        "bad date"
      ),
    })
    await expect(
      getReport(providerCtx(saCredentials()), base)
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(
      m.api().filter((c) => c.url.endsWith("googleAds:search"))
    ).toHaveLength(1)
    expect(VIDEO_EXTENDED.length).toBeGreaterThan(5)
  })
})

describe("#7 objects: loại kênh + video YouTube", () => {
  const acc = { currency: "VND", timezone: "Asia/Ho_Chi_Minh" }

  it("summary chiến dịch/nhóm có advertising_channel_type + sub type + cờ youtube", () => {
    const s = summaryFromRow("campaign", VIDEO_CAMPAIGN, acc)
    expect(s.extra).toMatchObject({
      advertising_channel_type: "VIDEO",
      advertising_channel_sub_type: "VIDEO_ACTION",
      youtube: true,
    })
    const g = summaryFromRow(
      "ad_group",
      {
        campaign: { id: "1", advertisingChannelType: "SEARCH" },
        adGroup: { id: "2", status: "ENABLED" },
      },
      acc
    )
    expect(g.extra).toMatchObject({
      advertising_channel_type: "SEARCH",
      youtube: false,
    })
  })

  it("list lọc channelTypes (youtube) và ad có trường video", () => {
    const q = buildListQuery({
      level: "campaign",
      limit: 50,
      channelTypes: ["youtube"],
    } as Parameters<typeof buildListQuery>[0])
    expect(q).toContain(
      "campaign.advertising_channel_type IN ('VIDEO', 'DEMAND_GEN')"
    )
    const ads = buildListQuery({ level: "ad", limit: 50 })
    expect(ads).toContain("ad_group_ad.ad.video_ad.video.asset")
    expect(ads).toContain(
      "ad_group_ad.ad.demand_gen_video_responsive_ad.videos"
    )
  })

  it("listObjects ad: đổi asset video → ID YouTube (1 truy vấn asset) + cảnh báo chỉ đọc cho VIDEO", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad/), {
      body: {
        results: [
          {
            campaign: { id: "70", advertisingChannelType: "VIDEO" },
            adGroup: { id: "72" },
            adGroupAd: {
              status: "ENABLED",
              ad: {
                id: "73",
                type: "VIDEO_RESPONSIVE_AD",
                videoResponsiveAd: {
                  videos: [{ asset: "customers/1234567890/assets/555" }],
                  headlines: [{ text: "Giày mới" }],
                },
              },
            },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM asset WHERE/), (c) => {
      expect(queryOf(c)).toContain("'customers/1234567890/assets/555'")
      return {
        body: {
          results: [
            {
              asset: {
                resourceName: "customers/1234567890/assets/555",
                youtubeVideoAsset: {
                  youtubeVideoId: "dQw4w9WgXcQ",
                  youtubeVideoTitle: "Clip",
                },
              },
            },
          ],
        },
      }
    })
    const page = await listObjects(providerCtx(saCredentials()), {
      level: "ad",
      limit: 10,
    })
    expect(page.items[0]!.name).toBe("Giày mới")
    expect(page.items[0]!.extra?.youtube_videos).toEqual([
      {
        asset: "customers/1234567890/assets/555",
        youtube_video_id: "dQw4w9WgXcQ",
        title: "Clip",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    ])
    expect(page.warnings.join(" ")).toContain("chỉ xem được qua API")
  })

  it("getObject chiến dịch VIDEO: read_only + video_ad_inventory_control", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id IN/), {
      body: {
        results: [
          {
            ...VIDEO_CAMPAIGN,
            campaign: {
              ...VIDEO_CAMPAIGN.campaign,
              videoCampaignSettings: {
                videoAdInventoryControl: {
                  allowInStream: true,
                  allowInFeed: false,
                  allowShorts: true,
                },
              },
            },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM campaign_criterion/), { body: { results: [] } })
    const d = await getObject(providerCtx(saCredentials()), "campaign", "70")
    expect(d.config).toMatchObject({
      read_only: true,
      video_ad_inventory_control: {
        allow_in_stream: true,
        allow_in_feed: false,
        allow_shorts: true,
      },
    })
  })

  it("#13 Demand Gen ngân sách trọn đời: lịch từ start_date_time / end_date_time", () => {
    const s = summaryFromRow(
      "campaign",
      {
        campaign: {
          id: "80",
          name: "DG",
          status: "PAUSED",
          advertisingChannelType: "DEMAND_GEN",
          startDateTime: "2026-10-10 00:00:00",
          endDateTime: "2026-10-20 23:59:59",
        },
        campaignBudget: {
          id: "81",
          totalAmountMicros: "30000000000",
          period: "CUSTOM_PERIOD",
        },
      },
      acc
    )
    expect(s.budget).toMatchObject({ type: "lifetime", amount: 30000 })
    expect(s.startTime).toBe("2026-10-10T00:00:00+07:00")
    expect(s.endTime).toBe("2026-10-20T23:59:59+07:00")
    expect(s.extra?.youtube).toBe(true)
  })
})

describe("#8 video YouTube → YoutubeVideoAsset", () => {
  it("parseYoutubeVideoId: id, watch, youtu.be, shorts, embed; từ chối host khác", () => {
    const id = "dQw4w9WgXcQ"
    for (const s of [
      id,
      `https://www.youtube.com/watch?v=${id}&t=3`,
      `https://youtu.be/${id}?si=x`,
      `https://youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://m.youtube.com/watch?v=${id}`,
    ]) {
      expect(parseYoutubeVideoId(s), s).toBe(id)
    }
    for (const s of [
      "https://evil.example/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=short",
      "javascript:alert(1)",
      "dQw4w9WgXc",
    ]) {
      expect(parseYoutubeVideoId(s), s).toBeNull()
    }
  })

  it("uploadMedia video với link YouTube → kiểm tra asset có sẵn rồi tạo youtubeVideoAsset (không tải file)", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM asset WHERE asset\.type = 'YOUTUBE_VIDEO'/), {
      body: { results: [] },
    })
    m.on((c) => c.url.endsWith("/assets:mutate"), {
      body: { results: [{ resourceName: "customers/1234567890/assets/901" }] },
    })
    const ref = await uploadMedia(providerCtx(saCredentials()), {
      type: "video",
      url: "https://youtu.be/dQw4w9WgXcQ",
    })
    expect(ref).toEqual({
      type: "video",
      id: "customers/1234567890/assets/901",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    })
    const body = mutates(m)[0]!.body as {
      operations: { create: Record<string, unknown> }[]
    }
    expect(body.operations[0]!.create).toEqual({
      name: "YouTube dQw4w9WgXcQ",
      youtubeVideoAsset: { youtubeVideoId: "dQw4w9WgXcQ" },
    })
    expect(m.calls.some((c) => c.url.includes("youtu.be"))).toBe(false)
  })

  it("asset của video đã có → dùng lại, không tạo mới", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM asset WHERE/), {
      body: {
        results: [{ asset: { resourceName: "customers/1234567890/assets/7" } }],
      },
    })
    const ref = await uploadMedia(providerCtx(saCredentials()), {
      type: "video",
      url: "dQw4w9WgXcQ",
    })
    expect(ref.id).toBe("customers/1234567890/assets/7")
    expect(mutates(m)).toHaveLength(0)
  })

  it("video không phải YouTube → unsupported; ảnh không kèm bytes → từ chối", async () => {
    const m = mockFetch()
    await expect(
      uploadMedia(providerCtx(saCredentials()), {
        type: "video",
        url: "https://cdn.example/a.mp4",
      })
    ).rejects.toMatchObject({ code: "unsupported" })
    await expect(
      uploadMedia(providerCtx(saCredentials()), {
        type: "image",
        url: "https://cdn.example/a.png",
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: "Lỗi nội bộ: ảnh chưa được tải qua bộ lọc an toàn.",
    })
    expect(m.calls.some((c) => c.url.includes("cdn.example"))).toBe(false)
  })

  it("google_ads_add_youtube_video: quyền create, không có tiền; dryRun dùng validateOnly", async () => {
    const tool = ext("google_ads_add_youtube_video")
    expect(tool).toMatchObject({ permission: "create", write: true })
    expect(tool.moneyOf).toBeUndefined()
    expect(addYoutubeVideoInput.safeParse({ video: "x" }).success).toBe(false)
    const m = mockFetch()
    m.on(searchMatching(/FROM asset WHERE/), { body: { results: [] } })
    m.on((c) => c.url.endsWith("/assets:mutate"), { body: { results: [] } })
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({
        video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      { dryRun: true }
    )) as {
      preview: boolean
      createdIds: string[]
    }
    expect(res.preview).toBe(true)
    expect(res.createdIds).toEqual([])
    expect(
      (mutates(m)[0]!.body as { validateOnly?: boolean }).validateOnly
    ).toBe(true)
  })
})
