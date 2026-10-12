// GMV Max phase 2 - fixes from the security + API conformance review (2026-10-10):
// S1 copy of a deleted campaign, S2 `confirmed` gate on every execution, S5 cumulative cap of started campaigns,
// S6 budget % rule against the GMV Max budget, S7 uncertain-create lookup, S8 preflight lock,
// A1 complete boost objects + defaults, A2 read-back, A3 guard only on increases, A4 400 products / removed list,
// A5 copy refusals, A6 definite business rejections, A7 delivering campaigns only for creatives, A8 promotion dates,
// A9 delete without retry + re-read, A10 store rows per BC, A11 legacy auto budget.
// Fixtures follow the official doc examples (see gmv-max-write.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import {
  STARTED_MAX_DAILY_SPEND_FIELD,
  STARTED_SPEND_UNCERTAIN_LOG_CODE,
  type DailySpendCheck,
  type MutationOptions,
  type StartedSpendLedger,
} from "../types"
import campaignGetFixture from "./__fixtures__/gmv-max-campaign-get.json"
import infoFixture from "./__fixtures__/gmv-max-campaign-info.json"
import createFixture from "./__fixtures__/gmv-max-create.json"
import identityFixture from "./__fixtures__/gmv-max-identity-get.json"
import productFixture from "./__fixtures__/gmv-max-store-product-get.json"
import storeFixture from "./__fixtures__/gmv-max-store-list.json"
import updateFixture from "./__fixtures__/gmv-max-update.json"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { formatTikTokTime } from "./api"
import { makeRequestId } from "./client"
import { copyTikTokObject } from "./copy"
import { isUncertainCreateError } from "./create-checked"
import { pickGmvMaxStoreRow } from "./gmv-max"
import {
  buildAutoBudgetPayload,
  buildPromotionDaysPayload,
  GMV_MAX_ITEM_GROUPS_MAX,
  gmvMaxUpdateInput,
  runGmvMaxCreate,
  runGmvMaxCreatives,
  runGmvMaxUpdate,
  startedRequestKey,
} from "./gmv-max-write"
import {
  GMV_MAX_GUARD_MISSING,
  GMV_MAX_LEGACY_AUTO_BUDGET_ON,
  GMV_MAX_PROMO_ALREADY_OFF,
  GMV_MAX_STARTED_HISTORY_UNAVAILABLE,
  gmvMaxConfirmReason,
  gmvMaxCopyCustomPostsMessage,
  gmvMaxCopyDeletedMessage,
  gmvMaxDeletedDespiteError,
  gmvMaxLockedMessage,
  gmvMaxPauseNotApplied,
  gmvMaxRoasRoundedWarning,
} from "./gmv-max-text"
import {
  deleteTikTokObject,
  setTikTokStatus,
  tiktokMustAlwaysConfirm,
  tiktokPreflightWrite,
  updateTikTokBudget,
  updateTikTokObject,
} from "./mutate"
import { getTikTokObject } from "./objects"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ADV = "7100000000000000001"
const CID = "1840000000000000001" // info fixture: budget 300 000 VND, auto budget 50 % × 10 → worst case 1 800 000
const NEW_ID = "1840000000000000099"
const STORE = "7494000000000000001"
const GMV_GET = "GET /gmv_max/campaign/get/"
const INFO = "GET /campaign/gmv_max/info/"
const UPDATE = "POST /campaign/gmv_max/update/"
const CREATE = "POST /campaign/gmv_max/create/"
const STATUS = "POST /campaign/status/update/"
const CREATIVE = "POST /campaign/gmv_max/creative/update/"

type Filtering = {
  gmv_max_promotion_types: string[]
  campaign_ids?: string[]
  primary_status?: string
  campaign_name?: string
}
const filteringOf = (c: RecordedCall) => c.query.filtering as Filtering
const ROWS = campaignGetFixture.data.list as Record<string, unknown>[]
const productRow = (over: Record<string, unknown> = {}) => ({
  ...ROWS[0],
  ...over,
})
const campaignGetEmpty = ok({ list: [], page_info: { total_page: 0 } })

/** /gmv_max/campaign/get/ filtered like TikTok (DELIVERY_OK = ENABLE rows, DELETE = deleted rows only). */
function gmvGet(
  rows: Record<string, unknown>[],
  deleted: Record<string, unknown>[] = []
) {
  return (c: RecordedCall) => {
    const f = filteringOf(c)
    let list = f.gmv_max_promotion_types[0] === "PRODUCT_GMV_MAX" ? rows : []
    if (f.primary_status === "STATUS_DELETE")
      list = f.gmv_max_promotion_types[0] === "PRODUCT_GMV_MAX" ? deleted : []
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

function info(over: Record<string, unknown> = {}) {
  return ok({ ...infoFixture.data, ...over })
}

function guardSpy(cap = 10_000_000) {
  const seen: DailySpendCheck[][] = []
  const fn = (items: DailySpendCheck[]) => {
    seen.push(items)
    for (const it of items)
      if (it.amount > cap) throw new Error(`budget_cap_exceeded ${it.amount}`)
  }
  return { fn, seen }
}

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
  protectionMode: "advanced",
  dailySpendGuard: () => {},
  budgetChangeGuard: async () => {},
  startedSpend24h: async () => [],
  startedSpendLedger: testLedger(),
  ...extra,
})

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /campaign/get/": campaignGetEmpty,
    [GMV_GET]: gmvGet([productRow()]),
    [INFO]: info(),
    [UPDATE]: ok(updateFixture.data),
    [STATUS]: ok({ campaign_ids: [CID] }),
    ...extra,
  }
}

const products = (c: RecordedCall) => {
  const ids = (c.query.filtering as { item_group_ids: string[] }).item_group_ids
  return ok({
    ...productFixture.data,
    store_products: ids.map((id) => ({
      ...productFixture.data.store_products[0],
      item_group_id: id,
      status: "AVAILABLE",
      gmv_max_ads_status: "UNOCCUPIED",
      is_running_custom_shop_ads: false,
    })),
  })
}

/** create / copy routes; /campaign/gmv_max/info/ of the NEW campaign mirrors what was created */
function createRoutes(
  extra: Record<string, unknown> = {},
  newInfo: Record<string, unknown> = {}
) {
  return baseRoutes({
    "GET /gmv_max/store/list/": ok(storeFixture.data),
    "GET /store/product/get/": products,
    "GET /gmv_max/identity/get/": ok(identityFixture.data),
    [CREATE]: ok(createFixture.data),
    [INFO]: (c: RecordedCall) =>
      c.query.campaign_id === NEW_ID
        ? ok({
            ...createFixture.data,
            auto_budget: { auto_budget_enabled: false },
            ...newInfo,
          })
        : info(),
    ...extra,
  })
}

const createInput = {
  type: "PRODUCT" as const,
  store_id: STORE,
  name: "GMV Max mới",
  budget: 500_000,
  roas_bid: 2.5,
  products: ["1729000000000000003"],
  identity_ids: ["7200000000000000002"],
}

describe("S1: copy of a DELETED GMV Max campaign", () => {
  const deletedRow = productRow({
    operation_status: "DISABLE",
    secondary_status: "CAMPAIGN_STATUS_DELETE",
  })

  it("the adapter refuses it (nothing created) and the always-confirm hook flags it for copy / update / delete", async () => {
    const m = mockTikTok(
      createRoutes({
        "GET /campaign/get/": ok({
          list: [deletedRow],
          page_info: { total_page: 1 },
        }),
        [GMV_GET]: gmvGet([], [deletedRow]),
      })
    )
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: gmvMaxCopyDeletedMessage(CID),
    })
    expect(m.posts()).toHaveLength(0)
    for (const op of ["copy", "update", "delete"] as const) {
      expect(
        await tiktokMustAlwaysConfirm(makeCtx(), "campaign", [CID], op)
      ).toEqual([gmvMaxConfirmReason(CID)])
    }
    // on / off of a deleted row sends nothing → not flagged
    expect(
      await tiktokMustAlwaysConfirm(makeCtx(), "campaign", [CID], "paused")
    ).toEqual([])
  })
})

describe("S2: GMV Max writes EXECUTE only through a consumed confirmation (opts.confirmed)", () => {
  it("every execution path refuses without it - nothing is sent; previews still work", async () => {
    const m = mockTikTok(
      createRoutes({
        [GMV_GET]: gmvGet([productRow()]),
        "GET /campaign/get/": campaignGetEmpty,
      })
    )
    const unconfirmed = ON({ confirmed: undefined })
    const refused = {
      code: "feature_not_enabled",
      message: expect.stringContaining("gmv_max_unconfirmed"),
    }
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 310_000 },
        unconfirmed
      )
    ).rejects.toMatchObject(refused)
    await expect(
      updateTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, changes: { name: "X" } },
        unconfirmed
      )
    ).rejects.toMatchObject(refused)
    await expect(
      deleteTikTokObject(makeCtx(), "campaign", CID, unconfirmed)
    ).rejects.toMatchObject(refused)
    await expect(
      setTikTokStatus(makeCtx(), "campaign", [CID], "paused", unconfirmed)
    ).rejects.toMatchObject(refused)
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, roas_bid: 2.5 },
        unconfirmed
      )
    ).rejects.toMatchObject(refused)
    await expect(
      runGmvMaxCreatives(
        makeCtx(),
        {
          campaign_id: CID,
          action: "remove",
          items: [{ item_id: "7400000000000000001", spu_ids: ["1"] }],
        },
        unconfirmed
      )
    ).rejects.toMatchObject(refused)
    await expect(
      runGmvMaxCreate(makeCtx(), createInput, unconfirmed)
    ).rejects.toMatchObject(refused)
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        unconfirmed
      )
    ).rejects.toMatchObject(refused)
    expect(m.posts()).toHaveLength(0)
    // a preview (dryRun) needs no confirmation
    const p = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 310_000 },
      { ...unconfirmed, dryRun: true }
    )
    expect(p.preview).toBe(true)
  })
})

describe("S5: cumulative cap of GMV Max campaigns started by this MCP in 24 h", () => {
  it("create: earlier starts + the new budget must fit the daily cap; missing / failing history → refused", async () => {
    mockTikTok(createRoutes())
    const now = new Date("2026-10-10T03:00:00Z")
    const at = new Date()
    const g = guardSpy(10_000_000)
    const p = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({
        dryRun: true,
        dailySpendGuard: g.fn,
        startedSpend24h: async () => [
          { objectId: "A", amount: 6_000_000, at },
          { objectId: "A", amount: 7_000_000, at }, // same campaign started twice → counted once (largest)
          { objectId: "B", amount: 2_000_000, at },
        ],
      }),
      now,
    } as MutationOptions)
    expect(g.seen.at(-1)).toEqual([
      {
        label: expect.stringContaining("24 giờ"),
        amount: 9_500_000,
        currency: "VND",
      },
    ])
    expect(p.warnings.join(" ")).toContain("Trần ngân sách cộng dồn")
    await expect(
      runGmvMaxCreate(makeCtx(), createInput, {
        ...ON({
          dryRun: true,
          dailySpendGuard: guardSpy(9_000_000).fn,
          startedSpend24h: async () => [
            { objectId: "A", amount: 8_600_000, at },
          ],
        }),
        now,
      } as MutationOptions)
    ).rejects.toThrow(/budget_cap_exceeded 9100000/)
    await expect(
      runGmvMaxCreate(makeCtx(), createInput, {
        ...ON({ dryRun: true, startedSpend24h: undefined }),
        now,
      } as MutationOptions)
    ).rejects.toMatchObject({ userMessageVi: GMV_MAX_GUARD_MISSING })
    await expect(
      runGmvMaxCreate(makeCtx(), createInput, {
        ...ON({
          dryRun: true,
          startedSpend24h: async () => {
            throw new Error("db down")
          },
        }),
        now,
      } as MutationOptions)
    ).rejects.toMatchObject({
      userMessageVi: GMV_MAX_STARTED_HISTORY_UNAVAILABLE,
    })
  })

  it("create / copy / enable record the worst-case daily spend of the campaign that starts running", async () => {
    const m = mockTikTok(createRoutes())
    const now = new Date("2026-10-10T03:00:00Z")
    const r = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON(),
      now,
    } as MutationOptions)
    expect(r.changes).toContainEqual(
      expect.objectContaining({
        objectId: NEW_ID,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 500_000,
      })
    )
    expect(m.callsTo(CREATE)).toHaveLength(1)
    // copy: paused source (products free) → extraChanges carry the started spend
    mockTikTok(
      createRoutes(
        {
          [GMV_GET]: gmvGet([productRow({ operation_status: "DISABLE" })]),
        },
        // the copy as TikTok reports it (same settings as the source, no boost)
        {
          budget: 300_000,
          roas_bid: 2,
          item_group_ids: ["1729000000000000001", "1729000000000000002"],
        }
      )
    )
    const c = await copyTikTokObject(
      makeCtx(),
      { level: "campaign", id: CID, deep: false },
      ON({ idempotencyKey: "c1" })
    )
    expect(c.extraChanges).toEqual([
      expect.objectContaining({
        objectId: NEW_ID,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 300_000,
      }),
    ])
    // enable: the campaign itself is not counted twice (its own earlier start is replaced)
    mockTikTok(
      baseRoutes({
        [GMV_GET]: gmvGet([
          productRow({
            operation_status: "DISABLE",
            secondary_status: "CAMPAIGN_STATUS_DISABLE",
          }),
        ]),
        [INFO]: (_c: RecordedCall, n: number) =>
          n === 0 ? info({ operation_status: "DISABLE" }) : info(),
      })
    )
    const g = guardSpy(2_000_000)
    const s = await setTikTokStatus(
      makeCtx(),
      "campaign",
      [CID],
      "active",
      ON({
        dailySpendGuard: g.fn,
        startedSpend24h: async () => [
          { objectId: CID, amount: 1_800_000, at: new Date() },
        ],
      })
    )
    expect(s.changes).toContainEqual(
      expect.objectContaining({
        objectId: CID,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 1_800_000,
      })
    )
    expect(g.seen.flat().every((x) => x.amount <= 2_000_000)).toBe(true)
  })
})

describe("S6: ads_update_budget % rule against the GMV Max budget read by the adapter", () => {
  it("budgetChangeGuard gets info.budget as the current value; missing guard → refused", async () => {
    mockTikTok(baseRoutes())
    const seen: unknown[] = []
    await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 330_000 },
      ON({ dryRun: true, budgetChangeGuard: async (q) => void seen.push(q) })
    )
    expect(seen).toEqual([{ current: 300_000, next: 330_000, currency: "VND" }])
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 330_000 },
        ON({
          dryRun: true,
          budgetChangeGuard: async () => {
            throw new Error("budget_change_too_large")
          },
        })
      )
    ).rejects.toThrow(/budget_change_too_large/)
    await expect(
      updateTikTokBudget(
        makeCtx(),
        { level: "campaign", id: CID, type: "daily", amount: 330_000 },
        ON({ dryRun: true, budgetChangeGuard: undefined })
      )
    ).rejects.toMatchObject({ userMessageVi: GMV_MAX_GUARD_MISSING })
  })

  it("getObject forWrite: a failed GMV Max check of a candidate refuses instead of falling back to the generic budget", async () => {
    mockTikTok(
      baseRoutes({
        "GET /campaign/get/": ok({
          list: [
            {
              campaign_id: CID,
              objective_type: "PRODUCT_SALES",
              operation_status: "ENABLE",
              budget: 999_000,
              budget_mode: "BUDGET_MODE_DAY",
            },
          ],
          page_info: { total_page: 1 },
        }),
        [GMV_GET]: fail(40001, "no permission"),
      })
    )
    await expect(
      getTikTokObject(makeCtx(), "campaign", CID, { forWrite: true })
    ).rejects.toBeInstanceOf(ProviderError)
    // reads keep the generic detail
    expect((await getTikTokObject(makeCtx(), "campaign", CID)).id).toBe(CID)
  })
})

describe("S7: uncertain create → only a campaign created after the request (same shop, exact name)", () => {
  it("an older same-name campaign is NOT reported as the new one", async () => {
    const old = {
      ...ROWS[0],
      campaign_id: "1840000000000000555",
      campaign_name: "GMV Max mới",
      create_time: formatTikTokTime(new Date(Date.now() - 60 * 60_000)),
    }
    const m = mockTikTok(
      createRoutes({
        [CREATE]: fail(50000, "system busy"),
        [GMV_GET]: gmvGet([productRow(), old]),
      })
    )
    const err = await runGmvMaxCreate(
      makeCtx(),
      createInput,
      ON({ idempotencyKey: "k7" })
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ retryable: false })
    expect(String((err as ProviderError).userMessageVi)).not.toContain(
      "1840000000000000555"
    )
    expect(m.callsTo(CREATE)).toHaveLength(1)
  })
})

describe("S8: switch OFF → the lock refusal comes before mcp-core's cap checks (preflightWrite)", () => {
  it("locked for a GMV Max campaign; switch ON or non-GMV → nothing to refuse", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      tiktokPreflightWrite(makeCtx(), "campaign", [CID], "active", {})
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage(CID),
    })
    const before = m.calls.length
    await tiktokPreflightWrite(makeCtx(), "campaign", [CID], "active", {
      gmvMaxWrite: true,
    })
    await tiktokPreflightWrite(makeCtx(), "ad_group", ["1"], "active", {})
    expect(m.calls.length).toBe(before)
  })
})

describe("A1 / A8: complete auto_budget / promotion_days objects", () => {
  it("auto budget: input → current → documented defaults (50 / 10), always both values", () => {
    const notes: string[] = []
    expect(buildAutoBudgetPayload({}, { enabled: true }, notes)).toEqual({
      auto_budget_enabled: true,
      budget_increase_percentage: 50,
      increase_limit: 10,
    })
    expect(notes).toHaveLength(1)
    expect(
      buildAutoBudgetPayload(
        { budget_increase_percentage: 120, increase_limit: 4 },
        { enabled: true, increase_limit: 6 }
      )
    ).toEqual({
      auto_budget_enabled: true,
      budget_increase_percentage: 120,
      increase_limit: 6,
    })
    expect(
      buildAutoBudgetPayload(
        { budget_increase_percentage: 120, increase_limit: 4 },
        { enabled: false }
      )
    ).toEqual({
      auto_budget_enabled: false,
      budget_increase_percentage: 120,
      increase_limit: 4,
    })
  })

  const ctx = { today: "2026-10-10", campaignStartDate: "2026-09-02" }
  const current = {
    is_enabled: true,
    auto_schedule_enabled: true,
    custom_schedule_list: [
      { start_time: "2026-09-01", end_time: "2026-09-05" }, // past → dropped
      { start_time: "2026-10-08", end_time: "2026-10-12" }, // running → restarts today
      { start_time: "2026-11-11", end_time: "2026-11-12" },
    ],
    roas_bid_multiplier: 80,
    budget_increase_percentage: 100,
    increase_limit: 5,
  }

  it("promotion days: current ranges converted (start_time → start_date), past dropped, running from today; values kept", () => {
    expect(buildPromotionDaysPayload(current, { enabled: true }, ctx)).toEqual({
      is_enabled: true,
      auto_schedule_enabled: true,
      roas_bid_multiplier: 80,
      budget_increase_percentage: 100,
      increase_limit: 5,
      custom_schedule_list: [
        { start_date: "2026-10-10", end_date: "2026-10-12" },
        { start_date: "2026-11-11", end_date: "2026-11-12" },
      ],
    })
  })

  it("custom_schedule without the TikTok-Shop flag → auto_schedule_enabled false; explicit flag kept; defaults when unknown", () => {
    const notes: string[] = []
    const p = buildPromotionDaysPayload(
      {},
      {
        enabled: true,
        custom_schedule: [{ start_date: "2026-11-01", end_date: "2026-11-03" }],
      },
      ctx,
      notes
    )
    expect(p).toEqual({
      is_enabled: true,
      auto_schedule_enabled: false,
      custom_schedule_list: [
        { start_date: "2026-11-01", end_date: "2026-11-03" },
      ],
      roas_bid_multiplier: 90,
      budget_increase_percentage: 50,
      increase_limit: 10,
    })
    expect(notes).toHaveLength(1)
    expect(
      buildPromotionDaysPayload(
        {},
        {
          enabled: true,
          use_tiktok_shop_schedule: true,
          custom_schedule: [
            { start_date: "2026-11-01", end_date: "2026-11-03" },
          ],
        },
        ctx
      )!.auto_schedule_enabled
    ).toBe(true)
  })

  it("A8: start_date must be before end_date and not before the campaign start date", () => {
    const bad =
      (s: string, e: string, c = ctx) =>
      () =>
        buildPromotionDaysPayload(
          {},
          { enabled: true, custom_schedule: [{ start_date: s, end_date: e }] },
          c
        )
    expect(bad("2026-11-03", "2026-11-03")).toThrow(/TRƯỚC ngày kết thúc/)
    expect(bad("2026-11-04", "2026-11-03")).toThrow(/TRƯỚC ngày kết thúc/)
    expect(
      bad("2026-10-11", "2026-10-13", {
        today: "2026-10-10",
        campaignStartDate: "2026-10-12",
      })
    ).toThrow(/ngày bắt đầu của chiến dịch/)
  })

  it("disable: already off → null (nothing sent); on → complete current values with is_enabled false", () => {
    expect(
      buildPromotionDaysPayload({ is_enabled: false }, { enabled: false }, ctx)
    ).toBeNull()
    expect(buildPromotionDaysPayload(current, { enabled: false }, ctx)).toEqual(
      {
        is_enabled: false,
        auto_schedule_enabled: true,
        roas_bid_multiplier: 80,
        budget_increase_percentage: 100,
        increase_limit: 5,
        custom_schedule_list: [
          { start_date: "2026-10-10", end_date: "2026-10-12" },
          { start_date: "2026-11-11", end_date: "2026-11-12" },
        ],
      }
    )
  })

  it("tiktok_gmv_max_update: promotion days already off + nothing else → refused; promotion_days never sent to disable an off boost", async () => {
    const m = mockTikTok(baseRoutes())
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, promotion_days: { enabled: false } },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
    const p = await runGmvMaxUpdate(
      makeCtx(),
      { campaign_id: CID, roas_bid: 2.2, promotion_days: { enabled: false } },
      ON({ dryRun: true })
    )
    expect(p.payload).not.toHaveProperty("promotion_days")
    expect(p.warnings).toContain(GMV_MAX_PROMO_ALREADY_OFF)
    expect(m.posts()).toHaveLength(0)
  })
})

describe("A2: read back after every write", () => {
  it("update: a value TikTok did not apply → red warning; a higher worst case than approved → error (check / pause)", async () => {
    mockTikTok(
      baseRoutes({
        [INFO]: (_c: RecordedCall, n: number) =>
          n === 0 ? info() : info({ roas_bid: 2 }),
      })
    )
    const r = await runGmvMaxUpdate(
      makeCtx(),
      { campaign_id: CID, roas_bid: 2.5 },
      ON()
    )
    expect(r.warnings.join(" ")).toContain("LỖI ĐỐI CHIẾU")
    // auto budget switched OFF, but TikTok still reports it on with 300 % × 10 → spend above the approved worst case
    mockTikTok(
      baseRoutes({
        [INFO]: (_c: RecordedCall, n: number) =>
          n === 0
            ? info()
            : info({
                auto_budget: {
                  auto_budget_enabled: true,
                  budget_increase_percentage: 300,
                  increase_limit: 10,
                },
              }),
      })
    )
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        { campaign_id: CID, auto_budget: { enabled: false } },
        ON()
      )
    ).rejects.toMatchObject({
      code: "upstream_error",
      userMessageVi: expect.stringContaining("TẠM DỪNG"),
    })
  })

  it("budget: read-back budget differs → warning", async () => {
    mockTikTok(
      baseRoutes({
        [INFO]: (_c: RecordedCall, n: number) =>
          n === 0 ? info() : info({ budget: 300_000 }),
      })
    )
    const r = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 310_000 },
      ON()
    )
    expect(r.warnings.join(" ")).toContain("ngân sách ngày")
  })

  it("create: a read-back above the approved worst case is the FIRST warning (the id is still returned) and is recorded", async () => {
    mockTikTok(
      createRoutes(
        {},
        {
          auto_budget: {
            auto_budget_enabled: true,
            budget_increase_percentage: 100,
            increase_limit: 2,
          },
        }
      )
    )
    const now = new Date("2026-10-10T03:00:00Z")
    const r = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON(),
      now,
    } as MutationOptions)
    expect(r.createdIds).toEqual([NEW_ID])
    expect(r.warnings[0]).toContain("TẠM DỪNG")
    expect(r.changes).toContainEqual(
      expect.objectContaining({
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 1_500_000,
      })
    )
  })

  it("status: a pause that did not take effect → loud warning", async () => {
    mockTikTok(baseRoutes())
    const r = await setTikTokStatus(
      makeCtx(),
      "campaign",
      [CID],
      "paused",
      ON()
    )
    expect(r.warnings).toContain(gmvMaxPauseNotApplied(CID, "ENABLE"))
  })
})

describe("A3: the cap applies only when the worst case rises", () => {
  it("a budget decrease is not blocked by a cap below the current worst case", async () => {
    const m = mockTikTok(baseRoutes())
    const g = guardSpy(1_000_000) // current worst case 1 800 000 is already above it
    const r = await updateTikTokBudget(
      makeCtx(),
      { level: "campaign", id: CID, type: "daily", amount: 200_000 },
      ON({ dailySpendGuard: g.fn })
    )
    expect(g.seen).toHaveLength(0)
    expect(r.preview).toBe(false)
    expect(m.callsTo(UPDATE)[0]!.body).toMatchObject({ budget: 200_000 })
  })
})

describe("A4: products", () => {
  it("up to 400 products accepted by the schema; removed products are listed in the preview", async () => {
    expect(
      gmvMaxUpdateInput.safeParse({
        campaign_id: CID,
        item_group_ids: Array.from({ length: 400 }, (_, i) => String(1e15 + i)),
      }).success
    ).toBe(true)
    expect(GMV_MAX_ITEM_GROUPS_MAX).toBe(400)
    mockTikTok(baseRoutes({ "GET /store/product/get/": products }))
    const p = await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        item_group_ids: ["1729000000000000001", "1729000000000000009"],
      },
      ON({ dryRun: true })
    )
    expect(p.warnings.join(" ")).toContain("GỠ 1 sản phẩm")
    expect(p.warnings.join(" ")).toContain("1729000000000000002")
  })
})

describe("A5: copy refusals and ROI precision", () => {
  const paused = gmvGet([productRow({ operation_status: "DISABLE" })])

  it("campaign-level customized posts → refused; > 50 posts (custom selection) → refused", async () => {
    mockTikTok(
      createRoutes({
        [GMV_GET]: paused,
        [INFO]: info({ campaign_custom_anchor_video_id: "777" }),
      })
    )
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      userMessageVi: gmvMaxCopyCustomPostsMessage(CID),
    })
    mockTikTok(
      createRoutes({
        [GMV_GET]: paused,
        [INFO]: info({ custom_anchor_video_list: [{ item_id: "1" }] }),
      })
    )
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      userMessageVi: gmvMaxCopyCustomPostsMessage(CID),
    })
    const item = infoFixture.data.item_list[0]!
    mockTikTok(
      createRoutes({
        [GMV_GET]: paused,
        [INFO]: info({
          product_video_specific_type: "CUSTOM_SELECTION",
          item_list: Array.from({ length: 51 }, (_, i) => ({
            ...item,
            item_id: String(7400000000000000000 + i),
          })),
        }),
      })
    )
    await expect(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: CID, deep: false },
        ON({ dryRun: true })
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringContaining("tối đa 50"),
    })
  })

  it("an ROI target with more precision than TikTok accepts → warned, not silently rounded", async () => {
    mockTikTok(
      createRoutes({ [GMV_GET]: paused, [INFO]: info({ roas_bid: 2.25 }) })
    )
    const p = await copyTikTokObject(
      makeCtx(),
      { level: "campaign", id: CID, deep: false },
      ON({ dryRun: true })
    )
    expect(p.warnings).toContain(gmvMaxRoasRoundedWarning(2.25, 2.3))
  })
})

describe("A6: business error codes are definite rejections", () => {
  const pe = (
    code: number,
    http = 200,
    kind: ProviderError["code"] = "unknown"
  ) =>
    new ProviderError({
      platform: "tiktok",
      code: kind,
      message: "x",
      userMessageVi: "x",
      upstream: { code, httpStatus: http },
    })
  it("only server codes (5xxxx / 60001), 40050, timeouts and network errors stay uncertain", () => {
    expect(isUncertainCreateError(pe(40099))).toBe(false)
    expect(isUncertainCreateError(pe(40002, 200, "invalid_request"))).toBe(
      false
    )
    expect(isUncertainCreateError(pe(50000, 200, "upstream_error"))).toBe(true)
    expect(isUncertainCreateError(pe(60001, 200, "upstream_error"))).toBe(true)
    expect(isUncertainCreateError(pe(40050, 200, "conflict"))).toBe(true)
    expect(isUncertainCreateError(new TypeError("fetch failed"))).toBe(true)
    expect(
      isUncertainCreateError(
        new ProviderError({
          platform: "tiktok",
          code: "upstream_error",
          message: "503",
          userMessageVi: "x",
          upstream: { httpStatus: 503 },
        })
      )
    ).toBe(true)
  })
})

describe("A7: creatives only on a DELIVERING campaign", () => {
  it("switched on but not delivering (out of budget) → refused, nothing sent", async () => {
    const m = mockTikTok(
      baseRoutes({
        [GMV_GET]: gmvGet([
          productRow({ secondary_status: "CAMPAIGN_STATUS_BUDGET_EXCEED" }),
        ]),
        [CREATIVE]: ok({}),
      })
    )
    await expect(
      runGmvMaxCreatives(
        makeCtx(),
        {
          campaign_id: CID,
          action: "remove",
          items: [
            {
              item_id: "7400000000000000001",
              spu_ids: ["1729000000000000001"],
            },
          ],
        },
        ON()
      )
    ).rejects.toMatchObject({
      userMessageVi: expect.stringContaining("CAMPAIGN_STATUS_BUDGET_EXCEED"),
    })
    expect(m.posts()).toHaveLength(0)
  })
})

describe("A9: delete is not retried; an error is checked by reading the status back", () => {
  it("error but deleted → success with a warning; error and not deleted → the error", async () => {
    const m = mockTikTok(
      baseRoutes({
        [STATUS]: fail(50000, "system busy"),
        [GMV_GET]: gmvGet([productRow()], [productRow()]),
      })
    )
    const r = await deleteTikTokObject(makeCtx(), "campaign", CID, ON())
    expect(m.callsTo(STATUS)).toHaveLength(1)
    expect(r.warnings).toContain(gmvMaxDeletedDespiteError(CID))
    const m2 = mockTikTok(baseRoutes({ [STATUS]: fail(50000, "system busy") }))
    await expect(
      deleteTikTokObject(makeCtx(), "campaign", CID, ON())
    ).rejects.toMatchObject({ code: "upstream_error" })
    expect(m2.callsTo(STATUS)).toHaveLength(1)
  })
})

describe("A10: /gmv_max/store/list/ rows per Business Center", () => {
  const base = storeFixture.data.store_list[0]! as Record<string, unknown>
  const partner = {
    ...base,
    is_owner_bc: false,
    store_authorized_bc_id: "7300000000000000777",
    exclusive_authorized_advertiser_info: {
      advertiser_id: "7100000000000000999",
      advertiser_status: "STATUS_ENABLE",
    },
  }
  it("the row ready for THIS advertiser wins (owner BC first among equals)", () => {
    expect(pickGmvMaxStoreRow([partner, base], STORE, ADV)).toBe(base)
    const partnerReady = {
      ...base,
      is_owner_bc: false,
      store_authorized_bc_id: "7300000000000000777",
    }
    expect(pickGmvMaxStoreRow([partnerReady, base], STORE, ADV)).toBe(base)
    expect(pickGmvMaxStoreRow([partner], "999", ADV)).toBeNull()
  })

  it("create uses that row (a non-ready partner row listed first does not block)", async () => {
    mockTikTok(
      createRoutes({
        "GET /gmv_max/store/list/": ok({ store_list: [partner, base] }),
      })
    )
    const now = new Date("2026-10-10T03:00:00Z")
    const p = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({ dryRun: true }),
      now,
    } as MutationOptions)
    expect(p.payload).toMatchObject({
      store_authorized_bc_id: base.store_authorized_bc_id,
    })
  })
})

describe("A11: legacy root auto_budget_enabled (× 10)", () => {
  it("shown in the preview and counted in the worst case", async () => {
    mockTikTok(
      baseRoutes({
        [INFO]: info({
          auto_budget_enabled: true,
          auto_budget: { auto_budget_enabled: false },
        }),
      })
    )
    const g = guardSpy()
    const p = await runGmvMaxUpdate(
      makeCtx(),
      {
        campaign_id: CID,
        auto_budget: {
          enabled: true,
          budget_increase_percentage: 50,
          increase_limit: 1,
        },
      },
      ON({ dryRun: true, dailySpendGuard: g.fn })
    )
    expect(p.warnings).toContain(GMV_MAX_LEGACY_AUTO_BUDGET_ON)
    expect(String(p.changes[0]!.before)).toContain("kiểu cũ")
    // legacy × 10 = 3 000 000 already the current worst case; 150 % is lower → no cap check (A3)
    expect(g.seen).toHaveLength(0)
    expect(p.warnings.join(" ")).toContain("3.000.000")
  })
})

describe("S5 follow-up: ledger reservations (M1), raises of running campaigns (M2), uncertain starts (L1), lock first (L5)", () => {
  const now = new Date("2026-10-10T03:00:00Z")
  type LedgerLog = { op: string; args: unknown[] }[]
  const spyLedger = () => {
    const log: LedgerLog = []
    const state = { locked: 0 }
    const base = testLedger(log)
    const ledger: StartedSpendLedger = {
      exclusive: async (fn) => {
        state.locked++
        return fn()
      },
      reserve: base.reserve,
    }
    return { log, state, ledger }
  }

  it("M1 create: check + reservation under the lock (request key), settled to the new id; a preview neither locks nor reserves", async () => {
    mockTikTok(createRoutes())
    const l = spyLedger()
    await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({ dryRun: true, startedSpendLedger: l.ledger }),
      now,
    } as MutationOptions)
    expect(l.state.locked).toBe(0)
    expect(l.log).toEqual([])
    const r = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({ idempotencyKey: "m1", startedSpendLedger: l.ledger }),
      now,
    } as MutationOptions)
    const key = startedRequestKey(makeRequestId("m1", "gmv_max_create"))
    expect(l.state.locked).toBe(1)
    expect(l.log).toEqual([
      { op: "reserve", args: [[{ objectId: key, amount: 500_000 }]] },
      { op: "settle", args: [key, { objectId: NEW_ID, amount: 500_000 }] },
    ])
    expect(r.createdIds).toEqual([NEW_ID])
  })

  it("M1 create: execution without the ledger → refused before anything is sent (fail closed)", async () => {
    const m = mockTikTok(createRoutes())
    await expect(
      runGmvMaxCreate(makeCtx(), createInput, {
        ...ON({ startedSpendLedger: undefined }),
        now,
      } as MutationOptions)
    ).rejects.toMatchObject({ userMessageVi: GMV_MAX_GUARD_MISSING })
    expect(m.callsTo(CREATE)).toHaveLength(0)
  })

  it("L1 create: definite rejection → reservation released; timeout + not found → kept and the error carries the started change + uncertain code", async () => {
    mockTikTok(createRoutes({ [CREATE]: fail(40002, "invalid param") }))
    const d = spyLedger()
    const err1 = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({ idempotencyKey: "l1a", startedSpendLedger: d.ledger }),
      now,
    } as MutationOptions).catch((e: unknown) => e)
    expect(err1).toBeInstanceOf(ProviderError)
    expect((err1 as ProviderError).audit).toBeUndefined()
    expect(d.log.map((x) => x.op)).toEqual(["reserve", "release"])

    mockTikTok(createRoutes({ [CREATE]: fail(50000, "system busy") }))
    const u = spyLedger()
    const err2 = await runGmvMaxCreate(makeCtx(), createInput, {
      ...ON({ idempotencyKey: "l1b", startedSpendLedger: u.ledger }),
      now,
    } as MutationOptions).catch((e: unknown) => e)
    const key = startedRequestKey(makeRequestId("l1b", "gmv_max_create"))
    expect(err2).toMatchObject({
      retryable: false,
      audit: {
        errorCode: STARTED_SPEND_UNCERTAIN_LOG_CODE,
        changes: [
          expect.objectContaining({
            objectId: key,
            field: STARTED_MAX_DAILY_SPEND_FIELD,
            after: 500_000,
          }),
        ],
      },
    })
    // kept for 24 h: neither released nor settled
    expect(u.log.map((x) => x.op)).toEqual(["reserve"])
  })

  it("M2 ads_update_budget: a RUNNING campaign's higher worst case enters the cumulative cap (its own entry replaced) and is recorded", async () => {
    const at = new Date()
    const u = {
      level: "campaign" as const,
      id: CID,
      type: "daily" as const,
      amount: 330_000,
    }
    // 300 000 → 330 000 with auto budget 50 % × 10: worst case 1 800 000 → 1 980 000
    mockTikTok(baseRoutes())
    await expect(
      updateTikTokBudget(
        makeCtx(),
        u,
        ON({
          dailySpendGuard: guardSpy(3_000_000).fn,
          startedSpend24h: async () => [
            { objectId: "OTHER", amount: 1_500_000, at },
          ],
        })
      )
    ).rejects.toThrow(/budget_cap_exceeded 3480000/)
    const l = spyLedger()
    mockTikTok(baseRoutes())
    const r = await updateTikTokBudget(
      makeCtx(),
      u,
      ON({
        dailySpendGuard: guardSpy(2_000_000).fn,
        // already counted: its old entry is replaced by the new worst case (1 980 000 ≤ 2 000 000)
        startedSpend24h: async () => [
          { objectId: CID, amount: 1_800_000, at },
        ],
        startedSpendLedger: l.ledger,
      })
    )
    expect(r.changes).toContainEqual(
      expect.objectContaining({
        objectId: CID,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 1_980_000,
      })
    )
    expect(l.log).toEqual([
      { op: "reserve", args: [[{ objectId: CID, amount: 1_980_000 }]] },
      { op: "settle", args: [CID, { objectId: CID, amount: 1_980_000 }] },
    ])
    // a paused campaign is not spending: no cumulative check, nothing recorded (enabling it later is checked)
    mockTikTok(baseRoutes({ [INFO]: info({ operation_status: "DISABLE" }) }))
    const read = vi.fn(async () => [])
    const p = await updateTikTokBudget(
      makeCtx(),
      u,
      ON({ startedSpend24h: read })
    )
    expect(read).not.toHaveBeenCalled()
    expect(
      p.changes.some((c) => c.field === STARTED_MAX_DAILY_SPEND_FIELD)
    ).toBe(false)
    // a definite failure of the update releases the reservation
    mockTikTok(baseRoutes({ [UPDATE]: fail(40002, "invalid") }))
    const f = spyLedger()
    await expect(
      updateTikTokBudget(makeCtx(), u, ON({ startedSpendLedger: f.ledger }))
    ).rejects.toBeInstanceOf(ProviderError)
    expect(f.log.map((x) => x.op)).toEqual(["reserve", "release"])
  })

  it("M2 tiktok_gmv_max_update: raising the auto budget of a running campaign is cumulated and recorded", async () => {
    const at = new Date()
    // 50 % × 10 (1 800 000) → 100 % × 10 (3 300 000)
    const input = {
      campaign_id: CID,
      auto_budget: { enabled: true, budget_increase_percentage: 100 },
    }
    mockTikTok(baseRoutes())
    await expect(
      runGmvMaxUpdate(
        makeCtx(),
        input,
        ON({
          dailySpendGuard: guardSpy(4_000_000).fn,
          startedSpend24h: async () => [
            { objectId: "OTHER", amount: 1_000_000, at },
          ],
        })
      )
    ).rejects.toThrow(/budget_cap_exceeded 4300000/)
    mockTikTok(baseRoutes())
    const r = await runGmvMaxUpdate(
      makeCtx(),
      input,
      ON({
        dailySpendGuard: guardSpy(5_000_000).fn,
        startedSpend24h: async () => [
          { objectId: "OTHER", amount: 1_000_000, at },
        ],
      })
    )
    expect(r.changes).toContainEqual(
      expect.objectContaining({
        objectId: CID,
        field: STARTED_MAX_DAILY_SPEND_FIELD,
        after: 3_300_000,
      })
    )
  })

  it("enable: a definite failure releases the reservation; ids TikTok refused (partial success) are released", async () => {
    const routes = (status: unknown) =>
      baseRoutes({
        [GMV_GET]: gmvGet([
          productRow({
            operation_status: "DISABLE",
            secondary_status: "CAMPAIGN_STATUS_DISABLE",
          }),
        ]),
        [INFO]: (_c: RecordedCall, n: number) =>
          n === 0 ? info({ operation_status: "DISABLE" }) : info(),
        [STATUS]: status,
      })
    mockTikTok(routes(fail(40002, "invalid")))
    const d = spyLedger()
    await expect(
      setTikTokStatus(
        makeCtx(),
        "campaign",
        [CID],
        "active",
        ON({ startedSpendLedger: d.ledger })
      )
    ).rejects.toBeInstanceOf(ProviderError)
    expect(d.log).toEqual([
      { op: "reserve", args: [[{ objectId: CID, amount: 1_800_000 }]] },
      { op: "release", args: [] },
    ])
    mockTikTok(
      routes({
        body: {
          code: 20001,
          message: "partial",
          request_id: "r",
          data: { campaign_ids: [] },
        },
      })
    )
    const p = spyLedger()
    const r = await setTikTokStatus(
      makeCtx(),
      "campaign",
      [CID],
      "active",
      ON({ startedSpendLedger: p.ledger })
    )
    expect(
      r.changes.some((c) => c.field === STARTED_MAX_DAILY_SPEND_FIELD)
    ).toBe(false)
    expect(p.log.at(-1)).toEqual({ op: "release", args: [[CID]] })
  })

  it("L5: preflightWrite op 'update' → locked for a GMV Max campaign with the switch OFF; switch ON / non-GMV → nothing", async () => {
    mockTikTok(baseRoutes())
    await expect(
      tiktokPreflightWrite(makeCtx(), "campaign", [CID], "update", {})
    ).rejects.toMatchObject({
      code: "feature_not_enabled",
      userMessageVi: gmvMaxLockedMessage(CID),
    })
    await tiktokPreflightWrite(makeCtx(), "campaign", [CID], "update", {
      gmvMaxWrite: true,
    })
    await tiktokPreflightWrite(makeCtx(), "campaign", [CID], "copy", {})
    mockTikTok(
      baseRoutes({
        "GET /campaign/get/": ok({
          list: [
            {
              campaign_id: "1",
              objective_type: "WEB_CONVERSIONS",
              operation_status: "ENABLE",
            },
          ],
          page_info: { total_page: 1 },
        }),
      })
    )
    await tiktokPreflightWrite(makeCtx(), "campaign", ["1"], "update", {})
  })
})
