import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { MONEY_KEY } from "../../mcp/guardrails"
import { __resetBuckets } from "../rate-limit"
import {
  assetLinkResourceName,
  canonicalSnippetHeader,
  createAssetsInput,
  displayMoneyMicros,
  googleAdsAssetExtensions,
  linkAssetsInput,
  percentToMicros,
  phoneDigits,
  planAssets,
  textWidth,
} from "./assets"
import { __clearTokenCache } from "./auth"
import {
  __resetBillableUnits,
  billableUnitMicros,
  primeBillableUnit,
} from "./units"
import {
  mockFetch,
  providerCtx,
  saCredentials,
  searchMatching,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
  __resetBillableUnits()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ext = (name: string) =>
  googleAdsAssetExtensions.find((e) => e.name === name)!
const isMutate = (c: RecordedCall) => c.url.endsWith("/googleAds:mutate")
const mutateBody = (c: RecordedCall) =>
  c.body as { mutateOperations: Record<string, any>[]; validateOnly?: boolean }

const CAMPAIGN = {
  campaign: {
    id: "111",
    name: "Search tóc",
    status: "ENABLED",
    advertisingChannelType: "SEARCH",
  },
}
const callout = (id: string, text: string, source = "ADVERTISER") => ({
  asset: { id, type: "CALLOUT", source, calloutAsset: { calloutText: text } },
})

describe("asset text rules", () => {
  it("counts NFC code points (Vietnamese diacritics = 1) and CJK / full-width = 2", () => {
    expect(textWidth("Miễn phí gội đầu")).toBe(16)
    // decomposed input (NFD) counts the same as composed
    expect(textWidth("Miễn phí gội đầu".normalize("NFD"))).toBe(16)
    expect(textWidth("優惠")).toBe(4)
    expect(textWidth("ＡＢ")).toBe(4)
    expect(textWidth("한국")).toBe(4)
  })

  it("callout ≤25 width; decomposed Vietnamese of 25 letters passes, 13 CJK chars (26) fail", () => {
    const ok = (text: string) =>
      createAssetsInput.safeParse({ callouts: [{ text }] }).success
    const vi25 = "Giảm giá đặc biệt hôm nay" // 25 code points
    expect(textWidth(vi25)).toBe(25)
    expect(ok(vi25)).toBe(true)
    expect(ok(vi25.normalize("NFD"))).toBe(true)
    expect(ok(`${vi25}!`)).toBe(false)
    expect(ok("優".repeat(12))).toBe(true)
    expect(ok("優".repeat(13))).toBe(false)
    expect(ok("   ")).toBe(false)
  })

  it("rejects invisible / control characters and newlines", () => {
    const ok = (text: string) =>
      createAssetsInput.safeParse({ callouts: [{ text }] }).success
    expect(ok(`Miễn${String.fromCodePoint(0x200b)}phí`)).toBe(false)
    expect(ok(`abc${String.fromCodePoint(0x202e)}def`)).toBe(false)
    expect(ok("dòng 1\ndòng 2")).toBe(false)
    expect(ok("a\u0007b")).toBe(false)
  })

  it("sitelink: description1/2 both or neither, https URL", () => {
    const base = { link_text: "Bảng giá", final_url: "https://salon.vn/gia" }
    const ok = (s: Record<string, unknown>) =>
      createAssetsInput.safeParse({ sitelinks: [s] }).success
    expect(ok(base)).toBe(true)
    expect(
      ok({
        ...base,
        description1: "Giá niêm yết",
        description2: "Cập nhật 2026",
      })
    ).toBe(true)
    expect(ok({ ...base, description1: "Giá niêm yết" })).toBe(false)
    expect(ok({ ...base, description2: "Cập nhật" })).toBe(false)
    expect(
      ok({ ...base, description1: "d".repeat(36), description2: "x" })
    ).toBe(false)
    expect(ok({ ...base, final_url: "http://salon.vn" })).toBe(false)
    expect(ok({ ...base, final_url: "salon.vn" })).toBe(false)
    expect(ok({ ...base, link_text: "x".repeat(26) })).toBe(false)
  })

  it("structured snippet: Vietnamese and English headers (case-insensitive), 3–10 values", () => {
    expect(canonicalSnippetHeader("dịch vụ")).toBe("Dịch vụ")
    expect(canonicalSnippetHeader("Dịch vụ".normalize("NFD"))).toBe("Dịch vụ")
    // "Service catalog" is the canonical English value sent (UNVERIFIED live), "Services" an alias
    expect(canonicalSnippetHeader("SERVICES")).toBe("Service catalog")
    expect(canonicalSnippetHeader("service catalog")).toBe("Service catalog")
    expect(canonicalSnippetHeader("Khoá học")).toBe("Khóa học")
    expect(canonicalSnippetHeader("Featured Hotels")).toBe("Featured hotels")
    expect(canonicalSnippetHeader("Sản phẩm")).toBeNull()
    const ok = (s: Record<string, unknown>) =>
      createAssetsInput.safeParse({ structured_snippets: [s] }).success
    expect(ok({ header: "dịch vụ", values: ["Cắt tóc", "Uốn", "Nhuộm"] })).toBe(
      true
    )
    expect(ok({ header: "Brands", values: ["A", "B", "C"] })).toBe(true)
    expect(ok({ header: "Sản phẩm", values: ["A", "B", "C"] })).toBe(false)
    expect(ok({ header: "Loại", values: ["A", "B"] })).toBe(false)
    expect(
      ok({
        header: "Loại",
        values: Array.from({ length: 11 }, (_, i) => `v${i}`),
      })
    ).toBe(false)
    const plan = planAssets(
      createAssetsInput.parse({
        structured_snippets: [
          { header: "dịch vụ", values: ["Cắt tóc", "Uốn", "Nhuộm"] },
        ],
      }),
      "VND",
      []
    )
    expect(plan[0]!.body).toEqual({
      structuredSnippetAsset: {
        header: "Dịch vụ",
        values: ["Cắt tóc", "Uốn", "Nhuộm"],
      },
    })
  })

  it("promotion: percent_off XOR money_amount_off, promotion_code XOR orders_over_amount, 1 decimal", () => {
    const base = {
      promotion_target: "Uốn tóc",
      final_url: "https://salon.vn/km",
    }
    const ok = (p: Record<string, unknown>) =>
      createAssetsInput.safeParse({ promotions: [{ ...base, ...p }] }).success
    expect(ok({ percent_off: 20 })).toBe(true)
    expect(ok({ money_amount_off: 50_000 })).toBe(true)
    expect(ok({})).toBe(false)
    expect(ok({ percent_off: 20, money_amount_off: 50_000 })).toBe(false)
    expect(
      ok({
        percent_off: 20,
        promotion_code: "TET2027",
        orders_over_amount: 500_000,
      })
    ).toBe(false)
    expect(ok({ percent_off: 12.5 })).toBe(true)
    expect(ok({ percent_off: 12.55 })).toBe(false)
    expect(ok({ percent_off: 101 })).toBe(false)
    expect(ok({ percent_off: 10, promotion_target: "x".repeat(21) })).toBe(
      false
    )
    expect(
      ok({ percent_off: 10, start_date: "2026-12-10", end_date: "2026-12-01" })
    ).toBe(false)
    expect(percentToMicros(12.5)).toBe("125000")
    expect(percentToMicros(100)).toBe("1000000")
    expect(percentToMicros(0.1 * 3)).toBe("3000")
  })

  it("price: header must differ from description, 3–8 offerings", () => {
    const off = (h: string, d: string) => ({
      header: h,
      description: d,
      price: 100_000,
      final_url: "https://salon.vn/gia",
    })
    const ok = (offerings: unknown[]) =>
      createAssetsInput.safeParse({ prices: [{ type: "SERVICES", offerings }] })
        .success
    expect(
      ok([
        off("Cắt", "Cắt tóc nam"),
        off("Uốn", "Uốn lạnh"),
        off("Nhuộm", "Nhuộm thời trang"),
      ])
    ).toBe(true)
    expect(
      ok([
        off("Cắt", "cắt"),
        off("Uốn", "Uốn lạnh"),
        off("Nhuộm", "Nhuộm thời trang"),
      ])
    ).toBe(false)
    expect(ok([off("Cắt", "Cắt tóc nam"), off("Uốn", "Uốn lạnh")])).toBe(false)
  })

  it("input totals and duplicates within the request", () => {
    expect(createAssetsInput.safeParse({}).success).toBe(false)
    expect(
      createAssetsInput.safeParse({
        callouts: Array.from({ length: 51 }, (_, i) => ({ text: `c${i}` })),
      }).success
    ).toBe(false)
    expect(
      createAssetsInput.safeParse({
        callouts: [{ text: "Miễn phí" }, { text: " Miễn  phí " }],
      }).success
    ).toBe(false)
    expect(
      createAssetsInput.safeParse({
        calls: [
          { phone_number: "+84 901 234 567" },
          { phone_number: "0901234567" },
        ],
      }).success
    ).toBe(false)
    expect(phoneDigits("+84 901 234 567", "VN")).toBe("0901234567")
    expect(
      createAssetsInput.safeParse({ calls: [{ phone_number: "0901-abc" }] })
        .success
    ).toBe(false)
  })
})

describe("display money → micros (advertised prices, not spend)", () => {
  it("VND integer, USD 2 decimals, never floored to the billable unit", async () => {
    expect(displayMoneyMicros(99_500, "VND", [], "Giá")).toBe("99500000000")
    const w: string[] = []
    expect(displayMoneyMicros(19.999, "USD", w, "Giá")).toBe("20000000")
    expect(w[0]).toMatch(/làm tròn/)
    expect(displayMoneyMicros(12.34, "usd", [], "Giá")).toBe("12340000")
    // a large billable unit cached by a budget tool does not change an advertised price
    await primeBillableUnit(
      {
        searchAll: async () => ({
          rows: [{ currencyConstant: { billableUnitMicros: "1000000000" } }],
          truncated: false,
        }),
      },
      "1234567890",
      "VND"
    )
    expect(billableUnitMicros("VND")).toBe(BigInt(1_000_000_000))
    expect(displayMoneyMicros(99_500, "VND", [], "Giá")).toBe("99500000000")
    expect(() => displayMoneyMicros(0, "VND", [], "Giá")).toThrow()
    expect(() => displayMoneyMicros(1e21, "VND", [], "Giá")).toThrow(expect.objectContaining({ code: "invalid_request" }))
  })

  it("huge display amounts are invalid input (no BigInt SyntaxError)", () => {
    const off = (price: number) => ({ header: "Cắt", description: "Cắt tóc", price, final_url: "https://salon.vn" })
    const parse = (price: number) => createAssetsInput.safeParse({ prices: [{ type: "SERVICES", offerings: [off(price), { ...off(1), header: "B" }, { ...off(1), header: "C" }] }] })
    expect(parse(1e12).success).toBe(true)
    expect(parse(1e21).success).toBe(false)
    expect(createAssetsInput.safeParse({ promotions: [{ promotion_target: "X", money_amount_off: 1e13, final_url: "https://a.vn" }] }).success).toBe(false)
  })

  it("price and promotion amounts use the account currency", () => {
    const input = createAssetsInput.parse({
      prices: [
        {
          type: "SERVICES",
          price_qualifier: "FROM",
          offerings: [
            {
              header: "Cắt",
              description: "Cắt tóc nam",
              price: 100_000,
              unit: "PER_HOUR",
              final_url: "https://salon.vn/1",
            },
            {
              header: "Uốn",
              description: "Uốn lạnh",
              price: 450_000,
              final_url: "https://salon.vn/2",
            },
            {
              header: "Nhuộm",
              description: "Nhuộm màu",
              price: 600_000,
              final_url: "https://salon.vn/3",
            },
          ],
        },
      ],
      promotions: [
        {
          promotion_target: "Uốn tóc",
          money_amount_off: 50_000,
          orders_over_amount: 300_000,
          final_url: "https://salon.vn/km",
        },
      ],
    })
    const [price, promo] = planAssets(input, "VND", [])
    expect(price!.body.priceAsset).toEqual({
      type: "SERVICES",
      priceQualifier: "FROM",
      languageCode: "vi",
      priceOfferings: [
        {
          header: "Cắt",
          description: "Cắt tóc nam",
          price: { currencyCode: "VND", amountMicros: "100000000000" },
          unit: "PER_HOUR",
          finalUrl: "https://salon.vn/1",
        },
        {
          header: "Uốn",
          description: "Uốn lạnh",
          price: { currencyCode: "VND", amountMicros: "450000000000" },
          finalUrl: "https://salon.vn/2",
        },
        {
          header: "Nhuộm",
          description: "Nhuộm màu",
          price: { currencyCode: "VND", amountMicros: "600000000000" },
          finalUrl: "https://salon.vn/3",
        },
      ],
    })
    expect(promo!.body).toEqual({
      finalUrls: ["https://salon.vn/km"],
      promotionAsset: {
        promotionTarget: "Uốn tóc",
        languageCode: "vi",
        moneyAmountOff: { currencyCode: "VND", amountMicros: "50000000000" },
        ordersOverAmount: { currencyCode: "VND", amountMicros: "300000000000" },
      },
    })
    const usd = planAssets(
      createAssetsInput.parse({
        promotions: [
          {
            promotion_target: "Shoes",
            percent_off: 15,
            final_url: "https://shop.com",
          },
        ],
      }),
      "USD",
      []
    )
    expect(usd[0]!.body.promotionAsset).toMatchObject({ percentOff: "150000" })
  })
})

describe("tool declarations", () => {
  it("inputs convert to JSON Schema (MCP tools/list)", () => {
    for (const e of googleAdsAssetExtensions) {
      const js = z.toJSONSchema(e.input as z.ZodType, { io: "input" }) as { type?: string }
      expect(js.type, e.name).toBe("object")
    }
  })

  it("create_assets is library-only: no link_campaign_id, createsAdObject false", () => {
    const create = ext("google_ads_create_assets")
    expect(create.createsAdObject).toBe(false)
    const props = (create.input as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(props)).not.toContain("link_campaign_id")
    expect(create.description).toMatch(/google_ads_link_assets/)
  })

  it("money-like keys of create_assets are exactly the advertised amounts (moneyOf: () => [] cannot hide a spend field)", () => {
    const names = (schema: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(schema)) for (const x of schema) names(x, out)
      else if (schema && typeof schema === "object") {
        const o = schema as Record<string, unknown>
        if (o.properties && typeof o.properties === "object") for (const k of Object.keys(o.properties)) out.add(k)
        for (const v of Object.values(o)) names(v, out)
      }
      return out
    }
    const js = z.toJSONSchema(createAssetsInput as z.ZodType, { unrepresentable: "any", io: "input" })
    const money = [...names(js)].filter((k) => MONEY_KEY.test(k)).sort()
    // price_qualifier (FROM / UP_TO / AVERAGE) only matches the key pattern: a string enum, never a numeric amount
    expect(money).toEqual(["money_amount_off", "orders_over_amount", "price", "price_qualifier"])
  })

  it("permissions, write flags, moneyOf = [] and alwaysConfirm on link", () => {
    expect(ext("google_ads_list_assets")).toMatchObject({
      permission: "read",
      write: false,
    })
    const create = ext("google_ads_create_assets")
    expect(create).toMatchObject({ permission: "create", write: true })
    expect(
      create.moneyOf!(
        create.input.parse({
          prices: [
            {
              type: "SERVICES",
              offerings: [1, 2, 3].map((i) => ({
                header: `H${i}`,
                description: `D${i}`,
                price: 1e6,
                final_url: "https://a.vn",
              })),
            },
          ],
        })
      )
    ).toEqual([])
    const link = ext("google_ads_link_assets")
    expect(link).toMatchObject({
      permission: "update",
      write: true,
      alwaysConfirm: true,
    })
    for (const e of googleAdsAssetExtensions) {
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
      expect(e.name.length).toBeLessThanOrEqual(40)
    }
  })

  it("link resource names", () => {
    expect(assetLinkResourceName("1234567890", "555", "CALLOUT", "111")).toBe(
      "customers/1234567890/campaignAssets/111~555~CALLOUT"
    )
    expect(assetLinkResourceName("1234567890", "555", "SITELINK")).toBe(
      "customers/1234567890/customerAssets/555~SITELINK"
    )
    expect(linkAssetsInput.safeParse({}).success).toBe(false)
    expect(
      linkAssetsInput.safeParse({
        attach: [{ asset_id: "1", field_type: "CALLOUT" }],
        detach: [{ asset_id: "1", field_type: "CALLOUT" }],
      }).success
    ).toBe(false)
  })
})

describe("google_ads_create_assets", () => {
  function setup() {
    const m = mockFetch()
    m.on(searchMatching(/FROM asset WHERE asset\.type = 'CALLOUT'/), { body: { results: [callout("555", "Miễn phí gội đầu")] } })
    m.on(isMutate, (c) => ({
      body: mutateBody(c).validateOnly ? {} : { mutateOperationResponses: [{ assetResult: { resourceName: "customers/1234567890/assets/777" } }] },
    }))
    return m
  }
  const input = () => ext("google_ads_create_assets").input.parse({ callouts: [{ text: "Miễn phí gội đầu" }, { text: "Đặt lịch online" }] })

  it("preview: reuses the identical asset, one validateOnly mutate of asset creates only (no links)", async () => {
    const m = setup()
    const res = (await ext("google_ads_create_assets").run(providerCtx(saCredentials()), input(), { dryRun: true })) as any
    const calls = m.api().filter(isMutate)
    expect(calls).toHaveLength(1)
    const body = mutateBody(calls[0]!)
    expect(body.validateOnly).toBe(true)
    expect(body.mutateOperations).toEqual([
      { assetOperation: { create: { resourceName: "customers/1234567890/assets/-1", calloutAsset: { calloutText: "Đặt lịch online" } } } },
    ])
    // never reads or touches campaigns / links
    expect(m.api().filter(searchMatching(/FROM (campaign|campaign_asset|customer_asset)\b/))).toHaveLength(0)
    expect(res.preview).toBe(true)
    expect(res.changes.map((c: any) => [c.objectId, c.field, c.objectName])).toEqual([["(mới)", "create", "Chú thích: Đặt lịch online"]])
    expect(res.changes[0].after).toEqual({ type: "CALLOUT", label_vi: "chú thích", text: "Đặt lịch online" })
    expect(res.changes.every((c: any) => !/budget|bid|amount|spend_cap|cost_cap/.test(c.field))).toBe(true)
    const w = res.warnings.join(" ")
    expect(w).toMatch(/dùng lại asset có sẵn \(id 555\)/)
    expect(w).toMatch(/google_ads_link_assets/)
    // the dedupe lookup filters on the exact text, ADVERTISER only
    const q = m.api().filter(searchMatching(/FROM asset WHERE/)).map((c) => (c.body as { query: string }).query)[0]!
    expect(q).toContain("asset.source = 'ADVERTISER'")
    expect(q).toContain("asset.callout_asset.callout_text IN ('Miễn phí gội đầu', 'Đặt lịch online')")
  })

  it("execute: non-validate mutate, createdIds = new asset resource names", async () => {
    const m = setup()
    const res = (await ext("google_ads_create_assets").run(providerCtx(saCredentials()), input(), {})) as any
    expect(mutateBody(m.api().filter(isMutate)[0]!).validateOnly).toBeUndefined()
    expect(res.createdIds).toEqual(["customers/1234567890/assets/777"])
    expect(res.changes.map((c: any) => c.objectId)).toEqual(["777"])
    expect(res.assets).toEqual([
      { type: "CALLOUT", label: "Chú thích: Miễn phí gội đầu", asset_id: "555", reused: true },
      { type: "CALLOUT", label: "Chú thích: Đặt lịch online", asset_id: "777", reused: false },
    ])
  })

  it("everything already exists: no mutate, no changes", async () => {
    const m = setup()
    const tool = ext("google_ads_create_assets")
    const res = (await tool.run(providerCtx(saCredentials()), tool.input.parse({ callouts: [{ text: "Miễn phí gội đầu" }] }), { dryRun: true })) as any
    expect(m.api().filter(isMutate)).toHaveLength(0)
    expect(res.changes).toEqual([])
  })

  it("5xx on execute: reports assets that now exist instead of retrying", async () => {
    const m = mockFetch()
    m.once(searchMatching(/FROM asset WHERE/), { body: { results: [] } })
    m.on(searchMatching(/FROM asset WHERE/), { body: { results: [callout("778", "Đặt lịch online")] } })
    m.on(isMutate, { status: 500, body: { error: { code: 500, status: "INTERNAL", message: "x" } } })
    const tool = ext("google_ads_create_assets")
    const res = (await tool.run(providerCtx(saCredentials()), tool.input.parse({ callouts: [{ text: "Đặt lịch online" }] }), {})) as any
    expect(m.api().filter(isMutate)).toHaveLength(1)
    expect(res.createdIds).toEqual(["customers/1234567890/assets/778"])
    expect(res.warnings.join(" ")).toMatch(/Mất kết nối/)
  })
})

describe("google_ads_link_assets", () => {
  function setup(
    o: {
      assets?: unknown[]
      campaignLinks?: unknown[]
      accountLinks?: unknown[]
    } = {}
  ) {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id/), {
      body: { results: [CAMPAIGN] },
    })
    m.on(searchMatching(/FROM campaign WHERE campaign\.status/), {
      body: {
        results: [
          { campaign: { id: "111", advertisingChannelType: "SEARCH" } },
          { campaign: { id: "112", advertisingChannelType: "SEARCH" } },
          // not a serving channel for callouts: never counted
          { campaign: { id: "113", advertisingChannelType: "DISPLAY" } },
        ],
      },
    })
    // like Google: only the assets named in asset.id IN (…)
    m.on(searchMatching(/FROM asset WHERE/), (c) => {
      const all = (o.assets ?? [callout("555", "A"), callout("556", "B"), callout("557", "C")]) as { asset: { id: string } }[]
      const ids = /asset\.id IN \(([^)]*)\)/.exec(String((c.body as { query?: string }).query))?.[1]?.split(", ") ?? []
      return { body: { results: all.filter((a) => ids.includes(a.asset.id)) } }
    })
    m.on(searchMatching(/FROM campaign_asset/), {
      body: { results: o.campaignLinks ?? [] },
    })
    m.on(searchMatching(/FROM customer_asset/), {
      body: { results: o.accountLinks ?? [] },
    })
    m.on(isMutate, { body: {} })
    return m
  }
  const campLink = (assetId: string, status: string) => ({
    campaignAsset: {
      resourceName: `customers/1234567890/campaignAssets/111~${assetId}~CALLOUT`,
      fieldType: "CALLOUT",
      status,
      source: "ADVERTISER",
    },
    asset: { id: assetId },
    campaign: { id: "111", name: "Search tóc" },
  })
  const acctLink = (assetId: string, status = "ENABLED") => ({
    customerAsset: {
      resourceName: `customers/1234567890/customerAssets/${assetId}~CALLOUT`,
      fieldType: "CALLOUT",
      status,
    },
    asset: { id: assetId },
  })

  it("campaign level: create, re-enable PAUSED, remove by resource name", async () => {
    const m = setup({
      campaignLinks: [campLink("556", "PAUSED"), campLink("557", "ENABLED")],
      accountLinks: [acctLink("900")],
    })
    const tool = ext("google_ads_link_assets")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({
        campaign_id: "111",
        attach: [
          { asset_id: "555", field_type: "CALLOUT" },
          { asset_id: "556", field_type: "CALLOUT" },
        ],
        detach: [{ asset_id: "557", field_type: "CALLOUT" }],
      }),
      { dryRun: true }
    )) as any
    const body = mutateBody(m.api().filter(isMutate)[0]!)
    expect(body.validateOnly).toBe(true)
    expect(body.mutateOperations).toEqual([
      {
        campaignAssetOperation: {
          create: {
            asset: "customers/1234567890/assets/555",
            fieldType: "CALLOUT",
            status: "ENABLED",
            campaign: "customers/1234567890/campaigns/111",
          },
        },
      },
      {
        campaignAssetOperation: {
          update: {
            resourceName: "customers/1234567890/campaignAssets/111~556~CALLOUT",
            status: "ENABLED",
          },
          updateMask: "status",
        },
      },
      {
        campaignAssetOperation: {
          remove: "customers/1234567890/campaignAssets/111~557~CALLOUT",
        },
      },
    ])
    expect(
      res.changes.map((c: any) => [
        c.objectId,
        c.level,
        c.field,
        c.before,
        c.after,
      ])
    ).toEqual([
      ["111", "campaign", "asset_link", "chưa gắn", "đã gắn"],
      ["111", "campaign", "asset_link", "tạm dừng", "đã gắn"],
      ["111", "campaign", "asset_link", "đã gắn", "đã gỡ"],
    ])
    expect(res.warnings.join(" ")).toMatch(/không cho xoá asset/)
  })

  it("detaching the last campaign-level asset warns that account-level assets serve again", async () => {
    setup({
      campaignLinks: [campLink("557", "ENABLED")],
      accountLinks: [acctLink("900")],
    })
    const tool = ext("google_ads_link_assets")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({
        campaign_id: "111",
        detach: [{ asset_id: "557", field_type: "CALLOUT" }],
      }),
      { dryRun: true }
    )) as any
    expect(res.warnings.join(" ")).toMatch(
      /1 asset chú thích cấp tài khoản sẽ hiển thị lại/
    )
  })

  it("account level: customerAsset remove + affected campaign count; attach of an ENABLED link is skipped", async () => {
    const m = setup({
      accountLinks: [acctLink("557"), acctLink("555")],
      campaignLinks: [campLink("556", "ENABLED")],
    })
    const tool = ext("google_ads_link_assets")
    const res = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({
        attach: [{ asset_id: "555", field_type: "CALLOUT" }],
        detach: [{ asset_id: "557", field_type: "CALLOUT" }],
      }),
      {}
    )) as any
    const body = mutateBody(m.api().filter(isMutate)[0]!)
    expect(body.validateOnly).toBeUndefined()
    expect(body.mutateOperations).toEqual([
      {
        customerAssetOperation: {
          remove: "customers/1234567890/customerAssets/557~CALLOUT",
        },
      },
    ])
    expect(res.changes).toEqual([
      {
        objectId: "557~CALLOUT",
        objectName: "Chú thích: C (asset 557)",
        field: "asset_link",
        before: "đã gắn",
        after: "đã gỡ",
      },
    ])
    const w = res.warnings.join(" ")
    expect(w).toMatch(/555\) đã được gắn - bỏ qua/)
    // 2 campaigns, 111 has its own enabled callout → 1 campaign uses account-level callouts
    expect(w).toMatch(/hiện có 1 chiến dịch như vậy/)
    const cq = m.api().filter(searchMatching(/FROM campaign WHERE campaign\.status/)).map((c) => (c.body as { query: string }).query)[0]!
    expect(cq).toContain("campaign.advertising_channel_type IN ('SEARCH', 'PERFORMANCE_MAX')")
  })

  it("refuses VIDEO and SMART campaigns before any mutate", async () => {
    for (const type of ["VIDEO", "SMART"]) {
      const m = mockFetch()
      m.on(searchMatching(/FROM campaign WHERE campaign\.id/), { body: { results: [{ campaign: { ...CAMPAIGN.campaign, advertisingChannelType: type } }] } })
      const tool = ext("google_ads_link_assets")
      await expect(
        tool.run(providerCtx(saCredentials()), tool.input.parse({ campaign_id: "111", attach: [{ asset_id: "555", field_type: "CALLOUT" }] }), { dryRun: true })
      ).rejects.toMatchObject({ code: expect.any(String) })
      expect(m.api().filter(isMutate)).toHaveLength(0)
      vi.unstubAllGlobals()
    }
  })

  it("field_type mismatch, automatically created and unknown assets are refused before any mutate", async () => {
    const tool = ext("google_ads_link_assets")
    let m = setup()
    await expect(
      tool.run(
        providerCtx(saCredentials()),
        tool.input.parse({
          attach: [{ asset_id: "555", field_type: "SITELINK" }],
        }),
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(
        /không khớp loại asset: 555 là CALLOUT, không phải SITELINK/
      ),
    })
    expect(m.api().filter(isMutate)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = setup({ assets: [callout("555", "A", "AUTOMATICALLY_CREATED")] })
    await expect(
      tool.run(
        providerCtx(saCredentials()),
        tool.input.parse({
          attach: [{ asset_id: "555", field_type: "CALLOUT" }],
        }),
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      userMessageVi: expect.stringMatching(/Google tự tạo.*555/),
    })
    expect(m.api().filter(isMutate)).toHaveLength(0)
    vi.unstubAllGlobals()
    m = setup({ assets: [callout("555", "A")] })
    await expect(
      tool.run(
        providerCtx(saCredentials()),
        tool.input.parse({
          attach: [
            { asset_id: "555", field_type: "CALLOUT" },
            { asset_id: "999", field_type: "CALLOUT" },
          ],
        }),
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      userMessageVi: expect.stringMatching(/Không tìm thấy asset: 999/),
    })
    expect(m.api().filter(isMutate)).toHaveLength(0)
  })
})

describe("google_ads_list_assets", () => {
  const price = {
    asset: {
      id: "901",
      type: "PRICE",
      source: "ADVERTISER",
      policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" },
      priceAsset: {
        type: "SERVICES",
        languageCode: "vi",
        priceOfferings: [
          {
            header: "Cắt",
            description: "Cắt nam",
            price: { currencyCode: "VND", amountMicros: "99500000000" },
            finalUrl: "https://salon.vn",
          },
        ],
      },
    },
  }

  it("with campaign_id: links, effective serving level per field type, money in major units", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE campaign\.id/), {
      body: { results: [CAMPAIGN] },
    })
    m.on(searchMatching(/FROM campaign_asset/), {
      body: {
        results: [
          {
            campaignAsset: {
              resourceName: "r",
              fieldType: "CALLOUT",
              status: "ENABLED",
              primaryStatus: "ELIGIBLE",
            },
            asset: { id: "555" },
            campaign: { id: "111", name: "Search tóc" },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM customer_asset/), {
      body: {
        results: [
          {
            customerAsset: {
              resourceName: "r2",
              fieldType: "CALLOUT",
              status: "ENABLED",
            },
            asset: { id: "900" },
          },
          {
            customerAsset: {
              resourceName: "r3",
              fieldType: "PRICE",
              status: "ENABLED",
            },
            asset: { id: "901" },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM asset WHERE/), {
      body: { results: [callout("555", "A"), callout("900", "B"), price] },
    })
    const tool = ext("google_ads_list_assets")
    const out = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ campaign_id: "111", types: ["CALLOUT", "PRICE"] }),
      {}
    )) as any
    expect(out.assets.map((a: any) => a.asset_id)).toEqual([
      "555",
      "900",
      "901",
    ])
    expect(out.effective).toEqual([
      {
        field_type: "CALLOUT",
        label_vi: "chú thích",
        campaign_enabled: 1,
        account_enabled: 1,
        serving_level: "campaign",
      },
      {
        field_type: "PRICE",
        label_vi: "giá",
        campaign_enabled: 0,
        account_enabled: 1,
        serving_level: "account",
      },
    ])
    const p = out.assets[2]
    expect(p.content.offerings[0]).toMatchObject({
      price: 99_500,
      currency: "VND",
    })
    expect(p.policy).toEqual({
      approval_status: "APPROVED",
      review_status: "REVIEWED",
    })
    expect(out.assets[0].links).toEqual([
      {
        level: "campaign",
        campaign_id: "111",
        campaign_name: "Search tóc",
        field_type: "CALLOUT",
        status: "ENABLED",
        primary_status: "ELIGIBLE",
      },
    ])
    const q = m
      .api()
      .filter(searchMatching(/FROM asset WHERE/))
      .map((c) => (c.body as { query: string }).query)[0]!
    expect(q).toContain("asset.id IN (555, 900, 901)")
  })

  it("account-wide: unlinked ADVERTISER assets kept, unlinked automatically created ones skipped", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign_asset/), { body: { results: [] } })
    m.on(searchMatching(/FROM customer_asset/), {
      body: {
        results: [
          {
            customerAsset: {
              resourceName: "r",
              fieldType: "CALLOUT",
              status: "ENABLED",
            },
            asset: { id: "998" },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM asset WHERE/), {
      body: {
        results: [
          callout("902", "Mới"),
          callout("998", "Tự tạo đang gắn", "AUTOMATICALLY_CREATED"),
          callout("999", "Tự tạo", "AUTOMATICALLY_CREATED"),
        ],
      },
    })
    const tool = ext("google_ads_list_assets")
    const out = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ limit: 1 }),
      {}
    )) as any
    expect(out.assets.map((a: any) => a.asset_id)).toEqual(["902"])
    expect(out.next_cursor).toBeTruthy()
    const next = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ limit: 5, cursor: out.next_cursor }),
      {}
    )) as any
    expect(next.assets.map((a: any) => [a.asset_id, a.source])).toEqual([
      ["998", "AUTOMATICALLY_CREATED"],
    ])
    expect(next.next_cursor).toBeNull()
  })
})
