import { describe, expect, it } from "vitest"
import { getObject, listObjects } from "./objects"
import { calls, clone, fx, list, makeCtx, route, setupHarness } from "./__fixtures__/harness"

setupHarness()

describe("OpenAI Ads objects", () => {
  it("liệt kê campaign: ngân sách micros → đơn vị chính, chỉ ở cấp campaign; cursor theo last_id", async () => {
    route("get", "/campaigns", list([fx.campaign], true))
    const page = await listObjects(makeCtx(), { level: "campaign", limit: 1 })
    expect(page.items).toHaveLength(1)
    const c = page.items[0]!
    expect(c.budget).toEqual({ type: "daily", amount: 50, currency: "USD", level: "campaign" })
    expect(c.status).toBe("active")
    expect(c.objective).toBe("clicks")
    expect(c.startTime).toBe(new Date(fx.campaign.start_time * 1000).toISOString())
    expect(page.nextCursor).toBeTruthy()

    route("get", "/campaigns", list([clone(fx.campaign, { id: "cmpn_102" })], false))
    const page2 = await listObjects(makeCtx(), { level: "campaign", limit: 1, cursor: page.nextCursor })
    expect(calls[1]!.url.searchParams.get("after")).toBe("cmpn_101")
    expect(page2.nextCursor).toBeNull()
  })

  it("ad group lọc theo campaign_id; ad lọc theo ad_group_id; ad in_review → pending_review", async () => {
    route("get", "/ad_groups", list([fx.adGroup]))
    const groups = await listObjects(makeCtx(), { level: "ad_group", parentId: "cmpn_101", limit: 50 })
    expect(calls[0]!.url.searchParams.get("campaign_id")).toBe("cmpn_101")
    expect(groups.items[0]!.parentId).toBe("cmpn_101")
    expect(groups.items[0]!.budget).toBeNull()

    route("get", "/ads", list([fx.ad, clone(fx.ad, { id: "ad_302", review_status: "rejected", status: "paused" })]))
    const ads = await listObjects(makeCtx(), { level: "ad", parentId: "adgrp_201", limit: 50 })
    expect(calls[1]!.url.searchParams.get("ad_group_id")).toBe("adgrp_201")
    expect(ads.items.map((a) => a.status)).toEqual(["pending_review", "rejected"])
    expect(ads.items[0]!.statusRaw).toBe("active")
  })

  it("lọc trạng thái phía ứng dụng", async () => {
    route("get", "/campaigns", list([fx.campaign, clone(fx.campaign, { id: "cmpn_2", status: "paused" })]))
    const page = await listObjects(makeCtx(), { level: "campaign", statuses: ["paused"], limit: 10 })
    expect(page.items.map((i) => i.id)).toEqual(["cmpn_2"])
  })

  it("getObject includeChildren dựng cây campaign → ad group → ad", async () => {
    route("get", "/campaigns/cmpn_101", fx.campaign)
    route("get", "/ad_groups", list([fx.adGroup]))
    route("get", "/ads", list([fx.ad]))
    const d = await getObject(makeCtx(), "campaign", "cmpn_101", { includeChildren: true })
    expect(d.children).toHaveLength(1)
    expect(d.children![0]!.id).toBe("adgrp_201")
    expect(d.children![0]!.config.bidding_config).toMatchObject({ strategy: "fixed_bid", max_bid: 2, billing_event_type: "click" })
    expect(d.children![0]!.children![0]!.id).toBe("ad_301")
    expect(d.children![0]!.children![0]!.parentId).toBe("adgrp_201")
  })
})
