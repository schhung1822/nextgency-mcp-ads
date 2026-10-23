import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import {
  buildCampaignCopy,
  copyObject,
  unsupportedChannel,
  type CampaignSource,
} from "./copy"
import {
  DG_AD_COPY_FIELDS,
  DG_AD_GROUP_COPY_FIELDS,
  DG_AD_GROUP_CRITERION_COPY_FIELDS,
  DG_CAMPAIGN_COPY_FIELDS,
  buildDemandGenAdCopy,
  buildDemandGenAdGroupCopy,
  buildDemandGenCampaignCopy,
  channelControlsBody,
  demandGenBidding,
} from "./copy-demand-gen"
import {
  mockFetch,
  providerCtx,
  queryOf,
  saCredentials,
  searchMatching,
} from "./__fixtures__/mock-fetch"

const CID = "1234567890"
const asset = (n: number) => `customers/${CID}/assets/${n}`

const VIDEO_AD = {
  campaign: { id: "40", advertisingChannelType: "DEMAND_GEN" },
  adGroup: { id: "50" },
  adGroupAd: {
    status: "ENABLED",
    adGroupAdAssetAutomationSettings: [
      {
        assetAutomationType: "GENERATE_SHORTER_YOUTUBE_VIDEOS",
        assetAutomationStatus: "OPTED_OUT",
      },
      { assetAutomationType: "UNSPECIFIED", assetAutomationStatus: "OPTED_IN" },
    ],
    ad: {
      id: "600",
      type: "DEMAND_GEN_VIDEO_RESPONSIVE_AD",
      name: "Video giày",
      resourceName: `customers/${CID}/ads/600`,
      addedByGoogleAds: false,
      finalUrls: ["https://shop.vn/giay"],
      urlCustomParameters: [{ key: "ad", value: "v1" }],
      demandGenVideoResponsiveAd: {
        videos: [
          {
            asset: asset(1),
            adVideoAssetInfo: { adVideoAssetInventoryPreferences: {} },
          },
        ],
        logoImages: [{ asset: asset(2) }],
        headlines: [
          {
            text: "Giày mới",
            assetPerformanceLabel: "GOOD",
            policySummaryInfo: { approvalStatus: "APPROVED" },
          },
        ],
        longHeadlines: [{ text: "Giày chạy bộ êm chân" }],
        descriptions: [{ text: "Giao nhanh 2h" }],
        businessName: {
          text: "Shop Giày",
          policySummaryInfo: { approvalStatus: "APPROVED" },
        },
        callToActions: [{ asset: asset(3) }],
        breadcrumb1: "giay",
      },
    },
  },
}

const ad = (
  agId: string,
  id: string,
  type: string,
  body: Record<string, unknown>,
  status = "ENABLED"
) => ({
  campaign: { id: "40", advertisingChannelType: "DEMAND_GEN" },
  adGroup: { id: agId },
  adGroupAd: {
    status,
    ad: { id, type, finalUrls: ["https://shop.vn"], ...body },
  },
})

const MULTI_AD = ad("51", "601", "DEMAND_GEN_MULTI_ASSET_AD", {
  demandGenMultiAssetAd: {
    marketingImages: [{ asset: asset(10) }],
    squareMarketingImages: [{ asset: asset(11) }],
    logoImages: [{ asset: asset(12) }],
    headlines: [{ text: "Sale 30%", assetPerformanceLabel: "BEST" }],
    descriptions: [{ text: "Chỉ hôm nay" }],
    businessName: "Shop Giày",
    callToActionText: "Mua ngay",
  },
})
const CAROUSEL_AD = ad("51", "602", "DEMAND_GEN_CAROUSEL_AD", {
  demandGenCarouselAd: {
    businessName: "Shop Giày",
    logoImage: { asset: asset(12) },
    headline: { text: "Bộ sưu tập", assetPerformanceLabel: "GOOD" },
    description: { text: "Mới về" },
    callToActionText: "Xem thêm",
    carouselCards: [{ asset: asset(20) }, { asset: asset(21) }],
  },
})
const PRODUCT_AD = ad("51", "603", "DEMAND_GEN_PRODUCT_AD", {
  demandGenProductAd: {
    headline: { text: "Giày hot" },
    description: { text: "Mua là có quà" },
    logoImage: { asset: asset(12) },
    businessName: { text: "Shop Giày" },
    callToAction: { asset: asset(3) },
    breadcrumb1: "sale",
  },
})
const IMAGE_AD = ad("51", "604", "IMAGE_AD", {})

const crit = (
  agId: string,
  criterionId: string,
  type: string,
  body: Record<string, unknown> = {}
) => ({
  adGroup: { id: agId },
  adGroupCriterion: { criterionId, type, status: "ENABLED", ...body },
})

const source = (): CampaignSource => ({
  campaign: {
    campaign: {
      id: "40",
      name: "DG Video",
      status: "ENABLED",
      advertisingChannelType: "DEMAND_GEN",
      biddingStrategyType: "TARGET_CPC",
      targetCpc: { targetCpcMicros: "3000000000" },
      demandGenCampaignSettings: { upgradedTargeting: true },
      audienceSetting: { useAudienceGrouped: true },
      shoppingSetting: { merchantId: "12345", feedLabel: "VN" },
      viewThroughConversionOptimizationEnabled: true,
      startDateTime: "2026-09-01 00:00:00",
      endDateTime: "2026-11-30 23:59:59",
      containsEuPoliticalAdvertising:
        "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      trackingUrlTemplate: "{lpurl}?src=dg",
      urlCustomParameters: [{ key: "c", value: "dg" }],
    },
    campaignBudget: {
      id: "88",
      totalAmountMicros: "30000000000000",
      period: "CUSTOM_PERIOD",
      deliveryMethod: "STANDARD",
      explicitlyShared: false,
    },
  },
  criteria: [
    {
      campaignCriterion: {
        criterionId: "30002",
        type: "DEVICE",
        bidModifier: 0,
        device: { type: "TABLET" },
      },
    },
  ],
  adGroups: [
    {
      campaign: { id: "40", advertisingChannelType: "DEMAND_GEN" },
      adGroup: {
        id: "50",
        name: "Video VN",
        status: "ENABLED",
        type: "UNKNOWN",
        audienceSetting: { useAudienceGrouped: true },
        optimizedTargetingEnabled: true,
        targetCpcMicros: "2500000000",
        targetCpaMicros: "0",
        demandGenAdGroupSettings: {
          channelControls: {
            channelConfig: "SELECTED_CHANNELS",
            selectedChannels: {
              youtubeInFeed: true,
              youtubeInStream: true,
              youtubeShorts: true,
            },
          },
        },
      },
    },
    {
      campaign: { id: "40", advertisingChannelType: "DEMAND_GEN" },
      adGroup: {
        id: "51",
        name: "Hình ảnh",
        status: "PAUSED",
        excludeDemographicExpansion: false,
        demandGenAdGroupSettings: {
          channelControls: {
            channelConfig: "CHANNEL_STRATEGY",
            channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS",
          },
        },
      },
    },
  ],
  keywords: [
    crit("50", "2704", "LOCATION", {
      location: { geoTargetConstant: "geoTargetConstants/2704" },
    }),
    crit("50", "1040", "LANGUAGE", {
      language: { languageConstant: "languageConstants/1040" },
    }),
    crit("50", "900", "AUDIENCE", {
      audience: { audience: `customers/${CID}/audiences/9` },
    }),
    crit("51", "503006", "AGE_RANGE", {
      negative: true,
      ageRange: { type: "AGE_RANGE_65_UP" },
    }),
    crit("51", "11", "GENDER", {
      gender: { type: "FEMALE" },
      bidModifier: 1.2,
    }),
    crit("51", "12", "USER_LIST", {
      negative: true,
      userList: { userList: `customers/${CID}/userLists/77` },
    }),
    crit("51", "13", "PARENTAL_STATUS", {
      status: "PAUSED",
      parentalStatus: { type: "PARENT" },
    }),
    crit("51", "14", "INCOME_RANGE", {
      incomeRange: { type: "INCOME_RANGE_90_UP" },
    }),
  ],
  ads: [VIDEO_AD, MULTI_AD, CAROUSEL_AD, PRODUCT_AD, IMAGE_AD],
})

type Op = Record<string, { create: Record<string, unknown> }>
const kind = (op: Record<string, unknown>) => Object.keys(op)[0]!
const create = (op: Record<string, unknown>) => (op as Op)[kind(op)]!.create
const opts = { today: "2026-10-02", budgetSuffix: "t" }

function assertTempIdOrder(ops: Record<string, unknown>[]) {
  const declared = new Set<string>()
  for (const op of ops) {
    const c = create(op)
    for (const r of [c.campaignBudget, c.campaign, c.adGroup].filter(
      (x): x is string => typeof x === "string"
    )) {
      if (/\/-\d+$/.test(r))
        expect(declared.has(r), `${r} referenced before declaration`).toBe(true)
    }
    if (typeof c.resourceName === "string") {
      expect(declared.has(c.resourceName)).toBe(false)
      declared.add(c.resourceName)
    }
  }
}

const thrown = (fn: () => unknown): ProviderError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    return e as ProviderError
  }
  throw new Error("should throw")
}

describe("buildDemandGenCampaignCopy", () => {
  it("deep copy: one temp-id ordered mutate budget → campaign → criteria → ad group → criteria → ads; non-DG ads skipped", () => {
    const plan = buildDemandGenCampaignCopy(CID, source(), {
      ...opts,
      name: "DG Video (bản sao)",
      deep: true,
    })
    expect(plan.ops.map(kind)).toEqual([
      "campaignBudgetOperation",
      "campaignOperation",
      "campaignCriterionOperation",
      "adGroupOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupAdOperation",
      "adGroupOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupAdOperation",
      "adGroupAdOperation",
      "adGroupAdOperation",
    ])
    assertTempIdOrder(plan.ops)
    expect(plan.rootIndex).toBe(1)
    expect(plan.uncopyable).toEqual([])
    expect(plan.warnings.join(" ")).toMatch(/50~604|51~604/)
    expect(plan.warnings.join(" ")).toMatch(/IMAGE_AD/)
    expect(
      plan.entries.filter((e) => e.level === "ad").map((e) => e.sourceId)
    ).toEqual(["50~600", "51~601", "51~602", "51~603"])
  })

  it("campaign: PAUSED DEMAND_GEN, no sub type / network / geo type, settings kept, TARGET_CPC, lifetime non-shared budget, flight shifted", () => {
    const plan = buildDemandGenCampaignCopy(CID, source(), {
      ...opts,
      name: "Copy",
      deep: false,
    })
    const budget = create(plan.ops[0]!)
    expect(budget).toEqual({
      resourceName: expect.stringMatching(/campaignBudgets\/-1$/),
      name: "Copy - ngân sách t",
      explicitlyShared: false,
      deliveryMethod: "STANDARD",
      period: "CUSTOM_PERIOD",
      totalAmountMicros: "30000000000000",
    })
    const camp = create(plan.ops[1]!)
    expect(camp).toEqual({
      resourceName: expect.stringMatching(/campaigns\/-2$/),
      name: "Copy",
      status: "PAUSED",
      advertisingChannelType: "DEMAND_GEN",
      campaignBudget: budget.resourceName,
      targetCpc: { targetCpcMicros: "3000000000" },
      demandGenCampaignSettings: { upgradedTargeting: true },
      audienceSetting: { useAudienceGrouped: true },
      shoppingSetting: { merchantId: "12345", feedLabel: "VN" },
      viewThroughConversionOptimizationEnabled: true,
      containsEuPoliticalAdvertising:
        "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      startDateTime: "2026-10-02 00:00:00",
      endDateTime: "2026-12-31 23:59:59",
      trackingUrlTemplate: "{lpurl}?src=dg",
      urlCustomParameters: [{ key: "c", value: "dg" }],
    })
    for (const k of [
      "advertisingChannelSubType",
      "networkSettings",
      "geoTargetTypeSetting",
      "biddingStrategyType",
    ])
      expect(camp).not.toHaveProperty(k)
    expect(plan.ops.map(kind)).not.toContain("adGroupOperation")
    const w = plan.warnings.join(" ")
    expect(w).toMatch(/Ngày kết thúc của bản sao được dời thành 2026-12-31/)
    expect(w).toMatch(/Sao chép nông/)
  })

  it("daily budget, shared source → new non-shared daily budget with a warning", () => {
    const s = source()
    s.campaign.campaignBudget = {
      id: "89",
      amountMicros: "500000000000",
      period: "DAILY",
      explicitlyShared: true,
    }
    const plan = buildDemandGenCampaignCopy(CID, s, {
      ...opts,
      name: "x",
      deep: false,
    })
    expect(create(plan.ops[0]!)).toMatchObject({
      explicitlyShared: false,
      amountMicros: "500000000000",
    })
    expect(create(plan.ops[0]!)).not.toHaveProperty("totalAmountMicros")
    expect(plan.warnings.join(" ")).toMatch(/ngân sách chung/)
  })

  it("bidding: TARGET_CPC added; other strategies reuse the Search mapping; portfolio kept; Manual CPC refused", () => {
    const row = (campaign: Record<string, unknown>) => ({ campaign })
    const w: string[] = []
    expect(
      demandGenBidding(
        row({
          biddingStrategyType: "TARGET_CPC",
          targetCpc: { targetCpcMicros: "1" },
        }),
        w
      )
    ).toEqual({ targetCpc: { targetCpcMicros: "1" } })
    // no readable target → Google would reject `targetCpc: {}` → clear refusal instead
    expect(thrown(() => demandGenBidding(row({ biddingStrategyType: "TARGET_CPC" }), w)).code).toBe("invalid_request")
    expect(thrown(() => demandGenBidding(row({ biddingStrategyType: "TARGET_CPC", targetCpc: { targetCpcMicros: "0" } }), w)).code).toBe("invalid_request")
    expect(
      demandGenBidding(
        row({
          biddingStrategyType: "MAXIMIZE_CONVERSIONS",
          maximizeConversions: { targetCpaMicros: "5" },
        }),
        w
      )
    ).toEqual({
      maximizeConversions: { targetCpaMicros: "5" },
    })
    expect(
      demandGenBidding(
        row({
          biddingStrategyType: "TARGET_CPA",
          targetCpa: { targetCpaMicros: "6" },
        }),
        w
      )
    ).toEqual({ maximizeConversions: { targetCpaMicros: "6" } })
    expect(
      demandGenBidding(
        row({
          biddingStrategyType: "TARGET_ROAS",
          targetRoas: { targetRoas: 3.5 },
        }),
        w
      )
    ).toEqual({ maximizeConversionValue: { targetRoas: 3.5 } })
    expect(
      demandGenBidding(row({ biddingStrategyType: "TARGET_SPEND" }), w)
    ).toEqual({ targetSpend: {} })
    expect(
      demandGenBidding(
        row({
          biddingStrategyType: "TARGET_CPC",
          biddingStrategy: `customers/${CID}/biddingStrategies/5`,
        }),
        w
      )
    ).toEqual({
      biddingStrategy: `customers/${CID}/biddingStrategies/5`,
    })
    expect(
      thrown(() =>
        demandGenBidding(row({ biddingStrategyType: "MANUAL_CPC" }), w)
      ).code
    ).toBe("unsupported")
  })

  it("campaign criteria: LOCATION and LANGUAGE kept (allowed on Demand Gen), device/schedule/negative keyword/proximity copied", () => {
    const s = source()
    ;(
      s.campaign.campaign as Record<string, unknown>
    ).demandGenCampaignSettings = { upgradedTargeting: false }
    s.criteria.push(
      {
        campaignCriterion: {
          criterionId: "2704",
          type: "LOCATION",
          bidModifier: 1.1,
          location: { geoTargetConstant: "geoTargetConstants/2704" },
        },
      },
      {
        campaignCriterion: {
          criterionId: "1040",
          type: "LANGUAGE",
          bidModifier: 1.5,
          language: { languageConstant: "languageConstants/1040" },
        },
      },
      {
        campaignCriterion: {
          criterionId: "5",
          type: "KEYWORD",
          negative: true,
          keyword: { text: "miễn phí", matchType: "BROAD" },
        },
      },
      {
        campaignCriterion: {
          criterionId: "6",
          type: "AD_SCHEDULE",
          adSchedule: { dayOfWeek: "MONDAY", startHour: 8, endHour: 20 },
        },
      },
      {
        campaignCriterion: {
          criterionId: "7",
          type: "PROXIMITY",
          proximity: {
            geoPoint: { latitudeInMicroDegrees: 1, longitudeInMicroDegrees: 2 },
            radius: 3,
            radiusUnits: "KILOMETERS",
          },
        },
      }
    )
    const plan = buildDemandGenCampaignCopy(CID, s, {
      ...opts,
      name: "x",
      deep: false,
    })
    const camp = create(plan.ops[1]!)
    expect(camp.demandGenCampaignSettings).toEqual({ upgradedTargeting: false })
    const crits = plan.ops
      .filter((o) => kind(o) === "campaignCriterionOperation")
      .map(create)
    const rn = camp.resourceName
    expect(crits).toEqual([
      { campaign: rn, device: { type: "TABLET" }, bidModifier: 0 },
      {
        campaign: rn,
        location: { geoTargetConstant: "geoTargetConstants/2704" },
        bidModifier: 1.1,
      },
      {
        campaign: rn,
        language: { languageConstant: "languageConstants/1040" },
      },
      {
        campaign: rn,
        keyword: { text: "miễn phí", matchType: "BROAD" },
        negative: true,
      },
      {
        campaign: rn,
        adSchedule: {
          dayOfWeek: "MONDAY",
          startHour: 8,
          startMinute: "ZERO",
          endHour: 20,
          endMinute: "ZERO",
        },
      },
      {
        campaign: rn,
        proximity: {
          geoPoint: { longitudeInMicroDegrees: 2, latitudeInMicroDegrees: 1 },
          radius: 3,
          radiusUnits: "KILOMETERS",
        },
      },
    ])
    expect(plan.warnings.join(" ")).not.toMatch(/tiêu chí ngôn ngữ|vị trí, ngôn ngữ/)
  })

  it("upgraded_targeting omitted in the read + campaign-level LOCATION → keeps campaign-level mode (false)", () => {
    const s = source()
    delete (s.campaign.campaign as Record<string, unknown>)
      .demandGenCampaignSettings
    expect(
      create(
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
          .ops[1]!
      )
    ).not.toHaveProperty("demandGenCampaignSettings")
    s.criteria.push({
      campaignCriterion: {
        criterionId: "2704",
        type: "LOCATION",
        location: { geoTargetConstant: "geoTargetConstants/2704" },
      },
    })
    expect(
      create(
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
          .ops[1]!
      ).demandGenCampaignSettings
    ).toEqual({ upgradedTargeting: false })
  })

  it("campaign criteria it cannot copy fail closed; allowIncomplete turns them into a warning", () => {
    const s = source()
    s.criteria.push(
      { campaignCriterion: { criterionId: "8", type: "USER_LIST" } },
      {
        campaignCriterion: {
          criterionId: "9",
          type: "PLACEMENT",
          negative: true,
        },
      }
    )
    const e = thrown(() =>
      buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
    )
    expect(e.code).toBe("invalid_request")
    expect(e.userMessageVi).toMatch(/USER_LIST/)
    expect(e.userMessageVi).toMatch(/PLACEMENT/)
    const plan = buildDemandGenCampaignCopy(CID, s, {
      ...opts,
      name: "x",
      deep: false,
      allowIncomplete: true,
    })
    expect(plan.warnings.join(" ")).toMatch(
      /allow_incomplete_targeting=true.*USER_LIST/
    )
  })

  it("never declares EU political advertising; shared sets and Search asset links reused", () => {
    const s = source()
    s.sharedSets = [
      {
        campaignSharedSet: {
          sharedSet: `customers/${CID}/sharedSets/55`,
          status: "ENABLED",
        },
        sharedSet: { id: "55", status: "ENABLED" },
      },
    ]
    s.assets = [
      {
        campaignAsset: {
          asset: asset(31),
          fieldType: "SITELINK",
          status: "ENABLED",
          source: "ADVERTISER",
        },
      },
      {
        campaignAsset: {
          asset: asset(32),
          fieldType: "BUSINESS_LOGO",
          status: "ENABLED",
          source: "ADVERTISER",
        },
      },
    ]
    const plan = buildDemandGenCampaignCopy(CID, s, {
      ...opts,
      name: "x",
      deep: false,
    })
    const rn = create(plan.ops[1]!).resourceName
    expect(
      plan.ops
        .filter((o) => kind(o) === "campaignSharedSetOperation")
        .map(create)
    ).toEqual([{ campaign: rn, sharedSet: `customers/${CID}/sharedSets/55` }])
    expect(
      plan.ops.filter((o) => kind(o) === "campaignAssetOperation").map(create)
    ).toEqual([{ campaign: rn, asset: asset(31), fieldType: "SITELINK" }])
    expect(plan.warnings.join(" ")).toMatch(/BUSINESS_LOGO: 1/)
    delete (s.campaign.campaign as Record<string, unknown>)
      .containsEuPoliticalAdvertising
    expect(
      thrown(() =>
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
      ).hint
    ).toMatch(/google_ads_declare_eu_political/)
  })

  it("lifetime budget with an end date already past → refused (same rule as Search)", () => {
    const s = source()
    ;(s.campaign.campaign as Record<string, unknown>).startDateTime = undefined
    ;(s.campaign.campaign as Record<string, unknown>).endDateTime =
      "2026-09-30 23:59:59"
    expect(
      thrown(() =>
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
      ).code
    ).toBe("invalid_request")
  })

  it("refuses other channels; the Search builder still refuses Demand Gen; message lists Search and Demand Gen", () => {
    const s = source()
    ;(s.campaign.campaign as Record<string, unknown>).advertisingChannelType =
      "SEARCH"
    expect(
      thrown(() =>
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false })
      ).code
    ).toBe("unsupported")
    expect(
      thrown(() =>
        buildCampaignCopy(CID, source(), { ...opts, name: "x", deep: false })
      ).code
    ).toBe("unsupported")
    expect(unsupportedChannel("DISPLAY").userMessageVi).toMatch(
      /Tìm kiếm \(Search\) và Demand Gen/
    )
    expect(unsupportedChannel("VIDEO").userMessageVi).toMatch(/chỉ xem được/)
    expect(unsupportedChannel("PERFORMANCE_MAX").userMessageVi).toMatch(
      /Performance Max/
    )
  })
})

describe("Demand Gen ad groups", () => {
  it("created without type; channel controls copied as selectedChannels (all 7 booleans) or channelStrategy, never channelConfig", () => {
    const plan = buildDemandGenCampaignCopy(CID, source(), {
      ...opts,
      name: "x",
      deep: true,
    })
    const groups = plan.ops
      .filter((o) => kind(o) === "adGroupOperation")
      .map(create)
    expect(groups[0]).toEqual({
      resourceName: expect.stringMatching(/adGroups\/-3$/),
      campaign: create(plan.ops[1]!).resourceName,
      name: "Video VN",
      status: "ENABLED",
      audienceSetting: { useAudienceGrouped: true },
      optimizedTargetingEnabled: true,
      targetCpcMicros: "2500000000",
      demandGenAdGroupSettings: {
        channelControls: {
          selectedChannels: {
            youtubeInFeed: true,
            youtubeInStream: true,
            youtubeShorts: true,
            discover: false,
            gmail: false,
            display: false,
            maps: false,
          },
        },
      },
    })
    expect(groups[1]).toMatchObject({
      name: "Hình ảnh",
      status: "PAUSED",
      excludeDemographicExpansion: false,
      demandGenAdGroupSettings: {
        channelControls: { channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS" },
      },
    })
    for (const g of groups) expect(g).not.toHaveProperty("type")
    expect(JSON.stringify(plan.ops)).not.toContain("channelConfig")
  })

  it("channel controls: nothing readable / unknown strategy / no channel selected → cannot copy (never silently ALL_CHANNELS)", () => {
    const g = (cc: Record<string, unknown> | undefined) => ({
      adGroup: {
        id: "1",
        demandGenAdGroupSettings: cc ? { channelControls: cc } : undefined,
      },
    })
    expect(channelControlsBody(g(undefined))).toBeNull()
    expect(channelControlsBody(g({ channelStrategy: "ALL_CHANNELS" }))).toEqual(
      { channelStrategy: "ALL_CHANNELS" }
    )
    expect(
      channelControlsBody(
        g({ channelConfig: "CHANNEL_STRATEGY", channelStrategy: "UNKNOWN" })
      )
    ).toBeNull()
    expect(
      channelControlsBody(
        g({ channelConfig: "SELECTED_CHANNELS", selectedChannels: {} })
      )
    ).toBeNull()
    expect(
      channelControlsBody(g({ channelConfig: "SOMETHING_NEW" }))
    ).toBeNull()
    const s = source()
    ;(
      s.adGroups[0]!.adGroup as Record<string, unknown>
    ).demandGenAdGroupSettings = {
      channelControls: { channelConfig: "SELECTED_CHANNELS" },
    }
    expect(
      thrown(() =>
        buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: true })
      ).userMessageVi
    ).toMatch(/channel controls/)
  })

  it("criteria: location, language, audience, user list and demographics re-created (negative / paused / bid modifier as source)", () => {
    const plan = buildDemandGenCampaignCopy(CID, source(), {
      ...opts,
      name: "x",
      deep: true,
    })
    const [ag1, ag2] = plan.ops
      .filter((o) => kind(o) === "adGroupOperation")
      .map((o) => create(o).resourceName)
    const crits = plan.ops
      .filter((o) => kind(o) === "adGroupCriterionOperation")
      .map(create)
    expect(crits).toEqual([
      {
        adGroup: ag1,
        location: { geoTargetConstant: "geoTargetConstants/2704" },
      },
      {
        adGroup: ag1,
        language: { languageConstant: "languageConstants/1040" },
      },
      { adGroup: ag1, audience: { audience: `customers/${CID}/audiences/9` } },
      { adGroup: ag2, negative: true, ageRange: { type: "AGE_RANGE_65_UP" } },
      { adGroup: ag2, gender: { type: "FEMALE" }, bidModifier: 1.2 },
      {
        adGroup: ag2,
        negative: true,
        userList: { userList: `customers/${CID}/userLists/77` },
      },
      { adGroup: ag2, status: "PAUSED", parentalStatus: { type: "PARENT" } },
      { adGroup: ag2, incomeRange: { type: "INCOME_RANGE_90_UP" } },
    ])
  })

  it("unknown criteria (TOPIC, a listing-group tree) fail closed; a single root listing UNIT is copied; allowIncomplete → warning", () => {
    const ag = source().adGroups[1]!
    const unit = crit("51", "1", "LISTING_GROUP", {
      listingGroup: { type: "UNIT" },
    })
    const ok = buildDemandGenAdGroupCopy(CID, "40", ag, [unit], [], {
      name: "G",
      deep: false,
    })
    expect(create(ok.ops[1]!)).toEqual({
      adGroup: create(ok.ops[0]!).resourceName,
      listingGroup: { type: "UNIT" },
    })
    const tree = [
      crit("51", "1", "LISTING_GROUP", {
        listingGroup: { type: "SUBDIVISION" },
      }),
      crit("51", "2", "LISTING_GROUP", { listingGroup: { type: "UNIT" } }),
      crit("51", "3", "LISTING_GROUP", { listingGroup: { type: "UNIT" } }),
      crit("51", "4", "TOPIC"),
      crit("51", "5", "AUDIENCE"), // no audience resource → cannot re-create
    ]
    const e = thrown(() =>
      buildDemandGenAdGroupCopy(CID, "40", ag, tree, [], {
        name: "G",
        deep: false,
      })
    )
    expect(e.userMessageVi).toMatch(/3 tiêu chí loại LISTING_GROUP/)
    expect(e.userMessageVi).toMatch(/TOPIC/)
    expect(e.userMessageVi).toMatch(/1 tiêu chí loại AUDIENCE/)
    const plan = buildDemandGenAdGroupCopy(CID, "40", ag, tree, [], {
      name: "G",
      deep: false,
      allowIncomplete: true,
    })
    expect(plan.ops.map(kind)).toEqual(["adGroupOperation"])
    expect(plan.warnings.join(" ")).toMatch(/allow_incomplete_targeting=true/)
  })

  it("ad group copy: root PAUSED under the target campaign, criteria always, ads only when deep", () => {
    const s = source()
    const ag = s.adGroups[0]!
    const kw = s.keywords.filter(
      (k) => (k.adGroup as { id: string }).id === "50"
    )
    const shallow = buildDemandGenAdGroupCopy(CID, "41", ag, kw, [VIDEO_AD], {
      name: "Video VN (bản sao)",
      deep: false,
    })
    expect(create(shallow.ops[0]!)).toMatchObject({
      campaign: `customers/${CID}/campaigns/41`,
      status: "PAUSED",
      name: "Video VN (bản sao)",
    })
    expect(shallow.ops.map(kind)).toEqual([
      "adGroupOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
    ])
    const deep = buildDemandGenAdGroupCopy(CID, "41", ag, kw, [VIDEO_AD], {
      name: "x",
      deep: true,
    })
    expect(deep.ops.map(kind).at(-1)).toBe("adGroupAdOperation")
    expect(create(deep.ops.at(-1)!).status).toBe("ENABLED")
  })
})

describe("Demand Gen ads", () => {
  const adOps = () =>
    buildDemandGenCampaignCopy(CID, source(), {
      ...opts,
      name: "x",
      deep: true,
    })
      .ops.filter((o) => kind(o) === "adGroupAdOperation")
      .map(create)

  it("video responsive: assets reused by resource name, text inline, output-only fields stripped, automation opt-outs kept", () => {
    const v = adOps()[0]!
    expect(v).toEqual({
      adGroup: expect.stringMatching(/adGroups\/-3$/),
      status: "ENABLED",
      ad: {
        name: "Video giày",
        finalUrls: ["https://shop.vn/giay"],
        urlCustomParameters: [{ key: "ad", value: "v1" }],
        demandGenVideoResponsiveAd: {
          videos: [{ asset: asset(1) }],
          logoImages: [{ asset: asset(2) }],
          headlines: [{ text: "Giày mới" }],
          longHeadlines: [{ text: "Giày chạy bộ êm chân" }],
          descriptions: [{ text: "Giao nhanh 2h" }],
          businessName: { text: "Shop Giày" },
          callToActions: [{ asset: asset(3) }],
          breadcrumb1: "giay",
        },
      },
      adGroupAdAssetAutomationSettings: [
        {
          assetAutomationType: "GENERATE_SHORTER_YOUTUBE_VIDEOS",
          assetAutomationStatus: "OPTED_OUT",
        },
      ],
    })
  })

  it("multi-asset, carousel and product ads: string vs AdTextAsset fields per type", () => {
    const [, multi, carousel, product] = adOps()
    expect(multi!.ad).toEqual({
      finalUrls: ["https://shop.vn"],
      demandGenMultiAssetAd: {
        marketingImages: [{ asset: asset(10) }],
        squareMarketingImages: [{ asset: asset(11) }],
        logoImages: [{ asset: asset(12) }],
        headlines: [{ text: "Sale 30%" }],
        descriptions: [{ text: "Chỉ hôm nay" }],
        businessName: "Shop Giày",
        callToActionText: "Mua ngay",
      },
    })
    expect(carousel!.ad).toEqual({
      finalUrls: ["https://shop.vn"],
      demandGenCarouselAd: {
        businessName: "Shop Giày",
        logoImage: { asset: asset(12) },
        headline: { text: "Bộ sưu tập" },
        description: { text: "Mới về" },
        callToActionText: "Xem thêm",
        carouselCards: [{ asset: asset(20) }, { asset: asset(21) }],
      },
    })
    expect(product!.ad).toEqual({
      finalUrls: ["https://shop.vn"],
      demandGenProductAd: {
        headline: { text: "Giày hot" },
        description: { text: "Mua là có quà" },
        logoImage: { asset: asset(12) },
        businessName: { text: "Shop Giày" },
        callToAction: { asset: asset(3) },
        breadcrumb1: "sale",
      },
    })
    const json = JSON.stringify(adOps())
    for (const f of [
      "assetPerformanceLabel",
      "policySummaryInfo",
      "resourceName",
      "addedByGoogleAds",
      "adVideoAssetInfo",
      '"type"',
      '"id"',
    ])
      expect(json).not.toContain(f)
  })

  it("ad-level copy: new PAUSED ad in the target ad group; unknown types refused", () => {
    const plan = buildDemandGenAdCopy(CID, "52", VIDEO_AD)
    expect(create(plan.ops[0]!)).toMatchObject({
      adGroup: `customers/${CID}/adGroups/52`,
      status: "PAUSED",
    })
    expect(plan.entries).toEqual([
      { index: 0, level: "ad", sourceId: "50~600" },
    ])
    expect(thrown(() => buildDemandGenAdCopy(CID, "52", IMAGE_AD)).code).toBe(
      "unsupported"
    )
  })
})

// research §5.1 (fields verified selectable in /fields/v25/*) + id/name fields already used by the Search copy
const RESEARCH_FIELDS = new Set([
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  "campaign.start_date_time",
  "campaign.end_date_time",
  "campaign.contains_eu_political_advertising",
  "campaign.demand_gen_campaign_settings.upgraded_targeting",
  "campaign.audience_setting.use_audience_grouped",
  "campaign.bidding_strategy_type",
  "campaign.bidding_strategy",
  "campaign.maximize_conversions.target_cpa_micros",
  "campaign.maximize_conversion_value.target_roas",
  "campaign.target_cpa.target_cpa_micros",
  "campaign.target_roas.target_roas",
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.target_cpc.target_cpc_micros",
  "campaign.view_through_conversion_optimization_enabled",
  "campaign.shopping_setting.merchant_id",
  "campaign.shopping_setting.feed_label",
  "campaign.tracking_url_template",
  "campaign.final_url_suffix",
  "campaign.url_custom_parameters",
  "campaign_budget.id",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "campaign_budget.period",
  "campaign_budget.explicitly_shared",
  "campaign_budget.delivery_method",
  "ad_group.id",
  "ad_group.name",
  "ad_group.status",
  "ad_group.audience_setting.use_audience_grouped",
  "ad_group.optimized_targeting_enabled",
  "ad_group.exclude_demographic_expansion",
  "ad_group.target_cpa_micros",
  "ad_group.target_cpc_micros",
  "ad_group.target_roas",
  "ad_group.demand_gen_ad_group_settings.channel_controls.channel_config",
  "ad_group.demand_gen_ad_group_settings.channel_controls.channel_strategy",
  ...[
    "youtube_in_feed",
    "youtube_in_stream",
    "youtube_shorts",
    "discover",
    "gmail",
    "display",
    "maps",
  ].map(
    (c) =>
      `ad_group.demand_gen_ad_group_settings.channel_controls.selected_channels.${c}`
  ),
  "ad_group.tracking_url_template",
  "ad_group.final_url_suffix",
  "ad_group.url_custom_parameters",
  "ad_group_criterion.criterion_id",
  "ad_group_criterion.type",
  "ad_group_criterion.negative",
  "ad_group_criterion.status",
  "ad_group_criterion.bid_modifier",
  "ad_group_criterion.audience.audience",
  "ad_group_criterion.location.geo_target_constant",
  "ad_group_criterion.language.language_constant",
  "ad_group_criterion.listing_group.type",
  "ad_group_criterion.user_list.user_list",
  "ad_group_criterion.age_range.type",
  "ad_group_criterion.gender.type",
  "ad_group_criterion.parental_status.type",
  "ad_group_criterion.income_range.type",
  "ad_group_ad.status",
  "ad_group_ad.ad_group_ad_asset_automation_settings", // checked selectable on /fields/v25/ad_group_ad (2026-10-23)
  ...[
    "id",
    "type",
    "name",
    "final_urls",
    "final_mobile_urls",
    "tracking_url_template",
    "final_url_suffix",
    "url_custom_parameters",
  ].map((f) => `ad_group_ad.ad.${f}`),
  ...[
    "marketing_images",
    "square_marketing_images",
    "portrait_marketing_images",
    "tall_portrait_marketing_images",
    "classic_display_images",
    "logo_images",
    "headlines",
    "descriptions",
    "business_name",
    "call_to_action_text",
  ].map((f) => `ad_group_ad.ad.demand_gen_multi_asset_ad.${f}`),
  ...[
    "business_name",
    "logo_image",
    "headline",
    "description",
    "call_to_action_text",
    "carousel_cards",
  ].map((f) => `ad_group_ad.ad.demand_gen_carousel_ad.${f}`),
  ...[
    "videos",
    "logo_images",
    "headlines",
    "long_headlines",
    "descriptions",
    "business_name",
    "call_to_actions",
    "companion_banners",
    "breadcrumb1",
    "breadcrumb2",
  ].map((f) => `ad_group_ad.ad.demand_gen_video_responsive_ad.${f}`),
  ...[
    "headline",
    "description",
    "logo_image",
    "business_name",
    "call_to_action",
    "breadcrumb1",
    "breadcrumb2",
  ].map((f) => `ad_group_ad.ad.demand_gen_product_ad.${f}`),
])

describe("Demand Gen GAQL", () => {
  it("selects only fields verified selectable (research §5.1)", () => {
    for (const f of [
      ...DG_CAMPAIGN_COPY_FIELDS,
      ...DG_AD_GROUP_COPY_FIELDS,
      ...DG_AD_GROUP_CRITERION_COPY_FIELDS,
      ...DG_AD_COPY_FIELDS,
    ]) {
      expect(RESEARCH_FIELDS.has(f), f).toBe(true)
    }
    expect(DG_AD_GROUP_COPY_FIELDS).not.toContain("ad_group.type")
  })
})

describe("copyObject Demand Gen", () => {
  beforeEach(() => {
    __clearTokenCache()
    __resetBuckets()
  })
  afterEach(() => vi.unstubAllGlobals())

  const fieldsOf = (q: string) =>
    q
      .replace(/^SELECT /, "")
      .split(" FROM ")[0]!
      .split(", ")
  const mutates = (m: ReturnType<typeof mockFetch>) =>
    m.api().filter((c) => c.url.endsWith("googleAds:mutate"))
  const opsOf = (m: ReturnType<typeof mockFetch>) =>
    (
      mutates(m)[0]!.body as {
        mutateOperations: Record<string, unknown>[]
        validateOnly?: boolean
      }
    ).mutateOperations

  function mockTree() {
    const s = source()
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id = 40/), {
      body: { results: [s.campaign] },
    })
    m.on(searchMatching(/FROM campaign_criterion/), {
      body: { results: s.criteria },
    })
    m.on(searchMatching(/FROM ad_group WHERE campaign\.id = 40/), {
      body: { results: s.adGroups },
    })
    m.on(searchMatching(/FROM ad_group_ad WHERE campaign\.id = 40/), {
      body: { results: s.ads },
    })
    m.on(searchMatching(/FROM ad_group_criterion WHERE campaign\.id = 40/), {
      body: { results: s.keywords },
    })
    m.on(searchMatching(/campaign\.name LIKE/), {
      body: { results: [{ campaign: { name: "DG Video (bản sao)" } }] },
    })
    m.on(searchMatching(/FROM campaign_shared_set/), { body: { results: [] } })
    m.on(searchMatching(/FROM campaign_asset/), { body: { results: [] } })
    m.on(searchMatching(/FROM conversion_goal_campaign_config/), {
      body: { results: [] },
    })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    return m
  }

  it("campaign deep dryRun: DG reads with only verified fields, one validateOnly mutate, unique name", async () => {
    const m = mockTree()
    const res = await copyObject(
      providerCtx(saCredentials()),
      { level: "campaign", id: "40", deep: true },
      { dryRun: true }
    )
    expect(res.preview).toBe(true)
    expect(mutates(m)).toHaveLength(1)
    expect(
      (mutates(m)[0]!.body as { validateOnly?: boolean }).validateOnly
    ).toBe(true)
    const ops = opsOf(m)
    expect(create(ops[1]!)).toMatchObject({
      name: "DG Video (bản sao) 2",
      status: "PAUSED",
      advertisingChannelType: "DEMAND_GEN",
      targetCpc: { targetCpcMicros: "3000000000" },
    })
    expect(ops.filter((o) => kind(o) === "adGroupAdOperation")).toHaveLength(4)
    const queries = m.api().map(queryOf).filter(Boolean)
    const dgCampaign = queries.find((q) =>
      q.includes("campaign.target_cpc.target_cpc_micros")
    )!
    expect(dgCampaign).toBeTruthy()
    for (const q of queries
      .filter((x) =>
        /FROM (ad_group|ad_group_ad|ad_group_criterion) WHERE campaign\.id = 40/.test(
          x
        )
      )
      .concat(dgCampaign)) {
      for (const f of fieldsOf(q))
        expect(RESEARCH_FIELDS.has(f), `${f} in ${q.slice(0, 60)}`).toBe(true)
    }
    expect(res.mappings.map((x) => `${x.level}:${x.sourceId}`)).toEqual([
      "campaign:40",
      "ad_group:50",
      "ad:50~600",
      "ad_group:51",
      "ad:51~601",
      "ad:51~602",
      "ad:51~603",
    ])
  })

  function mockAdGroup(target: Record<string, unknown> | null) {
    const s = source()
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE ad_group\.id = 50/), {
      body: { results: [s.adGroups[0]] },
    })
    if (target)
      m.on(searchMatching(/FROM campaign WHERE campaign\.id = 41/), {
        body: { results: [target] },
      })
    m.on(searchMatching(/FROM ad_group_criterion WHERE ad_group\.id = 50/), {
      body: {
        results: s.keywords.filter(
          (k) => (k.adGroup as { id: string }).id === "50"
        ),
      },
    })
    m.on(searchMatching(/FROM ad_group_ad WHERE ad_group\.id = 50/), {
      body: { results: [VIDEO_AD, { ...PRODUCT_AD, adGroup: { id: "50" } }] },
    })
    m.on(searchMatching(/ad_group\.name LIKE/), { body: { results: [] } })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    return m
  }

  it("ad group into another Demand Gen campaign: PAUSED under the target, criteria copied", async () => {
    const m = mockAdGroup({
      campaign: {
        id: "41",
        status: "PAUSED",
        advertisingChannelType: "DEMAND_GEN",
        shoppingSetting: { merchantId: "12345" },
      },
    })
    const res = await copyObject(
      providerCtx(saCredentials()),
      { level: "ad_group", id: "50", deep: true, targetParentId: "41" },
      { dryRun: true }
    )
    expect(res.preview).toBe(true)
    const ops = opsOf(m)
    expect(create(ops[0]!)).toMatchObject({
      campaign: `customers/${CID}/campaigns/41`,
      status: "PAUSED",
      name: "Video VN (bản sao)",
    })
    expect(ops.map(kind)).toEqual([
      "adGroupOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupAdOperation",
      "adGroupAdOperation",
    ])
  })

  it("ad group into a non-Demand-Gen campaign (or one without product feed for product ads) → refused, nothing sent", async () => {
    const ctx = providerCtx(saCredentials())
    let m = mockAdGroup({
      campaign: {
        id: "41",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
      },
    })
    let e = await copyObject(
      ctx,
      { level: "ad_group", id: "50", deep: true, targetParentId: "41" },
      { dryRun: true }
    ).catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).userMessageVi).toMatch(/cùng loại Demand Gen/)
    expect(mutates(m)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = mockAdGroup({
      campaign: {
        id: "41",
        status: "ENABLED",
        advertisingChannelType: "DEMAND_GEN",
      },
    })
    e = await copyObject(
      ctx,
      { level: "ad_group", id: "50", deep: true, targetParentId: "41" },
      { dryRun: true }
    ).catch((x) => x)
    expect((e as ProviderError).userMessageVi).toMatch(/Merchant Center/)
    expect(mutates(m)).toHaveLength(0)
  })

  it("a Search ad group into a Demand Gen campaign → channel mismatch (Search path)", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE ad_group\.id = 20/), {
      body: {
        results: [
          {
            campaign: { id: "10", advertisingChannelType: "SEARCH" },
            adGroup: {
              id: "20",
              name: "G",
              status: "ENABLED",
              type: "SEARCH_STANDARD",
            },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM campaign WHERE campaign\.id = 41/), {
      body: {
        results: [
          {
            campaign: {
              id: "41",
              status: "ENABLED",
              advertisingChannelType: "DEMAND_GEN",
            },
          },
        ],
      },
    })
    const e = await copyObject(
      providerCtx(saCredentials()),
      { level: "ad_group", id: "20", deep: false, targetParentId: "41" },
      { dryRun: true }
    ).catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).code).toBe("invalid_request")
    expect((e as ProviderError).userMessageVi).toMatch(
      /cùng loại Tìm kiếm \(Search\)/
    )
    expect(mutates(m)).toHaveLength(0)
  })

  function mockAd(
    target: Record<string, unknown>,
    src: Record<string, unknown> = VIDEO_AD
  ) {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group_ad WHERE ad_group_ad\.ad\.id = 60\d/), {
      body: { results: [src] },
    })
    m.on(searchMatching(/FROM ad_group WHERE ad_group\.id IN/), {
      body: { results: [target] },
    })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    return m
  }

  it("ad into a Demand Gen ad group: re-read with DG fields, new PAUSED ad; name kept (prefix ignored with a warning)", async () => {
    const m = mockAd({
      adGroup: { id: "52", status: "ENABLED" },
      campaign: { advertisingChannelType: "DEMAND_GEN" },
    })
    const res = await copyObject(
      providerCtx(saCredentials()),
      {
        level: "ad",
        id: "50~600",
        deep: false,
        targetParentId: "52",
        namePrefix: "[X] ",
      },
      { dryRun: true }
    )
    const ops = opsOf(m)
    expect(ops).toHaveLength(1)
    expect(create(ops[0]!)).toMatchObject({
      adGroup: `customers/${CID}/adGroups/52`,
      status: "PAUSED",
      ad: { name: "Video giày" },
    })
    expect(res.warnings.join(" ")).toMatch(/giữ nguyên tên/)
    const dgRead = m
      .api()
      .map(queryOf)
      .find((q) => q.includes("demand_gen_carousel_ad.carousel_cards"))!
    expect(dgRead).toContain(
      "WHERE ad_group_ad.ad.id = 600 AND ad_group.id = 50"
    )
    for (const f of fieldsOf(dgRead))
      expect(RESEARCH_FIELDS.has(f), f).toBe(true)
  })

  it("ad into a Search / Video ad group, or a product ad into a group without product feed → refused", async () => {
    const ctx = providerCtx(saCredentials())
    let m = mockAd({
      adGroup: { id: "30", status: "ENABLED", type: "SEARCH_STANDARD" },
      campaign: { advertisingChannelType: "SEARCH" },
    })
    let e = await copyObject(
      ctx,
      { level: "ad", id: "50~600", deep: false, targetParentId: "30" },
      { dryRun: true }
    ).catch((x) => x)
    expect((e as ProviderError).userMessageVi).toMatch(/cùng loại Demand Gen/)
    expect(mutates(m)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = mockAd({
      adGroup: { id: "30", status: "ENABLED" },
      campaign: { advertisingChannelType: "VIDEO" },
    })
    e = await copyObject(
      ctx,
      { level: "ad", id: "50~600", deep: false, targetParentId: "30" },
      { dryRun: true }
    ).catch((x) => x)
    expect((e as ProviderError).code).toBe("unsupported")
    vi.unstubAllGlobals()
    m = mockAd(
      {
        adGroup: { id: "52", status: "ENABLED" },
        campaign: { advertisingChannelType: "DEMAND_GEN" },
      },
      PRODUCT_AD
    )
    e = await copyObject(
      ctx,
      { level: "ad", id: "51~603", deep: false, targetParentId: "52" },
      { dryRun: true }
    ).catch((x) => x)
    expect((e as ProviderError).userMessageVi).toMatch(/Merchant Center/)
    expect(mutates(m)).toHaveLength(0)
  })
})

describe("review fixes: upgraded targeting, paused criteria, video asset info, portfolio overrides", () => {
  beforeEach(() => {
    __clearTokenCache()
    __resetBuckets()
  })
  afterEach(() => vi.unstubAllGlobals())

  const mutateCalls = (m: ReturnType<typeof mockFetch>) => m.api().filter((c) => c.url.endsWith("googleAds:mutate"))

  function mockAg(o: { source?: Record<string, unknown>; target: Record<string, unknown>; criteria?: Record<string, unknown>[]; agExtra?: Record<string, unknown> }) {
    const s = source()
    const ag = {
      ...s.adGroups[0]!,
      adGroup: { ...(s.adGroups[0]!.adGroup as Record<string, unknown>), ...(o.agExtra ?? {}) },
      campaign: { id: "40", advertisingChannelType: "DEMAND_GEN", ...(o.source ?? {}) },
    }
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE ad_group\.id = 50/), { body: { results: [ag] } })
    m.on(searchMatching(/FROM campaign WHERE campaign\.id = 41/), { body: { results: [{ campaign: { id: "41", status: "PAUSED", advertisingChannelType: "DEMAND_GEN", ...o.target } }] } })
    m.on(searchMatching(/FROM ad_group_criterion WHERE ad_group\.id = 50/), {
      body: { results: o.criteria ?? s.keywords.filter((k) => (k.adGroup as { id: string }).id === "50") },
    })
    m.on(searchMatching(/ad_group\.name LIKE/), { body: { results: [] } })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    return m
  }
  const copyAg = (allowIncomplete = false) =>
    copyObject(providerCtx(saCredentials()), { level: "ad_group", id: "50", deep: false, targetParentId: "41", allowIncomplete }, { dryRun: true })

  it("ad group into another campaign with a different upgraded_targeting mode → refused (both directions), nothing sent", async () => {
    let m = mockAg({ source: { demandGenCampaignSettings: { upgradedTargeting: false } }, target: {} }) // target absent = default true
    let e = await copyAg().catch((x) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).code).toBe("invalid_request")
    expect((e as ProviderError).userMessageVi).toMatch(/cấp chiến dịch, còn chiến dịch đích dùng vị trí\/ngôn ngữ đặt ở cấp nhóm/)
    expect(mutateCalls(m)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = mockAg({ target: { demandGenCampaignSettings: { upgradedTargeting: false } } })
    e = await copyAg().catch((x) => x)
    expect((e as ProviderError).userMessageVi).toMatch(/cấp nhóm quảng cáo, còn chiến dịch đích dùng vị trí\/ngôn ngữ đặt ở cấp chiến dịch/)
    expect(mutateCalls(m)).toHaveLength(0)
    const q = m.api().map(queryOf).find((x) => /FROM campaign WHERE campaign\.id = 41/.test(x))!
    expect(q).toContain("campaign.demand_gen_campaign_settings.upgraded_targeting")
    expect(q).toContain("campaign.bidding_strategy")
  })

  it("same mode (both campaign-level) → allowed", async () => {
    const m = mockAg({ source: { demandGenCampaignSettings: { upgradedTargeting: false } }, target: { demandGenCampaignSettings: { upgradedTargeting: false } } })
    expect((await copyAg()).preview).toBe(true)
    expect(mutateCalls(m)).toHaveLength(1)
  })

  it("upgraded target + copied group without a positive location → fail closed; allowIncomplete → warning", async () => {
    const noLoc = [crit("50", "1040", "LANGUAGE", { language: { languageConstant: "languageConstants/1040" } }), crit("50", "2704", "LOCATION", { negative: true, location: { geoTargetConstant: "geoTargetConstants/2704" } })]
    let m = mockAg({ target: {}, criteria: noLoc })
    const e = await copyAg().catch((x) => x)
    expect((e as ProviderError).userMessageVi).toMatch(/vị trí \(nhóm gốc không có vị trí riêng\)/)
    expect(mutateCalls(m)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = mockAg({ target: {}, criteria: noLoc })
    const res = await copyAg(true)
    expect(res.warnings.join(" ")).toMatch(/allow_incomplete_targeting=true.*vị trí/)
    expect(mutateCalls(m)).toHaveLength(1)
  })

  it("same-campaign copy of a group without location (source state) → warning only; campaign deep copy warns per group", () => {
    const ag = source().adGroups[0]!
    const plan = buildDemandGenAdGroupCopy(CID, "40", ag, [], [], { name: "G", deep: false })
    expect(plan.uncopyable).toEqual([])
    expect(plan.warnings.join(" ")).toMatch(/không có vị trí riêng/)
    const s = source()
    s.keywords = s.keywords.filter((k) => (k.adGroup as { id: string }).id === "50") // group 51 has no location
    const deep = buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: true })
    expect(deep.uncopyable).toEqual([])
    expect(deep.warnings.join(" ")).toMatch(/Nhóm “Hình ảnh” không có vị trí riêng/)
    expect(deep.warnings.join(" ")).not.toMatch(/Nhóm “Video VN” không có vị trí riêng/)
  })

  it("portfolio target campaign: ad group target ROAS override dropped with a warning; CPA/CPC overrides kept", async () => {
    const s = source()
    const ag = { ...s.adGroups[0]!, adGroup: { ...(s.adGroups[0]!.adGroup as Record<string, unknown>), targetRoas: 4, targetCpaMicros: "7000000" } }
    const kept = buildDemandGenAdGroupCopy(CID, "41", ag, s.keywords.slice(0, 1), [], { name: "G", deep: false, portfolio: false })
    expect(create(kept.ops[0]!)).toMatchObject({ targetRoas: 4, targetCpaMicros: "7000000" })
    const plan = buildDemandGenAdGroupCopy(CID, "41", ag, s.keywords.slice(0, 1), [], { name: "G", deep: false, portfolio: true })
    expect(create(plan.ops[0]!)).not.toHaveProperty("targetRoas")
    expect(create(plan.ops[0]!)).toMatchObject({ targetCpaMicros: "7000000", targetCpcMicros: "2500000000" })
    expect(plan.warnings.join(" ")).toMatch(/portfolio/)
    // via copyObject: the target's campaign.bidding_strategy decides
    const m = mockAg({ target: { biddingStrategy: `customers/${CID}/biddingStrategies/9` }, agExtra: { targetRoas: 4 } })
    const res = await copyAg()
    expect(res.warnings.join(" ")).toMatch(/portfolio/)
    const ops = (mutateCalls(m)[0]!.body as { mutateOperations: Record<string, unknown>[] }).mutateOperations
    expect(create(ops[0]!)).not.toHaveProperty("targetRoas")
  })

  it("paused positive campaign criteria stay PAUSED (Demand Gen and Search); ENABLED ones unchanged; query reads the status", () => {
    const s = source()
    s.criteria.push(
      { campaignCriterion: { criterionId: "2704", type: "LOCATION", status: "PAUSED", location: { geoTargetConstant: "geoTargetConstants/2704" } } },
      { campaignCriterion: { criterionId: "2840", type: "LOCATION", status: "ENABLED", location: { geoTargetConstant: "geoTargetConstants/2840" } } },
      { campaignCriterion: { criterionId: "5", type: "KEYWORD", status: "PAUSED", negative: true, keyword: { text: "x", matchType: "BROAD" } } }
    )
    const dg = buildDemandGenCampaignCopy(CID, s, { ...opts, name: "x", deep: false }).ops.filter((o) => kind(o) === "campaignCriterionOperation").map(create)
    expect(dg.find((c) => JSON.stringify(c).includes("2704"))).toMatchObject({ status: "PAUSED" })
    expect(dg.find((c) => JSON.stringify(c).includes("2840"))).not.toHaveProperty("status")
    expect(dg.find((c) => c.keyword)).not.toHaveProperty("status")
    const search: CampaignSource = {
      campaign: {
        campaign: { id: "10", name: "S", advertisingChannelType: "SEARCH", biddingStrategyType: "TARGET_SPEND", containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" },
        campaignBudget: { id: "1", amountMicros: "1000000", period: "DAILY" },
      },
      criteria: s.criteria.slice(1),
      adGroups: [],
      keywords: [],
      ads: [],
    }
    const sc = buildCampaignCopy(CID, search, { ...opts, name: "x", deep: false }).ops.filter((o) => kind(o) === "campaignCriterionOperation").map(create)
    expect(sc.find((c) => JSON.stringify(c).includes("2704"))).toMatchObject({ status: "PAUSED" })
    expect(sc.find((c) => JSON.stringify(c).includes("2840"))).toEqual({ campaign: expect.stringMatching(/campaigns\/-2$/), location: { geoTargetConstant: "geoTargetConstants/2840" } })
  })

  it("video assets keep only the boolean inventory preferences / YouTube-comments control of adVideoAssetInfo", () => {
    const v = JSON.parse(JSON.stringify(VIDEO_AD)) as typeof VIDEO_AD
    ;(v.adGroupAd.ad.demandGenVideoResponsiveAd as Record<string, unknown>).videos = [
      {
        asset: asset(1),
        adVideoAssetInfo: {
          adVideoAssetInventoryPreferences: { inFeedPreference: true, inStreamPreference: false, shortsPreference: "yes", other: true },
          adVideoAssetFeatureControl: { allowYoutubeComments: false, extra: 1 },
          outputOnly: "x",
        },
      },
      { asset: asset(4), adVideoAssetInfo: { adVideoAssetInventoryPreferences: {} } },
    ]
    const ad = create(buildDemandGenAdCopy(CID, "52", v).ops[0]!).ad as { demandGenVideoResponsiveAd: { videos: unknown[] } }
    expect(ad.demandGenVideoResponsiveAd.videos).toEqual([
      {
        asset: asset(1),
        adVideoAssetInfo: { adVideoAssetInventoryPreferences: { inFeedPreference: true, inStreamPreference: false }, adVideoAssetFeatureControl: { allowYoutubeComments: false } },
      },
      { asset: asset(4) },
    ])
  })
})
