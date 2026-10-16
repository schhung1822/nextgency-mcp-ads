import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { mapGraphError } from "./client"
import { archiveMetaObjects, deleteMetaObject, setMetaStatus, updateMetaBudget, updateMetaObject, validateOnly } from "./mutate"
import { batchRoute, graphError, json, mockGraph, providerCtx, type Route } from "./test-utils"

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

describe("validateOnly - path allow-list (create edges only)", () => {
  it("accepts act_X/{campaigns,adsets,ads,adcreatives} with execution_options=validate_only and refuses anything else before any call", async () => {
    const m = mockGraph([["POST", /^act_1001\/(campaigns|adsets|ads|adcreatives)$/, () => json({ success: true })]])
    for (const edge of ["campaigns", "adsets", "ads", "adcreatives"]) await validateOnly(providerCtx(), `act_1001/${edge}`, { name: "x" })
    expect(m.calls.map((c) => c.path)).toEqual(["act_1001/campaigns", "act_1001/adsets", "act_1001/ads", "act_1001/adcreatives"])
    for (const c of m.calls) expect(JSON.parse(c.params.execution_options)).toEqual(["validate_only"])
    for (const bad of ["11", "act_1001/adimages", "act_1001/adcreatives/x", "x/act_1001/ads", "act_1001/adcreatives?x=1"]) {
      await expect(validateOnly(providerCtx(), bad, {})).rejects.toThrow(/only allowed on create edges/)
    }
    expect(m.calls).toHaveLength(4)
  })
})

describe("updateMetaObject - final_url", () => {
  it("is refused before any call and points to meta_update_ad_creative", async () => {
    const m = mockGraph([])
    await expect(updateMetaObject(providerCtx(), { level: "ad", id: "11", changes: { finalUrl: "https://shop.vn" } })).rejects.toMatchObject({
      code: "invalid_request",
      hint: expect.stringContaining("meta_update_ad_creative"),
    })
    expect(m.calls).toHaveLength(0)
  })
})

describe("1487007 (ad set past its end date) on a budget edit", () => {
  it("→ hint to extend end_time, not 'archived / deleted'", async () => {
    mockGraph([
      ["GET", "2001", () => json(abosAdset)],
      ["POST", "2001", () => graphError(100, 1487007)],
    ])
    await expect(updateMetaBudget(providerCtx(), { level: "ad_group", id: "2001", type: "daily", amount: 600_000 })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/qua ngày kết thúc/),
      hint: expect.stringMatching(/Gia hạn end_time/),
    })
  })
})
describe("archiveMetaObjects (D3)", () => {
  const nodes = {
    "3001": {
      id: "3001",
      name: "Camp A",
      account_id: "1001",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      objective: "OUTCOME_SALES",
    },
    "3002": {
      id: "3002",
      name: "Camp B",
      account_id: "1001",
      status: "PAUSED",
      effective_status: "PAUSED",
      objective: "OUTCOME_SALES",
    },
    "3003": {
      id: "3003",
      name: "Camp lưu trữ",
      account_id: "1001",
      status: "ARCHIVED",
      effective_status: "ARCHIVED",
      objective: "OUTCOME_SALES",
    },
    "3004": {
      id: "3004",
      name: "Camp xoá",
      account_id: "1001",
      status: "DELETED",
      effective_status: "DELETED",
      objective: "OUTCOME_SALES",
    },
    "3005": {
      id: "3005",
      name: "Khác TK",
      account_id: "9999",
      status: "PAUSED",
      effective_status: "PAUSED",
      objective: "OUTCOME_SALES",
    },
  }

  it("dryRun reads only: changes before → ARCHIVED, not-reversible + children warnings, zero writes", async () => {
    const m = mockGraph([batchRoute(nodes)])
    const res = await archiveMetaObjects(
      providerCtx(),
      "campaign",
      ["3001", "3002"],
      { dryRun: true }
    )
    expect(res.preview).toBe(true)
    expect(
      res.changes.map((c) => [c.objectId, c.field, c.before, c.after])
    ).toEqual([
      ["3001", "status", "ACTIVE", "ARCHIVED"],
      ["3002", "status", "PAUSED", "ARCHIVED"],
    ])
    expect(res.warnings.join(" ")).toMatch(/chỉ cho đổi tên hoặc xoá/)
    expect(res.warnings.join(" ")).toMatch(/đối tượng con/)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("execute: one batch POST status=ARCHIVED; already archived / deleted objects are skipped with a warning", async () => {
    const m = mockGraph([batchRoute(nodes)])
    const res = await archiveMetaObjects(providerCtx(), "campaign", [
      "3001",
      "3003",
      "3004",
    ])
    expect(res.preview).toBe(false)
    expect(JSON.parse(m.mutatingPosts()[0].params.batch)).toEqual([
      { method: "POST", relative_url: "3001", body: "status=ARCHIVED" },
    ])
    expect(res.changes.map((c) => c.objectId)).toEqual(["3001"])
    expect(res.warnings.join(" ")).toMatch(
      /Camp lưu trữ \(3003\) đã ở trạng thái ARCHIVED - bỏ qua/
    )
    expect(res.warnings.join(" ")).toMatch(
      /Camp xoá \(3004\) đã bị xoá - bỏ qua/
    )
  })

  it("nothing left to archive → no write, no not-reversible warning", async () => {
    const m = mockGraph([batchRoute(nodes)])
    const res = await archiveMetaObjects(providerCtx(), "campaign", ["3003"])
    expect(res.changes).toEqual([])
    expect(res.warnings.join(" ")).not.toMatch(/không hoàn tác/)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("an object of another ad account is not found (grant boundary), nothing written", async () => {
    const m = mockGraph([batchRoute(nodes)])
    await expect(
      archiveMetaObjects(providerCtx(), "campaign", ["3001", "3005"])
    ).rejects.toMatchObject({ code: "not_found" })
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("Meta's 'too many archived objects' (1487990) is a clear Vietnamese error", () => {
    const err = mapGraphError(
      { message: "too many archived", code: 100, error_subcode: 1487990 },
      400,
      null
    )
    expect(err).toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/quá nhiều đối tượng được lưu trữ/),
    })
  })

  it("active / paused on an archived object is refused before any write, preview included (C4)", async () => {
    for (const status of ["active", "paused"] as const) {
      for (const opts of [{}, { dryRun: true }]) {
        const m = mockGraph([batchRoute(nodes)])
        await expect(
          setMetaStatus(providerCtx(), "campaign", ["3001", "3003"], status, opts)
        ).rejects.toMatchObject({
          code: "invalid_request",
          userMessageVi: expect.stringMatching(/3003.*đang được lưu trữ/),
          hint: expect.stringMatching(/ads_copy_object/),
        })
        expect(m.mutatingPosts()).toHaveLength(0)
      }
    }
  })
})

describe("updateMetaObject - start_time (B4) and creative (D1)", () => {
  const future = (days: number) =>
    new Date(Date.now() + days * 86_400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "+00:00")
  const adset = (start: string) => ({
    ...abosAdset,
    start_time: start,
    end_time: undefined,
  })

  it("an ad set whose start time has passed: changing start_time is refused before any write (preview too)", async () => {
    for (const opts of [{}, { dryRun: true }]) {
      const m = mockGraph([
        ["GET", "2001", () => json(adset("2026-10-01T00:00:00+0700"))],
      ])
      await expect(
        updateMetaObject(
          providerCtx(),
          { level: "ad_group", id: "2001", changes: { startTime: future(3) } },
          opts
        )
      ).rejects.toMatchObject({
        code: "invalid_request",
        userMessageVi: expect.stringMatching(/đã tới thời gian bắt đầu/),
        hint: expect.stringMatching(/end_time.*ads_copy_object/),
      })
      expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
    }
  })

  it("the same start instant (other offset) is no change; end_time can still be changed on a started ad set", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset("2026-10-01T00:00:00+0700"))],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await updateMetaObject(providerCtx(), {
      level: "ad_group",
      id: "2001",
      changes: { startTime: "2026-09-30T17:00:00+00:00", endTime: future(30) },
    })
    expect(res.changes.map((c) => c.field)).toEqual(["end_time"])
    expect(m.mutatingPosts()[0].params.start_time).toBeUndefined()
  })

  it("an ad set that has not started yet: start_time is sent", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset(future(5)))],
      ["POST", "2001", () => json({ success: true })],
    ])
    const start = future(2)
    const res = await updateMetaObject(providerCtx(), {
      level: "ad_group",
      id: "2001",
      changes: { startTime: start },
    })
    expect(m.mutatingPosts()[0].params.start_time).toBe(start)
    expect(res.changes[0]).toMatchObject({ field: "start_time", after: start })
  })

  it("campaign start_time is read-only on Meta → refused before any call", async () => {
    const m = mockGraph([])
    await expect(
      updateMetaObject(providerCtx(), {
        level: "campaign",
        id: "3001",
        changes: { startTime: future(2) },
      })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/chỉ đọc/),
    })
    expect(m.calls).toHaveLength(0)
  })

  it("creative changes are unsupported on Meta (meta_update_ad_creative), before any call", async () => {
    const m = mockGraph([])
    await expect(
      updateMetaObject(providerCtx(), {
        level: "ad",
        id: "4001",
        changes: { creative: { adText: "Mới" } },
      })
    ).rejects.toMatchObject({
      code: "unsupported",
      hint: expect.stringMatching(/meta_update_ad_creative/),
    })
    expect(m.calls).toHaveLength(0)
  })
})

describe("status batch with an op of unknown outcome (security follow-up)", () => {
  const nodes: Record<string, Record<string, unknown>> = {
    "11": {
      id: "11",
      name: "Ad 1",
      account_id: "1001",
      status: "PAUSED",
      effective_status: "PAUSED",
      adset_id: "2001",
    },
    "12": {
      id: "12",
      name: "Ad 2",
      account_id: "1001",
      status: "PAUSED",
      effective_status: "PAUSED",
      adset_id: "2001",
    },
  }
  const denied = {
    code: 403,
    body: JSON.stringify({
      error: { message: "(#200) denied", type: "OAuthException", code: 200 },
    }),
  }
  const applied = { code: 200, body: JSON.stringify({ success: true }) }
  /** reads answer the nodes; the write batch answers `writes` */
  const batch = (writes: unknown[]): Route => [
    "POST",
    "",
    (c) => {
      const ops = JSON.parse(c.params.batch) as {
        method: string
        relative_url: string
      }[]
      if (ops.every((o) => o.method === "GET"))
        return json(
          ops.map((o) => ({
            code: 200,
            body: JSON.stringify(nodes[o.relative_url.split("?")[0]]),
          }))
        )
      return json(writes)
    },
  ]

  it("one op refused (#200) + one op without answer → uncertain error with audit + ids, never the definite #200", async () => {
    for (const run of [
      () => setMetaStatus(providerCtx(), "ad", ["11", "12"], "active"),
      () => archiveMetaObjects(providerCtx(), "ad", ["11", "12"]),
    ]) {
      const m = mockGraph([batch([denied, null])])
      const e = await run().catch((x: unknown) => x)
      expect(e).toMatchObject({
        code: "timeout",
        retryable: false,
        audit: {
          errorCode: "status_outcome_unknown",
          changes: [expect.objectContaining({ objectId: "12" })],
        },
        userMessageVi: expect.stringMatching(/có thể đã thực hiện với: 12/),
        hint: expect.stringMatching(/ads_get_object/),
      })
      expect(m.mutatingPosts()).toHaveLength(1)
    }
  })

  it("every op definitely refused → the platform error itself (no audit)", async () => {
    mockGraph([batch([denied, denied])])
    const e = await setMetaStatus(
      providerCtx(),
      "ad",
      ["11", "12"],
      "active"
    ).catch((x: unknown) => x)
    expect(e).toMatchObject({
      code: "permission_denied",
      upstream: { code: 200 },
    })
    expect((e as { audit?: unknown }).audit).toBeUndefined()
  })

  it("one op applied + one 5xx → success with the applied change and a re-check warning", async () => {
    mockGraph([
      batch([
        applied,
        {
          code: 500,
          body: JSON.stringify({ error: { message: "x", code: 2 } }),
        },
      ]),
    ])
    const res = await setMetaStatus(providerCtx(), "ad", ["11", "12"], "active")
    expect(res.changes.map((c) => c.objectId)).toEqual(["11"])
    expect(res.warnings.join(" ")).toMatch(
      /Không rõ Ad 2 \(12\).*ads_get_object/
    )
  })
})
