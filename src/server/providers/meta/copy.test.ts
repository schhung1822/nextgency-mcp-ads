import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { copyMetaObject } from "./copy"
import { graphError, json, mockGraph, providerCtx, type Route } from "./test-utils"

beforeEach(() => __resetBuckets())

const campaign = { id: "3001", name: "Camp", account_id: "1001", objective: "OUTCOME_SALES", daily_budget: "2000000" }
const adsets = [
  { id: "2001", name: "A (2 ads)", status: "ACTIVE" },
  { id: "2002", name: "B (5 ads)", status: "ACTIVE" },
  { id: "2003", name: "C (fails)", status: "PAUSED" },
]
const ads = [
  ...["11", "12"].map((id) => ({ id, name: `ad ${id}`, adset_id: "2001" })),
  ...["21", "22", "23", "24", "25"].map((id) => ({ id, name: `ad ${id}`, adset_id: "2002" })),
  { id: "31", name: "ad 31", adset_id: "2003" },
]

function routes(): Route[] {
  return [
    ["GET", "3001", () => json(campaign)],
    ["GET", "3001/adsets", () => json({ data: adsets })],
    ["GET", "3001/ads", () => json({ data: ads })],
    ["POST", "3001/copies", () => json({ copied_campaign_id: "9001", ad_object_ids: [] })],
    [
      "POST",
      "2001/copies",
      () =>
        json({
          copied_adset_id: "9101",
          ad_object_ids: [
            { ad_object_type: "ad_set", source_id: "2001", copied_id: "9101" },
            { ad_object_type: "ad", source_id: "11", copied_id: "9911" },
            { ad_object_type: "ad", source_id: "12", copied_id: "9912" },
          ],
        }),
    ],
    ["POST", "2002/copies", () => json({ copied_adset_id: "9102" })],
    ["POST", "2003/copies", () => graphError(100, 1487694, { error_user_msg: "Sở thích đã ngừng hỗ trợ" })],
    ["POST", "23/copies", () => graphError(100, undefined, { error_user_msg: "Creative không hợp lệ" })],
    ["POST", /^2[1-5]\/copies$/, (c) => json({ copied_ad_id: `99${c.path.slice(0, 2)}` })],
  ]
}

describe("copyMetaObject - campaign deep copy strategy", () => {
  it("shallow campaign → per-adset (deep only when ≤3 ads) → per-ad; PAUSED; partial failures don't stop other branches", async () => {
    const m = mockGraph(routes())
    const res = await copyMetaObject(providerCtx(), { level: "campaign", id: "3001", deep: true, nameSuffix: " - Bản sao" })

    const posts = m.calls.filter((c) => c.method === "POST")
    for (const p of posts) expect(p.params.status_option).toBe("PAUSED")

    const camp = posts.find((p) => p.path === "3001/copies")!
    expect(camp.params.deep_copy).toBe("false")
    expect(JSON.parse(camp.params.rename_options)).toEqual({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: " - Bản sao" })

    const a = posts.find((p) => p.path === "2001/copies")!
    expect(a.params).toMatchObject({ campaign_id: "9001", deep_copy: "true" }) // 2 ads ≤ 3 → native deep copy
    expect(JSON.parse(a.params.rename_options)).toEqual({ rename_strategy: "NO_RENAME" })

    const b = posts.find((p) => p.path === "2002/copies")!
    expect(b.params).toMatchObject({ campaign_id: "9001", deep_copy: "false" }) // 5 ads > 3 → shallow + per-ad
    const adCopies = posts.filter((p) => /^2[1-5]\/copies$/.test(p.path))
    expect(adCopies).toHaveLength(5)
    for (const p of adCopies) expect(p.params.adset_id).toBe("9102")

    // C failed → its ad is skipped, not copied
    expect(posts.some((p) => p.path === "31/copies")).toBe(false)

    expect(res.preview).toBe(false)
    expect(res.mode).toBe("emulated")
    expect(res.rootNewId).toBe("9001")
    const map = Object.fromEntries(res.mappings.map((x) => [`${x.level}:${x.sourceId}`, x]))
    expect(map["campaign:3001"].newId).toBe("9001")
    expect(map["ad_group:2001"].newId).toBe("9101")
    expect(map["ad:11"].newId).toBe("9911")
    expect(map["ad:12"].newId).toBe("9912")
    expect(map["ad_group:2002"].newId).toBe("9102")
    expect(map["ad:21"].newId).toBe("9921")
    expect(map["ad:23"]).toMatchObject({ newId: null, error: "Creative không hợp lệ" })
    expect(map["ad:25"].newId).toBe("9925")
    expect(map["ad_group:2003"]).toMatchObject({ newId: null, error: "Sở thích đã ngừng hỗ trợ" })
    expect(map["ad:31"].newId).toBeNull()
    expect(res.warnings.join(" ")).toMatch(/TẠM DỪNG/)
    expect(res.warnings[0]).toMatch(/3 lỗi/)
  })

  it("dryRun returns the planned tree without any POST", async () => {
    const m = mockGraph(routes())
    const res = await copyMetaObject(providerCtx(), { level: "campaign", id: "3001", deep: true }, { dryRun: true })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
    expect(res.preview).toBe(true)
    expect(res.mappings).toHaveLength(1 + 3 + 8)
    expect(res.mappings.every((x) => x.newId === null)).toBe(true)
  })

  it("shallow (deep=false) copies only the campaign", async () => {
    const m = mockGraph(routes())
    const res = await copyMetaObject(providerCtx(), { level: "campaign", id: "3001", deep: false })
    expect(m.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["3001/copies"])
    expect(res.mode).toBe("native")
    expect(res.mappings).toEqual([{ level: "campaign", sourceId: "3001", newId: "9001" }])
  })

  it("refuses deep copies above 50 ads", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: String(500 + i), adset_id: "2001" }))
    const m = mockGraph([
      ["GET", "3001", () => json(campaign)],
      ["GET", "3001/adsets", () => json({ data: [adsets[0]] })],
      ["GET", "3001/ads", () => json({ data: many })],
    ])
    await expect(copyMetaObject(providerCtx(), { level: "campaign", id: "3001", deep: true })).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})

describe("copyMetaObject - ad set and ad", () => {
  it("ad set with ≤3 ads uses one native deep copy into the same campaign", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json({ id: "2001", name: "A", account_id: "1001", campaign_id: "3001", daily_budget: "100000" })],
      ["GET", "2001/ads", () => json({ data: ads.slice(0, 2) })],
      ...routes().filter((r) => r[1] === "2001/copies"),
    ])
    const res = await copyMetaObject(providerCtx(), { level: "ad_group", id: "2001", deep: true, namePrefix: "[Copy] " })
    const post = m.calls.find((c) => c.method === "POST")!
    expect(post.params).toMatchObject({ campaign_id: "3001", deep_copy: "true", status_option: "PAUSED" })
    expect(JSON.parse(post.params.rename_options)).toEqual({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_prefix: "[Copy] " })
    expect(res.rootNewId).toBe("9101")
    expect(res.mappings).toHaveLength(3)
  })

  it("ad copy into another ad set of the same account", async () => {
    const m = mockGraph([
      ["GET", "11", () => json({ id: "11", name: "ad", account_id: "1001", campaign_id: "3001", adset_id: "2001" })],
      ["GET", "2002", () => json({ id: "2002", name: "B", account_id: "1001", campaign_id: "3001" })],
      ["POST", "11/copies", () => json({ copied_ad_id: "9911" })],
    ])
    const res = await copyMetaObject(providerCtx(), { level: "ad", id: "11", deep: false, targetParentId: "2002" })
    expect(m.calls.find((c) => c.method === "POST")!.params).toMatchObject({ adset_id: "2002", status_option: "PAUSED" })
    expect(res).toMatchObject({ rootNewId: "9911", mode: "native" })
  })

  it("refuses a target ad set from another ad account", async () => {
    const m = mockGraph([
      ["GET", "11", () => json({ id: "11", name: "ad", account_id: "1001", campaign_id: "3001", adset_id: "2001" })],
      ["GET", "7777", () => json({ id: "7777", name: "X", account_id: "4242", campaign_id: "1" })],
    ])
    await expect(copyMetaObject(providerCtx(), { level: "ad", id: "11", deep: false, targetParentId: "7777" })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})
