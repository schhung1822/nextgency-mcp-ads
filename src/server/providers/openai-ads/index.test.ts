import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { openaiAdsProvider } from "./index"
import { apiError, calls, clone, freezeDate, fx, json, makeCtx, route, setupHarness } from "./__fixtures__/harness"

setupHarness()

describe("openaiAdsProvider - credentials & capabilities", () => {
  it("parseCredentials: nhận apiKey (và alias api_key), báo lỗi tiếng Việt khi thiếu", () => {
    expect(openaiAdsProvider.parseCredentials({ apiKey: "  sk-ads-abcdefghijklmnopqrstuvwxyz  " })).toEqual({
      apiKey: "sk-ads-abcdefghijklmnopqrstuvwxyz",
    })
    expect(openaiAdsProvider.parseCredentials({ api_key: "sk-ads-abcdefghijklmnopqrstuvwxyz" }).apiKey).toBe(
      "sk-ads-abcdefghijklmnopqrstuvwxyz"
    )
    expect(() => openaiAdsProvider.parseCredentials({})).toThrowError()
    try {
      openaiAdsProvider.parseCredentials({ apiKey: "short" })
    } catch (e) {
      expect((e as { code: string }).code).toBe("invalid_credentials_input")
    }
    expect(openaiAdsProvider.credentialHint({ apiKey: "sk-ads-abcdefghijklmnopqrstuvwxyz" })).toBe("…wxyz")
  })

  it("capabilities trung thực", () => {
    expect(openaiAdsProvider.platform).toBe("openai_ads")
    expect(openaiAdsProvider.capabilities).toMatchObject({
      copy: "emulated",
      delete: "native",
      conversions: "gated",
      upload_media: "native",
      update_targeting: "unsupported",
    })
    expect(openaiAdsProvider.credentialFields.map((f) => f.key)).toEqual(["apiKey"])
    expect(openaiAdsProvider.guide.steps.length).toBeGreaterThanOrEqual(3)
  })

  it("upload video → unsupported; ảnh → POST /upload {image_url}", async () => {
    await expect(openaiAdsProvider.uploadMedia(makeCtx(), { type: "video", url: "https://x.example/v.mp4" })).rejects.toMatchObject({
      code: "unsupported",
    })
    route("post", "/upload", { file_id: "file_9" })
    const ref = await openaiAdsProvider.uploadMedia(makeCtx(), { type: "image", url: "https://x.example/a.png" })
    expect(ref).toEqual({ type: "image", id: "file_9", url: "https://x.example/a.png" })
    expect(calls[0]!.body).toEqual({ image_url: "https://x.example/a.png" })
  })

  it("lookup locations → /geo_lookup/search; kind không hỗ trợ → unsupported", async () => {
    route("get", "/geo_lookup/search", {
      query: "Ho Chi Minh",
      count: 1,
      results: [
        {
          id: "geo_vn_sg",
          name: "Ho Chi Minh City",
          canonical_name: "Ho Chi Minh City, Vietnam",
          region_code: "SG",
          type: "region",
          country_code: "VN",
          parent_id: "geo_vn",
          parent_country: "VN",
        },
      ],
    })
    const r = await openaiAdsProvider.lookup(makeCtx(), "locations", { q: "Ho Chi Minh", limit: 5 })
    expect(calls[0]!.url.searchParams.get("q")).toBe("Ho Chi Minh")
    expect(calls[0]!.url.searchParams.get("limit")).toBe("5")
    expect(r.items[0]).toMatchObject({ id: "geo_vn_sg", name: "Ho Chi Minh City, Vietnam" })
    await expect(openaiAdsProvider.lookup(makeCtx(), "interests")).rejects.toMatchObject({ code: "unsupported" })
  })

  it("lookup conversion_events khi chưa bật → danh sách rỗng + cảnh báo", async () => {
    route("get", "/conversions/event_settings", () => apiError(404, "Not found"))
    const r = await openaiAdsProvider.lookup(makeCtx(), "conversion_events")
    expect(r.items).toEqual([])
    expect(r.warnings[0]).toContain("chưa bật")
  })
})

describe("openaiAdsProvider - accounts", () => {
  it("validateCredentials: GET /ad_account + dò tính năng (403/404 = chưa bật)", async () => {
    freezeDate()
    route("get", "/ad_account", fx.adAccount)
    route("get", "/conversions/event_settings", () => apiError(404, "Not found"))
    route("get", "/ad_account/insights", () => json({ object: "list", data: [], count: 0, first_id: null, last_id: null, has_more: false }))
    route("get", "/ad_account/spend_limit_windows", () => apiError(403, "Spend limit windows are not enabled"))
    route("post", "/bulk_mutation_jobs", () => apiError(404, "Not found"))
    const check = await openaiAdsProvider.validateCredentials({ credentials: { apiKey: "sk-ads-0123456789abcdefghij" } })
    expect(check.valid).toBe(true)
    expect(check.meta).toMatchObject({
      adAccountId: "adacct_123",
      currency: "USD",
      timezone: "America/New_York",
      features: { conversions: false, insights_segments: true, spend_limit_windows: false, bulk: false },
    })
    const bulk = calls.find((c) => c.path === "/bulk_mutation_jobs")!
    expect(bulk.body).toMatchObject({ validate_only: true, operations: [] })
    expect(calls.every((c) => c.headers.get("openai-ad-account") === null)).toBe(true)
  })

  it("validateCredentials: key sai → valid=false (không ném lỗi)", async () => {
    route("get", "/ad_account", () => apiError(401, "Incorrect API key provided", "invalid_api_key"))
    const check = await openaiAdsProvider.validateCredentials({ credentials: { apiKey: "sk-ads-0123456789abcdefghij" } })
    expect(check.valid).toBe(false)
    expect(check.warnings[0]).toContain("API key")
  })

  it("listAccounts: đúng 1 tài khoản/key", async () => {
    route("get", "/ad_account", clone(fx.adAccount, { review: { status: "in_review" } }))
    const accounts = await openaiAdsProvider.listAccounts({ credentials: { apiKey: "sk-ads-0123456789abcdefghij" } })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      externalId: "adacct_123",
      name: "Acme Ads",
      currency: "USD",
      timezone: "America/New_York",
      status: "pending",
    })
  })
})

// ---------------------------------------------------------------------------
// Fixtures must match the official OpenAPI response schemas
// ---------------------------------------------------------------------------

type Schema = {
  $ref?: string
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  anyOf?: Schema[]
  enum?: unknown[]
}

const spec = JSON.parse(
  readFileSync(path.resolve(process.cwd(), ".claude/docs/providers/openai-ads.openapi.json"), "utf8")
) as { components: { schemas: Record<string, Schema> } }

function validate(value: unknown, schema: Schema, at: string, errors: string[]) {
  if (schema.$ref) return validate(value, spec.components.schemas[schema.$ref.split("/").pop()!]!, at, errors)
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const e: string[] = []
      validate(value, s, at, e)
      return e.length === 0
    })
    if (!ok) errors.push(`${at}: matches no anyOf branch`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${String(value)} not in enum`)
  switch (schema.type) {
    case "null":
      if (value !== null) errors.push(`${at}: expected null`)
      return
    case "string":
      if (typeof value !== "string") errors.push(`${at}: expected string`)
      return
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${at}: expected integer`)
      return
    case "number":
      if (typeof value !== "number") errors.push(`${at}: expected number`)
      return
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${at}: expected boolean`)
      return
    case "array":
      if (!Array.isArray(value)) errors.push(`${at}: expected array`)
      else value.forEach((v, i) => validate(v, schema.items ?? {}, `${at}[${i}]`, errors))
      return
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${at}: expected object`)
        return
      }
      const obj = value as Record<string, unknown>
      for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${at}.${r}: required`)
      for (const [k, v] of Object.entries(obj)) {
        const prop = schema.properties?.[k]
        if (!prop) errors.push(`${at}.${k}: not in schema`)
        else validate(v, prop, `${at}.${k}`, errors)
      }
    }
  }
}

describe("fixtures khớp OpenAPI chính thức", () => {
  it.each([
    ["ad_account.json", fx.adAccount, "AdAccountResource"],
    ["campaign.json", fx.campaign, "CampaignItemBody"],
    ["ad_group.json", fx.adGroup, "AdGroupItemBody"],
    ["ad.json", fx.ad, "AdItemBody"],
    ["insights_campaign_daily.json", fx.insightsCampaignDaily, "InsightsResource"],
    ["conversions_insights.json", fx.conversionsInsights, "ConversionSummaryRowsResource"],
  ])("%s ⇔ %s", (_name, value, schemaName) => {
    const errors: string[] = []
    validate(value, { $ref: `#/components/schemas/${schemaName}` }, schemaName, errors)
    expect(errors).toEqual([])
  })
})
