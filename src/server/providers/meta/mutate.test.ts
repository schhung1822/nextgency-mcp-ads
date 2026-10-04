import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { deleteMetaObject, setMetaStatus, updateMetaBudget, updateMetaObject } from "./mutate"
import { batchRoute, graphError, json, mockGraph, providerCtx } from "./test-utils"

beforeEach(() => __resetBuckets())

const abosAdset = {
  id: "2001",
  name: "Nhóm A",
  account_id: "1001",
  campaign_id: "3001",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  daily_budget: "500000",
  budget_remaining: "500000",
  campaign: { id: "3001", name: "Camp", daily_budget: undefined },
}

describe("updateMetaBudget - money units", () => {
  it("VND (offset 1): 1.000.000đ is sent as daily_budget=1000000", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(abosAdset)],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "daily", amount: 1_000_000 })
    const post = m.mutatingPosts()
    expect(post).toHaveLength(1)
    expect(post[0].params.daily_budget).toBe("1000000")
    expect(res.changes[0]).toMatchObject({ field: "daily_budget", before: 500000, after: 1000000 })
    expect(res.warnings.join(" ")).toMatch(/tăng 100%/)
    expect(res.warnings.join(" ")).toMatch(/4 lần\/giờ/)
  })

  it("USD (offset 100): 12.5 USD is sent as 1250 cents; before is read in major units", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json({ ...abosAdset, daily_budget: "1000" })],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await updateMetaBudget(providerCtx({ currency: "USD", timezone: "America/New_York" }), {
      level: "ad_group",
      id: "2001",
      type: "daily",
      amount: 12.5,
    })
    expect(m.mutatingPosts()[0].params.daily_budget).toBe("1250")
    expect(res.changes[0]).toMatchObject({ before: 10, after: 12.5 })
  })

  it("dryRun on an update sends zero POSTs (validate_only is not documented on POST /{id})", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(abosAdset)],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "daily", amount: 600_000 }, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(res.changes[0]).toMatchObject({ field: "daily_budget", before: 500000, after: 600000 })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  it("refuses ad-set budget when the campaign uses CBO", async () => {
    const m = mockGraph([["GET", "2001", () => json({ ...abosAdset, daily_budget: undefined, campaign: { id: "3001", daily_budget: "2000000" } })]])
    await expect(updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "daily", amount: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  it("refuses campaign budget when the campaign uses ABO", async () => {
    mockGraph([["GET", "3001", () => json({ id: "3001", name: "Camp", account_id: "1001", objective: "OUTCOME_SALES", status: "PAUSED" })]])
    await expect(updateMetaBudget(providerCtx(), { level: "campaign", id: "3001", type: "daily", amount: 100000 })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("refuses switching daily ↔ lifetime", async () => {
    mockGraph([["GET", "2001", () => json(abosAdset)]])
    await expect(updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "lifetime", amount: 9_000_000 })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("treats an object from another ad account as not found (grant boundary)", async () => {
    const m = mockGraph([["GET", "2001", () => json({ ...abosAdset, account_id: "999" })]])
    await expect(updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "daily", amount: 1 })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})

describe("setMetaStatus", () => {
  const nodes = {
    "11": { id: "11", name: "Ad 1", account_id: "1001", status: "PAUSED", effective_status: "PAUSED", adset_id: "2001" },
    "12": { id: "12", name: "Ad 2", account_id: "1001", status: "PAUSED", effective_status: "ADSET_PAUSED", adset_id: "2001" },
    "13": { id: "13", name: "Ad 3", account_id: "1001", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "2001" },
  }

  it("uses one batch call and reports before/after; skips objects already in the target status", async () => {
    const m = mockGraph([batchRoute(nodes)])
    const res = await setMetaStatus(providerCtx(), "ad", ["11", "12", "13"], "active")
    expect(m.mutatingPosts()).toHaveLength(1)
    const batch = JSON.parse(m.mutatingPosts()[0].params.batch)
    expect(batch).toEqual([
      { method: "POST", relative_url: "11", body: "status=ACTIVE" },
      { method: "POST", relative_url: "12", body: "status=ACTIVE" },
    ])
    expect(res.changes.map((c) => [c.objectId, c.before, c.after])).toEqual([
      ["11", "PAUSED", "ACTIVE"],
      ["12", "PAUSED", "ACTIVE"],
    ])
    expect(res.warnings.join(" ")).toMatch(/cấp cha đang tạm dừng/)
    expect(res.warnings.join(" ")).toMatch(/đã ở trạng thái ACTIVE/)
    // reads go through one batch of GETs (v26 rejects `?ids=`), each with the level probe field
    const reads = JSON.parse(m.calls[0].params.batch) as { method: string; relative_url: string }[]
    expect(reads.map((r) => r.method)).toEqual(["GET", "GET", "GET"])
    expect(decodeURIComponent(reads[0].relative_url)).toMatch(/^11\?fields=.*adset_id/)
    expect(m.calls.some((c) => "ids" in c.params)).toBe(false)
  })

  it("dryRun never sends a mutating request", async () => {
    const m = mockGraph([batchRoute(nodes)])
    const res = await setMetaStatus(providerCtx(), "ad", ["11", "12"], "active", { dryRun: true })
    expect(res.preview).toBe(true)
    expect(res.changes).toHaveLength(2)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("reports an unknown id as not found and posts nothing", async () => {
    const m = mockGraph([batchRoute(nodes)])
    await expect(setMetaStatus(providerCtx(), "ad", ["11", "404"], "paused")).rejects.toMatchObject({ code: "not_found" })
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("aborts before any write when a read is throttled", async () => {
    const throttled = { code: 400, body: JSON.stringify({ error: { message: "Too many calls", type: "OAuthException", code: 17 } }) }
    const m = mockGraph([["POST", "", () => json([throttled])]])
    await expect(setMetaStatus(providerCtx(), "ad", ["11"], "paused")).rejects.toMatchObject({ code: "rate_limited" })
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("rejects more than 50 ids", async () => {
    mockGraph([])
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1))
    await expect(setMetaStatus(providerCtx(), "ad", ids, "paused")).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("updateMetaObject / deleteMetaObject", () => {
  it("updates name + end_time on an ad set; bid in minor units", async () => {
    const m = mockGraph([
      [
        "GET",
        "2001",
        () =>
          json({ ...abosAdset, start_time: "2026-10-01T00:00:00+0700", end_time: "2026-12-31T00:00:00+0700", bid_strategy: "COST_CAP", bid_amount: "15000" }),
      ],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await updateMetaObject(providerCtx(), {
      level: "ad_group",
      id: "2001",
      changes: { name: "Nhóm A v2", endTime: "2027-01-31T23:59:00+07:00", bidAmount: 20_000 },
    })
    const p = m.mutatingPosts()[0].params
    expect(p).toMatchObject({ name: "Nhóm A v2", end_time: "2027-01-31T23:59:00+07:00", bid_amount: "20000" })
    expect(res.changes.find((c) => c.field === "bid_amount")).toMatchObject({ before: 15000, after: 20000 })
  })

  it("renames an ad without requesting start_time/end_time (ads have no such fields → #100)", async () => {
    const m = mockGraph([
      [
        "GET",
        "4001",
        (c) => {
          const f = c.params.fields.split(",")
          if (f.some((x) => ["start_time", "end_time", "stop_time"].includes(x))) {
            return graphError(100, undefined, { message: "Tried accessing nonexisting field (start_time)" })
          }
          return json({ id: "4001", name: "Ad cũ", account_id: "1001", campaign_id: "3001", status: "PAUSED", effective_status: "PAUSED" })
        },
      ],
      ["POST", "4001", () => json({ success: true })],
    ])
    const res = await updateMetaObject(providerCtx(), { level: "ad", id: "4001", changes: { name: "Ad mới" } })
    expect(res.changes).toEqual([expect.objectContaining({ field: "name", before: "Ad cũ", after: "Ad mới" })])
    expect(m.mutatingPosts()[0].params).toMatchObject({ name: "Ad mới" })
  })

  it("requests only the schedule fields valid for each level", async () => {
    const seen: Record<string, string[]> = {}
    const node = (id: string, extra: Record<string, unknown>) => ({ id, name: "X", account_id: "1001", status: "PAUSED", ...extra })
    mockGraph([
      ["GET", "3001", (c) => ((seen.campaign = c.params.fields.split(",")), json(node("3001", { objective: "OUTCOME_SALES" })))],
      ["GET", "2001", (c) => ((seen.adset = c.params.fields.split(",")), json(node("2001", { campaign_id: "3001" })))],
      ["GET", "4001", (c) => ((seen.ad = c.params.fields.split(",")), json(node("4001", { campaign_id: "3001" })))],
    ])
    for (const [level, id] of [["campaign", "3001"], ["ad_group", "2001"], ["ad", "4001"]] as const) {
      await updateMetaObject(providerCtx(), { level, id, changes: { name: "X" } }, { dryRun: true })
    }
    expect(seen.campaign).toEqual(expect.arrayContaining(["start_time", "stop_time"]))
    expect(seen.campaign).not.toContain("end_time")
    expect(seen.adset).toEqual(expect.arrayContaining(["start_time", "end_time"]))
    expect(seen.adset).not.toContain("stop_time")
    for (const f of ["start_time", "end_time", "stop_time"]) expect(seen.ad).not.toContain(f)
  })

  it("dryRun of an object update sends zero POSTs", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json({ ...abosAdset, start_time: "2026-10-01T00:00:00+0700", bid_strategy: "COST_CAP", bid_amount: "15000" })],
    ])
    const res = await updateMetaObject(
      providerCtx(),
      { level: "ad_group", id: "2001", changes: { name: "Nhóm B", bidAmount: 18_000 } },
      { dryRun: true }
    )
    expect(res.preview).toBe(true)
    expect(res.changes.map((c) => c.field)).toEqual(["name", "bid_amount"])
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  it("rejects dates without a time zone offset", async () => {
    mockGraph([])
    await expect(
      updateMetaObject(providerCtx(), { level: "campaign", id: "3001", changes: { endTime: "2027-01-31 23:59" } })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("delete → status=DELETED; dryRun does not POST", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json({ id: "3001", name: "Camp", account_id: "1001", status: "PAUSED", objective: "OUTCOME_SALES" })],
      ["POST", "3001", () => json({ success: true })],
    ])
    const preview = await deleteMetaObject(providerCtx(), "campaign", "3001", { dryRun: true })
    expect(preview.preview).toBe(true)
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
    const done = await deleteMetaObject(providerCtx(), "campaign", "3001")
    expect(done.changes[0]).toMatchObject({ before: "PAUSED", after: "DELETED" })
    expect(m.mutatingPosts()[0].params.status).toBe("DELETED")
  })
})
