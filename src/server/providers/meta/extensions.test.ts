import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import type { ProviderExtension } from "../types"
import type { MetaCredentials } from "./client"
import { metaExtensions, type MetaWriteResult } from "./extensions"
import { graphError, json, mockGraph, providerCtx } from "./test-utils"

beforeEach(() => __resetBuckets())

function ext(name: string) {
  const e = metaExtensions.find((x) => x.name === name)
  if (!e) throw new Error(`missing ${name}`)
  return e as ProviderExtension<MetaCredentials, unknown, MetaWriteResult>
}

async function run(name: string, raw: unknown, opts: { dryRun?: boolean } = {}, ctx = providerCtx()) {
  const e = ext(name)
  const input = e.input.parse(raw)
  return e.run(ctx, input, opts)
}

describe("extension metadata", () => {
  it("exposes the four Meta tools with Vietnamese 'Dùng khi…' descriptions ≤1500 chars", () => {
    expect(metaExtensions.map((e) => e.name)).toEqual([
      "meta_create_campaign",
      "meta_create_adset",
      "meta_create_ad",
      "meta_update_targeting",
    ])
    for (const e of metaExtensions) {
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
      expect(e.name.length).toBeLessThanOrEqual(40)
      expect(e.write).toBe(true)
    }
  })
})

describe("meta_create_campaign", () => {
  it("ABO: always PAUSED and sends is_adset_budget_sharing_enabled", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3001" })]])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" })
    const p = m.mutatingPosts()[0].params
    expect(p).toMatchObject({ name: "Camp", objective: "OUTCOME_SALES", status: "PAUSED", buying_type: "AUCTION", is_adset_budget_sharing_enabled: "false" })
    expect(JSON.parse(p.special_ad_categories)).toEqual([])
    expect(p.daily_budget).toBeUndefined()
    expect(p.bid_strategy).toBeUndefined()
    expect(res.createdIds).toEqual(["3001"])
  })

  it("CBO with a VND budget sends minor units with offset 1 and an explicit bid_strategy", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3002" })]])
    const res = await run("meta_create_campaign", { name: "CBO", objective: "OUTCOME_TRAFFIC", budget: { type: "daily", amount: 300000 } })
    const p = m.mutatingPosts()[0].params
    expect(p.daily_budget).toBe("300000")
    expect(p.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP")
    expect(p.is_adset_budget_sharing_enabled).toBeUndefined()
    expect(p.status).toBe("PAUSED")
    expect(res.payload.budget).toMatchObject({ amount: 300000, currency: "VND", minor_units_sent: 300000 })
  })

  it("CBO with a USD budget sends cents", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3003" })]])
    await run("meta_create_campaign", { name: "CBO", objective: "OUTCOME_TRAFFIC", budget: { type: "daily", amount: 25.5 } }, {}, providerCtx({ currency: "USD" }))
    expect(m.mutatingPosts()[0].params.daily_budget).toBe("2550")
  })

  it("dryRun only sends validate_only", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ success: true })]])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" }, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
    expect(JSON.parse(m.calls[0].params.execution_options)).toEqual(["validate_only"])
    expect(m.calls[0].params.status).toBe("PAUSED")
  })

  it("special ad categories require a country", async () => {
    mockGraph([])
    await expect(run("meta_create_campaign", { name: "Nhà", objective: "OUTCOME_LEADS", special_ad_categories: ["HOUSING"] })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("recovers the id after a create timeout instead of retrying blindly", async () => {
    let posts = 0
    const m = mockGraph([
      [
        "POST",
        "act_1001/campaigns",
        () => {
          posts++
          return json({ error: { code: 2, message: "Service temporarily unavailable", is_transient: true } }, 500)
        },
      ],
      ["GET", "act_1001/campaigns", () => json({ data: [{ id: "3009", name: "Camp", created_time: new Date().toISOString() }] })],
    ])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" })
    expect(posts).toBe(1)
    expect(res.createdIds).toEqual(["3009"])
    expect(JSON.parse(m.calls[1].params.filtering)).toEqual([{ field: "name", operator: "EQUAL", value: "Camp" }])
  })
})

const aboCampaign = {
  id: "3001",
  name: "Camp",
  account_id: "1001",
  objective: "OUTCOME_SALES",
  special_ad_categories: [],
  status: "PAUSED",
}

const adsetInput = {
  campaign_id: "3001",
  name: "Nhóm VN 25-45",
  optimization_goal: "OFFSITE_CONVERSIONS",
  budget: { type: "daily", amount: 200000 },
  promoted_object: { pixel_id: "777", custom_event_type: "PURCHASE" },
  targeting: { countries: ["vn"], age_min: 25, age_max: 45, interests: [{ id: "6003139266461", name: "Fashion" }] },
}

describe("meta_create_adset", () => {
  it("ABO ad set: PAUSED, budget in minor units, explicit advantage_audience=0", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2001" })],
    ])
    const res = await run("meta_create_adset", adsetInput)
    const p = m.mutatingPosts()[0].params
    expect(p).toMatchObject({ status: "PAUSED", daily_budget: "200000", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })
    const t = JSON.parse(p.targeting)
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 })
    expect(t.geo_locations).toEqual({ countries: ["VN"] })
    expect(t.flexible_spec).toEqual([{ interests: [{ id: "6003139266461", name: "Fashion" }] }])
    expect(JSON.parse(p.promoted_object)).toEqual({ pixel_id: "777", custom_event_type: "PURCHASE" })
    expect(res.createdIds).toEqual(["2001"])
  })

  it("advantage_audience=true is sent as 1", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2001" })],
    ])
    await run("meta_create_adset", { ...adsetInput, targeting: { ...adsetInput.targeting, advantage_audience: true } })
    expect(JSON.parse(m.mutatingPosts()[0].params.targeting).targeting_automation).toEqual({ advantage_audience: 1 })
  })

  it("rejects a budget on a CBO campaign and a missing budget on an ABO campaign", async () => {
    mockGraph([["GET", "3001", () => json({ ...aboCampaign, daily_budget: "1000000" })]])
    await expect(run("meta_create_adset", adsetInput)).rejects.toMatchObject({ code: "invalid_request" })
    mockGraph([["GET", "3001", () => json(aboCampaign)]])
    await expect(run("meta_create_adset", { ...adsetInput, budget: undefined })).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("validates objective → optimization_goal and promoted_object", async () => {
    mockGraph([["GET", "3001", () => json(aboCampaign)]])
    await expect(run("meta_create_adset", { ...adsetInput, optimization_goal: "LINK_CLICKS" })).rejects.toThrow(/OFFSITE_CONVERSIONS, VALUE/)
    await expect(run("meta_create_adset", { ...adsetInput, promoted_object: { pixel_id: "777" } })).rejects.toThrow(/custom_event_type/)
  })

  it("requires DSA fields when targeting EU countries", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2002" })],
    ])
    const eu = { ...adsetInput, targeting: { countries: ["DE", "VN"] } }
    await expect(run("meta_create_adset", eu)).rejects.toThrow(/dsa_beneficiary/)
    await run("meta_create_adset", { ...eu, dsa_beneficiary: "Shop VN", dsa_payor: "Shop VN" })
    expect(m.mutatingPosts()[0].params).toMatchObject({ dsa_beneficiary: "Shop VN", dsa_payor: "Shop VN" })
  })

  it("dryRun validates without creating", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ success: true })],
    ])
    const res = await run("meta_create_adset", adsetInput, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
    expect(res.payload.budget).toMatchObject({ amount: 200000, currency: "VND" })
  })

  it("refuses a campaign from another ad account", async () => {
    const m = mockGraph([["GET", "3001", () => json({ ...aboCampaign, account_id: "4242" })]])
    await expect(run("meta_create_adset", adsetInput)).rejects.toMatchObject({ code: "not_found" })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})

describe("meta_create_ad", () => {
  const adset = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    optimization_goal: "OFFSITE_CONVERSIONS",
    campaign: { id: "3001", objective: "OUTCOME_SALES" },
  }

  it("link ad: PAUSED, inline creative, Advantage+ creative features OPT_OUT unless requested", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ["POST", "act_1001/ads", () => json({ id: "11" })],
    ])
    await run("meta_create_ad", {
      adset_id: "2001",
      name: "Ad 1",
      page_id: "888",
      creative: {
        type: "link",
        link: "https://shop.vn/sp",
        message: "Giảm 50%",
        headline: "Sale",
        image_hash: "0123456789abcdef0123456789abcdef",
        call_to_action: { type: "SHOP_NOW" },
      },
      url_tags: "utm_source=facebook",
      advantage_creative_opt_in: ["image_touchups"],
    })
    const p = m.mutatingPosts()[0].params
    expect(p.status).toBe("PAUSED")
    const creative = JSON.parse(p.creative)
    expect(creative.object_story_spec).toEqual({
      page_id: "888",
      link_data: {
        link: "https://shop.vn/sp",
        message: "Giảm 50%",
        name: "Sale",
        image_hash: "0123456789abcdef0123456789abcdef",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.vn/sp" } },
      },
    })
    const features = creative.degrees_of_freedom_spec.creative_features_spec
    expect(features.text_optimizations).toEqual({ enroll_status: "OPT_OUT" })
    expect(features.image_templates).toEqual({ enroll_status: "OPT_OUT" })
    expect(features.image_touchups).toEqual({ enroll_status: "OPT_IN" })
    expect(creative.url_tags).toBe("utm_source=facebook")
  })

  it("video ad requires a thumbnail; existing post uses object_story_id", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ["POST", "act_1001/ads", () => json({ id: "12" })],
    ])
    await expect(
      run("meta_create_ad", { adset_id: "2001", name: "V", page_id: "888", creative: { type: "video", video_id: "555" } })
    ).rejects.toThrow(/thumbnail/)
    await run("meta_create_ad", { adset_id: "2001", name: "Post", creative: { type: "existing_post", object_story_id: "888_999" } })
    const creative = JSON.parse(m.mutatingPosts()[0].params.creative)
    expect(creative.object_story_id).toBe("888_999")
    expect(creative.degrees_of_freedom_spec.creative_features_spec.enhance_cta).toEqual({ enroll_status: "OPT_OUT" })
  })

  it("lead ads need a lead form id", async () => {
    mockGraph([["GET", "2001", () => json({ ...adset, optimization_goal: "LEAD_GENERATION", campaign: { objective: "OUTCOME_LEADS" } })]])
    await expect(
      run("meta_create_ad", { adset_id: "2001", name: "L", page_id: "888", creative: { type: "link", link: "https://x.vn", call_to_action: { type: "SIGN_UP" } } })
    ).rejects.toThrow(/lead_gen_form_id/)
  })

  it("dryRun never creates", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ["POST", "act_1001/ads", () => json({ success: true })],
    ])
    const res = await run("meta_create_ad", { adset_id: "2001", name: "Ad", page_id: "888", creative: { type: "link", link: "https://shop.vn" } }, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
  })
})

describe("meta_update_targeting", () => {
  const current = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    targeting: {
      geo_locations: { countries: ["VN"] },
      age_min: 18,
      age_max: 65,
      targeting_automation: { advantage_audience: 1 },
      publisher_platforms: ["facebook", "instagram"],
    },
  }

  it("merge mode keeps other fields and the current advantage_audience", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await run("meta_update_targeting", { adset_id: "2001", targeting: { age_min: 25, age_max: 40 } })
    const t = JSON.parse(m.mutatingPosts()[0].params.targeting)
    expect(t).toMatchObject({ age_min: 25, age_max: 40, geo_locations: { countries: ["VN"] }, publisher_platforms: ["facebook", "instagram"] })
    expect(t.targeting_automation).toEqual({ advantage_audience: 1 })
    expect(res.changes[0].before).toEqual(current.targeting)
    expect(res.warnings.join(" ")).toMatch(/đang chạy/)
  })

  it("replace mode requires geo and always sends advantage_audience", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => json({ success: true })],
    ])
    await expect(run("meta_update_targeting", { adset_id: "2001", merge: false, targeting: { age_min: 30 } })).rejects.toThrow(/vị trí/)
    await run("meta_update_targeting", { adset_id: "2001", merge: false, targeting: { countries: ["VN"] } })
    const t = JSON.parse(m.mutatingPosts()[0].params.targeting)
    expect(t).toEqual({ geo_locations: { countries: ["VN"] }, targeting_automation: { advantage_audience: 0 }, age_min: 18 })
  })

  it("rejects removed placements", async () => {
    mockGraph([["GET", "2001", () => json(current)]])
    await expect(
      run("meta_update_targeting", { adset_id: "2001", targeting: { publisher_platforms: ["instagram"], instagram_positions: ["explore"] } })
    ).rejects.toThrow(/Explore/)
  })

  it("dryRun on targeting update sends zero POSTs (preview from reads only)", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => graphError(100, undefined, { error_user_msg: "should not be called" })],
    ])
    const res = (await run("meta_update_targeting", { adset_id: "2001", targeting: { age_min: 25 } }, { dryRun: true })) as {
      preview: boolean
    }
    expect(res.preview).toBe(true)
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})
