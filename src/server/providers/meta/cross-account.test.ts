// Graph object ids are GLOBAL: a token that can see ad accounts A and B can address B's campaign through the
// connection scoped to A. Every Meta entry point that takes an object id must therefore verify that the object
// belongs to the ad account the MCP was granted - otherwise the account scope of an MCP is only cosmetic.
import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { copyMetaObject } from "./copy"
import { metaExtensions } from "./extensions"
import { deleteMetaObject, setMetaStatus, updateMetaBudget, updateMetaObject } from "./mutate"
import { getMetaObject, listMetaObjects } from "./objects"
import { batchRoute, json, mockGraph, providerCtx } from "./test-utils"

beforeEach(() => __resetBuckets())

// granted account: act_1001. These objects live in ANOTHER ad account (act_2002) of the same token.
const foreign = (extra: Record<string, unknown> = {}) => ({
  id: "9001",
  name: "Chiến dịch của TKQC khác",
  account_id: "2002",
  campaign_id: "9000",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_SALES",
  optimization_goal: "LINK_CLICKS",
  adset_id: "9002",
  daily_budget: "500000",
  ...extra,
})
const notFound = { code: "not_found" }

describe("Meta adapter refuses object ids of another ad account", () => {
  it("setStatus: nothing is posted", async () => {
    const m = mockGraph([batchRoute({ "9001": foreign() })])
    await expect(setMetaStatus(providerCtx(), "campaign", ["9001"], "paused")).rejects.toMatchObject(notFound)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("updateBudget / updateObject / delete: nothing is posted", async () => {
    const m = mockGraph([
      ["GET", "9001", () => json(foreign())],
      ["POST", /.*/, () => json({ success: true })],
      ["DELETE", /.*/, () => json({ success: true })],
    ])
    await expect(updateMetaBudget(providerCtx(), { level: "campaign", id: "9001", type: "daily", amount: 500_000 })).rejects.toMatchObject(notFound)
    await expect(updateMetaObject(providerCtx(), { level: "campaign", id: "9001", changes: { name: "pwned" } })).rejects.toMatchObject(notFound)
    await expect(deleteMetaObject(providerCtx(), "campaign", "9001")).rejects.toMatchObject(notFound)
    expect(m.mutatingPosts()).toHaveLength(0)
    expect(m.calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
  })

  it("getObject and listObjects(parent): the foreign object's data is not returned", async () => {
    mockGraph([
      ["GET", "9001", () => json(foreign())],
      ["GET", "9000", () => json(foreign({ id: "9000" }))],
    ])
    await expect(getMetaObject(providerCtx(), "campaign", "9001")).rejects.toMatchObject(notFound)
    await expect(listMetaObjects(providerCtx(), { level: "ad_group", parentId: "9000", limit: 10 })).rejects.toMatchObject(notFound)
  })

  it("copy (campaign / ad set into a foreign parent / ad): nothing is copied", async () => {
    const m = mockGraph([
      ["GET", /^(9001|9002|9003)$/, () => json(foreign())],
      ["POST", /.*/, () => json({ copied_campaign_id: "1" })],
    ])
    await expect(copyMetaObject(providerCtx(), { level: "campaign", id: "9001", deep: false })).rejects.toMatchObject(notFound)
    await expect(copyMetaObject(providerCtx(), { level: "ad", id: "9003", deep: false })).rejects.toMatchObject(notFound)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("create tools given a foreign campaign_id / adset_id: nothing is created", async () => {
    const m = mockGraph([
      ["GET", /^(9000|9002)$/, () => json(foreign())],
      ["POST", /.*/, () => json({ id: "1" })],
    ])
    const adset = metaExtensions.find((e) => e.name === "meta_create_adset")!
    const ad = metaExtensions.find((e) => e.name === "meta_create_ad")!
    // both tools read the parent first (readNode → same-account check); the rest of the input is irrelevant
    await expect(adset.run(providerCtx(), { campaign_id: "9000", name: "x" } as never, {})).rejects.toMatchObject(notFound)
    await expect(adset.run(providerCtx(), { campaign_id: "9000", name: "x" } as never, { dryRun: true })).rejects.toMatchObject(notFound)
    await expect(ad.run(providerCtx(), { adset_id: "9002", name: "x" } as never, {})).rejects.toMatchObject(notFound)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("meta_update_ad_creative given a foreign ad_id / creative_id: nothing is created or swapped", async () => {
    const tool = metaExtensions.find((e) => e.name === "meta_update_ad_creative")!
    const own = { ...foreign({ id: "11", account_id: "1001" }), adset: { id: "2001", status: "ACTIVE" }, campaign: { id: "3001" }, creative: { id: "100" } }
    const m = mockGraph([
      ["GET", "9003", () => json(foreign({ id: "9003" }))],
      ["GET", "11", () => json(own)],
      ["GET", "9100", () => json({ id: "9100", account_id: "2002", object_story_id: "888_1" })],
      ["POST", /.*/, () => json({ id: "1" })],
    ])
    for (const opts of [{}, { dryRun: true }]) {
      await expect(tool.run(providerCtx(), tool.input.parse({ ad_id: "9003", welcome_message: "x" }), opts)).rejects.toMatchObject(notFound)
      await expect(tool.run(providerCtx(), tool.input.parse({ ad_id: "11", creative_id: "9100" }), opts)).rejects.toMatchObject(notFound)
    }
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  it("control: an object of the granted account is served", async () => {
    mockGraph([["GET", "9001", () => json(foreign({ account_id: "1001" }))]])
    await expect(getMetaObject(providerCtx(), "campaign", "9001")).resolves.toMatchObject({ id: "9001" })
  })
})
