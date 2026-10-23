import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { todayInTz } from "../dates"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import {
  buildDemandGenCampaignOps,
  createDemandGenCampaignInput,
  demandGenCampaignMoney,
  demandGenExtensions,
  type CreateDemandGenCampaignInput,
  type DemandGenResolved,
  type DgAssetInfo,
} from "./demand-gen"
import { budgetMinimumNote, parseGoogleError, toProviderError } from "./errors"
import { googleAdsExtensions } from "./extensions"
import {
  mockFetch,
  providerCtx,
  saCredentials,
  searchMatching,
  queryOf,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const CID = "1234567890"
const TODAY = "2026-10-23"
const VID = "dQw4w9WgXcQ"
const VID2 = "aBcDeFgHiJk"
const LOGO = `customers/${CID}/assets/111`

const videoAd = (over: Record<string, unknown> = {}) => ({
  type: "video",
  videos: [`https://www.youtube.com/watch?v=${VID}`],
  logo_images: [LOGO],
  headlines: ["Giày chạy bộ chính hãng"],
  long_headlines: ["Giày chạy bộ chính hãng giảm 30% hôm nay"],
  descriptions: ["Đổi trả 30 ngày, freeship toàn quốc."],
  business_name: "Shop Giày",
  final_url: "https://shop.vn/giay",
  ...over,
})

const imageAd = (over: Record<string, unknown> = {}) => ({
  type: "image",
  marketing_images: ["222"],
  square_marketing_images: ["333"],
  portrait_marketing_images: ["444"],
  tall_portrait_marketing_images: ["555"],
  logo_images: ["111"],
  headlines: ["Giày giảm 30%"],
  descriptions: ["Mua ngay hôm nay."],
  business_name: "Shop Giày",
  final_url: "https://shop.vn/giay",
  ...over,
})

const raw = (over: Record<string, unknown> = {}) => ({
  name: "DG giày Q4",
  daily_budget: 500_000,
  location_ids: ["2704"],
  ad_groups: [{ name: "Nhóm 1", ads: [videoAd()] }],
  ...over,
})
const parse = (
  over: Record<string, unknown> = {}
): CreateDemandGenCampaignInput => createDemandGenCampaignInput.parse(raw(over))

const img = (
  width: number | null,
  height: number | null,
  over: Partial<DgAssetInfo> = {}
): DgAssetInfo => ({ type: "IMAGE", width, height, fileSize: 40_000, ...over })
const resolved = (
  over: Partial<DemandGenResolved> = {}
): DemandGenResolved => ({
  assets: new Map<string, DgAssetInfo>([
    ["111", img(1200, 1200)],
    ["222", img(1200, 628)],
    ["333", img(1200, 1200)],
    ["444", img(960, 1200)],
    ["555", img(1080, 1920)],
    [
      "999",
      { type: "YOUTUBE_VIDEO", width: null, height: null, fileSize: null },
    ],
  ]),
  youtubeAssets: new Map(),
  ctaAssets: new Map(),
  ...over,
})
const build = (
  input: CreateDemandGenCampaignInput,
  r: DemandGenResolved = resolved()
) =>
  buildDemandGenCampaignOps(CID, input, {
    currency: "VND",
    today: TODAY,
    budgetSuffix: "t",
    resolved: r,
  })

type Op = Record<string, { create: Record<string, unknown> }>
const kinds = (ops: Record<string, unknown>[]) =>
  ops.map((o) => Object.keys(o)[0])
const creates = (ops: Record<string, unknown>[], kind: string) =>
  ops.filter((o) => kind in o).map((o) => (o as Op)[kind]!.create)
const campaignOf = (ops: Record<string, unknown>[]) =>
  creates(ops, "campaignOperation")[0]!
const budgetOf = (ops: Record<string, unknown>[]) =>
  creates(ops, "campaignBudgetOperation")[0]!
const issues = (over: Record<string, unknown>) => {
  const r = createDemandGenCampaignInput.safeParse(raw(over))
  return r.success ? "<ok>" : JSON.stringify(r.error.issues)
}
const viOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as { userMessageVi?: string }).userMessageVi ?? String(e)
  }
  return "<no error>"
}

describe("buildDemandGenCampaignOps - structure", () => {
  it("one atomic mutate: budget → campaign → new assets → ad groups → criteria → ads, temp ids declared before use", () => {
    const input = parse({
      language_ids: ["1040"],
      ad_groups: [
        {
          name: "Nhóm 1",
          audience_id: "77",
          ads: [videoAd({ call_to_action: "SHOP_NOW" })],
        },
        { name: "Nhóm 2", location_ids: ["1028581"], ads: [imageAd()] },
      ],
    })
    const plan = build(input)
    expect(kinds(plan.ops)).toEqual([
      "campaignBudgetOperation",
      "campaignOperation",
      "assetOperation", // YouTube video
      "assetOperation", // call to action
      "adGroupOperation",
      "adGroupOperation",
      "adGroupCriterionOperation", // AG1 location
      "adGroupCriterionOperation", // AG1 language
      "adGroupCriterionOperation", // AG1 audience
      "adGroupCriterionOperation", // AG2 location
      "adGroupCriterionOperation", // AG2 language
      "adGroupAdOperation",
      "adGroupAdOperation",
    ])
    expect(budgetOf(plan.ops).resourceName).toBe(
      `customers/${CID}/campaignBudgets/-1`
    )
    expect(campaignOf(plan.ops)).toMatchObject({
      resourceName: `customers/${CID}/campaigns/-2`,
      campaignBudget: `customers/${CID}/campaignBudgets/-1`,
    })
    const assets = creates(plan.ops, "assetOperation")
    expect(assets[0]).toEqual({
      resourceName: `customers/${CID}/assets/-3`,
      name: `YouTube ${VID}`,
      youtubeVideoAsset: { youtubeVideoId: VID },
    })
    expect(assets[1]).toEqual({
      resourceName: `customers/${CID}/assets/-4`,
      callToActionAsset: { callToAction: "SHOP_NOW" },
    })
    const ags = creates(plan.ops, "adGroupOperation")
    expect(ags.map((a) => a.resourceName)).toEqual([
      `customers/${CID}/adGroups/-5`,
      `customers/${CID}/adGroups/-6`,
    ])
    expect(plan.campaignIndex).toBe(1)
    expect(plan.adGroupIndexes).toEqual([4, 5])
    // every temp resource referenced is declared by an earlier operation
    const declared = new Set<string>()
    for (const op of plan.ops) {
      const c = Object.values(op)[0] as { create: Record<string, unknown> }
      const refs =
        JSON.stringify(c.create).match(/customers\/\d+\/[a-zA-Z]+\/-\d+/g) ?? []
      for (const r of refs)
        if (r !== c.create.resourceName) expect(declared.has(r), r).toBe(true)
      if (typeof c.create.resourceName === "string")
        declared.add(c.create.resourceName)
    }
    expect(plan.videos).toEqual({ reused: 0, created: 1 })
  })

  it("campaign: PAUSED, DEMAND_GEN, no sub type / networkSettings / geoTargetTypeSetting / upgradedTargeting, EU declaration; budget not shared", () => {
    for (const eu of [false, true]) {
      const plan = build(parse({ contains_eu_political_advertising: eu }))
      const c = campaignOf(plan.ops)
      expect(c).toMatchObject({
        status: "PAUSED",
        advertisingChannelType: "DEMAND_GEN",
        startDateTime: `${TODAY} 00:00:00`,
      })
      expect(c.containsEuPoliticalAdvertising).toBe(
        eu
          ? "CONTAINS_EU_POLITICAL_ADVERTISING"
          : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
      )
      for (const k of [
        "advertisingChannelSubType",
        "networkSettings",
        "geoTargetTypeSetting",
        "demandGenCampaignSettings",
        "endDateTime",
        "biddingStrategyType",
      ]) {
        expect(c, k).not.toHaveProperty(k)
      }
      expect(budgetOf(plan.ops)).toMatchObject({
        explicitlyShared: false,
        deliveryMethod: "STANDARD",
        amountMicros: "500000000000",
      })
      expect(budgetOf(plan.ops)).not.toHaveProperty("period")
    }
    expect(JSON.stringify(build(parse()).ops)).not.toContain("channelConfig")
  })

  it("ad group: no type, ENABLED, optimized targeting only when given", () => {
    const plan = build(
      parse({
        ad_groups: [
          { name: "A", optimized_targeting: false, ads: [videoAd()] },
        ],
      })
    )
    const ag = creates(plan.ops, "adGroupOperation")[0]!
    expect(ag).not.toHaveProperty("type")
    expect(ag).not.toHaveProperty("audienceSetting")
    expect(ag).toMatchObject({
      status: "ENABLED",
      campaign: `customers/${CID}/campaigns/-2`,
      optimizedTargetingEnabled: false,
    })
    expect(
      creates(build(parse()).ops, "adGroupOperation")[0]
    ).not.toHaveProperty("optimizedTargetingEnabled")
  })
})

describe("budget", () => {
  it("total budget → CUSTOM_PERIOD + totalAmountMicros + start/end date time", () => {
    const plan = build(
      parse({
        daily_budget: undefined,
        total_budget: 3_000_000,
        start_date: "2026-11-01",
        end_date: "2026-11-10",
      })
    )
    const b = budgetOf(plan.ops)
    expect(b).toMatchObject({
      period: "CUSTOM_PERIOD",
      totalAmountMicros: "3000000000000",
      explicitlyShared: false,
    })
    expect(b).not.toHaveProperty("amountMicros")
    expect(campaignOf(plan.ops)).toMatchObject({
      startDateTime: "2026-11-01 00:00:00",
      endDateTime: "2026-11-10 23:59:59",
    })
    expect(plan.dailyEquivalent).toBe(300_000)
  })

  it("exactly one budget; total needs end_date", () => {
    expect(issues({ daily_budget: undefined })).toMatch(
      /Chọn đúng 1 loại ngân sách/
    )
    expect(issues({ total_budget: 1_000_000, end_date: "2026-12-01" })).toMatch(
      /Chọn đúng 1 loại ngân sách/
    )
    expect(
      issues({ daily_budget: undefined, total_budget: 1_000_000 })
    ).toMatch(/total_budget cần end_date/)
    expect(
      issues({ start_date: "2026-11-05", end_date: "2026-11-01" })
    ).toMatch(/end_date phải sau/)
  })

  it("total budget flight: ≥3 days, ≤1 year", () => {
    const tb = (start: string, end: string) =>
      parse({
        daily_budget: undefined,
        total_budget: 1_000_000,
        start_date: start,
        end_date: end,
      })
    expect(viOf(() => build(tb("2026-11-01", "2026-11-02")))).toMatch(
      /ít nhất 3 ngày/
    )
    expect(() => build(tb("2026-11-01", "2026-11-03"))).not.toThrow()
    expect(() => build(tb("2026-11-01", "2027-10-31"))).not.toThrow() // 365 days
    expect(viOf(() => build(tb("2026-11-01", "2027-11-01")))).toMatch(
      /tối đa 1 năm/
    )
    // start defaults to today
    expect(
      viOf(() =>
        build(
          parse({
            daily_budget: undefined,
            total_budget: 1_000_000,
            end_date: "2026-10-24",
          })
        )
      )
    ).toMatch(/ít nhất 3 ngày/)
  })

  it("rejects a start date in the past", () => {
    expect(viOf(() => build(parse({ start_date: "2026-10-01" })))).toMatch(
      /quá khứ/
    )
  })
})

describe("bidding", () => {
  const bid = (over: Record<string, unknown>) => {
    const c = campaignOf(build(parse(over)).ops)
    const keys = [
      "targetSpend",
      "maximizeConversions",
      "maximizeConversionValue",
      "targetCpc",
      "targetCpa",
      "targetRoas",
      "manualCpc",
    ].filter((k) => k in c)
    expect(keys).toHaveLength(1)
    return { [keys[0]!]: c[keys[0]!] }
  }

  it("builds each strategy body (micros strings, no deprecated targetSpendMicros)", () => {
    expect(bid({})).toEqual({ targetSpend: {} })
    expect(bid({ max_cpc_bid_limit: 2_000 })).toEqual({
      targetSpend: { cpcBidCeilingMicros: "2000000000" },
    })
    expect(bid({ bidding_strategy: "maximize_conversions" })).toEqual({
      maximizeConversions: {},
    })
    expect(
      bid({ bidding_strategy: "maximize_conversions", target_cpa: 30_000 })
    ).toEqual({ maximizeConversions: { targetCpaMicros: "30000000000" } })
    expect(bid({ bidding_strategy: "maximize_conversion_value" })).toEqual({
      maximizeConversionValue: {},
    })
    expect(
      bid({ bidding_strategy: "maximize_conversion_value", target_roas: 3.5 })
    ).toEqual({ maximizeConversionValue: { targetRoas: 3.5 } })
    expect(bid({ bidding_strategy: "target_cpc", target_cpc: 1_500 })).toEqual({
      targetCpc: { targetCpcMicros: "1500000000" },
    })
  })

  it("rejects invalid combinations", () => {
    expect(issues({ target_cpa: 10 })).toMatch(
      /target_cpa chỉ dùng với maximize_conversions/
    )
    expect(
      issues({
        bidding_strategy: "maximize_conversions",
        max_cpc_bid_limit: 10,
      })
    ).toMatch(/max_cpc_bid_limit chỉ dùng với maximize_clicks/)
    expect(issues({ target_roas: 2 })).toMatch(
      /target_roas chỉ dùng với maximize_conversion_value/
    )
    expect(issues({ bidding_strategy: "target_cpc" })).toMatch(/cần target_cpc/)
    expect(issues({ target_cpc: 100 })).toMatch(
      /target_cpc chỉ dùng với chiến lược target_cpc/
    )
    expect(
      issues({
        bidding_strategy: "maximize_conversion_value",
        target_roas: 0.001,
      })
    ).not.toBe("<ok>")
    expect(issues({ bidding_strategy: "manual_cpc" })).not.toBe("<ok>")
  })
})

describe("channels", () => {
  const controls = (over: Record<string, unknown>, i = 0) =>
    (
      creates(build(parse(over)).ops, "adGroupOperation")[i]!
        .demandGenAdGroupSettings as {
        channelControls: Record<string, unknown>
      }
    ).channelControls

  it("default = YouTube only with all 7 booleans", () => {
    expect(controls({})).toEqual({
      selectedChannels: {
        youtubeInFeed: true,
        youtubeInStream: true,
        youtubeShorts: true,
        discover: false,
        gmail: false,
        display: false,
        maps: false,
      },
    })
  })

  it("all / google_owned → channelStrategy; custom list → selectedChannels with all 7 booleans; group override", () => {
    expect(controls({ channels: "all" })).toEqual({
      channelStrategy: "ALL_CHANNELS",
    })
    expect(controls({ channels: "google_owned" })).toEqual({
      channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS",
    })
    expect(controls({ channels: ["youtube_shorts", "gmail"] })).toEqual({
      selectedChannels: {
        youtubeInFeed: false,
        youtubeInStream: false,
        youtubeShorts: true,
        discover: false,
        gmail: true,
        display: false,
        maps: false,
      },
    })
    const over = {
      channels: "all",
      ad_groups: [
        { name: "A", ads: [videoAd()] },
        { name: "B", channels: ["maps"], ads: [videoAd()] },
      ],
    }
    expect(controls(over, 0)).toEqual({ channelStrategy: "ALL_CHANNELS" })
    expect(controls(over, 1)).toEqual({
      selectedChannels: {
        youtubeInFeed: false,
        youtubeInStream: false,
        youtubeShorts: false,
        discover: false,
        gmail: false,
        display: false,
        maps: true,
      },
    })
    expect(issues({ channels: [] })).not.toBe("<ok>")
    expect(issues({ channels: ["youtube_shorts", "youtube_shorts"] })).not.toBe(
      "<ok>"
    )
    expect(issues({ channels: "display_only" })).not.toBe("<ok>")
  })
})

describe("targeting on the ad group", () => {
  it("requires ≥1 location per ad group (top-level default or group override)", () => {
    expect(issues({ location_ids: undefined })).toMatch(
      /Nhóm “Nhóm 1” chưa có vị trí/
    )
    expect(
      issues({
        location_ids: undefined,
        ad_groups: [
          { name: "A", location_ids: ["2704"], ads: [videoAd()] },
          { name: "B", ads: [videoAd()] },
        ],
      })
    ).toMatch(/ad_groups.*1.*location_ids/)
    expect(
      issues({
        location_ids: undefined,
        ad_groups: [{ name: "A", location_ids: ["2704"], ads: [videoAd()] }],
      })
    ).toBe("<ok>")
  })

  it("location / language criteria on the ad group (override wins), none at campaign level", () => {
    const plan = build(
      parse({
        location_ids: ["2704"],
        language_ids: ["1040", "1000"],
        ad_groups: [
          { name: "A", ads: [videoAd()] },
          {
            name: "B",
            location_ids: ["1028581", "1028580"],
            language_ids: ["1000"],
            ads: [videoAd()],
          },
        ],
      })
    )
    expect(plan.ops.some((o) => "campaignCriterionOperation" in o)).toBe(false)
    expect(creates(plan.ops, "adGroupCriterionOperation")).toEqual([
      {
        adGroup: `customers/${CID}/adGroups/-4`,
        location: { geoTargetConstant: "geoTargetConstants/2704" },
      },
      {
        adGroup: `customers/${CID}/adGroups/-4`,
        language: { languageConstant: "languageConstants/1040" },
      },
      {
        adGroup: `customers/${CID}/adGroups/-4`,
        language: { languageConstant: "languageConstants/1000" },
      },
      {
        adGroup: `customers/${CID}/adGroups/-5`,
        location: { geoTargetConstant: "geoTargetConstants/1028581" },
      },
      {
        adGroup: `customers/${CID}/adGroups/-5`,
        location: { geoTargetConstant: "geoTargetConstants/1028580" },
      },
      {
        adGroup: `customers/${CID}/adGroups/-5`,
        language: { languageConstant: "languageConstants/1000" },
      },
    ])
  })

  it("audience → useAudienceGrouped at create + audience criterion; other customer refused", () => {
    const plan = build(
      parse({
        ad_groups: [
          {
            name: "A",
            audience_id: `customers/${CID}/audiences/55`,
            ads: [videoAd()],
          },
        ],
      })
    )
    expect(creates(plan.ops, "adGroupOperation")[0]!.audienceSetting).toEqual({
      useAudienceGrouped: true,
    })
    expect(creates(plan.ops, "adGroupCriterionOperation")).toContainEqual({
      adGroup: `customers/${CID}/adGroups/-4`,
      audience: { audience: `customers/${CID}/audiences/55` },
    })
    const numeric = build(
      parse({ ad_groups: [{ name: "A", audience_id: "56", ads: [videoAd()] }] })
    )
    expect(creates(numeric.ops, "adGroupCriterionOperation")).toContainEqual({
      adGroup: `customers/${CID}/adGroups/-4`,
      audience: { audience: `customers/${CID}/audiences/56` },
    })
    expect(
      viOf(() =>
        build(
          parse({
            ad_groups: [
              {
                name: "A",
                audience_id: "customers/9999999999/audiences/5",
                ads: [videoAd()],
              },
            ],
          })
        )
      )
    ).toMatch(/tài khoản Google Ads khác/)
    expect(
      issues({
        ad_groups: [{ name: "A", audience_id: "abc", ads: [videoAd()] }],
      })
    ).not.toBe("<ok>")
  })

  it("ad group names must be unique; 1–10 groups, 1–5 ads", () => {
    expect(
      issues({
        ad_groups: [
          { name: "A", ads: [videoAd()] },
          { name: "a", ads: [videoAd()] },
        ],
      })
    ).toMatch(/không được trùng/)
    expect(issues({ ad_groups: [] })).not.toBe("<ok>")
    expect(issues({ ad_groups: [{ name: "A", ads: [] }] })).not.toBe("<ok>")
    expect(
      issues({
        ad_groups: [
          { name: "A", ads: Array.from({ length: 6 }, () => videoAd()) },
        ],
      })
    ).not.toBe("<ok>")
  })
})

describe("ads", () => {
  it("video ad body: businessName is an AdTextAsset object; CTA asset referenced; final URL", () => {
    const plan = build(
      parse({
        ad_groups: [
          {
            name: "A",
            ads: [
              videoAd({
                name: "Video 1",
                call_to_action: "LEARN_MORE",
                business_name: "  Shop   Giày ",
              }),
            ],
          },
        ],
      })
    )
    const ad = creates(plan.ops, "adGroupAdOperation")[0]!
    expect(ad).toMatchObject({
      adGroup: `customers/${CID}/adGroups/-5`,
      status: "ENABLED",
    })
    expect(ad.ad).toEqual({
      name: "Video 1",
      finalUrls: ["https://shop.vn/giay"],
      demandGenVideoResponsiveAd: {
        videos: [{ asset: `customers/${CID}/assets/-3` }],
        logoImages: [{ asset: LOGO }],
        headlines: [{ text: "Giày chạy bộ chính hãng" }],
        longHeadlines: [{ text: "Giày chạy bộ chính hãng giảm 30% hôm nay" }],
        descriptions: [{ text: "Đổi trả 30 ngày, freeship toàn quốc." }],
        businessName: { text: "Shop Giày" },
        callToActions: [{ asset: `customers/${CID}/assets/-4` }],
      },
    })
  })

  it("image ad body: businessName is a plain string; all four image slots", () => {
    const plan = build(parse({ ad_groups: [{ name: "A", ads: [imageAd()] }] }))
    expect(plan.ops.some((o) => "assetOperation" in o)).toBe(false)
    const ad = creates(plan.ops, "adGroupAdOperation")[0]!.ad as Record<
      string,
      unknown
    >
    expect(ad).toEqual({
      finalUrls: ["https://shop.vn/giay"],
      demandGenMultiAssetAd: {
        marketingImages: [{ asset: `customers/${CID}/assets/222` }],
        squareMarketingImages: [{ asset: `customers/${CID}/assets/333` }],
        portraitMarketingImages: [{ asset: `customers/${CID}/assets/444` }],
        tallPortraitMarketingImages: [{ asset: `customers/${CID}/assets/555` }],
        logoImages: [{ asset: `customers/${CID}/assets/111` }],
        headlines: [{ text: "Giày giảm 30%" }],
        descriptions: [{ text: "Mua ngay hôm nay." }],
        businessName: "Shop Giày",
      },
    })
  })

  it("image ad needs a landscape or square image, ≤20 images in total; warns when no headline ≤30", () => {
    expect(
      issues({
        ad_groups: [
          {
            name: "A",
            ads: [
              imageAd({
                marketing_images: undefined,
                square_marketing_images: undefined,
              }),
            ],
          },
        ],
      })
    ).toMatch(/ít nhất 1 ảnh ngang/)
    const many = Array.from({ length: 11 }, (_, i) => String(1000 + i))
    const many2 = Array.from({ length: 10 }, (_, i) => String(2000 + i))
    expect(
      issues({
        ad_groups: [
          {
            name: "A",
            ads: [
              imageAd({
                marketing_images: many,
                square_marketing_images: many2,
              }),
            ],
          },
        ],
      })
    ).toMatch(/tối đa 20/)
    const long = build(
      parse({
        ad_groups: [
          {
            name: "A",
            ads: [
              imageAd({
                headlines: ["Giày chạy bộ chính hãng giảm 30% nha"],
              }),
            ],
          },
        ],
      })
    )
    expect(long.warnings.join(" ")).toMatch(/ít nhất 1 tiêu đề ≤30 ký tự/)
  })

  it("text limits and duplicates (case-insensitive)", () => {
    const one = (ad: Record<string, unknown>) =>
      issues({ ad_groups: [{ name: "A", ads: [ad] }] })
    expect(one(videoAd({ headlines: ["x".repeat(41)] }))).toMatch(/tối đa 40/)
    expect(one(videoAd({ long_headlines: ["x".repeat(91)] }))).toMatch(
      /tối đa 90/
    )
    expect(one(videoAd({ business_name: "x".repeat(26) }))).toMatch(/tối đa 25/)
    expect(one(videoAd({ headlines: ["Giày", "GIÀY"] }))).toMatch(
      /không được trùng/
    )
    expect(
      one(videoAd({ headlines: ["a", "b", "c", "d", "e", "f"] }))
    ).not.toBe("<ok>")
    expect(one(videoAd({ final_url: "http://shop.vn" }))).toMatch(/https/)
    expect(one(videoAd({ logo_images: [] }))).toMatch(/logo/)
    expect(
      one(videoAd({ logo_images: ["111", `customers/${CID}/assets/111`] }))
    ).toMatch(/không được trùng/)
    expect(one(videoAd({ videos: ["not a video link"] }))).toMatch(
      /Không nhận ra video YouTube/
    )
    expect(one(videoAd({ videos: [VID, `https://youtu.be/${VID}`] }))).toMatch(
      /video không được trùng/
    )
    expect(one(videoAd({ call_to_action: "CLICK_HERE" }))).not.toBe("<ok>")
    expect(one(imageAd({ headlines: ["Ẩn​ký tự"] }))).toMatch(/ký tự ẩn/)
  })
})

describe("image slot validation", () => {
  const withAssets = (entries: [string, DgAssetInfo][]) =>
    resolved({ assets: new Map([...resolved().assets, ...entries]) })
  const imgInput = (over: Record<string, unknown>) =>
    parse({ ad_groups: [{ name: "A", ads: [imageAd(over)] }] })

  it("aspect ratio within ±1%", () => {
    expect(() =>
      build(
        imgInput({ marketing_images: ["600"] }),
        withAssets([["600", img(1200, 632)]])
      )
    ).not.toThrow() // 1.899 (−0.6%)
    expect(
      viOf(() =>
        build(
          imgInput({ marketing_images: ["600"] }),
          withAssets([["600", img(1200, 600)]])
        )
      )
    ).toMatch(/Ảnh 600 dùng làm ảnh ngang.*1200×600 px.*2\.00:1.*1\.91:1/)
    expect(
      viOf(() => build(parse(), withAssets([["111", img(1200, 1000)]])))
    ).toMatch(/logo.*1:1/)
    expect(
      viOf(() =>
        build(
          imgInput({ portrait_marketing_images: ["601"] }),
          withAssets([["601", img(1080, 1920)]])
        )
      )
    ).toMatch(/4:5/)
  })

  it("minimum pixel size per slot", () => {
    expect(
      viOf(() => build(parse(), withAssets([["111", img(100, 100)]])))
    ).toMatch(/100×100 px, nhỏ hơn mức tối thiểu 128×128/)
    expect(
      viOf(() =>
        build(
          imgInput({ square_marketing_images: ["602"] }),
          withAssets([["602", img(250, 250)]])
        )
      )
    ).toMatch(/300×300/)
    expect(
      viOf(() =>
        build(
          imgInput({ tall_portrait_marketing_images: ["603"] }),
          withAssets([["603", img(540, 960)]])
        )
      )
    ).toMatch(/600×1067/)
  })

  it("wrong type, missing asset, other customer; missing dimensions only warn; heavy logo warns", () => {
    expect(viOf(() => build(imgInput({ marketing_images: ["999"] })))).toMatch(
      /không phải ảnh \(loại YOUTUBE_VIDEO\)/
    )
    expect(viOf(() => build(imgInput({ marketing_images: ["4242"] })))).toMatch(
      /Không tìm thấy asset ảnh 4242/
    )
    expect(
      viOf(() =>
        build(
          parse({
            ad_groups: [
              {
                name: "A",
                ads: [
                  videoAd({ logo_images: ["customers/9999999999/assets/111"] }),
                ],
              },
            ],
          })
        )
      )
    ).toMatch(/tài khoản Google Ads khác \(9999999999\)/)
    const noDims = build(
      imgInput({ marketing_images: ["604"] }),
      withAssets([["604", img(null, null)]])
    )
    expect(noDims.warnings.join(" ")).toMatch(/không trả về kích thước ảnh 604/)
    const heavy = build(
      parse(),
      withAssets([["111", img(1200, 1200, { fileSize: 300_000 })]])
    )
    expect(heavy.warnings.join(" ")).toMatch(/Logo 111 nặng 293 KB/)
  })
})

describe("YouTube video assets", () => {
  it("reuses an existing YOUTUBE_VIDEO asset, creates the others once in the same mutate", () => {
    const input = parse({
      ad_groups: [
        {
          name: "A",
          ads: [
            videoAd({ videos: [VID, `https://youtube.com/shorts/${VID2}`] }),
          ],
        },
        { name: "B", ads: [videoAd({ videos: [`https://youtu.be/${VID2}`] })] },
      ],
    })
    const plan = build(
      input,
      resolved({
        youtubeAssets: new Map([[VID, `customers/${CID}/assets/700`]]),
      })
    )
    const assets = creates(plan.ops, "assetOperation")
    expect(assets).toEqual([
      {
        resourceName: `customers/${CID}/assets/-3`,
        name: `YouTube ${VID2}`,
        youtubeVideoAsset: { youtubeVideoId: VID2 },
      },
    ])
    const ads = creates(plan.ops, "adGroupAdOperation").map(
      (a) =>
        (a.ad as { demandGenVideoResponsiveAd: { videos: unknown[] } })
          .demandGenVideoResponsiveAd.videos
    )
    expect(ads).toEqual([
      [
        { asset: `customers/${CID}/assets/700` },
        { asset: `customers/${CID}/assets/-3` },
      ],
      [{ asset: `customers/${CID}/assets/-3` }],
    ])
    expect(plan.videos).toEqual({ reused: 1, created: 1 })
  })

  it("accepts an existing video asset resource name (must be YOUTUBE_VIDEO); reuses an existing CTA asset", () => {
    const plan = build(
      parse({
        ad_groups: [
          {
            name: "A",
            ads: [
              videoAd({
                videos: [`customers/${CID}/assets/999`],
                call_to_action: "SHOP_NOW",
              }),
            ],
          },
        ],
      }),
      resolved({
        ctaAssets: new Map([["SHOP_NOW", `customers/${CID}/assets/800`]]),
      })
    )
    expect(plan.ops.some((o) => "assetOperation" in o)).toBe(false)
    const dg = (
      creates(plan.ops, "adGroupAdOperation")[0]!.ad as {
        demandGenVideoResponsiveAd: Record<string, unknown>
      }
    ).demandGenVideoResponsiveAd
    expect(dg.videos).toEqual([{ asset: `customers/${CID}/assets/999` }])
    expect(dg.callToActions).toEqual([{ asset: `customers/${CID}/assets/800` }])
    expect(
      viOf(() =>
        build(
          parse({
            ad_groups: [
              {
                name: "A",
                ads: [videoAd({ videos: [`customers/${CID}/assets/111`] })],
              },
            ],
          })
        )
      )
    ).toMatch(/không phải video YouTube/)
  })
})

// ---------------------------------------------------------------------------
// run() with a mocked Google Ads API
// ---------------------------------------------------------------------------

const tool = () => demandGenExtensions[0]!
const isMutate = (c: RecordedCall) => c.url.endsWith("/googleAds:mutate")
const nameQuery = searchMatching(/FROM campaign WHERE campaign\.name = /)

function mockReads(
  m: ReturnType<typeof mockFetch>,
  opts: { youtube?: Record<string, unknown>[] } = {}
) {
  m.on(searchMatching(/FROM asset WHERE asset\.id IN/), {
    body: {
      results: [
        {
          asset: {
            id: "111",
            resourceName: LOGO,
            type: "IMAGE",
            imageAsset: {
              fileSize: "40000",
              fullSize: { widthPixels: "1200", heightPixels: "1200" },
            },
          },
        },
      ],
    },
  })
  m.on(searchMatching(/youtube_video_asset\.youtube_video_id IN/), {
    body: { results: opts.youtube ?? [] },
  })
  m.on(searchMatching(/FROM currency_constant/), { body: { results: [] } })
}

describe("google_ads_create_demand_gen_campaign run", () => {
  it("metadata: create permission, write, title, description limits, registered after create_search_campaign", () => {
    const t = tool()
    expect(t.name).toBe("google_ads_create_demand_gen_campaign")
    expect(t.permission).toBe("create")
    expect(t.write).toBe(true)
    expect(t.title).toBe("Tạo chiến dịch Demand Gen (YouTube)")
    expect(t.description.startsWith("Dùng khi")).toBe(true)
    expect(t.description.length).toBeLessThanOrEqual(1500)
    for (const s of [
      "ads_list_accounts",
      "ads_lookup",
      "ads_upload_media",
      "TẠM DỪNG",
      "5 USD",
    ])
      expect(t.description).toContain(s)
    const names = googleAdsExtensions.map((e) => e.name)
    expect(names[names.indexOf("google_ads_create_search_campaign") + 1]).toBe(
      "google_ads_create_demand_gen_campaign"
    )
  })

  it("dryRun: reads assets in one query each, sends validateOnly and returns a preview summary", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [] } })
    mockReads(m, {
      youtube: [
        {
          asset: {
            resourceName: `customers/${CID}/assets/700`,
            youtubeVideoAsset: { youtubeVideoId: VID },
          },
        },
      ],
    })
    m.on(isMutate, { body: {} })
    const out = (await tool().run(
      providerCtx(saCredentials()),
      parse({ bidding_strategy: "maximize_conversions", target_cpa: 50_000 }),
      { dryRun: true }
    )) as {
      preview: boolean
      changes: { after: Record<string, unknown> }[]
      warnings: string[]
      createdIds: string[]
    }
    expect(out.preview).toBe(true)
    expect(out.createdIds).toEqual([])
    const mutates = m.api().filter(isMutate)
    expect(mutates).toHaveLength(1)
    const body = mutates[0]!.body as {
      validateOnly: boolean
      mutateOperations: Record<string, unknown>[]
    }
    expect(body.validateOnly).toBe(true)
    // the existing YouTube asset is reused: no asset create
    expect(body.mutateOperations.some((o) => "assetOperation" in o)).toBe(false)
    const assetQueries = m.api().filter((c) => /FROM asset/.test(queryOf(c)))
    expect(assetQueries).toHaveLength(2)
    expect(queryOf(assetQueries[0]!)).toContain(
      "asset.image_asset.full_size.width_pixels"
    )
    expect(out.changes[0]!.after).toMatchObject({
      name: "DG giày Q4",
      budget: { type: "daily", amount: 500_000 },
      currency: "VND",
      bidding_strategy: "maximize_conversions",
      start_date: todayInTz("Asia/Ho_Chi_Minh"),
      ad_groups: [
        {
          name: "Nhóm 1",
          channels: "Chỉ YouTube (In-feed, In-stream, Shorts)",
          locations: 1,
          ads: { video: 1, image: 0 },
        },
      ],
      youtube_videos: { reused: 1, new: 0 },
    })
    const w = out.warnings.join(" ")
    expect(w).toMatch(/TẠM DỪNG/)
    expect(w).toMatch(/theo dõi chuyển đổi/)
    expect(w).toMatch(/15 lần CPA mục tiêu/)
    expect(w).toMatch(/5 USD\/ngày/)
    expect(w).toMatch(/Công khai hoặc Không công khai/)
    expect(w).toMatch(/xét duyệt/)
  })

  it("execution returns campaign / ad group ids from the atomic response", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [] } })
    mockReads(m)
    m.on(isMutate, (c) => {
      const ops = (c.body as { mutateOperations: Record<string, unknown>[] })
        .mutateOperations
      return {
        body: {
          mutateOperationResponses: ops.map((o) => {
            const k = Object.keys(o)[0]!
            if (k === "campaignOperation")
              return {
                campaignResult: {
                  resourceName: `customers/${CID}/campaigns/501`,
                },
              }
            if (k === "adGroupOperation")
              return {
                adGroupResult: {
                  resourceName: `customers/${CID}/adGroups/601`,
                },
              }
            return {
              [k.replace("Operation", "Result")]: {
                resourceName: `customers/${CID}/x/1`,
              },
            }
          }),
        },
      }
    })
    const out = (await tool().run(
      providerCtx(saCredentials()),
      parse(),
      {}
    )) as { campaign_id: string; ad_group_ids: string[]; createdIds: string[] }
    expect(out.campaign_id).toBe("501")
    expect(out.ad_group_ids).toEqual(["601"])
    expect(out.createdIds).toEqual(["501", "601"])
    const body = m.api().find(isMutate)!.body as {
      validateOnly?: boolean
      mutateOperations: Record<string, unknown>[]
    }
    expect(body.validateOnly).toBeUndefined()
    expect(
      body.mutateOperations.filter((o) => "assetOperation" in o)
    ).toHaveLength(1) // new YouTube asset
    expect(m.api().filter(isMutate)).toHaveLength(1)
  })

  it("refuses a duplicate campaign name before anything is sent", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [{ campaign: { id: "55" } }] } })
    await expect(
      tool().run(providerCtx(saCredentials()), parse(), {})
    ).rejects.toMatchObject({ code: "conflict" })
    expect(m.api().filter(isMutate)).toHaveLength(0)
  })

  it("uncertain outcome (5xx) → finds the campaign by name and does not create it again", async () => {
    const m = mockFetch()
    m.once(nameQuery, { body: { results: [] } })
    m.on(nameQuery, { body: { results: [{ campaign: { id: "77" } }] } })
    mockReads(m)
    m.on(isMutate, {
      status: 502,
      body: { error: { code: 502, status: "UNAVAILABLE", message: "x" } },
    })
    const out = (await tool().run(
      providerCtx(saCredentials()),
      parse(),
      {}
    )) as { campaign_id: string; createdIds: string[]; warnings: string[] }
    expect(out.campaign_id).toBe("77")
    expect(out.createdIds).toEqual(["77"])
    expect(out.warnings.join(" ")).toMatch(/không tạo lại/)
    expect(m.api().filter(isMutate)).toHaveLength(1)
  })

  it("uncertain outcome and nothing found → rethrows (no retry)", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [] } })
    mockReads(m)
    m.on(isMutate, {
      status: 503,
      body: { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
    })
    await expect(
      tool().run(providerCtx(saCredentials()), parse(), {})
    ).rejects.toMatchObject({ retryable: false })
    expect(m.api().filter(isMutate)).toHaveLength(1)
  })

  it("BUDGET_BELOW_PER_DAY_MINIMUM in the preview surfaces the minimum from the error details", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [] } })
    mockReads(m)
    m.on(isMutate, {
      status: 400,
      body: budgetFailure({
        currencyCode: "VND",
        minimumBudgetAmountMicros: "130000000000",
        failedBudgetAmountMicros: "50000000000",
      }),
    })
    const err = (await tool()
      .run(providerCtx(saCredentials()), parse({ daily_budget: 50_000 }), {
        dryRun: true,
      })
      .catch((e: unknown) => e)) as { code: string; userMessageVi: string }
    expect(err.code).toBe("invalid_request")
    expect(err.userMessageVi).toMatch(/mức tối thiểu mỗi ngày/)
    expect(err.userMessageVi).toContain("ngân sách ngày tối thiểu 130.000 VND")
  })
})

function budgetFailure(
  details: Record<string, unknown>,
  code = "BUDGET_BELOW_PER_DAY_MINIMUM"
) {
  return {
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "Request contains an invalid argument.",
      details: [
        {
          "@type":
            "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
          errors: [
            {
              errorCode: { campaignBudgetError: code },
              message: "Budget below minimum.",
              details: { budgetPerDayMinimumErrorDetails: details },
            },
          ],
          requestId: "req-budget",
        },
      ],
    },
  }
}

describe("budget minimum error mapping", () => {
  const map = (body: unknown) =>
    toProviderError(parseGoogleError(400, body, null))

  it("total-budget minimum, the legacy alias name, and no details", () => {
    expect(
      map(
        budgetFailure({
          currencyCode: "USD",
          minimumBudgetTotalAmountMicros: "35500000",
        })
      ).userMessageVi
    ).toContain("ngân sách tổng tối thiểu 35,5 USD cho thời gian chạy đã chọn")
    expect(
      map(
        budgetFailure(
          { currencyCode: "USD", budgetPerDayMinimumMicros: "5000000" },
          "BUDGET_BELOW_DAILY_MINIMUM"
        )
      ).userMessageVi
    ).toContain("tối thiểu 5 USD/ngày")
    const bare = map(budgetFailure({}))
    expect(bare.userMessageVi).toMatch(/mức tối thiểu mỗi ngày/)
    expect(bare.userMessageVi).not.toMatch(/Mức Google yêu cầu/)
    expect(bare.upstream?.code).toBe(
      "campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM"
    )
  })

  it("only digits and a 3-letter currency are taken from the details", () => {
    expect(
      budgetMinimumNote([
        {
          details: {
            budgetPerDayMinimumErrorDetails: {
              currencyCode: "<script>",
              minimumBudgetAmountMicros: "1e9; DROP",
            },
          },
        },
      ])
    ).toBeNull()
    expect(
      budgetMinimumNote([
        {
          details: {
            budgetPerDayMinimumErrorDetails: {
              currencyCode: "vnd!",
              minimumBudgetAmountMicros: "2000000",
            },
          },
        },
      ])
    ).toBe("Mức Google yêu cầu: ngân sách ngày tối thiểu 2.")
  })

  it("maps the Demand Gen ad / asset errors to Vietnamese", () => {
    const one = (errorCode: Record<string, string>) =>
      map({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "x",
          details: [
            {
              "@type":
                "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
              errors: [{ errorCode, message: "m" }],
            },
          ],
        },
      }).userMessageVi
    expect(one({ adError: "MISSING_BUSINESS_NAME" })).toMatch(
      /tên doanh nghiệp/
    )
    expect(
      one({ assetLinkError: "IMAGE_NOT_WITHIN_SPECIFIED_DIMENSION_RANGE" })
    ).toMatch(/Kích thước \/ tỉ lệ ảnh/)
    expect(
      one({ campaignBudgetError: "CAMPAIGN_BUDGET_CANNOT_BE_SHARED" })
    ).toMatch(/ngân sách chia sẻ/)
    expect(
      one({ campaignError: "END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET" })
    ).toMatch(/ngày kết thúc/)
    expect(one({ criterionError: "CANNOT_TARGET_LANGUAGE" })).toMatch(
      /ngôn ngữ/
    )
    expect(one({ collectionSizeError: "TOO_MANY" })).toMatch(/quá nhiều/)
  })
})

describe("moneyOf", () => {
  it("daily budget + bids; total budget as lifetime with flight; target_roas is not money", () => {
    expect(demandGenCampaignMoney(parse({ max_cpc_bid_limit: 3_000 }))).toEqual(
      [
        { kind: "daily_budget", amount: 500_000, field: "daily_budget" },
        { kind: "bid", amount: 3_000, field: "max_cpc_bid_limit" },
      ]
    )
    expect(
      demandGenCampaignMoney(
        parse({
          daily_budget: undefined,
          total_budget: 9_000_000,
          start_date: "2026-11-01",
          end_date: "2026-11-30",
          bidding_strategy: "maximize_conversions",
          target_cpa: 40_000,
        })
      )
    ).toEqual([
      {
        kind: "lifetime_budget",
        amount: 9_000_000,
        field: "total_budget",
        startTime: "2026-11-01",
        endTime: "2026-11-30",
      },
      { kind: "bid", amount: 40_000, field: "target_cpa" },
    ])
    expect(
      demandGenCampaignMoney(
        parse({ bidding_strategy: "target_cpc", target_cpc: 1_200 })
      )
    ).toContainEqual({ kind: "bid", amount: 1_200, field: "target_cpc" })
    expect(
      demandGenCampaignMoney(
        parse({ bidding_strategy: "maximize_conversion_value", target_roas: 4 })
      )
    ).toEqual([
      { kind: "daily_budget", amount: 500_000, field: "daily_budget" },
    ])
    expect(tool().moneyOf!(parse())).toEqual(demandGenCampaignMoney(parse()))
  })
})

describe("API review fixes", () => {
  it("budget minimum note is added when ANY error of the atomic mutate is a budget-minimum error", () => {
    const body = {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "x",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
            errors: [
              { errorCode: { adError: "MISSING_BUSINESS_NAME" }, message: "m" },
              {
                errorCode: { campaignBudgetError: "BUDGET_BELOW_PER_DAY_MINIMUM" },
                message: "b",
                details: { budgetPerDayMinimumErrorDetails: { currencyCode: "VND", minimumBudgetAmountMicros: "130000000000" } },
              },
            ],
          },
        ],
      },
    }
    const e = toProviderError(parseGoogleError(400, body, null))
    expect(e.upstream?.code).toBe("adError.MISSING_BUSINESS_NAME")
    expect(e.userMessageVi).toMatch(/tên doanh nghiệp/)
    expect(e.userMessageVi).toContain("ngân sách ngày tối thiểu 130.000 VND")
  })

  it("adError.TOO_LONG / LINE_TOO_WIDE hint at ≤30 (image) / ≤40 (video) headlines", () => {
    for (const code of ["TOO_LONG", "LINE_TOO_WIDE"]) {
      const e = toProviderError(
        parseGoogleError(
          400,
          {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "x",
              details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { adError: code }, message: "m" }] }],
            },
          },
          null
        )
      )
      expect(e.code).toBe("invalid_request")
      expect(e.hint).toMatch(/≤30/)
      expect(e.hint).toMatch(/≤40/)
    }
  })

  it("logo below 144×144 warns (API minimum 128×128 still accepted)", () => {
    const r = resolved({ assets: new Map([...resolved().assets, ["111", img(130, 130)]]) })
    const plan = build(parse(), r)
    expect(plan.warnings.join(" ")).toMatch(/Logo 111 chỉ 130×130 px - Google khuyên logo ≥144×144/)
    expect(build(parse()).warnings.join(" ")).not.toMatch(/≥144×144/)
  })

  it("asset creates never send Asset.type (output only)", () => {
    const plan = build(parse({ ad_groups: [{ name: "A", ads: [videoAd({ call_to_action: "SHOP_NOW" })] }] }))
    const assets = creates(plan.ops, "assetOperation")
    expect(assets).toHaveLength(2)
    for (const a of assets) expect(a).not.toHaveProperty("type")
  })

  it("call-to-action lookup filters the requested values in GAQL", async () => {
    const m = mockFetch()
    m.on(nameQuery, { body: { results: [] } })
    mockReads(m)
    m.on(searchMatching(/asset\.type = 'CALL_TO_ACTION'/), {
      body: { results: [{ asset: { resourceName: `customers/${CID}/assets/800`, callToActionAsset: { callToAction: "SHOP_NOW" } } }] },
    })
    m.on(isMutate, { body: {} })
    const input = parse({
      ad_groups: [{ name: "A", ads: [videoAd({ call_to_action: "SHOP_NOW" }), videoAd({ call_to_action: "LEARN_MORE", headlines: ["Khác"] })] }],
    })
    await tool().run(providerCtx(saCredentials()), input, { dryRun: true })
    const q = queryOf(m.api().find(searchMatching(/CALL_TO_ACTION/))!)
    expect(q).toContain("asset.call_to_action_asset.call_to_action IN ('LEARN_MORE', 'SHOP_NOW')")
    const ops = (m.api().find(isMutate)!.body as { mutateOperations: Record<string, unknown>[] }).mutateOperations
    // SHOP_NOW reused, LEARN_MORE created (plus the new YouTube asset)
    expect(creates(ops, "assetOperation").filter((a) => "callToActionAsset" in a)).toEqual([
      { resourceName: expect.stringMatching(/assets\/-\d+$/), callToActionAsset: { callToAction: "LEARN_MORE" } },
    ])
  })
})
