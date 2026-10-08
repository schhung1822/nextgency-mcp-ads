// ads-api-reviewer findings 2026-10-08 (TikTok): create retries/lookup, /adgroup/update/ budget, copy-task naming,
// timezone, partial success, copied flight length, Smart+ landing pages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isProviderError, type ProviderError } from "../errors"
import type { HttpResponse } from "../http"
import { __resetBuckets } from "../rate-limit"
import adFixture from "./__fixtures__/ad_get.json"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { toAccountInfo } from "./accounts"
import { formatTikTokTime } from "./api"
import { CREATE_RETRY_WINDOW_MS, tiktokCreateRetryDecision } from "./client"
import {
  copyTikTokObject,
  COPY_POLL,
  freshSchedule,
  matchCopyResult,
} from "./copy"
import { tiktokExtensions } from "./extensions"
import {
  buildAdgroupUpdatePayload,
  setTikTokStatus,
  smartPlusLandingPages,
  updateTikTokObject,
} from "./mutate"

const savedPoll = { ...COPY_POLL }
beforeEach(() => {
  __resetBuckets()
  Object.assign(COPY_POLL, {
    initialDelayMs: 0,
    intervalMs: 0,
    timeoutMs: 1_000,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(COPY_POLL, savedPoll)
})

const ext = (name: string) => tiktokExtensions.find((e) => e.name === name)!
const CAMPAIGN_INPUT = {
  name: "Chien dich moi",
  objective: "TRAFFIC",
  budget_type: "unlimited",
}
const ADGROUP_INPUT = {
  campaign_id: "1810000000000000001",
  name: "Nhom moi",
  promotion_type: "WEBSITE",
  location_ids: ["1562822"],
  optimization_goal: "CLICK",
  budget_type: "daily",
  budget: 500_000,
}

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    if (isProviderError(e)) return e
    throw e
  }
  throw new Error("expected a ProviderError")
}

function resp(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: new Headers(),
    body,
    requestId: null,
    durationMs: 1,
  }
}

describe("#2 create: no blind retry, lookup after an unknown outcome", () => {
  it("retry decision: only 40100/40133 and only inside the request_id window", () => {
    let t = 1_000
    const d = tiktokCreateRetryDecision(1_000, () => t)
    expect(d(resp({ code: 40133 }))).toBe(2_000)
    expect(d(resp({ code: 40100 }))).toBe(1_000)
    for (const code of [50000, 50002, 40202, 40050, 40002])
      expect(d(resp({ code })), String(code)).toBe(false)
    expect(d(resp(null, 500))).toBe(false)
    expect(d(resp(null, 429))).toBe(false)
    t = 1_000 + CREATE_RETRY_WINDOW_MS - 1_000 // too late: the retry would land outside the dedup window
    expect(d(resp({ code: 40100 }))).toBe(false)
  })

  it("throttled (40100) campaign create is retried once with the SAME request_id", async () => {
    const m = mockTikTok({
      "POST /campaign/create/": (_c: RecordedCall, nth: number) =>
        nth === 0
          ? fail(40100, "QPM limit")
          : ok({ campaign_id: "1900000000000000001" }),
    })
    const res = (await ext("tiktok_create_campaign").run(
      makeCtx(),
      ext("tiktok_create_campaign").input.parse(CAMPAIGN_INPUT),
      { idempotencyKey: "k1" }
    )) as {
      createdIds: string[]
    }
    expect(res.createdIds).toEqual(["1900000000000000001"])
    const posts = m.callsTo("POST /campaign/create/")
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body!.request_id).toBe(posts[1]!.body!.request_id)
  })

  it("HTTP 500 on campaign create → not retried, found by name (created after the call) → id + warning", async () => {
    const fresh = formatTikTokTime(new Date())
    const m = mockTikTok({
      "POST /campaign/create/": { status: 500, body: "oops" },
      "GET /campaign/get/": ok({
        list: [
          {
            campaign_id: "1800000000000000009",
            campaign_name: "Chien dich moi",
            create_time: "2025-01-01 00:00:00",
          }, // older namesake
          {
            campaign_id: "1900000000000000002",
            campaign_name: "Chien dich moi",
            create_time: fresh,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const res = (await ext("tiktok_create_campaign").run(
      makeCtx(),
      ext("tiktok_create_campaign").input.parse(CAMPAIGN_INPUT),
      {}
    )) as {
      createdIds: string[]
      warnings: string[]
    }
    expect(m.callsTo("POST /campaign/create/")).toHaveLength(1)
    expect(res.createdIds).toEqual(["1900000000000000002"])
    expect(
      res.warnings.some(
        (w) => w.includes("đã được tạo") && w.includes("không tạo lại")
      )
    ).toBe(true)
    expect(
      (
        m.callsTo("GET /campaign/get/")[0]!.query.filtering as Record<
          string,
          unknown
        >
      ).campaign_name
    ).toBe("Chien dich moi")
  })

  it("50002 on ad group create and nothing found → non-retryable error with a check-first hint", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": { body: campaignFixture },
      "POST /adgroup/create/": fail(50002, "internal error"),
      "GET /adgroup/get/": ok({ list: [], page_info: { total_page: 1 } }),
    })
    const e = await rejection(
      ext("tiktok_create_adgroup").run(
        makeCtx(),
        ext("tiktok_create_adgroup").input.parse(ADGROUP_INPUT),
        {}
      )
    )
    expect(m.callsTo("POST /adgroup/create/")).toHaveLength(1)
    expect(e.retryable).toBe(false)
    expect(e.hint).toMatch(
      /kiểm tra trong TikTok Ads Manager.*trước khi thử lại/
    )
    const q = m.callsTo("GET /adgroup/get/")[0]!.query.filtering as Record<
      string,
      unknown
    >
    expect(q.campaign_ids).toEqual(["1810000000000000001"])
  })

  it("40050 (duplicate request_id) → lookup instead of a plain conflict", async () => {
    const fresh = formatTikTokTime(new Date())
    mockTikTok({
      "GET /campaign/get/": { body: campaignFixture },
      "POST /adgroup/create/": fail(40050, "duplicate request"),
      "GET /adgroup/get/": ok({
        list: [
          {
            adgroup_id: "1900000000000000301",
            adgroup_name: "Nhom moi",
            create_time: fresh,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const res = (await ext("tiktok_create_adgroup").run(
      makeCtx(),
      ext("tiktok_create_adgroup").input.parse(ADGROUP_INPUT),
      {}
    )) as { createdIds: string[] }
    expect(res.createdIds).toEqual(["1900000000000000301"])
  })

  it("validation errors are thrown as is (no lookup)", async () => {
    const m = mockTikTok({ "POST /campaign/create/": fail(40002, "bad param") })
    const e = await rejection(
      ext("tiktok_create_campaign").run(
        makeCtx(),
        ext("tiktok_create_campaign").input.parse(CAMPAIGN_INPUT),
        {}
      )
    )
    expect(e.code).toBe("invalid_request")
    expect(m.callsTo("GET /campaign/get/")).toHaveLength(0)
  })

  it("copy task create with an unknown outcome → no DIY fallback, non-retryable", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": { body: campaignFixture },
      "GET /adgroup/get/": { body: adgroupFixture },
      "GET /ad/get/": { body: adFixture },
      "POST /campaign/copy/task/create/": { status: 502, body: "bad gateway" },
    })
    const e = await rejection(
      copyTikTokObject(
        makeCtx(),
        { level: "campaign", id: "1810000000000000001", deep: true },
        { now: new Date() }
      )
    )
    expect(e.retryable).toBe(false)
    expect(e.hint).toMatch(/trước khi thử lại/)
    expect(m.callsTo("POST /campaign/copy/task/create/")).toHaveLength(1)
    expect(m.callsTo("POST /campaign/create/")).toHaveLength(0)
  })
})

describe("#3 /adgroup/update/ only sends budget when it changes", () => {
  const AG = adgroupFixture.data.list[0] as Record<string, unknown>
  it("omits the current budget; sends a changed one", () => {
    expect(
      buildAdgroupUpdatePayload("71", AG, { adgroup_name: "x" })
    ).not.toHaveProperty("budget")
    expect(
      buildAdgroupUpdatePayload("71", AG, { budget: 600_000 }).budget
    ).toBe(600_000)
  })
  it("a budget rejection is explained in Vietnamese", async () => {
    mockTikTok({
      "GET /adgroup/get/": { body: adgroupFixture },
      "POST /adgroup/update/": fail(
        40002,
        "The new budget should be at least 105% of the current spend"
      ),
    })
    const e = await rejection(
      updateTikTokObject(makeCtx(), {
        level: "ad_group",
        id: "1810000000000000101",
        changes: { name: "Ten moi" },
      })
    )
    expect(e.userMessageVi).toMatch(
      /TikTok từ chối cập nhật nhóm quảng cáo vì thiếu\/không hợp lệ ngân sách/
    )
    expect(e.hint).toMatch(/ads_update_budget/)
  })
  it("other rejections are untouched", async () => {
    mockTikTok({
      "GET /adgroup/get/": { body: adgroupFixture },
      "POST /adgroup/update/": fail(40002, "invalid location"),
    })
    const e = await rejection(
      updateTikTokObject(makeCtx(), {
        level: "ad_group",
        id: "1810000000000000101",
        changes: { name: "Ten moi" },
      })
    )
    expect(e.userMessageVi).toMatch(/Tham số gửi lên TikTok không hợp lệ/)
  })
})

describe("#4 copy task results mapped by name (no positional guess)", () => {
  it("exact name, then TikTok's default COPIED_<name>_<id> suffix", () => {
    const results = [{ ad_name: "COPIED_B_22" }, { ad_name: "A" }]
    expect(matchCopyResult(results, new Set(), "ad_name", "A", "11")).toBe(1)
    expect(
      matchCopyResult(results, new Set(), "ad_name", "B renamed", "22")
    ).toBe(0)
    expect(matchCopyResult(results, new Set([1]), "ad_name", "A", "11")).toBe(
      -1
    ) // no positional fallback
  })

  it("swapped result order still maps the right ids; unmapped groups are still disabled", async () => {
    const m = mockTikTok({
      "GET /campaign/get/": { body: campaignFixture },
      "GET /adgroup/get/": { body: adgroupFixture },
      "GET /ad/get/": { body: adFixture },
      "POST /campaign/copy/task/create/": ok({
        task_id: "t1",
        adgroup_error_list: [],
      }),
      "GET /campaign/copy/task/check/": ok({
        task_status: "SUCCESS",
        task_result: {
          campaign_id: "1950000000000000001",
          adgroup_result_list: [
            {
              adgroup_id: "1950000000000000101",
              adgroup_name: "HCM - Nu 18-34",
              ad_result_list: [
                {
                  ad_id: "1950000000000001002",
                  ad_name: "Anh san pham 02",
                  is_success: true,
                },
                {
                  ad_id: "1950000000000001001",
                  ad_name: "COPIED_Video review 01_1810000000000001001",
                  is_success: true,
                },
              ],
            },
            {
              adgroup_id: "1950000000000000999",
              adgroup_name: "Nhom la",
              ad_result_list: [],
            },
          ],
        },
      }),
      "POST /adgroup/status/update/": ok({}),
    })
    const res = await copyTikTokObject(
      makeCtx(),
      { level: "campaign", id: "1810000000000000001", deep: true },
      { now: new Date("2026-10-02T08:00:00Z") }
    )
    expect(res.mappings.filter((x) => x.level === "ad")).toEqual([
      {
        level: "ad",
        sourceId: "1810000000000001001",
        newId: "1950000000000001001",
      },
      {
        level: "ad",
        sourceId: "1810000000000001002",
        newId: "1950000000000001002",
      },
    ])
    const disabled = m
      .callsTo("POST /adgroup/status/update/")
      .flatMap((c) => c.body!.adgroup_ids as string[])
    expect(disabled).toEqual(["1950000000000000101", "1950000000000000999"])
  })
})

describe("#5 account time zone", () => {
  it("prefers `timezone` (account TZ, GMT offset) over display_timezone", () => {
    expect(
      toAccountInfo({
        advertiser_id: "1",
        currency: "VND",
        timezone: "Etc/GMT-7",
        display_timezone: "Asia/Ho_Chi_Minh",
      })!.timezone
    ).toBe("Etc/GMT-7")
    expect(
      toAccountInfo({
        advertiser_id: "1",
        currency: "VND",
        timezone: "GMT+07:00",
        display_timezone: "Asia/Ho_Chi_Minh",
      })!.timezone
    ).toBe("Asia/Ho_Chi_Minh")
    expect(
      toAccountInfo({
        advertiser_id: "1",
        currency: "VND",
        timezone: "",
        display_timezone: "",
      })!.timezone
    ).toBe("UTC")
  })
})

describe("#12 code 20001 partial success", () => {
  const groups = (ids: string[]) =>
    ok({
      list: ids.map((id) => ({
        adgroup_id: id,
        adgroup_name: `G${id}`,
        operation_status: "DISABLE",
        campaign_automation_type: "MANUAL",
      })),
      page_info: { total_page: 1 },
    })
  it("only the ids TikTok returns are reported as changes; the rest become warnings", async () => {
    mockTikTok({
      "GET /adgroup/get/": groups(["1", "2"]),
      "POST /adgroup/status/update/": {
        body: {
          code: 20001,
          message: "partial success",
          request_id: "r",
          data: { adgroup_ids: ["1"] },
        },
      },
    })
    const res = await setTikTokStatus(
      makeCtx(),
      "ad_group",
      ["1", "2"],
      "active"
    )
    expect(res.changes.map((c) => c.objectId)).toEqual(["1"])
    expect(
      res.warnings.some((w) =>
        w.includes("không đổi được trạng thái nhóm quảng cáo 2")
      )
    ).toBe(true)
  })
  it("partial success without an id list → kept, with a verify warning", async () => {
    mockTikTok({
      "GET /adgroup/get/": groups(["1", "2"]),
      "POST /adgroup/status/update/": {
        body: { code: 20001, message: "partial", request_id: "r", data: {} },
      },
    })
    const res = await setTikTokStatus(
      makeCtx(),
      "ad_group",
      ["1", "2"],
      "active"
    )
    expect(res.changes).toHaveLength(2)
    expect(res.warnings.some((w) => w.includes("kiểm tra lại"))).toBe(true)
  })
})

describe("#13 copied flight keeps its length", () => {
  const now = new Date("2026-10-02T08:00:00Z")
  it("past start → the end moves by the same delta (10-day flight stays 10 days)", () => {
    const r = freshSchedule(
      {
        schedule_type: "SCHEDULE_START_END",
        budget_mode: "BUDGET_MODE_TOTAL",
        schedule_start_time: "2026-09-25 00:00:00",
        schedule_end_time: "2026-10-05 00:00:00",
      },
      now
    )
    expect(r.changed).toBe(true)
    expect(r.schedule).toEqual({
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: "2026-10-02 08:10:00",
      schedule_end_time: "2026-10-12 08:10:00",
    })
  })
  it("future flight is copied unchanged", () => {
    const r = freshSchedule(
      {
        schedule_type: "SCHEDULE_START_END",
        schedule_start_time: "2026-10-10 00:00:00",
        schedule_end_time: "2026-10-20 00:00:00",
      },
      now
    )
    expect(r.changed).toBe(false)
    expect(r.schedule.schedule_end_time).toBe("2026-10-20 00:00:00")
  })
})

describe("#15 Upgraded Smart+ landing pages", () => {
  it("replaces only the first URL and keeps the others", () => {
    const r = smartPlusLandingPages(
      [
        { landing_page_url: "https://a.vn", extra: 1 },
        { landing_page_url: "https://b.vn" },
      ],
      "https://new.vn"
    )
    expect(r.list).toEqual([
      { landing_page_url: "https://new.vn", extra: 1 },
      { landing_page_url: "https://b.vn" },
    ])
    expect(r.before).toBe("https://a.vn")
    expect(r.warning).toMatch(/chỉ thay URL đầu tiên/)
    expect(smartPlusLandingPages(undefined, "https://new.vn")).toEqual({
      list: [{ landing_page_url: "https://new.vn" }],
      before: null,
      warning: null,
    })
  })
})
