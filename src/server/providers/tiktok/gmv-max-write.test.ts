// GMV Max writes behind the admin-only MCP switch (phase 2, contract C3-C7): routing of the generic writes, the
// GMV-Max-only tools (update / creatives / create + read helpers), request bodies per the official docs
// (1822001009002497 update, 1822000988713089 create, 1861260625563202 creative update, 1739320994354178 status),
// pre-checks (shop ready, product / identity occupancy), strict worst-case daily-spend guard, request_id idempotency
// without blind retry, ROI history warnings. Fixtures follow the doc examples (placeholders filled).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import type {
  DailySpendCheck,
  FieldHistoryEntry,
  MutationOptions,
  StartedSpendLedger,
} from "../types"
import bidFixture from "./__fixtures__/gmv-max-bid-recommend.json"
import campaignGetFixture from "./__fixtures__/gmv-max-campaign-get.json"
import infoFixture from "./__fixtures__/gmv-max-campaign-info.json"
import createFixture from "./__fixtures__/gmv-max-create.json"
import creativeFixture from "./__fixtures__/gmv-max-creative-update.json"
import identityFixture from "./__fixtures__/gmv-max-identity-get.json"
import productFixture from "./__fixtures__/gmv-max-store-product-get.json"
import usageFixture from "./__fixtures__/gmv-max-shop-usage-check.json"
import storeFixture from "./__fixtures__/gmv-max-store-list.json"
import updateFixture from "./__fixtures__/gmv-max-update.json"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { formatTikTokTime, ttFromCtx } from "./api"
import { copyTikTokObject } from "./copy"
import { tiktokExtensions } from "./extensions"
import {
  gmvMaxRoiWarnings,
  gmvMaxWorstCaseAfter,
  parseAccountTime,
  roasBidSchema,
  runGmvMaxBidRecommend,
  runGmvMaxCreate,
  runGmvMaxCreatives,
  runGmvMaxIdentities,
  runGmvMaxProducts,
  runGmvMaxUpdate,
} from "./gmv-max-write"
import {
  GMV_MAX_BOOST_WARNING,
  GMV_MAX_DELETE_WARNING,
  GMV_MAX_GUARD_MISSING,
  GMV_MAX_PRODUCTS_EDIT_WARNING,
  GMV_MAX_ROI_HISTORY_SCOPE,
  GMV_MAX_ROI_PROTECTION_NOTE,
  GMV_MAX_ROI_RAISE_WARNING,
  GMV_MAX_ROI_SECOND_LOWER_WARNING,
  GMV_MAX_RUNS_NOW_WARNING,
  gmvMaxConfirmReason,
  gmvMaxCopyAllProductsMessage,
  gmvMaxEnableWarning,
  gmvMaxLockedMessage,
  gmvMaxRoiLiveTodayWarning,
  gmvMaxRoiRecentWarning,
} from "./gmv-max-text"
import { tiktokProvider } from "./index"
import {
  deleteTikTokObject,
  setTikTokStatus,
  tiktokMustAlwaysConfirm,
  updateTikTokBudget,
  updateTikTokObject,
} from "./mutate"
import { getTikTokObject } from "./objects"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ADV = "7100000000000000001"
const CID = "1840000000000000001" // Product GMV Max (info fixture: CUSTOMIZED_PRODUCTS, budget 300 000 VND, auto budget 50 % × 10)
const STORE = "7494000000000000001"
const BC = "7300000000000000001"
const GMV_GET = "GET /gmv_max/campaign/get/"
const INFO = "GET /campaign/gmv_max/info/"
const UPDATE = "POST /campaign/gmv_max/update/"
const CREATE = "POST /campaign/gmv_max/create/"
const STATUS = "POST /campaign/status/update/"

type Filtering = {
  gmv_max_promotion_types: string[]
  campaign_ids?: string[]
  primary_status?: string
  store_ids?: string[]
  campaign_name?: string
}
const filteringOf = (c: RecordedCall) => c.query.filtering as Filtering

/** /gmv_max/campaign/get/ rows of the fixture (+ overrides), filtered like TikTok would. */
function gmvGet(byType: {
  PRODUCT_GMV_MAX?: Record<string, unknown>[]
  LIVE_GMV_MAX?: Record<string, unknown>[]
}) {
  return (c: RecordedCall) => {
    const f = filteringOf(c)
    let list = byType[f.gmv_max_promotion_types[0] as keyof typeof byType] ?? []
    if (f.campaign_ids)
      list = list.filter((r) => f.campaign_ids!.includes(String(r.campaign_id)))
    if (f.primary_status === "STATUS_DELIVERY_OK")
      list = list.filter((r) => r.operation_status === "ENABLE")
    if (f.campaign_name)
      list = list.filter((r) => r.campaign_name === f.campaign_name)
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
const ROWS = campaignGetFixture.data.list as Record<string, unknown>[]
const productRow = (over: Record<string, unknown> = {}) => ({
  ...ROWS[0],
  ...over,
})
/** /campaign/get/ does not return the GMV Max campaign (absent there). */
const campaignGetEmpty = ok({ list: [], page_info: { total_page: 0 } })

function info(over: Record<string, unknown> = {}) {
  return ok({ ...infoFixture.data, ...over })
}

function guardSpy(cap: number | null = 10_000_000) {
  const seen: DailySpendCheck[][] = []
  const fn = (items: DailySpendCheck[]) => {
    seen.push(items)
    if (cap === null) throw new Error("budget_cap_missing")
    for (const it of items)
      if (it.amount > cap) throw new Error(`budget_cap_exceeded ${it.amount}`)
  }
  return { fn, seen }
}

/** Switch ON + mcp-core options; `confirmed` = executed through a consumed two-step confirmation (C4). */
/** S5/M1 ledger stub: no lock contention in unit tests, reservations recorded in `log`. */
function testLedger(log: { op: string; args: unknown[] }[] = []): StartedSpendLedger {
  return {
    exclusive: (fn) => fn(),
    reserve: (items) => {
      log.push({ op: "reserve", args: [items] })
      return {
        settle: (...args) => void log.push({ op: "settle", args }),
        release: (...args) => void log.push({ op: "release", args }),
      }
    },
  }
}

const ON = (extra: MutationOptions = {}): MutationOptions => ({
  gmvMaxWrite: true,
  confirmed: true,
  dailySpendGuard: () => {},
  budgetChangeGuard: async () => {},
  startedSpend24h: async () => [],
  startedSpendLedger: testLedger(),
  ...extra,
})

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /campaign/get/": campaignGetEmpty,
    [GMV_GET]: gmvGet({ PRODUCT_GMV_MAX: [productRow()] }),
    [INFO]: info(),
    [UPDATE]: ok(updateFixture.data),
    [STATUS]: ok({ campaign_ids: [CID] }),
    ...extra,
  }
}

describe("roasBidSchema / helpers", () => {
  it("ROI target: positive, at most one decimal place; sent without float noise", () => {
    expect(roasBidSchema.safeParse(3.2).success).toBe(true)
    expect(roasBidSchema.safeParse(3).success).toBe(true)
    expect(roasBidSchema.safeParse(2.55).success).toBe(false)
    expect(roasBidSchema.safeParse(0).success).toBe(false)
  })

  it("account-time input → UTC instant (Asia/Ho_Chi_Minh +07:00); ISO with offset accepted; 'T' without zone = account time", () => {
    expect(
      parseAccountTime("2026-10-12 08:00", "Asia/Ho_Chi_Minh")!.toISOString()
    ).toBe("2026-10-12T01:00:00.000Z")
    expect(
      parseAccountTime("2026-10-12T08:00:00+07:00", "UTC")!.toISOString()
    ).toBe("2026-10-12T01:00:00.000Z")
    expect(parseAccountTime("2026-10-12T08:00:00", "UTC")!.toISOString()).toBe("2026-10-12T08:00:00.000Z")
    expect(parseAccountTime("tomorrow", "UTC")).toBeNull()
  })

  it("worst case after a change ignores TikTok's stale maximum_budget and uses pct × limit (or 31× when unknown)", () => {
    const i = infoFixture.data as Record<string, unknown>
    expect(gmvMaxWorstCaseAfter(i, {}, "VND").max_possible_daily_spend).toBe(
      1_800_000
    )
    // new budget 400 000 with 50 % × 10 → 400 000 × 6
    expect(
      gmvMaxWorstCaseAfter(i, { budget: 400_000 }, "VND")
        .max_possible_daily_spend
    ).toBe(2_400_000)
    // auto budget switched to 300 % × 10 → 31 ×
    expect(
      gmvMaxWorstCaseAfter(
        i,
        {
          auto_budget: {
            auto_budget_enabled: true,
            budget_increase_percentage: 300,
            increase_limit: 10,
          },
        },
        "VND"
      ).max_possible_daily_spend
    ).toBe(9_300_000)
    // promotion days enabled without known pct / limit → 31 × fallback
    const bare = { budget: 100_000 }
    expect(
      gmvMaxWorstCaseAfter(
        bare,
        { promotion_days: { is_enabled: true } },
        "VND"
      ).max_possible_daily_spend
    ).toBe(3_100_000)
  })
})

describe("ads_update_budget on a GMV Max campaign (switch ON)", () => {
  it("POST /campaign/gmv_max/update/ {budget}; worst case (new budget × boosts) goes through the strict guard; dry run sends nothing", async () => {
    const m = mockTikTok(baseRoutes())
    const g = guardSpy()
    const preview = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 330_000 },
      ON({ dryRun: true, dailySpendGuard: g.fn })
    )
    expect(preview.changes).toEqual([
      {
        objectId: CID,
        objectName: "GMV Max - Tất cả sản phẩm",
        level: "campaign",
        field: "daily_budget",
        before: 300_000,
        after: 330_000,
      },
    ])
    expect(preview.effectiveAt).toBeNull()
    expect(g.seen[0]).toEqual([
      {
        label: expect.stringContaining(CID),
        amount: 1_980_000,
        currency: "VND",
      },
    ])
    expect(m.posts()).toHaveLength(0)
    await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 330_000 },
      ON({ dailySpendGuard: g.fn })
    )
    expect(m.callsTo(UPDATE).map((c) => c.body)).toEqual([
      { advertiser_id: ADV, campaign_id: CID, budget: 330_000 },
    ])
  })

  it("worst case above the cap / no guard → refused, nothing written; lifetime type refused", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 330_000 },
        ON({ dailySpendGuard: guardSpy(1_000_000).fn })
      )
    ).rejects.toThrow(/budget_cap_exceeded 1980000/)
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 330_000 },
        {
          gmvMaxWrite: true,
          confirmed: true,
          budgetChangeGuard: async () => {},
          startedSpend24h: async () => [],
        }
      )
    ).rejects.toMatchObject({ userMessageVi: GMV_MAX_GUARD_MISSING })
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "lifetime", amount: 330_000 },
        ON()
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("switch OFF → locked even when the campaign is absent from /campaign/get/", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 330_000 },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage(CID),
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("an id that is neither in /campaign/get/ nor GMV Max → not_found (GMV list failure → not_found too, nothing written)", async () => {
    mockTikTok(baseRoutes())
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: "999", type: "daily", amount: 1 },
        ON()
      )
    ).rejects.toMatchObject({ code: "not_found" })
    mockTikTok(baseRoutes({ [GMV_GET]: fail(50000, "system") }))
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: "999", type: "daily", amount: 1 },
        ON()
      )
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("ads_get_object on a GMV Max campaign", () => {
  it("budget = GMV Max daily budget (the % guardrail of ads_update_budget applies to it), extra.gmv_max, no media URLs", async () => {
    mockTikTok(baseRoutes())
    const d = await getTikTokObject(makeCtx(), "campaign", CID)
    expect(d.budget).toEqual({
      type: "daily",
      amount: 300_000,
      currency: "VND",
      level: "campaign",
    })
    expect(d.extra).toMatchObject({
      gmv_max: "PRODUCT",
      target_roi: 2,
      max_possible_daily_spend: 1_800_000,
      configuredStatus: "active",
    })
    expect(JSON.stringify(d)).not.toMatch(/x-expires|preview\.mp4/)
  })

  it("a non-candidate campaign: no GMV Max call, generic detail", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": ok({
        list: [
          {
            campaign_id: "5",
            campaign_name: "T",
            objective_type: "TRAFFIC",
            operation_status: "ENABLE",
            budget_mode: "BUDGET_MODE_DAY",
            budget: 100000,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const d = await getTikTokObject(makeCtx(), "campaign", "5")
    expect(d.extra?.gmv_max).toBeUndefined()
    expect(m.callsTo(GMV_GET)).toHaveLength(0)
  })
})

describe("ads_update_object / ads_delete_object on a GMV Max campaign (switch ON)", () => {
  it("name + end time → /campaign/gmv_max/update/ (schedule_end_time UTC); end null → SCHEDULE_FROM_NOW", async () => {
    const m = mockTikTok(baseRoutes())
    const now = new Date("2026-10-10T03:00:00Z")
    const r = await updateTikTokObject(
      makeCtx(),
      {
        level: "campaign",
        id: CID,
        changes: { name: "GMV mới", endTime: "2026-11-30T23:59:59+07:00" },
      },
      { ...ON(), now } as MutationOptions
    )
    expect(r.changes.map((c) => c.field)).toEqual(["name", "end_time"])
    expect(m.callsTo(UPDATE)[0]!.body).toEqual({
      advertiser_id: ADV,
      campaign_id: CID,
      campaign_name: "GMV mới",
      schedule_type: "SCHEDULE_START_END",
      schedule_end_time: "2026-11-30 16:59:59",
    })
    await updateTikTokObject(
      makeCtx(),
      { level: "campaign", id: CID, changes: { endTime: null } },
      ON()
    )
    expect(m.callsTo(UPDATE)[1]!.body).toEqual({
      advertiser_id: ADV,
      campaign_id: CID,
      schedule_type: "SCHEDULE_FROM_NOW",
    })
  })

  it("start time / bid / URL refused before anything is sent; past end refused", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      updateTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, changes: { bidAmount: 5 } },
        ON()
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      updateTikTokObject(
        makeCtx(),
        {
          level: "campaign",
          id: CID,
          changes: { endTime: "2020-01-01T00:00:00Z" },
        },
        ON()
      )
    ).rejects.toMatchObject({
      userMessageVi: "Ngày kết thúc phải ở tương lai.",
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("delete → /campaign/status/update/ DELETE with the GMV Max warnings", async () => {
    const m = mockTikTok(baseRoutes())
    const p = await deleteTikTokObject(
      makeCtx(),
      "campaign",
      CID,
      ON({ dryRun: true })
    )
    expect(p.warnings).toContain(GMV_MAX_DELETE_WARNING)
    expect(m.posts()).toHaveLength(0)
    await deleteTikTokObject(makeCtx(), "campaign", CID, ON())
    expect(m.callsTo(STATUS)[0]!.body).toEqual({
      advertiser_id: ADV,
      campaign_ids: [CID],
      operation_status: "DELETE",
    })
  })
})

describe("ads_set_status on GMV Max campaigns (switch ON)", () => {
  it("enable: the worst-case daily spend of each GMV Max campaign goes through the guard; above the cap → refused", async () => {
    const m = mockTikTok(
      baseRoutes({
        [GMV_GET]: gmvGet({
          PRODUCT_GMV_MAX: [
            productRow({
              operation_status: "DISABLE",
              secondary_status: "CAMPAIGN_STATUS_DISABLE",
            }),
          ],
        }),
      })
    )
    const g = guardSpy()
    const r = await setTikTokStatus(
      makeCtx(),
      "campaign",
      [CID],
      "active",
      ON({ dryRun: true, dailySpendGuard: g.fn })
    )
    expect(r.warnings).toContain(gmvMaxEnableWarning(CID))
    expect(g.seen[0]).toEqual([
      {
        label: expect.stringContaining(CID),
        amount: 1_800_000,
        currency: "VND",
      },
    ])
    await expect(
      setTikTokStatus(
        makeCtx(),
        "campaign",
        [CID],
        "active",
        ON({ dailySpendGuard: guardSpy(1_000_000).fn })
      )
    ).rejects.toThrow(/budget_cap_exceeded/)
    expect(m.posts()).toHaveLength(0)
    await setTikTokStatus(makeCtx(), "campaign", [CID], "active", ON())
    expect(m.callsTo(STATUS)[0]!.body).toMatchObject({
      campaign_ids: [CID],
      operation_status: "ENABLE",
    })
  })

  it("pause of a campaign absent from /campaign/get/: row from /gmv_max/campaign/get/, no guard needed", async () => {
    const m = mockTikTok(baseRoutes())
    const r = await setTikTokStatus(makeCtx(), "campaign", [CID], "paused", {
      gmvMaxWrite: true,
      confirmed: true,
    })
    expect(r.changes).toEqual([
      expect.objectContaining({
        objectId: CID,
        before: "active",
        after: "paused",
      }),
    ])
    expect(m.callsTo(STATUS)[0]!.body).toMatchObject({
      campaign_ids: [CID],
      operation_status: "DISABLE",
    })
  })
})

describe("mustAlwaysConfirm (C4): every write op on a GMV Max campaign", () => {
  it("update / copy / delete → reason per GMV Max id (ids absent from /campaign/get/ included); non-candidate → no GMV call", async () => {
    const m = mockTikTok(baseRoutes())
    for (const op of ["update", "copy", "delete"] as const) {
      expect(
        await tiktokMustAlwaysConfirm(makeCtx(), "campaign", [CID], op)
      ).toEqual([gmvMaxConfirmReason(CID)])
    }
    expect(
      await tiktokProvider.mustAlwaysConfirm!(
        makeCtx(),
        "campaign",
        [CID],
        "active"
      )
    ).toEqual([gmvMaxEnableWarning(CID)])
    const n = m.callsTo(GMV_GET).length
    mockTikTok({
      "GET /campaign/get/": ok({
        list: [{ campaign_id: "5", objective_type: "TRAFFIC" }],
        page_info: { total_page: 1 },
      }),
    })
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", ["5"], "update")
    ).toEqual([])
    expect(n).toBeGreaterThan(0)
  })

  it("check failure → reasons for every candidate (fail closed)", async () => {
    mockTikTok(baseRoutes({ [GMV_GET]: fail(50000, "system") }))
    const r = await tiktokMustAlwaysConfirm(
      makeCtx(),
      "campaign",
      [CID],
      "update"
    )
    expect(r).toHaveLength(2)
    expect(r[1]).toBe(gmvMaxConfirmReason(CID))
  })
})

describe("tiktok_gmv_max_update", () => {
  const history = (entries: FieldHistoryEntry[]) => vi.fn(async () => entries)
  const now = new Date("2026-10-10T05:00:00Z") // 12:00 in Asia/Ho_Chi_Minh

  it("switch OFF → locked, nothing sent", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, roas_bid: 2.5 },
        { dryRun: true }
      )
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("ROI: body roas_bid (1 decimal); Product changed yesterday → strong warning; raise → loses today's ROI protection; history asked for roas_bid", async () => {
    const m = mockTikTok(baseRoutes())
    const fh = history([
      { at: new Date("2026-10-09T03:00:00Z"), before: 2.2, after: 2 },
    ])
    const p = await runGmvMaxUpdate(
      makeCtx(),
      { campaign_id: CID, roas_bid: 2.5 },
      { ...ON({ dryRun: true, fieldHistory: fh }), now } as MutationOptions
    )
    expect(fh).toHaveBeenCalledWith({
      objectId: CID,
      field: "roas_bid",
      sinceHours: 120,
    })
    expect(p.changes).toEqual([
      expect.objectContaining({ field: "roas_bid", before: 2, after: 2.5 }),
    ])
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        gmvMaxRoiRecentWarning(CID, "2026-10-09", 0),
        GMV_MAX_ROI_RAISE_WARNING,
        GMV_MAX_ROI_PROTECTION_NOTE,
        GMV_MAX_ROI_HISTORY_SCOPE,
      ])
    )
    expect(p.payload).toEqual({ campaign_id: CID, roas_bid: 2.5 })
    expect(m.posts()).toHaveLength(0)
    await runGmvMaxUpdate(makeCtx(), { campaign_id: CID, roas_bid: 2.5 }, {
      ...ON({ fieldHistory: fh }),
      now,
    } as MutationOptions)
    expect(m.callsTo(UPDATE)[0]!.body).toEqual({
      advertiser_id: ADV,
      campaign_id: CID,
      roas_bid: 2.5,
    })
  })

  it("ROI history: change 4 days ago → no 'recent' warning; LIVE changed today → strong warning; second lowering today", async () => {
    const tt = ttFromCtx(makeCtx())
    const old = await gmvMaxRoiWarnings(
      tt,
      CID,
      "PRODUCT",
      2,
      1.8,
      {
        fieldHistory: history([
          { at: new Date("2026-10-06T03:00:00Z"), before: 2.4, after: 2 },
        ]),
      },
      now
    )
    expect(old.join(" ")).not.toContain("CẢNH BÁO MẠNH")
    const live = await gmvMaxRoiWarnings(
      tt,
      CID,
      "LIVE",
      2,
      1.8,
      {
        fieldHistory: history([
          { at: new Date("2026-10-10T01:00:00Z"), before: 2.2, after: 2 },
        ]),
      },
      now
    )
    expect(live).toEqual(
      expect.arrayContaining([
        gmvMaxRoiLiveTodayWarning(CID, 1),
        GMV_MAX_ROI_SECOND_LOWER_WARNING,
      ])
    )
    // no history hook (non-MCP caller) → only the general notes
    expect(
      await gmvMaxRoiWarnings(tt, CID, "PRODUCT", 2, 1.8, {}, now)
    ).toEqual([GMV_MAX_ROI_PROTECTION_NOTE, GMV_MAX_ROI_HISTORY_SCOPE])
  })

  it("auto budget 300 % × 10 → worst case 31 × budget through the guard (refused above the cap); payload keys per doc", async () => {
    const m = mockTikTok(baseRoutes())
    const g = guardSpy()
    const p = await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        auto_budget: {
          enabled: true,
          budget_increase_percentage: 300,
          increase_limit: 10,
        },
      },
      ON({ dryRun: true, dailySpendGuard: g.fn })
    )
    expect(g.seen[0]).toEqual([
      {
        label: expect.stringContaining(CID),
        amount: 9_300_000,
        currency: "VND",
      },
    ])
    expect(p.payload).toEqual({
      campaign_id: CID,
      auto_budget: {
        auto_budget_enabled: true,
        budget_increase_percentage: 300,
        increase_limit: 10,
      },
    })
    expect(p.changes[0]).toMatchObject({
      field: "auto_budget",
      before: "bật +50% × tối đa 10 lần/ngày",
      after: "bật +300% × tối đa 10 lần/ngày",
    })
    expect(p.warnings).toContain(GMV_MAX_BOOST_WARNING)
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        {
          campaign_id: CID,
          auto_budget: {
            enabled: true,
            budget_increase_percentage: 300,
            increase_limit: 10,
          },
        },
        ON({ dailySpendGuard: guardSpy(5_000_000).fn })
      )
    ).rejects.toThrow(/budget_cap_exceeded/)
    // switching the boost OFF needs no cap
    const off = await runGmvMaxUpdate(
      makeCtx(),
      { campaign_id: CID, auto_budget: { enabled: false } },
      { gmvMaxWrite: true, dryRun: true }
    )
    // A1: the COMPLETE object (current % / limit kept), A3: lowering needs no cap
    expect(off.payload).toEqual({
      campaign_id: CID,
      auto_budget: {
        auto_budget_enabled: false,
        budget_increase_percentage: 50,
        increase_limit: 10,
      },
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("promotion days: custom schedule in the past refused; multiplier 100 - reduction; guard asked", async () => {
    mockTikTok(baseRoutes())
    const now2 = new Date("2026-10-10T05:00:00Z")
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        {
          campaign_id: CID,
          promotion_days: {
            enabled: true,
            use_tiktok_shop_schedule: false,
            custom_schedule: [
              { start_date: "2026-10-01", end_date: "2026-10-12" },
            ],
          },
        },
        { ...ON({ dryRun: true }), now: now2 } as MutationOptions
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    const g = guardSpy()
    const p = await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        promotion_days: {
          enabled: true,
          use_tiktok_shop_schedule: false,
          custom_schedule: [
            { start_date: "2026-11-10", end_date: "2026-11-12" },
          ],
          roi_reduction_pct: 20,
        },
      },
      {
        ...ON({ dryRun: true, dailySpendGuard: g.fn }),
        now: now2,
      } as MutationOptions
    )
    // A1: complete object - % / limit from the current info (50 / 10), explicit multiplier
    expect(p.payload).toEqual({
      campaign_id: CID,
      promotion_days: {
        is_enabled: true,
        auto_schedule_enabled: false,
        custom_schedule_list: [
          { start_date: "2026-11-10", end_date: "2026-11-12" },
        ],
        roas_bid_multiplier: 80,
        budget_increase_percentage: 50,
        increase_limit: 10,
      },
    })
    // A3: promotion days 50 % × 10 = 6 × 300 000, the same as the auto budget already on → not higher → no cap check
    expect(g.seen).toHaveLength(0)
    // a higher promotion boost (300 % × 10 → 31 × 300 000) must fit the cap
    const g2 = guardSpy()
    await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        promotion_days: {
          enabled: true,
          custom_schedule: [
            { start_date: "2026-11-10", end_date: "2026-11-12" },
          ],
          budget_increase_percentage: 300,
        },
      },
      {
        ...ON({ dryRun: true, dailySpendGuard: g2.fn }),
        now: now2,
      } as MutationOptions
    )
    expect(g2.seen[0]![0]!.amount).toBe(9_300_000)
  })

  it("products: new ones must be AVAILABLE + UNOCCUPIED (occupied → refused naming the campaign); list replaced", async () => {
    const products = (c: RecordedCall) => {
      const ids = (c.query.filtering as { item_group_ids: string[] })
        .item_group_ids
      return ok({
        ...productFixture.data,
        store_products: productFixture.data.store_products.filter((p) =>
          ids.includes(p.item_group_id)
        ),
      })
    }
    const other = {
      ...ROWS[0],
      campaign_id: "1840000000000000077",
      campaign_name: "Khác",
    }
    const m = mockTikTok(
      baseRoutes({
        "GET /store/product/get/": products,
        [GMV_GET]: gmvGet({ PRODUCT_GMV_MAX: [productRow(), other] }),
        [INFO]: (c: RecordedCall) =>
          c.query.campaign_id === "1840000000000000077"
            ? info({
                campaign_id: "1840000000000000077",
                item_group_ids: ["1729000000000000005"],
              })
            : info(),
      })
    )
    const ok3 = await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        item_group_ids: ["1729000000000000001", "1729000000000000003"],
      },
      ON({ dryRun: true })
    )
    expect(ok3.changes).toEqual([
      expect.objectContaining({
        field: "item_group_ids",
        before: ["1729000000000000001", "1729000000000000002"],
        after: ["1729000000000000001", "1729000000000000003"],
      }),
    ])
    expect(ok3.warnings).toEqual(
      expect.arrayContaining([
        GMV_MAX_PRODUCTS_EDIT_WARNING,
        expect.stringContaining("VSA/PSA"),
      ])
    )
    // only NEW products are checked against /store/product/get/
    expect(m.callsTo("GET /store/product/get/")[0]!.query).toMatchObject({
      bc_id: BC,
      store_id: STORE,
      advertiser_id: ADV,
      filtering: {
        item_group_ids: ["1729000000000000003"],
        ad_creation_eligible: "GMV_MAX",
      },
    })
    mockTikTok(
      baseRoutes({
        "GET /store/product/get/": ok({
          ...productFixture.data,
          store_products: [
            {
              ...productFixture.data.store_products[1],
              item_group_id: "1729000000000000005",
            },
          ],
        }),
        [GMV_GET]: gmvGet({ PRODUCT_GMV_MAX: [productRow(), other] }),
        [INFO]: (c: RecordedCall) =>
          c.query.campaign_id === "1840000000000000077"
            ? info({
                campaign_id: "1840000000000000077",
                item_group_ids: ["1729000000000000005"],
              })
            : info(),
      })
    )
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, item_group_ids: ["1729000000000000005"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: expect.stringContaining("1840000000000000077"),
    })
  })

  it("products of an 'all products' campaign cannot be edited", async () => {
    mockTikTok(
      baseRoutes({
        [INFO]: info({ product_specific_type: "ALL", item_group_ids: [] }),
      })
    )
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, item_group_ids: ["1729000000000000003"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
  })
})

describe("tiktok_gmv_max_creatives", () => {
  it("REMOVE with spu_id_list per post (Product); Product without spu_ids / custom selection / paused campaign → refused", async () => {
    const m = mockTikTok(
      baseRoutes({ "POST /campaign/gmv_max/creative/update/": ok(creativeFixture.data) })
    )
    await expect(
      runGmvMaxCreatives(
        makeCtx(),
        {
          campaign_id: CID,
          action: "remove",
          items: [{ item_id: "7400000000000000001" }],
        },
        ON()
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    const r = await runGmvMaxCreatives(
      makeCtx(),
      {
        campaign_id: CID,
        action: "remove",
        items: [
          { item_id: "7400000000000000001", spu_ids: ["1729000000000000001"] },
        ],
      },
      ON()
    )
    expect(r.changes[0]).toMatchObject({
      field: "creative:7400000000000000001",
      after: "đã gỡ (EXCLUDED)",
    })
    expect(
      m.callsTo("POST /campaign/gmv_max/creative/update/")[0]!.body
    ).toEqual({
      advertiser_id: ADV,
      campaign_id: CID,
      action: "REMOVE",
      item_list: [
        {
          item_id: "7400000000000000001",
          spu_id_list: ["1729000000000000001"],
        },
      ],
    })
    mockTikTok(
      baseRoutes({
        [INFO]: info({ product_video_specific_type: "CUSTOM_SELECTION" }),
      })
    )
    await expect(
      runGmvMaxCreatives(
        makeCtx(),
        {
          campaign_id: CID,
          action: "add",
          items: [{ item_id: "1", spu_ids: ["2"] }],
        },
        ON()
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    mockTikTok(
      baseRoutes({
        [GMV_GET]: gmvGet({
          PRODUCT_GMV_MAX: [
            productRow({
              operation_status: "DISABLE",
              secondary_status: "CAMPAIGN_STATUS_DISABLE",
            }),
          ],
        }),
      })
    )
    await expect(
      runGmvMaxCreatives(
        makeCtx(),
        {
          campaign_id: CID,
          action: "add",
          items: [{ item_id: "1", spu_ids: ["2"] }],
        },
        ON()
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("tiktok_gmv_max_create", () => {
  const products = (c: RecordedCall) => {
    const ids = (c.query.filtering as { item_group_ids: string[] })
      .item_group_ids
    return ok({
      ...productFixture.data,
      store_products: productFixture.data.store_products.filter((p) =>
        ids.includes(p.item_group_id)
      ),
    })
  }
  const routes = (extra: Record<string, unknown> = {}) => ({
    "GET /gmv_max/store/list/": ok(storeFixture.data),
    "GET /store/product/get/": products,
    "GET /gmv_max/identity/get/": ok(identityFixture.data),
    "GET /gmv_max/store/shop_ad_usage_check/": ok(usageFixture.data),
    [GMV_GET]: gmvGet({ PRODUCT_GMV_MAX: [productRow()] }),
    [INFO]: info(),
    [CREATE]: ok(createFixture.data),
    ...extra,
  })
  const input = {
    type: "PRODUCT" as const,
    store_id: STORE,
    name: "GMV Max mới",
    budget: 500_000,
    roas_bid: 2.5,
    products: ["1729000000000000003"],
    identity_ids: ["7200000000000000002"],
  }

  it("preview: red 'runs now' warning, body per doc, guard with the daily budget; execution sends request_id from the idempotency key", async () => {
    const m = mockTikTok(routes())
    const g = guardSpy()
    const now = new Date("2026-10-10T03:00:00Z")
    const p = await runGmvMaxCreate(makeCtx(), input, {
      ...ON({ dryRun: true, dailySpendGuard: g.fn }),
      now,
    } as MutationOptions)
    expect(p.warnings[0]).toBe(GMV_MAX_RUNS_NOW_WARNING)
    expect(g.seen[0]).toEqual([
      { label: expect.any(String), amount: 500_000, currency: "VND" },
    ])
    expect(p.payload).toEqual({
      store_id: STORE,
      store_authorized_bc_id: BC,
      shopping_ads_type: "PRODUCT",
      product_specific_type: "CUSTOMIZED_PRODUCTS",
      item_group_ids: ["1729000000000000003"],
      product_video_specific_type: "AUTO_SELECTION",
      identity_list: [
        {
          identity_id: "7200000000000000002",
          identity_type: "BC_AUTH_TT",
          identity_authorized_bc_id: BC,
        },
      ],
      optimization_goal: "VALUE",
      deep_bid_type: "VO_MIN_ROAS",
      roas_bid: 2.5,
      budget: 500_000,
      schedule_start_time: "2026-10-10 03:00:00",
      schedule_type: "SCHEDULE_FROM_NOW",
      campaign_name: "GMV Max mới",
    })
    expect(m.posts()).toHaveLength(0)
    const r = await runGmvMaxCreate(makeCtx(), input, {
      ...ON({ idempotencyKey: "mcpw-abc" }),
      now,
    } as MutationOptions)
    expect(r.createdIds).toEqual(["1840000000000000099"])
    const body = m.callsTo(CREATE)[0]!.body!
    expect(body.request_id).toMatch(/^\d{1,19}$/)
    expect(body.advertiser_id).toBe(ADV)
    await runGmvMaxCreate(makeCtx(), input, {
      ...ON({ idempotencyKey: "mcpw-abc" }),
      now,
    } as MutationOptions)
    expect(m.callsTo(CREATE)[1]!.body!.request_id).toBe(body.request_id)
  })

  it("start_time in the account time zone → future schedule_start_time (UTC) + note; end before start refused", async () => {
    mockTikTok(routes())
    const now = new Date("2026-10-10T03:00:00Z")
    const p = await runGmvMaxCreate(
      makeCtx(),
      {
        ...input,
        start_time: "2026-10-12 08:00",
        end_time: "2026-10-20 23:00",
      },
      {
        ...ON({ dryRun: true }),
        now,
      } as MutationOptions
    )
    expect(p.payload).toMatchObject({
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: "2026-10-12 01:00:00",
      schedule_end_time: "2026-10-20 16:00:00",
    })
    expect(p.warnings.join(" ")).toContain("2026-10-12 08:00")
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        {
          ...input,
          start_time: "2026-10-12 08:00",
          end_time: "2026-10-12 08:30",
        },
        { ...ON({ dryRun: true }), now } as MutationOptions
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("pre-checks: shop of another ad account / product occupied / product not available / 'all products' not allowed → refused", async () => {
    mockTikTok(routes())
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...input, store_id: "7494000000000000002" },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringContaining("chưa sẵn sàng GMV Max"),
    })
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...input, products: ["1729000000000000001"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: expect.stringContaining(CID),
    })
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...input, products: ["1729000000000000009"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...input, products: "all" },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: expect.stringContaining(CID),
    })
    // identity not available for Product GMV Max
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...input, identity_ids: ["7200000000000000004"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("LIVE: the LIVE source must be available; occupied by an enabled LIVE GMV Max → refused", async () => {
    const live = {
      ...ROWS[0],
      campaign_id: "1840000000000000055",
      campaign_name: "LIVE",
    }
    mockTikTok(routes({ [GMV_GET]: gmvGet({ LIVE_GMV_MAX: [live] }) }))
    const base = {
      type: "LIVE" as const,
      store_id: STORE,
      name: "LIVE mới",
      budget: 500_000,
      roas_bid: 3,
    }
    const ok1 = await runGmvMaxCreate(
      makeCtx(),
      { ...base, identity_ids: ["7200000000000000003"] },
      ON({ dryRun: true })
    )
    expect(ok1.payload).toMatchObject({
      shopping_ads_type: "LIVE",
      identity_list: [
        { identity_id: "7200000000000000003", identity_type: "BC_AUTH_TT" },
      ],
    })
    expect(ok1.payload).not.toHaveProperty("product_video_specific_type")
    await expect(
      runGmvMaxCreate(
        makeCtx(),
        { ...base, identity_ids: ["7200000000000000002"] },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: expect.stringContaining("1840000000000000055"),
    })
    await expect(
      runGmvMaxCreate(makeCtx(), base, ON({ dryRun: true }))
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("uncertain outcome (5xx) → NO blind retry: looked up by name + creation time; found → its id + warning; not found → non-retryable error", async () => {
    const created = {
      ...ROWS[0],
      campaign_id: "1840000000000000123",
      campaign_name: "GMV Max mới",
      create_time: formatTikTokTime(new Date()),
    }
    const m = mockTikTok(
      routes({
        [CREATE]: fail(50000, "system busy"),
        [GMV_GET]: gmvGet({ PRODUCT_GMV_MAX: [productRow(), created] }),
      })
    )
    const r = await runGmvMaxCreate(
      makeCtx(),
      input,
      ON({ idempotencyKey: "k1" })
    )
    expect(m.callsTo(CREATE)).toHaveLength(1)
    expect(r.createdIds).toEqual(["1840000000000000123"])
    expect(r.warnings.join(" ")).toContain("không tạo lại")
    const lookup = m.callsTo(GMV_GET).at(-1)!
    expect(filteringOf(lookup)).toMatchObject({
      store_ids: [STORE],
      campaign_name: "GMV Max mới",
    })
    const m2 = mockTikTok(routes({ [CREATE]: fail(50000, "system busy") }))
    await expect(
      runGmvMaxCreate(makeCtx(), input, ON({ idempotencyKey: "k2" }))
    ).rejects.toMatchObject({
      retryable: false,
      hint: expect.stringContaining("ĐANG CHẠY"),
    })
    expect(m2.callsTo(CREATE)).toHaveLength(1)
  })

  it("switch OFF → locked before any read", async () => {
    const m = mockTikTok(routes())
    await expect(
      runGmvMaxCreate(makeCtx(), input, { dryRun: true })
    ).rejects.toMatchObject({ code: "feature_not_enabled" })
    expect(m.calls).toHaveLength(0)
  })
})

describe("ads_copy_object on a GMV Max campaign (C6)", () => {
  const products = (state: string) => (c: RecordedCall) => {
    const ids = (c.query.filtering as { item_group_ids: string[] })
      .item_group_ids
    return ok({
      ...productFixture.data,
      store_products: ids.map((id) => ({
        ...productFixture.data.store_products[0],
        item_group_id: id,
        gmv_max_ads_status: state,
        is_running_custom_shop_ads: false,
      })),
    })
  }
  const routes = (state: string, extra: Record<string, unknown> = {}) => ({
    ...baseRoutes(),
    "GET /gmv_max/store/list/": ok(storeFixture.data),
    "GET /store/product/get/": products(state),
    "GET /gmv_max/identity/get/": ok(identityFixture.data),
    [CREATE]: ok(createFixture.data),
    ...extra,
  })

  it("products still occupied by the (enabled) source → refused naming it", async () => {
    const m = mockTikTok(routes("OCCUPIED"))
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: expect.stringContaining(CID),
    })
    expect(m.posts()).toHaveLength(0)
  })

  it("source paused (products free) → preview newStatus active + red warning; execution creates with the same settings", async () => {
    const m = mockTikTok(routes("UNOCCUPIED"))
    const g = guardSpy()
    const p = await copyTikTokObject(
      makeCtx(),
      { level: "campaign", id: CID, deep: true },
      ON({ dryRun: true, dailySpendGuard: g.fn })
    )
    expect(p.newStatus).toBe("active")
    expect(p.warnings).toContain(GMV_MAX_RUNS_NOW_WARNING)
    expect(g.seen[0]![0]!.amount).toBe(300_000)
    const r = await copyTikTokObject(
      makeCtx(),
      { level: "campaign", id: CID, deep: false },
      ON({ idempotencyKey: "copy-1" })
    )
    expect(r.rootNewId).toBe("1840000000000000099")
    const body = m.callsTo(CREATE)[0]!.body!
    expect(body).toMatchObject({
      store_id: STORE,
      store_authorized_bc_id: BC,
      shopping_ads_type: "PRODUCT",
      product_specific_type: "CUSTOMIZED_PRODUCTS",
      item_group_ids: ["1729000000000000001", "1729000000000000002"],
      roas_bid: 2,
      budget: 300_000,
      campaign_name: "GMV Max - Tất cả sản phẩm - bản sao",
      schedule_type: "SCHEDULE_START_END",
      schedule_end_time: "2026-12-31 16:59:59",
    })
    // auto budget / promotion days are NOT copied (worst case = budget)
    expect(body).not.toHaveProperty("auto_budget")
    expect(body).not.toHaveProperty("promotion_days")
    // the source identities (TT_USER + BC_AUTH_TT) are re-checked with /gmv_max/identity/get/ and kept
    expect((body.identity_list as unknown[]).length).toBe(2)
  })

  it("'all products' campaign → refused with the explanation pointing to tiktok_gmv_max_create", async () => {
    mockTikTok(
      routes("UNOCCUPIED", {
        [INFO]: info({ product_specific_type: "ALL", item_group_ids: [] }),
      })
    )
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      userMessageVi: gmvMaxCopyAllProductsMessage(CID),
    })
  })
})

describe("read helpers for the write tools", () => {
  it("products: usable flag, prices as numbers, no image URLs; bc_id from the shop", async () => {
    const m = mockTikTok({
      "GET /gmv_max/store/list/": ok(storeFixture.data),
      "GET /store/product/get/": ok(productFixture.data),
    })
    const r = await runGmvMaxProducts(makeCtx(), {
      store_id: STORE,
      only_usable: false,
      limit: 100,
    })
    expect(
      (r.products as { usable_for_new_gmv_max: boolean }[]).map(
        (p) => p.usable_for_new_gmv_max
      )
    ).toEqual([true, false, false])
    expect(JSON.stringify(r)).not.toContain("p16-oec")
    expect(m.callsTo("GET /store/product/get/")[0]!.query).toMatchObject({
      bc_id: BC,
      store_id: STORE,
      filtering: { ad_creation_eligible: "GMV_MAX" },
    })
    const usable = await runGmvMaxProducts(makeCtx(), {
      store_id: STORE,
      only_usable: true,
      limit: 100,
    })
    expect(usable.count).toBe(1)
  })

  it("identities: availability flags, no profile_image", async () => {
    mockTikTok({
      "GET /gmv_max/store/list/": ok(storeFixture.data),
      "GET /gmv_max/identity/get/": ok(identityFixture.data),
    })
    const r = await runGmvMaxIdentities(makeCtx(), { store_id: STORE })
    expect(r.count).toBe(4)
    expect(JSON.stringify(r)).not.toContain("avatar")
  })

  it("bid recommend: major units of the account currency; LIVE needs identity_id", async () => {
    const m = mockTikTok({ "GET /gmv_max/bid/recommend/": ok(bidFixture.data) })
    const r = await runGmvMaxBidRecommend(makeCtx(), {
      store_id: STORE,
      type: "PRODUCT",
    })
    expect(r).toMatchObject({
      recommended_roas_bid: 2,
      recommended_daily_budget: 300_000,
      currency: "VND",
    })
    expect(m.calls[0]!.query).toMatchObject({
      store_id: STORE,
      shopping_ads_type: "PRODUCT",
      optimization_goal: "VALUE",
    })
    await expect(
      runGmvMaxBidRecommend(makeCtx(), { store_id: STORE, type: "LIVE" })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("extension declarations", () => {
  it("write tools: opt-in setting, always confirmed, money declared; create starts active; reads ungated", () => {
    const by = (n: string) => tiktokExtensions.find((e) => e.name === n)!
    for (const n of [
      "tiktok_gmv_max_update",
      "tiktok_gmv_max_creatives",
      "tiktok_gmv_max_create",
    ]) {
      expect(by(n)).toMatchObject({
        write: true,
        requiresSetting: "tiktok_gmv_max_write",
        alwaysConfirm: true,
      })
      expect(typeof by(n).moneyOf).toBe("function")
    }
    expect(by("tiktok_gmv_max_create").createsActive).toBe(true)
    expect(by("tiktok_gmv_max_create").moneyOf!({ budget: 5 })).toEqual([
      { kind: "daily_budget", amount: 5, field: "budget" },
    ])
    for (const n of [
      "tiktok_gmv_max_products",
      "tiktok_gmv_max_identities",
      "tiktok_gmv_max_bid_recommend",
    ]) {
      expect(by(n).requiresSetting).toBeUndefined()
      expect(by(n).write).toBe(false)
    }
  })
})
