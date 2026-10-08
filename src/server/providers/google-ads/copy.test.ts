import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { buildAdCopy, buildCampaignCopy, copyName, copyObject, uniqueName, type CampaignSource } from "./copy"
import { mockFetch, providerCtx, saCredentials, searchMatching, type RecordedCall } from "./__fixtures__/mock-fetch"

const CID = "1234567890"

const source = (): CampaignSource => ({
  campaign: {
    campaign: {
      id: "10",
      name: "Search VN",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      biddingStrategyType: "MAXIMIZE_CONVERSIONS",
      maximizeConversions: { targetCpaMicros: "50000000000" },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true },
      geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" },
      startDateTime: "2026-01-01 00:00:00",
      endDateTime: "2037-12-30 23:59:59",
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    },
    campaignBudget: { id: "77", amountMicros: "500000000000", period: "DAILY", deliveryMethod: "STANDARD", explicitlyShared: true },
  },
  criteria: [
    { campaignCriterion: { criterionId: "2704", type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/2704" } } },
    { campaignCriterion: { criterionId: "1040", type: "LANGUAGE", language: { languageConstant: "languageConstants/1040" } } },
    { campaignCriterion: { criterionId: "5", type: "KEYWORD", negative: true, keyword: { text: "miễn phí", matchType: "BROAD" } } },
    { campaignCriterion: { criterionId: "30001", type: "DEVICE", bidModifier: 1, device: { type: "DESKTOP" } } },
  ],
  adGroups: [
    { campaign: { id: "10" }, adGroup: { id: "20", name: "Giày nam", status: "ENABLED", type: "SEARCH_STANDARD", cpcBidMicros: "8000000000" } },
    { campaign: { id: "10" }, adGroup: { id: "21", name: "Giày nữ", status: "PAUSED", type: "SEARCH_STANDARD" } },
  ],
  keywords: [
    { adGroup: { id: "20" }, adGroupCriterion: { criterionId: "100", type: "KEYWORD", status: "ENABLED", keyword: { text: "giày chạy bộ", matchType: "PHRASE" }, cpcBidMicros: "9000000000" } },
    { adGroup: { id: "20" }, adGroupCriterion: { criterionId: "101", type: "KEYWORD", negative: true, keyword: { text: "cũ", matchType: "BROAD" } } },
    { adGroup: { id: "21" }, adGroupCriterion: { criterionId: "102", type: "KEYWORD", status: "PAUSED", keyword: { text: "giày nữ", matchType: "EXACT" } } },
  ],
  ads: [
    {
      adGroup: { id: "20" },
      adGroupAd: {
        status: "ENABLED",
        ad: {
          id: "500",
          type: "RESPONSIVE_SEARCH_AD",
          finalUrls: ["https://shop.vn/giay"],
          responsiveSearchAd: {
            headlines: [
              { text: "Giày chạy bộ", pinnedField: "HEADLINE_1", assetPerformanceLabel: "GOOD", policySummaryInfo: { approvalStatus: "APPROVED" } },
              { text: "Giảm 30%" },
              { text: "Giao nhanh" },
            ],
            descriptions: [{ text: "Mô tả 1" }, { text: "Mô tả 2" }],
            path1: "giay",
          },
        },
      },
    },
    { adGroup: { id: "21" }, adGroupAd: { status: "ENABLED", ad: { id: "501", type: "EXPANDED_TEXT_AD" } } },
  ],
})

type Op = Record<string, { create: Record<string, unknown> }>
const kind = (op: Record<string, unknown>) => Object.keys(op)[0]!
const create = (op: Record<string, unknown>) => (op as Op)[kind(op)]!.create

/** Every temp id is declared (resourceName) before it is referenced, and declared once. */
function assertTempIdOrder(ops: Record<string, unknown>[]) {
  const declared = new Set<string>()
  const refs = (c: Record<string, unknown>) => [c.campaignBudget, c.campaign, c.adGroup].filter((x): x is string => typeof x === "string")
  for (const op of ops) {
    const c = create(op)
    for (const r of refs(c)) if (/\/-\d+$/.test(r)) expect(declared.has(r), `${r} referenced before declaration`).toBe(true)
    if (typeof c.resourceName === "string") {
      expect(c.resourceName).toMatch(/\/-\d+$/)
      expect(declared.has(c.resourceName)).toBe(false)
      declared.add(c.resourceName)
    }
  }
  const ids = [...declared].map((r) => Number(r.split("/").pop()))
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids.every((n) => n < 0)).toBe(true)
}

describe("buildCampaignCopy", () => {
  it("builds one temp-id ordered mutate: budget → campaign → criteria → ad group → keywords → ads", () => {
    const plan = buildCampaignCopy(CID, source(), { name: "Search VN (bản sao)", today: "2026-10-02", deep: true, budgetSuffix: "t" })
    // LANGUAGE criterion skipped (warning, not incomplete targeting): Search no longer accepts manual languages
    expect(plan.ops.map(kind)).toEqual([
      "campaignBudgetOperation",
      "campaignOperation",
      "campaignCriterionOperation",
      "campaignCriterionOperation",
      "adGroupOperation",
      "adGroupCriterionOperation",
      "adGroupCriterionOperation",
      "adGroupAdOperation",
      "adGroupOperation",
      "adGroupCriterionOperation",
    ])
    assertTempIdOrder(plan.ops)
    expect(JSON.stringify(plan.ops)).not.toContain("languageConstant")
    expect(plan.warnings.join(" ")).toMatch(/1 tiêu chí ngôn ngữ/)
    expect(plan.uncopyable).toEqual([])
  })

  it("creates a PAUSED campaign with EU declaration, non-shared budget and a start date not in the past", () => {
    const plan = buildCampaignCopy(CID, source(), { name: "Copy", today: "2026-10-02", deep: false, budgetSuffix: "t" })
    const budget = create(plan.ops[0]!)
    expect(budget).toMatchObject({ explicitlyShared: false, amountMicros: "500000000000", deliveryMethod: "STANDARD" })
    expect(budget).not.toHaveProperty("id")
    const camp = create(plan.ops[1]!)
    expect(camp).toMatchObject({
      name: "Copy",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      campaignBudget: budget.resourceName,
      maximizeConversions: { targetCpaMicros: "50000000000" },
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      startDateTime: "2026-10-02 00:00:00",
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    })
    expect(camp).not.toHaveProperty("endDateTime") // 2037-12-30 sentinel = open ended
    expect(camp).not.toHaveProperty("id")
    expect(plan.ops.map(kind)).not.toContain("adGroupOperation")
    expect(plan.warnings.join(" ")).toMatch(/ngân sách chung/)
  })

  it("fails closed on targeting it cannot copy (USER_LIST, PROXIMITY, ad-group AUDIENCE) unless allowIncomplete", () => {
    const s = source()
    s.criteria.push({ campaignCriterion: { criterionId: "6", type: "USER_LIST" } }, { campaignCriterion: { criterionId: "7", type: "PROXIMITY" } })
    s.keywords.push({ adGroup: { id: "21" }, adGroupCriterion: { criterionId: "103", type: "AUDIENCE" } })
    let err: unknown
    try {
      buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe("invalid_request")
    const msg = (err as ProviderError).userMessageVi
    expect(msg).toMatch(/USER_LIST/)
    expect(msg).toMatch(/PROXIMITY/)
    expect(msg).toMatch(/AUDIENCE/)
    const plan = buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: true, allowIncomplete: true })
    expect(plan.warnings.join(" ")).toMatch(/allow_incomplete_targeting=true.*USER_LIST/)
  })

  it("copies DEVICE bid modifiers, including 0 (= device excluded); 1.0 / absent create nothing", () => {
    const s = source()
    s.criteria.push(
      { campaignCriterion: { criterionId: "30000", type: "DEVICE", bidModifier: 0, device: { type: "MOBILE" } } },
      { campaignCriterion: { criterionId: "30002", type: "DEVICE", bidModifier: 1.2, device: { type: "TABLET" } } },
      { campaignCriterion: { criterionId: "30004", type: "DEVICE", device: { type: "CONNECTED_TV" } } }
    )
    const plan = buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: false })
    const devices = plan.ops.map(create).filter((c) => c.device)
    expect(devices).toEqual([
      { campaign: expect.stringMatching(/campaigns\/-\d+$/), device: { type: "MOBILE" }, bidModifier: 0 },
      { campaign: expect.stringMatching(/campaigns\/-\d+$/), device: { type: "TABLET" }, bidModifier: 1.2 },
    ])
  })

  it("links ENABLED shared sets (negative keyword lists) to the copy", () => {
    const s = source()
    s.sharedSets = [
      { campaignSharedSet: { sharedSet: `customers/${CID}/sharedSets/55`, status: "ENABLED" }, sharedSet: { id: "55", type: "NEGATIVE_KEYWORDS", status: "ENABLED" } },
      { campaignSharedSet: { sharedSet: `customers/${CID}/sharedSets/56`, status: "ENABLED" }, sharedSet: { id: "56", type: "NEGATIVE_KEYWORDS", status: "REMOVED" } },
    ]
    const plan = buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: false })
    const links = plan.ops.filter((o) => kind(o) === "campaignSharedSetOperation").map(create)
    expect(links).toEqual([{ campaign: create(plan.ops[1]!).resourceName, sharedSet: `customers/${CID}/sharedSets/55` }])
    assertTempIdOrder(plan.ops)
  })

  it("refuses to auto-declare EU political advertising when the source has no declaration", () => {
    const s = source()
    delete (s.campaign.campaign as Record<string, unknown>).containsEuPoliticalAdvertising
    try {
      buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: false })
      throw new Error("should throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).hint).toMatch(/google_ads_declare_eu_political/)
    }
  })

  it("keeps the source EU declaration when present", () => {
    const s = source()
    ;(s.campaign.campaign as Record<string, unknown>).containsEuPoliticalAdvertising = "CONTAINS_EU_POLITICAL_ADVERTISING"
    const camp = create(buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: false }).ops[1]!)
    expect(camp.containsEuPoliticalAdvertising).toBe("CONTAINS_EU_POLITICAL_ADVERTISING")
  })

  it("strips output-only fields from RSA assets, keeps pins and skips non-RSA ads", () => {
    const plan = buildCampaignCopy(CID, source(), { name: "x", today: "2026-10-02", deep: true })
    const ad = create(plan.ops.find((o) => kind(o) === "adGroupAdOperation")!)
    expect(ad.status).toBe("ENABLED")
    expect(ad.ad).toEqual({
      finalUrls: ["https://shop.vn/giay"],
      responsiveSearchAd: {
        headlines: [{ text: "Giày chạy bộ", pinnedField: "HEADLINE_1" }, { text: "Giảm 30%" }, { text: "Giao nhanh" }],
        descriptions: [{ text: "Mô tả 1" }, { text: "Mô tả 2" }],
        path1: "giay",
      },
    })
    const negKw = plan.ops.map(create).find((c) => c.negative === true && c.adGroup)
    expect(negKw).toEqual({ adGroup: expect.stringMatching(/adGroups\/-\d+$/), negative: true, keyword: { text: "cũ", matchType: "BROAD" } })
    const w = plan.warnings.join(" ")
    expect(w).toMatch(/EXPANDED_TEXT_AD/)
  })

  it("rejects Performance Max with a Vietnamese unsupported error", () => {
    const s = source()
    ;(s.campaign.campaign as Record<string, unknown>).advertisingChannelType = "PERFORMANCE_MAX"
    try {
      buildCampaignCopy(CID, s, { name: "x", today: "2026-10-02", deep: true })
      throw new Error("should throw")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("unsupported")
      expect((e as ProviderError).userMessageVi).toContain("Performance Max")
    }
  })

  it("ad copies are new PAUSED ads (no ad sharing)", () => {
    const plan = buildAdCopy(CID, "99", source().ads[0]!)
    const c = create(plan.ops[0]!)
    expect(c.adGroup).toBe(`customers/${CID}/adGroups/99`)
    expect(c.status).toBe("PAUSED")
    expect((c.ad as Record<string, unknown>).resourceName).toBeUndefined()
    expect(() => buildAdCopy(CID, "99", source().ads[1]!)).toThrow(ProviderError)
  })
})

describe("names", () => {
  it("applies prefix/suffix (default suffix) and avoids duplicates", () => {
    expect(copyName("A")).toBe("A (bản sao)")
    expect(copyName("A", "[Test] ", "")).toBe("[Test] A")
    expect(uniqueName("A (bản sao)", new Set(["A (bản sao)", "A (bản sao) 2"]))).toBe("A (bản sao) 3")
  })
})

describe("copyObject (campaign, deep)", () => {
  beforeEach(() => {
    __clearTokenCache()
    __resetBuckets()
  })
  afterEach(() => vi.unstubAllGlobals())

  function mockTree() {
    const s = source()
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id = 10/), { body: { results: [s.campaign] } })
    m.on(searchMatching(/FROM campaign_criterion/), { body: { results: s.criteria } })
    m.on(searchMatching(/FROM ad_group WHERE/), { body: { results: s.adGroups } })
    m.on(searchMatching(/FROM ad_group_ad WHERE/), { body: { results: s.ads } })
    m.on(searchMatching(/FROM ad_group_criterion WHERE/), { body: { results: s.keywords } })
    m.on(searchMatching(/campaign\.name LIKE/), { body: { results: [{ campaign: { name: "Search VN (bản sao)" } }] } })
    m.on(searchMatching(/FROM campaign_shared_set/), { body: { results: [] } })
    m.on(searchMatching(/FROM conversion_goal_campaign_config/), { body: { results: [{ conversionGoalCampaignConfig: { goalConfigLevel: "CAMPAIGN" } }] } })
    return m
  }

  it("stops (no mutate) when a source read is truncated", async () => {
    const m = mockFetch()
    const s = source()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id = 10/), { body: { results: [s.campaign] } })
    const many = Array.from({ length: 5_000 }, () => s.criteria[0]!)
    m.on(searchMatching(/FROM campaign_criterion/), { body: { results: many, nextPageToken: "more" } })
    const err = await copyObject(providerCtx(saCredentials()), { level: "campaign", id: "10", deep: false }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe("invalid_request")
    expect(m.api().some((c) => c.url.endsWith("googleAds:mutate"))).toBe(false)
  })

  it("warns when the source uses campaign-specific conversion goals", async () => {
    const m = mockTree()
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    const res = await copyObject(providerCtx(saCredentials()), { level: "campaign", id: "10", deep: true }, { dryRun: true })
    expect(res.warnings.join(" ")).toMatch(/mục tiêu chuyển đổi riêng cấp chiến dịch/)
  })

  it("dryRun validates the single atomic mutate with validateOnly", async () => {
    const m = mockTree()
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    const res = await copyObject(providerCtx(saCredentials()), { level: "campaign", id: "10", deep: true }, { dryRun: true })
    const calls = m.api().filter((c) => c.url.endsWith("googleAds:mutate"))
    expect(calls).toHaveLength(1)
    const body = calls[0]!.body as { validateOnly?: boolean; partialFailure?: boolean; mutateOperations: Record<string, unknown>[] }
    expect(body.validateOnly).toBe(true)
    expect(body.partialFailure).toBeUndefined()
    expect(create(body.mutateOperations[1]!).name).toBe("Search VN (bản sao) 2")
    expect(res.preview).toBe(true)
    expect(res.mode).toBe("emulated")
    expect(res.mappings.every((x) => x.newId === null)).toBe(true)
  })

  it("maps source ids to the new ids from the response", async () => {
    const m = mockTree()
    m.on(
      (c) => c.url.endsWith("googleAds:mutate"),
      (call: RecordedCall) => {
        const ops = (call.body as { mutateOperations: Record<string, unknown>[] }).mutateOperations
        const agMap = new Map<string, string>()
        let n = 900
        const results = ops.map((op) => {
          const k = kind(op)
          const c = create(op)
          n++
          if (k === "campaignBudgetOperation") return { campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/${n}` } }
          if (k === "campaignOperation") return { campaignResult: { resourceName: `customers/${CID}/campaigns/${n}` } }
          if (k === "campaignCriterionOperation") return { campaignCriterionResult: { resourceName: `customers/${CID}/campaignCriteria/${n}~1` } }
          if (k === "adGroupOperation") {
            agMap.set(c.resourceName as string, String(n))
            return { adGroupResult: { resourceName: `customers/${CID}/adGroups/${n}` } }
          }
          const ag = agMap.get(c.adGroup as string)
          if (k === "adGroupAdOperation") return { adGroupAdResult: { resourceName: `customers/${CID}/adGroupAds/${ag}~${n}` } }
          return { adGroupCriterionResult: { resourceName: `customers/${CID}/adGroupCriteria/${ag}~${n}` } }
        })
        return { body: { mutateOperationResponses: results } }
      }
    )
    const res = await copyObject(providerCtx(saCredentials()), { level: "campaign", id: "10", deep: true })
    expect(res.preview).toBe(false)
    expect(res.rootNewId).toBe("902")
    expect(res.mappings).toEqual([
      { level: "campaign", sourceId: "10", newId: "902" },
      { level: "ad_group", sourceId: "20", newId: "905" },
      { level: "keyword", sourceId: "20~100", newId: "905~906" },
      { level: "keyword", sourceId: "20~101", newId: "905~907" },
      { level: "ad", sourceId: "20~500", newId: "905~908" },
      { level: "ad_group", sourceId: "21", newId: "909" },
      { level: "keyword", sourceId: "21~102", newId: "909~910" },
    ])
  })
})
