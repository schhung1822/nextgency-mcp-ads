import { describe, expect, it } from "vitest"
import { deleteObject, setStatus, updateBudget, updateObject } from "./mutate"
import { apiError, calls, clone, fx, json, makeCtx, route, setupHarness, writes } from "./__fixtures__/harness"

setupHarness()

const lifetimeCampaign = () => clone(fx.campaign, { budget: { lifetime_spend_limit_micros: 500_000_000 } })

describe("OpenAI Ads updateBudget", () => {
  it("gửi object budget đầy đủ theo micros (75 USD → 75000000)", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/campaigns/cmpn_101", clone(fx.campaign, { budget: { daily_spend_limit_micros: 75_000_000 } }))
    const r = await updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 75 })
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.body).toEqual({ budget: { daily_spend_limit_micros: 75_000_000 } })
    expect(r.changes[0]).toMatchObject({
      field: "budget",
      before: { type: "daily", amount: 50, currency: "USD" },
      after: { type: "daily", amount: 75, currency: "USD" },
    })
  })

  it("số lẻ không trôi float: 12.34 → 12340000 micros", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/campaigns/cmpn_101", fx.campaign)
    await updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 12.34 })
    expect(writes()[0]!.body).toEqual({ budget: { daily_spend_limit_micros: 12_340_000 } })
  })

  it("dryRun: chỉ đọc, không ghi", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    const r = await updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 80 }, { dryRun: true })
    expect(r.preview).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(r.changes[0]!.after).toMatchObject({ amount: 80 })
  })

  it("ngân sách ad group → unsupported, giải thích ngân sách nằm ở campaign", async () => {
    await expect(updateBudget(makeCtx(), { level: "ad_group", id: "adgrp_201", type: "daily", amount: 10 })).rejects.toMatchObject({
      code: "unsupported",
      userMessageVi: expect.stringContaining("campaign"),
    })
    expect(calls).toHaveLength(0)
  })

  it("không cho đổi daily → lifetime", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    await expect(updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "lifetime", amount: 100 })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(writes()).toHaveLength(0)
  })

  it("lifetime → daily được phép, kèm cảnh báo không đổi ngược", async () => {
    route("get", "/campaigns/cmpn_101", lifetimeCampaign())
    route("post", "/campaigns/cmpn_101", fx.campaign)
    const r = await updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 50 })
    expect(writes()[0]!.body).toEqual({ budget: { daily_spend_limit_micros: 50_000_000 } })
    expect(r.warnings.join(" ")).toContain("KHÔNG thể đổi ngược")
  })

  it("dưới mức đã chi → 422 được map thành invalid_request", async () => {
    route("get", "/campaigns/cmpn_101", lifetimeCampaign())
    route("post", "/campaigns/cmpn_101", () => apiError(422, "Lifetime budget cannot be below spend", "budget_window_amount_below_spend"))
    await expect(updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "lifetime", amount: 1 })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringContaining("đã chi"),
    })
  })

  it("ngân sách < 1 đơn vị bị chặn trước khi gọi API", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    await expect(updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 0.5 })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(writes()).toHaveLength(0)
  })

  it("503 khi ghi → đọc lại thấy đã lưu → không gửi lại", async () => {
    let gets = 0
    route("get", "/campaigns/cmpn_101", () => {
      gets++
      return json(gets === 1 ? fx.campaign : clone(fx.campaign, { budget: { daily_spend_limit_micros: 60_000_000 } }))
    })
    route("post", "/campaigns/cmpn_101", () => apiError(503, "Service unavailable"))
    const r = await updateBudget(makeCtx(), { level: "campaign", id: "cmpn_101", type: "daily", amount: 60 })
    expect(writes()).toHaveLength(1)
    expect(gets).toBe(2)
    expect(r.changes[0]!.after).toMatchObject({ amount: 60 })
  })
})

describe("OpenAI Ads updateObject", () => {
  it("đổi giá thầu ad group: gửi lại bidding_config đầy đủ (giữ billing, strategy, multipliers)", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("post", "/ad_groups/adgrp_201", fx.adGroup)
    const r = await updateObject(makeCtx(), { level: "ad_group", id: "adgrp_201", changes: { bidAmount: 3 } })
    expect(writes()[0]!.body).toEqual({
      bidding_config: {
        billing_event_type: "click",
        strategy: "fixed_bid",
        max_bid_micros: 3_000_000,
        custom_audience_bid_multipliers: [{ custom_audience_id: "ca_1", bid_multiplier_micros: 1_500_000 }],
      },
    })
    expect(r.changes[0]).toMatchObject({ field: "max_bid", before: 2, after: 3 })
  })

  it("giá thầu ad group Maximize → từ chối, hướng dẫn dùng openai_ads_update_ad_group", async () => {
    route("get", "/ad_groups/adgrp_201", clone(fx.adGroup, { bidding_config: { billing_event_type: "click", strategy: "maximize_clicks" } }))
    await expect(updateObject(makeCtx(), { level: "ad_group", id: "adgrp_201", changes: { bidAmount: 3 } })).rejects.toMatchObject({
      code: "invalid_request",
      hint: expect.stringContaining("openai_ads_update_ad_group"),
    })
    expect(writes()).toHaveLength(0)
  })

  it("đổi URL đích của ad: gửi creative đầy đủ (không gửi image_url) + cảnh báo duyệt lại", async () => {
    route("get", "/ads/ad_301", fx.ad)
    route("post", "/ads/ad_301", fx.ad)
    const r = await updateObject(makeCtx(), { level: "ad", id: "ad_301", changes: { finalUrl: "https://example.com/new" } })
    expect(writes()[0]!.body).toEqual({
      creative: {
        type: "chat_card",
        title: "Find your next trail shoe",
        body: "Explore shoes made for your next outdoor run.",
        target_url: "https://example.com/new",
        file_id: "file_123",
      },
    })
    expect(r.warnings.join(" ")).toContain("DUYỆT LẠI")
  })

  it("đổi tên + lịch campaign: start/end gửi Unix giây", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/campaigns/cmpn_101", fx.campaign)
    await updateObject(makeCtx(), {
      level: "campaign",
      id: "cmpn_101",
      changes: { name: "Autumn launch", endTime: "2027-01-01T00:00:00-05:00" },
    })
    expect(writes()[0]!.body).toEqual({ name: "Autumn launch", end_time: Date.parse("2027-01-01T05:00:00Z") / 1000 })
  })

  it("503 khi sửa: verify so sánh trường đã đổi (updated_at đổi nhưng tên chưa đổi → thử lại 1 lần)", async () => {
    let gets = 0
    route("get", "/campaigns/cmpn_101", () => json(++gets === 1 ? fx.campaign : clone(fx.campaign, { updated_at: fx.campaign.updated_at + 60 })))
    route("post", "/campaigns/cmpn_101", (_c, n) => (n === 1 ? apiError(503, "Service unavailable") : json(clone(fx.campaign, { name: "Tên mới" }))))
    await updateObject(makeCtx(), { level: "campaign", id: "cmpn_101", changes: { name: "Tên mới" } })
    expect(writes()).toHaveLength(2) // updated_at moved but name did not → not treated as saved
  })

  it("503 khi sửa: verify thấy trường đã đổi → không gửi lại", async () => {
    let gets = 0
    route("get", "/campaigns/cmpn_101", () => json(++gets === 1 ? fx.campaign : clone(fx.campaign, { name: "Tên mới" })))
    route("post", "/campaigns/cmpn_101", () => apiError(503, "Service unavailable"))
    await updateObject(makeCtx(), { level: "campaign", id: "cmpn_101", changes: { name: "Tên mới" } })
    expect(writes()).toHaveLength(1)
  })

  it("409 khi đổi giá thầu: đọc lại và ghép trên cấu hình mới (giữ multipliers mới)", async () => {
    const fresh = clone(fx.adGroup, {
      bidding_config: { ...fx.adGroup.bidding_config, custom_audience_bid_multipliers: [{ custom_audience_id: "ca_9", bid_multiplier_micros: 2_000_000 }] },
    })
    let gets = 0
    route("get", "/ad_groups/adgrp_201", () => json(++gets === 1 ? fx.adGroup : fresh))
    route("post", "/ad_groups/adgrp_201", (_c, n) => (n === 1 ? apiError(409, "Revision conflict") : json(fresh)))
    await updateObject(makeCtx(), { level: "ad_group", id: "adgrp_201", changes: { bidAmount: 3 } })
    expect(writes()).toHaveLength(2)
    expect((writes()[1]!.body as { bidding_config: Record<string, unknown> }).bidding_config).toMatchObject({
      max_bid_micros: 3_000_000,
      custom_audience_bid_multipliers: [{ custom_audience_id: "ca_9", bid_multiplier_micros: 2_000_000 }],
    })
  })

  it("giá thầu làm tròn tới cent (USD); impression → bước 1/1000 cent", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("post", "/ad_groups/adgrp_201", fx.adGroup)
    const r = await updateObject(makeCtx(), { level: "ad_group", id: "adgrp_201", changes: { bidAmount: 2.345 } })
    expect((writes()[0]!.body as { bidding_config: { max_bid_micros: number } }).bidding_config.max_bid_micros).toBe(2_350_000)
    expect(r.warnings.join(" ")).toMatch(/làm tròn/)
  })

  it("lịch ở cấp ad group → unsupported", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    await expect(
      updateObject(makeCtx(), { level: "ad_group", id: "adgrp_201", changes: { startTime: "2026-11-01T00:00:00Z" } })
    ).rejects.toMatchObject({ code: "unsupported" })
  })

  it("dryRun không ghi", async () => {
    route("get", "/ads/ad_301", fx.ad)
    const r = await updateObject(makeCtx(), { level: "ad", id: "ad_301", changes: { name: "Renamed ad" } }, { dryRun: true })
    expect(r.preview).toBe(true)
    expect(r.changes).toHaveLength(1)
    expect(writes()).toHaveLength(0)
  })
})

describe("OpenAI Ads setStatus / deleteObject", () => {
  it("tạm dừng → POST /pause; đã tạm dừng thì bỏ qua", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("get", "/campaigns/cmpn_2", clone(fx.campaign, { id: "cmpn_2", status: "paused" }))
    route("post", "/campaigns/cmpn_101/pause", clone(fx.campaign, { status: "paused" }))
    const r = await setStatus(makeCtx(), "campaign", ["cmpn_101", "cmpn_2"], "paused")
    expect(writes().map((c) => c.path)).toEqual(["/campaigns/cmpn_101/pause"])
    expect(r.changes).toEqual([
      expect.objectContaining({ objectId: "cmpn_101", field: "status", before: "active", after: "paused" }),
    ])
    expect(r.warnings.join(" ")).toContain("bỏ qua")
  })

  it("bật quảng cáo đang chờ duyệt: POST /activate + cảnh báo", async () => {
    route("get", "/ads/ad_301", clone(fx.ad, { status: "paused" }))
    route("post", "/ads/ad_301/activate", fx.ad)
    const r = await setStatus(makeCtx(), "ad", ["ad_301"], "active")
    expect(writes()[0]!.path).toBe("/ads/ad_301/activate")
    expect(r.warnings.join(" ")).toContain("chờ duyệt")
  })

  it("dryRun setStatus không ghi", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    const r = await setStatus(makeCtx(), "campaign", ["cmpn_101"], "paused", { dryRun: true })
    expect(r.preview).toBe(true)
    expect(r.changes).toHaveLength(1)
    expect(writes()).toHaveLength(0)
  })

  it("xoá = archive không hoàn tác", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("post", "/ad_groups/adgrp_201/archive", clone(fx.adGroup, { status: "archived" }))
    const r = await deleteObject(makeCtx(), "ad_group", "adgrp_201")
    expect(writes()[0]!.path).toBe("/ad_groups/adgrp_201/archive")
    expect(r.changes[0]).toMatchObject({ before: "active", after: "archived" })
    expect(r.warnings.join(" ")).toContain("KHÔNG THỂ")
  })

  it("dryRun xoá không ghi", async () => {
    route("get", "/ads/ad_301", fx.ad)
    const r = await deleteObject(makeCtx(), "ad", "ad_301", { dryRun: true })
    expect(r.preview).toBe(true)
    expect(writes()).toHaveLength(0)
  })
})
