import { describe, expect, it } from "vitest"
import type { MutationResult } from "../types"
import { createIdempotencyKey } from "./client"
import { extensions } from "./extensions"
import { apiError, calls, clone, freezeDate, fx, json, makeCtx, route, setupHarness, writes } from "./__fixtures__/harness"
import type { ConversionsResult } from "./conversions"

setupHarness()

function ext(name: string) {
  const e = extensions.find((x) => x.name === name)
  if (!e) throw new Error(`missing ${name}`)
  return e
}

describe("OpenAI Ads extensions - metadata", () => {
  it("tên ≤40 ký tự, tiền tố openai_ads_, mô tả tiếng Việt bắt đầu 'Dùng khi'", () => {
    expect(extensions.map((e) => e.name).sort()).toEqual([
      "openai_ads_create_ad",
      "openai_ads_create_ad_group",
      "openai_ads_create_campaign",
      "openai_ads_get_conversions",
      "openai_ads_update_ad_group",
    ])
    for (const e of extensions) {
      expect(e.name.length).toBeLessThanOrEqual(40)
      expect(e.name).toMatch(/^openai_ads_[a-z0-9_]+$/)
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
    }
    expect(ext("openai_ads_get_conversions")).toMatchObject({ permission: "read", write: false })
    expect(ext("openai_ads_update_ad_group")).toMatchObject({ permission: "update", write: true })
  })
})

describe("openai_ads_create_campaign", () => {
  const input = {
    name: "Thu đông 2026",
    bidding_type: "clicks",
    budget: { type: "daily", amount: 25.5 },
    countries: ["vn"],
    platforms: ["ios_app", "web"],
  }

  it("ngân sách đơn vị chính → micros, luôn paused, Idempotency-Key suy ra từ opts (tất định)", async () => {
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new", status: "paused" }))
    const e = ext("openai_ads_create_campaign")
    const r = (await e.run(makeCtx(), e.input.parse(input), { idempotencyKey: "create-1" })) as MutationResult
    expect(r.createdIds).toEqual(["cmpn_new"])
    const ctx = makeCtx()
    expect(writes()[0]!.headers.get("idempotency-key")).toBe(
      createIdempotencyKey(ctx.account.externalId, "openai_ads_create_campaign", e.input.parse(input), "create-1")
    )
    expect(writes()[0]!.body).toEqual({
      name: "Thu đông 2026",
      status: "paused",
      budget: { daily_spend_limit_micros: 25_500_000 },
      bidding_type: "clicks",
      targeting: { locations: { countries: ["VN"] }, platforms: { included: ["ios_app", "web"] } },
    })
  })

  it("không có idempotencyKey → Idempotency-Key tất định từ input (không ngẫu nhiên): chạy lại không tạo trùng", async () => {
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new" }))
    const e = ext("openai_ads_create_campaign")
    await e.run(makeCtx(), e.input.parse(input), {})
    await e.run(makeCtx(), e.input.parse(input), {})
    await e.run(makeCtx(), e.input.parse({ ...input, name: "Tên khác" }), {})
    const keys = writes().map((w) => w.headers.get("idempotency-key"))
    expect(keys[0]).toMatch(/^adsmcp-[0-9a-f]{48}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })

  it("bắt buộc chọn địa điểm, trừ khi all_locations=true", async () => {
    const e = ext("openai_ads_create_campaign")
    const { countries: _c, ...noGeo } = input
    await expect(e.run(makeCtx(), e.input.parse(noGeo), { dryRun: true })).rejects.toMatchObject({ code: "invalid_request" })
    const r = (await e.run(makeCtx(), e.input.parse({ ...noGeo, all_locations: true }), { dryRun: true })) as MutationResult
    expect(r.warnings.join(" ")).toMatch(/MỌI địa điểm/)
    await expect(e.run(makeCtx(), e.input.parse({ ...input, all_locations: true }), { dryRun: true })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("ngân sách làm tròn tới đơn vị tiền nhỏ nhất (USD: cent)", async () => {
    route("post", "/campaigns", clone(fx.campaign, { id: "cmpn_new" }))
    const e = ext("openai_ads_create_campaign")
    const r = (await e.run(makeCtx(), e.input.parse({ ...input, budget: { type: "daily", amount: 25.555 } }), {})) as MutationResult
    expect(writes()[0]!.body).toMatchObject({ budget: { daily_spend_limit_micros: 25_560_000 } })
    expect(r.warnings.join(" ")).toMatch(/làm tròn/)
  })

  it("dryRun trả tóm tắt payload (đơn vị chính), không ghi", async () => {
    const e = ext("openai_ads_create_campaign")
    const r = (await e.run(makeCtx(), e.input.parse(input), { dryRun: true })) as MutationResult
    expect(r.preview).toBe(true)
    expect(calls).toHaveLength(0)
    expect(r.changes[0]!.after).toMatchObject({ status: "paused", budget: { type: "daily", amount: 25.5, currency: "USD" } })
  })

  it("conversions bắt buộc conversion_event_setting_id và kiểm tra sự kiện tồn tại", async () => {
    const e = ext("openai_ads_create_campaign")
    await expect(e.run(makeCtx(), e.input.parse({ ...input, bidding_type: "conversions" }), { dryRun: true })).rejects.toMatchObject({
      code: "invalid_request",
    })
    route("get", "/conversions/event_settings", () => apiError(404, "Not found"))
    await expect(
      e.run(makeCtx(), e.input.parse({ ...input, bidding_type: "conversions", conversion_event_setting_id: "ces_1" }), { dryRun: true })
    ).rejects.toMatchObject({ code: "feature_not_enabled" })
  })

  it("ngân sách < 1 bị chặn", async () => {
    const e = ext("openai_ads_create_campaign")
    await expect(e.run(makeCtx(), e.input.parse({ ...input, budget: { type: "daily", amount: 0.5 } }), {})).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(calls).toHaveLength(0)
  })
})

describe("openai_ads_create_ad_group", () => {
  const e = () => ext("openai_ads_create_ad_group")

  it("fixed_bid: max_bid đơn vị chính → micros; billing suy ra từ campaign; paused + Idempotency-Key", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/ad_groups", clone(fx.adGroup, { id: "adgrp_new" }))
    const input = e().input.parse({
      campaign_id: "cmpn_101",
      name: "Giày chạy trail",
      context_hints: ["giày chạy địa hình"],
      bidding: { max_bid: 2.5 },
    })
    await e().run(makeCtx(), input, {})
    expect(writes()[0]!.body).toEqual({
      campaign_id: "cmpn_101",
      name: "Giày chạy trail",
      status: "paused",
      context_hints: ["giày chạy địa hình"],
      bidding_config: { billing_event_type: "click", strategy: "fixed_bid", max_bid_micros: 2_500_000, custom_audience_bid_multipliers: [] },
    })
    expect(writes()[0]!.headers.get("idempotency-key")).toBeTruthy()
  })

  it("Maximize cần ngân sách hằng ngày", async () => {
    route("get", "/campaigns/cmpn_101", clone(fx.campaign, { budget: { lifetime_spend_limit_micros: 100_000_000 } }))
    const input = e().input.parse({ campaign_id: "cmpn_101", name: "Maximize", bidding: { strategy: "maximize_clicks" } })
    await expect(e().run(makeCtx(), input, {})).rejects.toMatchObject({ code: "invalid_request", userMessageVi: expect.stringContaining("HẰNG NGÀY") })
    expect(writes()).toHaveLength(0)
  })

  it("chiến lược không khớp mục tiêu campaign bị từ chối (impressions + maximize_clicks)", async () => {
    route("get", "/campaigns/cmpn_101", clone(fx.campaign, { bidding_type: "impressions" }))
    const input = e().input.parse({ campaign_id: "cmpn_101", name: "Bad combo", bidding: { strategy: "maximize_clicks" } })
    await expect(e().run(makeCtx(), input, {})).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("impressions: cảnh báo giá theo MỖI lượt hiển thị (không phải CPM)", async () => {
    route("get", "/campaigns/cmpn_101", clone(fx.campaign, { bidding_type: "impressions" }))
    const input = e().input.parse({ campaign_id: "cmpn_101", name: "Reach", bidding: { max_bid: 0.06 } })
    const r = (await e().run(makeCtx(), input, { dryRun: true })) as MutationResult
    expect(r.warnings.join(" ")).toContain("MỖI lượt hiển thị")
    expect(writes()).toHaveLength(0)
  })
})

describe("openai_ads_create_ad", () => {
  const e = () => ext("openai_ads_create_ad")
  const input = {
    ad_group_id: "adgrp_201",
    name: "Ad mới",
    title: "Giày trail mới",
    body: "Bám đường tốt, nhẹ chân.",
    target_url: "https://example.com/trail",
    image_url: "https://example.com/img.png",
  }

  it("image_url → tải ảnh trước, rồi tạo chat_card paused với file_id", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("post", "/upload", { file_id: "file_new" })
    route("post", "/ads", clone(fx.ad, { id: "ad_new" }))
    const r = (await e().run(makeCtx(), e().input.parse(input), { idempotencyKey: "ad-1" })) as MutationResult
    expect(writes().map((w) => w.path)).toEqual(["/upload", "/ads"])
    expect(writes()[0]!.body).toEqual({ image_url: "https://example.com/img.png" })
    expect(writes()[1]!.body).toEqual({
      ad_group_id: "adgrp_201",
      name: "Ad mới",
      status: "paused",
      creative: {
        type: "chat_card",
        title: "Giày trail mới",
        body: "Bám đường tốt, nhẹ chân.",
        target_url: "https://example.com/trail",
        file_id: "file_new",
      },
    })
    expect(writes()[1]!.headers.get("idempotency-key")).toMatch(/^adsmcp-[0-9a-f]{48}$/)
    expect(r.createdIds).toEqual(["ad_new"])
  })

  it("dryRun không tải ảnh, không tạo", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    const r = (await e().run(makeCtx(), e().input.parse(input), { dryRun: true })) as MutationResult
    expect(r.preview).toBe(true)
    expect(writes()).toHaveLength(0)
  })

  it("schema: title 3–50, body ≤100, đúng một trong file_id/image_url", () => {
    expect(e().input.safeParse({ ...input, title: "ab" }).success).toBe(false)
    expect(e().input.safeParse({ ...input, body: "x".repeat(101) }).success).toBe(false)
    expect(e().input.safeParse({ ...input, file_id: "file_1" }).success).toBe(false)
    const { image_url: _img, ...noImage } = input
    expect(e().input.safeParse(noImage).success).toBe(false)
  })
})

describe("openai_ads_update_ad_group", () => {
  const e = () => ext("openai_ads_update_ad_group")

  it("thêm context_hints: gửi lại danh sách đầy đủ đã gộp", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("post", "/ad_groups/adgrp_201", fx.adGroup)
    const input = e().input.parse({ ad_group_id: "adgrp_201", context_hints: { mode: "add", hints: ["Waterproof trail shoes"] } })
    await e().run(makeCtx(), input, {})
    expect(writes()[0]!.body).toEqual({ context_hints: [...fx.adGroup.context_hints, "Waterproof trail shoes"] })
  })

  it("chuyển sang maximize_clicks: bỏ max_bid, xoá multipliers, kiểm tra campaign", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("post", "/ad_groups/adgrp_201", fx.adGroup)
    const input = e().input.parse({ ad_group_id: "adgrp_201", campaign_id: "cmpn_101", bidding: { strategy: "maximize_clicks" } })
    const r = (await e().run(makeCtx(), input, {})) as MutationResult
    expect(writes()[0]!.body).toEqual({
      bidding_config: { billing_event_type: "click", strategy: "maximize_clicks", custom_audience_bid_multipliers: [] },
    })
    expect(r.warnings.join(" ")).toContain("bị xoá")
  })

  it("409 khi sửa: đọc lại + ghép lại thay đổi trên bản mới, không gửi lại body cũ", async () => {
    const fresh = clone(fx.adGroup, { context_hints: [...fx.adGroup.context_hints, "Added by someone else"] })
    let gets = 0
    route("get", "/ad_groups/adgrp_201", () => json(++gets === 1 ? fx.adGroup : fresh))
    let posts = 0
    route("post", "/ad_groups/adgrp_201", () => (++posts === 1 ? apiError(409, "Revision conflict") : json(fresh)))
    const input = e().input.parse({ ad_group_id: "adgrp_201", context_hints: { mode: "add", hints: ["Waterproof trail shoes"] } })
    await e().run(makeCtx(), input, {})
    expect(writes()).toHaveLength(2)
    expect(writes()[1]!.body).toEqual({ context_hints: [...fresh.context_hints, "Waterproof trail shoes"] })
  })

  it("max_bid của campaign conversions được gọi là CPA mục tiêu", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    route("get", "/campaigns/cmpn_101", clone(fx.campaign, { bidding_type: "conversions" }))
    const input = e().input.parse({ ad_group_id: "adgrp_201", campaign_id: "cmpn_101", bidding: { strategy: "fixed_bid", max_bid: 12.5 } })
    const r = (await e().run(makeCtx(), input, { dryRun: true })) as MutationResult
    expect(r.warnings.join(" ")).toMatch(/CPA MỤC TIÊU/)
    expect((r.changes[0]!.after as { max_bid_meaning: string }).max_bid_meaning).toMatch(/CPA mục tiêu/)
  })

  it("dryRun không ghi", async () => {
    route("get", "/ad_groups/adgrp_201", fx.adGroup)
    const input = e().input.parse({ ad_group_id: "adgrp_201", context_hints: { mode: "replace", hints: ["a hint"] } })
    const r = (await e().run(makeCtx(), input, { dryRun: true })) as MutationResult
    expect(r.preview).toBe(true)
    expect(writes()).toHaveLength(0)
  })
})

describe("openai_ads_get_conversions", () => {
  const e = () => ext("openai_ads_get_conversions")

  it("không truyền entity_ids → group_by_entity=false; time_ranges theo múi giờ tài khoản; doanh thu chuỗi → số", async () => {
    freezeDate()
    route("post", "/conversions/insights", fx.conversionsInsights)
    const input = e().input.parse({ level: "campaign", date_from: "2026-09-01", date_to: "2026-09-07" })
    const r = (await e().run(makeCtx(), input, {})) as ConversionsResult
    const body = calls[0]!.body as Record<string, unknown>
    expect(body.group_by_entity).toBe(false)
    expect(body.entity_ids).toBeUndefined()
    expect(body.time_granularity).toBe("none")
    // conversions time_ranges have an EXCLUSIVE end → inclusive 09-07 is sent as until 09-08
    expect((body.time_ranges as string[]).map((t) => JSON.parse(t))).toEqual([
      { type: "date_range", since: "2026-09-01", until: "2026-09-08", timezone: "America/New_York" },
    ])
    expect(r.rows[0]).toMatchObject({ entity_id: "cmpn_101", conversions: 10, order_created_attributed_sales: 100.5 })
    expect(r.currency).toBe("USD")
  })

  it("413 → tự chia khoảng ngày và cộng tổng", async () => {
    freezeDate()
    route("post", "/conversions/insights", (c) => {
      const tr = JSON.parse((c.body as { time_ranges: string[] }).time_ranges[0]!)
      if (tr.since === "2026-09-01" && tr.until === "2026-09-05") return apiError(413, "Report too large")
      return json({
        object: "list",
        account_currency: "USD",
        data: [
          {
            entity_id: "cmpn_101",
            conversions: 1,
            click_through_conversions: 1,
            view_through_conversions: 0,
            order_created_attributed_sales: "10",
            order_created_attributed_sales_currency: "USD",
          },
        ],
        count: 1,
      })
    })
    const input = e().input.parse({ level: "campaign", entity_ids: ["cmpn_101"], date_from: "2026-09-01", date_to: "2026-09-04" })
    const r = (await e().run(makeCtx(), input, {})) as ConversionsResult
    const ranges = calls.map((c) => JSON.parse((c.body as { time_ranges: string[] }).time_ranges[0]!))
    expect(ranges.map((t) => [t.since, t.until])).toEqual([
      ["2026-09-01", "2026-09-05"],
      ["2026-09-01", "2026-09-03"],
      ["2026-09-03", "2026-09-05"],
    ])
    expect(r.rows).toEqual([expect.objectContaining({ entity_id: "cmpn_101", conversions: 2, order_created_attributed_sales: 20 })])
    expect(r.warnings.join(" ")).toContain("chia")
  })

  it("khoảng ngày gồm hôm nay → chuyển đổi lấy tới hết hôm qua (cận trên không ở tương lai)", async () => {
    freezeDate()
    route("post", "/conversions/insights", fx.conversionsInsights)
    const today = new Date().toISOString().slice(0, 10)
    const input = e().input.parse({ level: "campaign", date_from: "2026-09-01", date_to: today })
    const r = (await e().run(makeCtx(), input, {})) as ConversionsResult
    const tr = JSON.parse((calls[0]!.body as { time_ranges: string[] }).time_ranges[0]!)
    expect(tr.until <= today).toBe(true)
    expect(r.warnings.join(" ")).toMatch(/hết hôm qua/)
  })

  it("tài khoản chưa bật conversions (404) → feature_not_enabled", async () => {
    freezeDate()
    route("post", "/conversions/insights", () => apiError(404, "Not found"))
    const input = e().input.parse({ level: "campaign", date_from: "2026-09-01", date_to: "2026-09-07" })
    await expect(e().run(makeCtx(), input, {})).rejects.toMatchObject({ code: "feature_not_enabled" })
  })
})
