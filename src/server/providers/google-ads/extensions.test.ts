import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { assertSelectOnly, buildSearchCampaignOps, createRsaInput, createSearchCampaignInput, googleAdsExtensions, type CreateSearchCampaignInput } from "./extensions"
import { mockFetch, providerCtx, saCredentials, searchMatching, viMessage } from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const ext = (name: string) => googleAdsExtensions.find((e) => e.name === name)!

const rsa = {
  final_url: "https://shop.vn/giay",
  headlines: ["Giày chạy bộ chính hãng", "Giảm 30% hôm nay", "Giao hàng 2 giờ"],
  descriptions: ["Mua giày chạy bộ chính hãng, đổi trả 30 ngày.", "Freeship toàn quốc cho đơn từ 500K."],
}

const validInput = (): CreateSearchCampaignInput =>
  createSearchCampaignInput.parse({
    name: "Search giày Q4",
    daily_budget: 500_000,
    bidding_strategy: "maximize_conversions",
    target_cpa: 80_000,
    location_ids: ["2704"],
    negative_keywords: [{ text: "miễn phí", match_type: "BROAD" }],
    ad_groups: [{ name: "Giày nam", keywords: [{ text: "giày chạy bộ nam" }], ads: [rsa] }],
  })

describe("google_ads_run_gaql validation", () => {
  it("accepts SELECT (case-insensitive, leading comments ignored)", () => {
    expect(assertSelectOnly("  select campaign.id from campaign")).toBe("select campaign.id from campaign")
    expect(assertSelectOnly("/* report */ -- note\nSELECT campaign.name FROM campaign WHERE campaign.name LIKE '%a -- b; c%'")).toContain("'%a -- b; c%'")
  })

  it("rejects anything that is not a single SELECT", () => {
    expect(viMessage(() => assertSelectOnly("DELETE FROM campaign"))).toMatch(/SELECT/)
    expect(() => assertSelectOnly("/* SELECT */ UPDATE campaign SET x = 1")).toThrow()
    expect(() => assertSelectOnly("-- SELECT\nmutate campaigns")).toThrow()
    expect(() => assertSelectOnly("SELECT campaign.id FROM campaign; SELECT 1")).toThrow()
    expect(() => assertSelectOnly("SELECTcampaign.id FROM campaign")).toThrow()
    expect(() => assertSelectOnly("SELECT campaign.id")).toThrow()
  })

  it("rejects account-hierarchy and user resources (no enumeration outside the grant)", () => {
    for (const q of [
      "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client",
      "SELECT customer_manager_link.manager_customer FROM customer_manager_link",
      "select customer_client_link.client_customer from customer_client_link",
      "SELECT customer_user_access.email_address FROM customer_user_access",
    ]) {
      expect(viMessage(() => assertSelectOnly(q)), q).toMatch(/không cho truy vấn/)
    }
    // a literal mentioning the resource is fine
    expect(assertSelectOnly("SELECT campaign.id FROM campaign WHERE campaign.name = 'customer_client'")).toContain("FROM campaign")
  })

  it("refuses to run on manager (MCC) accounts", async () => {
    const tool = ext("google_ads_run_gaql")
    const input = tool.input.parse({ query: "SELECT campaign.id FROM campaign" })
    // known from connection meta: no upstream call at all
    const m1 = mockFetch()
    await expect(tool.run(providerCtx(saCredentials(), { connectionMeta: { manager_ids: ["1234567890"] } }), input, {})).rejects.toMatchObject({ code: "invalid_request" })
    expect(m1.api()).toHaveLength(0)
    vi.unstubAllGlobals()
    // detected live (customer.manager = true): the user query is never sent
    const m2 = mockFetch()
    m2.on(searchMatching(/FROM customer\b/), { body: { results: [{ customer: { id: "1234567890", manager: true } }] } })
    await expect(tool.run(providerCtx(saCredentials()), input, {})).rejects.toMatchObject({ code: "invalid_request" })
    expect(m2.api().filter(searchMatching(/FROM campaign/))).toHaveLength(0)
  })

  it("caps rows per call and returns a cursor", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM customer\b/), { body: { results: [{ customer: { id: "1234567890", manager: false } }] } })
    m.on(searchMatching(/FROM campaign/), { body: { results: Array.from({ length: 5 }, (_, i) => ({ campaign: { id: String(i) } })), fieldMask: "campaign.id" } })
    const tool = ext("google_ads_run_gaql")
    expect(tool.permission).toBe("read")
    expect(tool.write).toBe(false)
    const out = (await tool.run(providerCtx(saCredentials()), tool.input.parse({ query: "SELECT campaign.id FROM campaign", max_rows: 2 }), {})) as {
      rows: unknown[]
      next_cursor: string | null
    }
    expect(out.rows).toHaveLength(2)
    expect(out.next_cursor).toBeTruthy()
  })

  it("never sends a non-SELECT query upstream", async () => {
    const m = mockFetch()
    const tool = ext("google_ads_run_gaql")
    await expect(tool.run(providerCtx(saCredentials()), tool.input.parse({ query: "REMOVE campaigns/1 now" }), {})).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.api()).toHaveLength(0)
  })
})

describe("google_ads_create_search_campaign", () => {
  it("validates RSA lengths and counts with zod", () => {
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa }).success).toBe(true)
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa, headlines: ["a", "b"] }).success).toBe(false)
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa, headlines: ["x".repeat(31), "b", "c"] }).success).toBe(false)
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa, descriptions: ["only one"] }).success).toBe(false)
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa, descriptions: ["d".repeat(91), "ok"] }).success).toBe(false)
    expect(createRsaInput.safeParse({ ad_group_id: "1", ...rsa, path2: "x" }).success).toBe(false)
    expect(createRsaInput.safeParse({ ad_group_id: "abc", ...rsa }).success).toBe(false)
  })

  it("requires cpc_bid for manual_cpc", () => {
    const r = createSearchCampaignInput.safeParse({ ...validInput(), bidding_strategy: "manual_cpc", target_cpa: undefined })
    expect(r.success).toBe(false)
  })

  it("builds one atomic mutate: budget → PAUSED campaign with EU declaration → criteria → ad group → RSA → keywords", () => {
    const plan = buildSearchCampaignOps("1234567890", validInput(), { currency: "VND", today: "2026-10-02", budgetSuffix: "t" })
    expect(plan.ops.map((o) => Object.keys(o)[0])).toEqual([
      "campaignBudgetOperation",
      "campaignOperation",
      "campaignCriterionOperation",
      "campaignCriterionOperation",
      "adGroupOperation",
      "adGroupAdOperation",
      "adGroupCriterionOperation",
    ])
    const budget = (plan.ops[0] as { campaignBudgetOperation: { create: Record<string, unknown> } }).campaignBudgetOperation.create
    expect(budget).toMatchObject({ resourceName: "customers/1234567890/campaignBudgets/-1", amountMicros: "500000000000", explicitlyShared: false })
    const camp = (plan.ops[1] as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create
    expect(camp).toMatchObject({
      resourceName: "customers/1234567890/campaigns/-2",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      campaignBudget: "customers/1234567890/campaignBudgets/-1",
      maximizeConversions: { targetCpaMicros: "80000000000" },
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      startDateTime: "2026-10-02 00:00:00",
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    })
    const crit = plan.ops.slice(2, 4).map((o) => (o as { campaignCriterionOperation: { create: Record<string, unknown> } }).campaignCriterionOperation.create)
    // no language criterion: manual language targeting on Search is rejected since 2026-09-30
    expect(crit).toEqual([
      { campaign: "customers/1234567890/campaigns/-2", location: { geoTargetConstant: "geoTargetConstants/2704" } },
      { campaign: "customers/1234567890/campaigns/-2", negative: true, keyword: { text: "miễn phí", matchType: "BROAD" } },
    ])
    expect(JSON.stringify(plan.ops)).not.toContain("languageConstant")
    const ad = (plan.ops[5] as { adGroupAdOperation: { create: Record<string, unknown> } }).adGroupAdOperation.create
    expect(ad.adGroup).toBe("customers/1234567890/adGroups/-3")
    expect((ad.ad as { responsiveSearchAd: { headlines: unknown[] } }).responsiveSearchAd.headlines).toHaveLength(3)
  })

  it("every campaign create carries contains_eu_political_advertising", () => {
    for (const eu of [true, false]) {
      const plan = buildSearchCampaignOps("1234567890", { ...validInput(), contains_eu_political_advertising: eu }, { currency: "VND", today: "2026-10-02" })
      const camps = plan.ops.filter((o) => "campaignOperation" in o)
      expect(camps).toHaveLength(1)
      for (const c of camps) expect((c as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create.containsEuPoliticalAdvertising).toMatch(/EU_POLITICAL_ADVERTISING$/)
    }
  })

  it("rejects a start date in the past", () => {
    expect(() => buildSearchCampaignOps("1234567890", { ...validInput(), start_date: "2026-09-01" }, { currency: "VND", today: "2026-10-02" })).toThrow()
  })

  it("dryRun sends validateOnly and returns a preview", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-02T03:00:00Z") })
    const m = mockFetch()
    m.on(searchMatching(/campaign\.name = /), { body: { results: [] } })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: {} })
    const tool = ext("google_ads_create_search_campaign")
    const out = (await tool.run(providerCtx(saCredentials()), validInput(), { dryRun: true })) as { preview: boolean }
    expect(out.preview).toBe(true)
    const body = m.api().find((c) => c.url.endsWith("googleAds:mutate"))!.body as { validateOnly: boolean }
    expect(body.validateOnly).toBe(true)
  })

  it("refuses a duplicate campaign name", async () => {
    const m = mockFetch()
    m.on(searchMatching(/campaign\.name = 'Search giày Q4'/), { body: { results: [{ campaign: { id: "55" } }] } })
    await expect(ext("google_ads_create_search_campaign").run(providerCtx(saCredentials()), validInput(), {})).rejects.toMatchObject({ code: "conflict" })
  })
})

describe("google_ads_declare_eu_political", () => {
  it("updates only campaigns missing the declaration with an exact mask", async () => {
    const m = mockFetch()
    m.on(searchMatching(/missing_eu_political_advertising_declaration = TRUE/), {
      body: { results: [{ campaign: { id: "1", name: "A" } }, { campaign: { id: "2", name: "B", containsEuPoliticalAdvertising: "UNSPECIFIED" } }] },
    })
    m.on((c) => c.url.endsWith("campaigns:mutate"), { body: { results: [{}, {}] } })
    const tool = ext("google_ads_declare_eu_political")
    expect(tool.permission).toBe("update")
    expect(tool.input.safeParse({}).success).toBe(false) // no default: the user must choose
    const res = (await tool.run(providerCtx(saCredentials()), tool.input.parse({ contains_eu_political_advertising: false }), {})) as {
      changes: { objectId: string; after: string }[]
    }
    const body = m.api().find((c) => c.url.endsWith("campaigns:mutate"))!.body as { operations: unknown[]; partialFailure: boolean }
    expect(body.partialFailure).toBe(true)
    expect(body.operations[0]).toEqual({
      update: { resourceName: "customers/1234567890/campaigns/1", containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" },
      updateMask: "contains_eu_political_advertising",
    })
    expect(res.changes.map((c) => c.objectId)).toEqual(["1", "2"])
  })
})

describe("google_ads_create_rsa - unknown outcome", () => {
  it("5xx → finds the RSA by headline set in the ad group and does not create it again", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE/), { body: { results: [{ adGroup: { id: "22", name: "AG", status: "ENABLED", type: "SEARCH_STANDARD" }, campaign: { id: "1" } }] } })
    m.on((c) => c.url.endsWith("adGroupAds:mutate"), { status: 502, body: { error: { code: 502, status: "UNAVAILABLE", message: "x" } } })
    m.on(searchMatching(/FROM ad_group_ad WHERE/), {
      body: {
        results: [
          { adGroupAd: { ad: { id: "900", finalUrls: [rsa.final_url], responsiveSearchAd: { headlines: [{ text: "Khác" }, { text: "B" }, { text: "C" }] } } } },
          { adGroupAd: { ad: { id: "901", finalUrls: [rsa.final_url], responsiveSearchAd: { headlines: [...rsa.headlines].reverse().map((text) => ({ text })) } } } },
        ],
      },
    })
    const tool = ext("google_ads_create_rsa")
    const res = (await tool.run(providerCtx(saCredentials()), createRsaInput.parse({ ad_group_id: "22", ...rsa }), {})) as { createdIds: string[]; warnings: string[] }
    expect(res.createdIds).toEqual(["901"])
    expect(res.warnings.join(" ")).toMatch(/không tạo lại/)
    expect(m.api().filter((c) => c.url.endsWith("adGroupAds:mutate"))).toHaveLength(1)
  })
})

describe("google_ads_add_keywords", () => {
  it("creates positive keywords PAUSED and negatives without status", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE/), { body: { results: [{ adGroup: { id: "22", name: "AG", status: "ENABLED", type: "SEARCH_STANDARD" }, campaign: { id: "1" } }] } })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), { body: { results: [{ resourceName: "customers/1234567890/adGroupCriteria/22~1" }, { resourceName: "customers/1234567890/adGroupCriteria/22~2" }] } })
    const tool = ext("google_ads_add_keywords")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ ad_group_id: "22", keywords: [{ text: "giày", match_type: "EXACT", cpc_bid: 5000 }, { text: "cũ", negative: true }] }),
      {}
    )) as { createdIds: string[] }
    const body = m.api().find((c) => c.url.endsWith("adGroupCriteria:mutate"))!.body as { operations: { create: Record<string, unknown> }[] }
    expect(body.operations[0]!.create).toEqual({
      adGroup: "customers/1234567890/adGroups/22",
      keyword: { text: "giày", matchType: "EXACT" },
      status: "PAUSED",
      cpcBidMicros: "5000000000",
    })
    expect(body.operations[1]!.create).toEqual({ adGroup: "customers/1234567890/adGroups/22", keyword: { text: "cũ", matchType: "PHRASE" }, negative: true })
    expect(res.createdIds).toEqual(["22~1", "22~2"])
  })

  it("5xx on create → reports keywords that now exist instead of failing (no retry)", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE/), { body: { results: [{ adGroup: { id: "22", name: "AG", status: "ENABLED", type: "SEARCH_STANDARD" }, campaign: { id: "1" } }] } })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), { status: 500, body: { error: { code: 500, status: "INTERNAL", message: "x" } } })
    m.on(searchMatching(/FROM ad_group_criterion WHERE/), {
      body: { results: [{ adGroupCriterion: { criterionId: "7", negative: false, keyword: { text: "giày", matchType: "EXACT" } } }] },
    })
    const tool = ext("google_ads_add_keywords")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ ad_group_id: "22", keywords: [{ text: "giày", match_type: "EXACT" }, { text: "dép", match_type: "EXACT" }] }),
      {}
    )) as { createdIds: string[]; warnings: string[] }
    expect(res.createdIds).toEqual(["22~7"])
    expect(res.warnings.join(" ")).toMatch(/Chưa thấy: dép/)
    expect(m.api().filter((c) => c.url.endsWith("adGroupCriteria:mutate"))).toHaveLength(1)
  })

  it("5xx on create and nothing found → non-retryable error with verify hint", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM ad_group WHERE/), { body: { results: [{ adGroup: { id: "22", name: "AG", status: "ENABLED", type: "SEARCH_STANDARD" }, campaign: { id: "1" } }] } })
    m.on((c) => c.url.endsWith("adGroupCriteria:mutate"), { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "x" } } })
    m.on(searchMatching(/FROM ad_group_criterion WHERE/), { body: { results: [] } })
    const tool = ext("google_ads_add_keywords")
    const err = await tool
      .run(providerCtx(saCredentials()), tool.input.parse({ ad_group_id: "22", keywords: [{ text: "giày" }] }), {})
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ retryable: false, hint: expect.stringMatching(/kiểm tra trước khi thử lại/) })
  })

  it("campaign-level input only accepts negatives", () => {
    const tool = ext("google_ads_add_keywords")
    expect(tool.input.safeParse({ campaign_id: "1", keywords: [{ text: "x" }] }).success).toBe(false)
    expect(tool.input.safeParse({ campaign_id: "1", keywords: [{ text: "x", negative: true }] }).success).toBe(true)
  })
})

describe("extension metadata", () => {
  it("uses google_ads_ prefix, ≤40 chars, Vietnamese 'Dùng khi' descriptions", () => {
    for (const e of googleAdsExtensions) {
      expect(e.name).toMatch(/^google_ads_[a-z0-9_]+$/)
      expect(e.name.length).toBeLessThanOrEqual(40)
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
    }
  })
})
