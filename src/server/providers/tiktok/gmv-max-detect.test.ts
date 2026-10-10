// GMV Max write guards: detection via /gmv_max/campaign/get/, the admin switch (C3: every write - status included -
// refused while MutationOptions.gmvMaxWrite is off), set_status warnings and the always-confirm hook (C4). Response shapes follow the official doc example (1826463372290177).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import {
  makeCtx,
  mockTikTok,
  ok,
  fail,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { copyTikTokObject } from "./copy"
import {
  assertNotGmvMaxCampaign,
  detectGmvMaxCampaigns,
  gmvMaxCandidateIds,
  gmvMaxErrorText,
  gmvMaxStatusPermissionWarning,
  gmvMaxStatusUnverifiedWarning,
  GMV_MAX_READ_TOOLS_HINT,
  isGmvMaxCandidate,
} from "./gmv-max-detect"
import {
  gmvMaxEnableWarning,
  gmvMaxPauseWarning,
  gmvMaxLockedMessage,
  gmvMaxNoAdGroupsMessage,
  gmvMaxPermissionUnverifiedMessage,
  gmvMaxScopeHint,
  gmvMaxUnverifiedMessage,
} from "./gmv-max-text"
import { mapTikTokError } from "./client"
import { tiktokExtensions } from "./extensions"
import { tiktokProvider } from "./index"
import { ttFromCtx } from "./api"
import {
  deleteTikTokObject,
  setTikTokStatus,
  tiktokActivationSpend,
  tiktokMustAlwaysConfirm,
  updateTikTokBudget,
  updateTikTokObject,
} from "./mutate"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ADV = "7100000000000000001"
const GMV_GET = "GET /gmv_max/campaign/get/"

function campaign(id: string, extra: Record<string, unknown> = {}) {
  return {
    advertiser_id: ADV,
    campaign_id: id,
    campaign_name: `C${id}`,
    campaign_automation_type: "MANUAL",
    objective_type: "PRODUCT_SALES",
    budget_mode: "BUDGET_MODE_DAY",
    budget: 500000,
    operation_status: "ENABLE",
    secondary_status: "CAMPAIGN_STATUS_ENABLE",
    ...extra,
  }
}

/** /gmv_max/campaign/get/ row as in the official example */
function gmvRow(id: string) {
  return {
    campaign_name: `C${id}`,
    advertiser_id: ADV,
    objective_type: "PRODUCT_SALES",
    modify_time: "2026-10-01 00:00:01",
    secondary_status: "CAMPAIGN_STATUS_ENABLE",
    campaign_id: id,
    create_time: "2026-09-01 00:00:01",
    operation_status: "ENABLE",
  }
}

type Filtering = {
  gmv_max_promotion_types: string[]
  campaign_ids: string[]
  primary_status?: string
}
const filteringOf = (c: RecordedCall) => c.query.filtering as Filtering

/**
 * GMV Max handler: ids per promotion type. `deleted` ids are returned only with primary_status STATUS_DELETE,
 * `disabledOnly` ids only with STATUS_DISABLE (to model the undocumented default filter).
 */
function gmvHandler(
  byType: {
    PRODUCT_GMV_MAX?: string[]
    LIVE_GMV_MAX?: string[]
  },
  opts: { deleted?: string[]; disabledOnly?: string[] } = {}
) {
  return (c: RecordedCall) => {
    const f = filteringOf(c)
    const ps = f.primary_status
    const visible = (id: string) =>
      opts.deleted?.includes(id)
        ? ps === "STATUS_DELETE"
        : opts.disabledOnly?.includes(id)
          ? ps === "STATUS_DISABLE"
          : ps !== "STATUS_DELETE"
    const pool = (
      byType[f.gmv_max_promotion_types[0] as keyof typeof byType] ?? []
    ).filter(visible)
    const list = f.campaign_ids.filter((id) => pool.includes(id)).map(gmvRow)
    return ok({
      list,
      page_info: {
        page: 1,
        page_size: 100,
        total_number: list.length,
        total_page: list.length ? 1 : 0,
      },
    })
  }
}

/** /campaign/get/ handler returning the requested ids from a pool of rows */
function campaignGet(rows: Record<string, unknown>[]) {
  return (c: RecordedCall) => {
    const ids = (c.query.filtering as { campaign_ids: string[] }).campaign_ids
    const list = rows.filter((r) => ids.includes(String(r.campaign_id)))
    return ok({ list, page_info: { total_page: 1 } })
  }
}

describe("detectGmvMaxCampaigns", () => {
  it("no PRODUCT_SALES candidate → no GMV Max call at all", async () => {
    const m = mockTikTok({})
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [
      campaign("1", { objective_type: "WEB_CONVERSIONS" }),
      campaign("2", { objective_type: "TRAFFIC" }),
    ])
    expect(res.size).toBe(0)
    expect(m.calls).toHaveLength(0)
  })

  it("maps PRODUCT / LIVE; only candidates are sent; found ids are not re-checked as LIVE", async () => {
    const m = mockTikTok({
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1"], LIVE_GMV_MAX: ["2"] }),
    })
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [
      campaign("1"),
      campaign("2"),
      campaign("3"),
      campaign("4", { objective_type: "WEB_CONVERSIONS" }),
    ])
    expect([...res.entries()]).toEqual([
      ["1", "PRODUCT"],
      ["2", "LIVE"],
    ])
    const calls = m.callsTo(GMV_GET)
    // pass 1 (no primary_status): PRODUCT then LIVE; pass 2 (STATUS_DISABLE) only for the unresolved id "3";
    // no STATUS_DELETE pass (no candidate is deleted in /campaign/get/)
    expect(calls).toHaveLength(4)
    expect(calls[0]!.query).toMatchObject({
      advertiser_id: ADV,
      fields: ["campaign_id"],
      page: "1",
      page_size: "100",
    })
    expect(filteringOf(calls[0]!)).toEqual({
      gmv_max_promotion_types: ["PRODUCT_GMV_MAX"],
      campaign_ids: ["1", "2", "3"],
    })
    expect(filteringOf(calls[1]!)).toEqual({
      gmv_max_promotion_types: ["LIVE_GMV_MAX"],
      campaign_ids: ["2", "3"],
    })
    expect(filteringOf(calls[2]!)).toEqual({
      gmv_max_promotion_types: ["PRODUCT_GMV_MAX"],
      campaign_ids: ["3"],
      primary_status: "STATUS_DISABLE",
    })
    expect(filteringOf(calls[3]!)).toEqual({
      gmv_max_promotion_types: ["LIVE_GMV_MAX"],
      campaign_ids: ["3"],
      primary_status: "STATUS_DISABLE",
    })
  })

  it("every candidate found as PRODUCT → no LIVE call", async () => {
    const m = mockTikTok({
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1", "2"] }),
    })
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [
      campaign("1"),
      campaign("2"),
    ])
    expect(res.size).toBe(2)
    expect(m.callsTo(GMV_GET)).toHaveLength(1)
  })

  it("campaign_ids are sent in batches of ≤100", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      campaign(String(5000 + i))
    )
    const m = mockTikTok({ [GMV_GET]: gmvHandler({}) })
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), rows)
    expect(res.size).toBe(0)
    expect(
      m.callsTo(GMV_GET).map((c) => filteringOf(c).campaign_ids.length)
    ).toEqual([100, 50, 100, 50, 100, 50, 100, 50])
  })

  it("a failed check throws (callers fail closed)", async () => {
    mockTikTok({ [GMV_GET]: fail(40002, "Invalid filtering") })
    await expect(
      detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [campaign("1")])
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("assertNotGmvMaxCampaign (new ad group): refusal carries the shared message and the GMV tools hint", async () => {
    mockTikTok({ [GMV_GET]: gmvHandler({ LIVE_GMV_MAX: ["9"] }) })
    await expect(
      assertNotGmvMaxCampaign(ttFromCtx(makeCtx()), campaign("9"))
    ).rejects.toMatchObject({
      code: "unsupported",
      userMessageVi: gmvMaxNoAdGroupsMessage("9"),
      hint: GMV_MAX_READ_TOOLS_HINT,
    })
  })
})

describe("GMV Max writes while the admin switch is OFF (C3)", () => {
  const routes = (extra: Record<string, unknown> = {}) => ({
    "GET /campaign/get/": campaignGet([
      campaign("1"),
      campaign("2"),
      campaign("3", { objective_type: "WEB_CONVERSIONS" }),
    ]),
    [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1"] }),
    "POST /campaign/update/": ok({}),
    "POST /campaign/status/update/": ok({}),
    ...extra,
  })

  it("ads_update_budget: refused (dry run too, explicit false too), nothing written", async () => {
    const m = mockTikTok(routes())
    for (const opts of [{ dryRun: true }, {}, { gmvMaxWrite: false }]) {
      await expect(
        updateTikTokBudget(
          makeCtx(),
          { level: "campaign", id: "1", type: "daily", amount: 900000 },
          opts
        )
      ).rejects.toMatchObject({
        code: "feature_not_enabled",
        userMessageVi: gmvMaxLockedMessage("1"),
      })
    }
    expect(m.posts()).toHaveLength(0)
  })

  it("ads_update_object (rename): refused; a non-GMV PRODUCT_SALES campaign is renamed normally", async () => {
    const m = mockTikTok(routes())
    await expect(
      updateTikTokObject(makeCtx(), {
        level: "campaign",
        id: "1",
        changes: { name: "Mới" },
      })
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage("1"),
    })
    expect(m.posts()).toHaveLength(0)
    const res = await updateTikTokObject(makeCtx(), {
      level: "campaign",
      id: "2",
      changes: { name: "Mới" },
    })
    expect(res.changes).toHaveLength(1)
    expect(m.callsTo("POST /campaign/update/")[0]!.body).toMatchObject({
      campaign_id: "2",
      campaign_name: "Mới",
    })
  })

  it("non-candidate campaign: no GMV Max call, existing behaviour", async () => {
    const m = mockTikTok(routes())
    await updateTikTokObject(makeCtx(), {
      level: "campaign",
      id: "3",
      changes: { name: "X" },
    })
    expect(m.callsTo(GMV_GET)).toHaveLength(0)
    expect(m.callsTo("POST /campaign/update/")).toHaveLength(1)
  })

  it("ads_delete_object: refused (preview and execution)", async () => {
    const m = mockTikTok(routes())
    await expect(
      deleteTikTokObject(makeCtx(), "campaign", "1", { dryRun: true })
    ).rejects.toMatchObject({
      userMessageVi: gmvMaxLockedMessage("1"),
    })
    await expect(
      deleteTikTokObject(makeCtx(), "campaign", "1")
    ).rejects.toMatchObject({ code: "feature_not_enabled" })
    expect(m.posts()).toHaveLength(0)
  })

  it("ads_copy_object: copying a GMV Max campaign is refused", async () => {
    const m = mockTikTok(routes())
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: "1", deep: true },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage("1"),
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("GMV Max check fails on a PRODUCT_SALES campaign → refused as unverifiable (fail closed)", async () => {
    const m = mockTikTok(routes({ [GMV_GET]: fail(40002, "bad request") }))
    await expect(
      updateTikTokObject(makeCtx(), {
        level: "campaign",
        id: "2",
        changes: { name: "Mới" },
      })
    ).rejects.toMatchObject({
      userMessageVi: gmvMaxUnverifiedMessage("2"),
    })
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: "2", type: "daily", amount: 900000 },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ userMessageVi: gmvMaxUnverifiedMessage("2") })
    await expect(
      deleteTikTokObject(makeCtx(), "campaign", "2", { dryRun: true })
    ).rejects.toMatchObject({
      userMessageVi: gmvMaxUnverifiedMessage("2"),
    })
    expect(m.posts()).toHaveLength(0)
    // a non-candidate is not affected by the failing check
    await updateTikTokObject(makeCtx(), {
      level: "campaign",
      id: "3",
      changes: { name: "X" },
    })
    expect(m.callsTo("POST /campaign/update/")).toHaveLength(1)
  })
})

describe("set_status on GMV Max campaigns", () => {
  const ON = {
    gmvMaxWrite: true,
    confirmed: true,
    dailySpendGuard: () => {},
    startedSpend24h: async () => [],
  }

  it("switch OFF: pause / enable of a GMV Max campaign refused (also in a mixed batch), nothing sent", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("1"), campaign("3", { objective_type: "WEB_CONVERSIONS" })]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1"] }),
      "POST /campaign/status/update/": ok({}),
    })
    for (const dryRun of [true, false]) {
      await expect(
        setTikTokStatus(makeCtx(), "campaign", ["1", "3"], "paused", { dryRun })
      ).rejects.toMatchObject({ code: "feature_not_enabled", userMessageVi: gmvMaxLockedMessage("1") })
    }
    expect(m.posts()).toHaveLength(0)
    // a non-GMV campaign alone is unchanged
    await setTikTokStatus(makeCtx(), "campaign", ["3"], "paused")
    expect(m.posts()).toHaveLength(1)
  })

  it("switch OFF + GMV Max check failure → refused (fail closed)", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("1")]),
      [GMV_GET]: fail(40002, "bad"),
      "POST /campaign/status/update/": ok({}),
    })
    await expect(setTikTokStatus(makeCtx(), "campaign", ["1"], "paused")).rejects.toMatchObject({
      userMessageVi: gmvMaxUnverifiedMessage("1"),
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("pause: allowed, with the pause warning in the preview and in the result", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1"),
        campaign("2"),
        campaign("3", { objective_type: "WEB_CONVERSIONS" }),
      ]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1"] }),
      "POST /campaign/status/update/": ok({}),
    })
    const preview = await setTikTokStatus(
      makeCtx(),
      "campaign",
      ["1", "2", "3"],
      "paused",
      { ...ON, dryRun: true }
    )
    expect(preview.warnings).toContain(gmvMaxPauseWarning("1"))
    expect(preview.warnings.join(" ")).not.toContain("2: Chiến dịch GMV Max")
    expect(m.posts()).toHaveLength(0)
    const res = await setTikTokStatus(
      makeCtx(),
      "campaign",
      ["1", "2", "3"],
      "paused",
      ON
    )
    expect(res.warnings).toContain(gmvMaxPauseWarning("1"))
    expect(res.changes).toHaveLength(3)
    expect(m.callsTo("POST /campaign/status/update/")[0]!.body).toMatchObject({
      campaign_ids: ["1", "2", "3"],
      operation_status: "DISABLE",
    })
  })

  it("enable: enable warning; already-enabled / non-candidate campaigns → no GMV Max call", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1", {
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
        campaign("2"),
        campaign("3", {
          objective_type: "WEB_CONVERSIONS",
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
      ]),
      [GMV_GET]: gmvHandler({ LIVE_GMV_MAX: ["1"] }),
      "GET /campaign/gmv_max/info/": ok({ campaign_id: "1", budget: 300000 }),
      "POST /campaign/status/update/": ok({}),
    })
    const res = await setTikTokStatus(makeCtx(), "campaign", ["1"], "active", {
      ...ON,
      dryRun: true,
    })
    expect(res.warnings).toContain(gmvMaxEnableWarning("1"))
    const n = m.callsTo(GMV_GET).length
    // "2" is already on (skipped), "3" is not a candidate
    const other = await setTikTokStatus(
      makeCtx(),
      "campaign",
      ["2", "3"],
      "active",
      { dryRun: true }
    )
    expect(other.warnings.join(" ")).not.toContain("GMV Max")
    expect(m.callsTo(GMV_GET)).toHaveLength(n)
  })

  it("check failure → handled as GMV Max (unverified + pause warning), the change itself still goes through", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("1")]),
      [GMV_GET]: fail(40001, "No permission"),
      "POST /campaign/status/update/": ok({}),
    })
    const res = await setTikTokStatus(makeCtx(), "campaign", ["1"], "paused", ON)
    expect(res.warnings).toContain(gmvMaxStatusPermissionWarning(["1"]))
    expect(res.warnings).toContain(gmvMaxPauseWarning("1"))
    expect(res.warnings.join(" ")).not.toContain("No permission")
    expect(m.callsTo("POST /campaign/status/update/")).toHaveLength(1)
  })

  it("ad group level: no GMV Max call", async () => {
    const m = mockTikTok({
      "GET /adgroup/get/": ok({
        list: [
          {
            adgroup_id: "11",
            campaign_id: "1",
            adgroup_name: "G",
            operation_status: "ENABLE",
            secondary_status: "ADGROUP_STATUS_DELIVERY_OK",
            campaign_automation_type: "MANUAL",
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    await setTikTokStatus(makeCtx(), "ad_group", ["11"], "paused", {
      dryRun: true,
    })
    expect(m.callsTo(GMV_GET)).toHaveLength(0)
  })
})

describe("mustAlwaysConfirm hook (TikTok)", () => {
  it("is wired on the provider", () => {
    expect(typeof tiktokProvider.mustAlwaysConfirm).toBe("function")
  })

  it("GMV Max campaign that would change → reasons; already in the target state / non-candidate / ad group → []", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1"),
        campaign("2", {
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
        campaign("3", { objective_type: "WEB_CONVERSIONS" }),
      ]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1", "2"] }),
    })
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["1", "3"], "paused")
    ).toEqual([gmvMaxPauseWarning("1")])
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["2"], "active")
    ).toEqual([gmvMaxEnableWarning("2")])
    const n = m.callsTo(GMV_GET).length
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["2"], "paused")
    ).toEqual([]) // already paused
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["3"], "paused")
    ).toEqual([]) // not a candidate
    expect(m.callsTo(GMV_GET)).toHaveLength(n)
    const calls = m.calls.length
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "ad_group", ["11"], "paused")
    ).toEqual([])
    expect(m.calls).toHaveLength(calls)
  })

  it("GMV Max check failure → candidates must be confirmed (fail closed)", async () => {
    mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1"),
        campaign("3", { objective_type: "WEB_CONVERSIONS" }),
      ]),
      [GMV_GET]: fail(40002, "bad"),
    })
    const reasons = await tiktokMustAlwaysConfirm(
      makeCtx(),
      "campaign",
      ["1", "3"],
      "paused"
    )
    expect(reasons).toEqual([
      gmvMaxStatusUnverifiedWarning(["1"]),
      gmvMaxPauseWarning("1"),
    ])
  })

  it("campaign read failure → throws (the MCP tool then requires confirmation)", async () => {
    mockTikTok({ "GET /campaign/get/": fail(40002, "bad") })
    await expect(
      tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["1"], "paused")
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("candidates fail closed on unknown objectives", () => {
  it("PRODUCT_SALES, missing / empty / unknown objective → candidate; known non-shop objectives → not", () => {
    expect(isGmvMaxCandidate(campaign("1"))).toBe(true)
    expect(isGmvMaxCandidate(campaign("1", { objective_type: undefined }))).toBe(true)
    expect(isGmvMaxCandidate(campaign("1", { objective_type: "" }))).toBe(true)
    expect(isGmvMaxCandidate(campaign("1", { objective_type: "SHOP_NEW_THING" }))).toBe(true)
    for (const o of [
      "REACH",
      "RF_REACH",
      "TRAFFIC",
      "VIDEO_VIEWS",
      "ENGAGEMENT",
      "APP_PROMOTION",
      "LEAD_GENERATION",
      "WEB_CONVERSIONS",
    ]) {
      expect(isGmvMaxCandidate(campaign("1", { objective_type: o }))).toBe(false)
    }
    expect(isGmvMaxCandidate({ objective_type: "PRODUCT_SALES" })).toBe(false) // no id
    expect(
      gmvMaxCandidateIds([
        campaign("1"),
        campaign("1"),
        campaign("2", { objective_type: undefined }),
        campaign("3", { objective_type: "TRAFFIC" }),
      ])
    ).toEqual(["1", "2"])
  })

  it("a campaign without objective_type is checked (and refused when it is GMV Max)", async () => {
    mockTikTok({ [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["7"] }) })
    await expect(
      assertNotGmvMaxCampaign(
        ttFromCtx(makeCtx()),
        campaign("7", { objective_type: undefined })
      )
    ).rejects.toMatchObject({ userMessageVi: gmvMaxNoAdGroupsMessage("7") })
  })
})

describe("detection passes (undocumented default primary_status)", () => {
  it("a GMV Max campaign returned only with STATUS_DISABLE is found in pass 2", async () => {
    const m = mockTikTok({
      [GMV_GET]: gmvHandler({ LIVE_GMV_MAX: ["4"] }, { disabledOnly: ["4"] }),
    })
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [campaign("4")])
    expect([...res.entries()]).toEqual([["4", "LIVE"]])
    expect(m.callsTo(GMV_GET).map((c) => filteringOf(c).primary_status)).toEqual([
      undefined,
      undefined,
      "STATUS_DISABLE",
      "STATUS_DISABLE",
    ])
  })

  it("STATUS_DELETE is asked only for candidates that /campaign/get/ reports deleted", async () => {
    const m = mockTikTok({
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["5"] }, { deleted: ["5"] }),
    })
    const deleted = campaign("5", {
      operation_status: "DISABLE",
      secondary_status: "CAMPAIGN_STATUS_DELETE",
    })
    const res = await detectGmvMaxCampaigns(ttFromCtx(makeCtx()), [
      deleted,
      campaign("6"),
    ])
    expect([...res.entries()]).toEqual([["5", "PRODUCT"]])
    const del = m
      .callsTo(GMV_GET)
      .filter((c) => filteringOf(c).primary_status === "STATUS_DELETE")
    expect(del.map((c) => filteringOf(c).campaign_ids)).toEqual([["5"]])
  })

  it("copying a DELETED GMV Max campaign is refused too (switch off)", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("5", {
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DELETE",
        }),
      ]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["5"] }, { deleted: ["5"] }),
    })
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: "5", deep: true },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage("5"),
    })
    expect(m.posts()).toHaveLength(0)
  })
})

describe("permission refusals of the GMV Max check", () => {
  it("40001 → dedicated 'Token chưa có quyền đọc chiến dịch GMV Max' message + Read Campaigns hint (fail closed)", async () => {
    mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("2")]),
      [GMV_GET]: fail(40001, "No permission to operate"),
    })
    const e = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: "2", type: "daily", amount: 900000 },
      { dryRun: true }
    ).catch((x: unknown) => x)
    expect(e).toMatchObject({
      code: "permission_denied",
      userMessageVi: gmvMaxPermissionUnverifiedMessage("2"),
      hint: gmvMaxScopeHint("/gmv_max/campaign/get/"),
    })
    expect(gmvMaxPermissionUnverifiedMessage("2")).toContain(
      "Token chưa có quyền đọc chiến dịch GMV Max nên không xác minh được chiến dịch 2"
    )
    expect(JSON.stringify(e)).not.toContain("TikTok không trả lời")
  })

  it("other failures keep the unverified message, without the raw TikTok message", async () => {
    mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("2")]),
      [GMV_GET]: fail(40002, "secret upstream detail"),
    })
    const e = (await updateTikTokObject(makeCtx(), {
      level: "campaign",
      id: "2",
      changes: { name: "X" },
    }).catch((x: unknown) => x)) as { userMessageVi: string; hint?: string }
    expect(e.userMessageVi).toBe(gmvMaxUnverifiedMessage("2"))
    expect(e.hint).toContain("(mã 40002)")
    expect(e.hint).not.toContain("secret upstream detail")
  })

  it("auth_invalid is rethrown as is", async () => {
    mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("2")]),
      [GMV_GET]: fail(40105, "token revoked"),
    })
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: "2", type: "daily", amount: 1 },
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "auth_invalid" })
  })

  it("gmvMaxErrorText keeps our text + code, drops the upstream message", () => {
    const e = mapTikTokError(40002, "raw upstream text")
    expect(gmvMaxErrorText(e)).toBe(
      "Tham số gửi lên TikTok không hợp lệ. (mã 40002)"
    )
    expect(gmvMaxErrorText(new Error("raw"))).toBe("Lỗi không xác định khi gọi TikTok.")
  })
})

describe("tiktok_create_adgroup on a GMV Max campaign", () => {
  it("is refused before anything is built or written", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([campaign("1")]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1"] }),
    })
    const ext = tiktokExtensions.find((e) => e.name === "tiktok_create_adgroup")!
    await expect(
      ext.run(makeCtx(), { campaign_id: "1" } as never, { dryRun: true })
    ).rejects.toMatchObject({
      code: "unsupported",
      userMessageVi: gmvMaxNoAdGroupsMessage("1"),
    })
    expect(m.posts()).toHaveLength(0)
  })
})

describe("activationSpend hook (TikTok)", () => {
  it("is wired; only GMV Max campaigns that would be switched on are returned, with worst-case daily spend", async () => {
    expect(typeof tiktokProvider.activationSpend).toBe("function")
    const m = mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1", {
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
        campaign("2"), // already on → skipped
        campaign("3", {
          objective_type: "TRAFFIC",
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
      ]),
      [GMV_GET]: gmvHandler({ PRODUCT_GMV_MAX: ["1", "2"] }),
      "GET /campaign/gmv_max/info/": ok({
        campaign_id: "1",
        budget: 400000,
        auto_budget: {
          auto_budget_enabled: true,
          budget_increase_percentage: 100,
          increase_limit: 5,
          maximum_budget: 2400000,
        },
      }),
    })
    const out = await tiktokActivationSpend(makeCtx(), "campaign", ["1", "2", "3"])
    expect(out).toEqual([
      {
        id: "1",
        label: 'Chiến dịch GMV Max "C1" (1)',
        currency: "VND",
        dailyBudget: 400000,
        maxDailySpend: 2400000,
        notes: [expect.stringContaining("Max delivery")],
      },
    ])
    expect(m.callsTo("GET /campaign/gmv_max/info/")).toHaveLength(1)
    const n = m.calls.length
    expect(await tiktokActivationSpend(makeCtx(), "ad_group", ["11"])).toEqual([])
    expect(m.calls).toHaveLength(n)
  })

  it("GMV Max status unverifiable → throws (the MCP refuses activation when a daily cap exists)", async () => {
    mockTikTok({
      "GET /campaign/get/": campaignGet([
        campaign("1", {
          operation_status: "DISABLE",
          secondary_status: "CAMPAIGN_STATUS_DISABLE",
        }),
      ]),
      [GMV_GET]: fail(50000, "system"),
    })
    await expect(
      tiktokActivationSpend(makeCtx(), "campaign", ["1"])
    ).rejects.toMatchObject({ code: "upstream_error" })
  })
})
