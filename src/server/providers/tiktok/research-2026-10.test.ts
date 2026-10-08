// Behaviour changes from the TikTok API re-check of 2026-10-08 (providers/tiktok.md, research corrections 1–8).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import {
  CREDS,
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { mapAccountStatus, normalizeScopeIds, scopeArea } from "./accounts"
import { normalizeStatus, toBudget } from "./api"
import {
  mapTikTokError,
  tiktokBaseUrl,
  tiktokRequest,
  tiktokUrl,
} from "./client"
import { exchangeAuthCode } from "./credentials"
import { tiktokExtensions } from "./extensions"
import { tiktokProvider } from "./index"
import { buildAdgroupUpdatePayload } from "./mutate"
import { configuredStatus, toSummary } from "./objects"
import { getTikTokReport, latencyWarning, UNCONFIRMED_METRICS } from "./report"

beforeEach(() => __resetBuckets())
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TIKTOK_BASE_URL
})

const ADGROUP = adgroupFixture.data.list[0] as Record<string, unknown>
const CAMPAIGN = campaignFixture.data.list[0] as Record<string, unknown>
const ext = (name: string) => tiktokExtensions.find((e) => e.name === name)!
const FUTURE_START = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`

describe("#1 ad group đã chạy: lịch trong /adgroup/update/", () => {
  const now = new Date("2026-10-02T08:00:00Z")
  const started = {
    ...ADGROUP,
    schedule_type: "SCHEDULE_START_END",
    schedule_start_time: "2026-09-20 17:00:00",
    schedule_end_time: "2026-12-31 17:00:00",
  }

  it("không đổi lịch → không gửi schedule_start_time, schedule_type, schedule_end_time", () => {
    const body = buildAdgroupUpdatePayload(
      "71",
      started,
      { adgroup_name: "X" },
      now
    )
    for (const k of [
      "schedule_start_time",
      "schedule_type",
      "schedule_end_time",
    ])
      expect(body, k).not.toHaveProperty(k)
  })

  it("đổi ngày kết thúc → gửi kèm start time cũ không đổi", () => {
    const body = buildAdgroupUpdatePayload(
      "71",
      started,
      {
        schedule_type: "SCHEDULE_START_END",
        schedule_end_time: "2027-02-01 00:00:00",
      },
      now
    )
    expect(body).toMatchObject({
      schedule_start_time: "2026-09-20 17:00:00",
      schedule_type: "SCHEDULE_START_END",
      schedule_end_time: "2027-02-01 00:00:00",
    })
  })

  it("nhóm chưa chạy → vẫn gửi lại đủ lịch hiện tại", () => {
    const future = { ...started, schedule_start_time: "2026-10-10 00:00:00" }
    const body = buildAdgroupUpdatePayload(
      "71",
      future,
      { adgroup_name: "X" },
      now
    )
    expect(body).toMatchObject({
      schedule_start_time: "2026-10-10 00:00:00",
      schedule_type: "SCHEDULE_START_END",
      schedule_end_time: "2026-12-31 17:00:00",
    })
  })
})

describe("#2 scope: cấp con cũng tính là có quyền; id 19 chữ số giữ dạng chuỗi", () => {
  it("scopeArea map id cấp 1 và id con", () => {
    expect(["1", "10", "100", "150", "159"].map(scopeArea)).toEqual([
      1, 1, 1, 1, 1,
    ])
    expect(["2", "20", "21", "22", "200", "299"].map(scopeArea)).toEqual([
      2, 2, 2, 2, 2, 2,
    ])
    expect(["4", "40", "44"].map(scopeArea)).toEqual([4, 4, 4])
    expect(
      ["6", "60", "61", "69", "601", "610", "611", "693"].map(scopeArea)
    ).toEqual([6, 6, 6, 6, 6, 6, 6, 6])
    expect(["8", "80", "800"].map(scopeArea)).toEqual([8, 8, 8])
    expect(scopeArea("45")).toBeNull()
    expect(scopeArea("7123456789012345678")).toBeNull()
  })

  it("normalizeScopeIds: số cũ → chuỗi, bỏ giá trị lạ, không Number() chuỗi dài", () => {
    expect(
      normalizeScopeIds([1, "10", " 7123456789012345678 ", "abc", null])
    ).toEqual(["1", "10", "7123456789012345678"])
  })

  it("validate: chỉ có id con của đủ 5 nhóm → không cảnh báo thiếu quyền", async () => {
    mockTikTok({
      "GET /user/info/": ok({
        core_user_id: "7000",
        display_name: "ads-admin",
      }),
      "GET /oauth2/advertiser/get/": ok({
        list: [{ advertiser_id: "1", advertiser_name: "A" }],
      }),
    })
    const res = await tiktokProvider.validateCredentials({
      credentials: CREDS,
      connectionMeta: {
        scope: ["10", "200", "41", "610", "800", "7123456789012345678"],
      },
    })
    expect(res.scopes).toEqual([
      "Ad Account Management",
      "Ads Management",
      "Reporting",
      "Creative Management",
      "Pixel Management",
      "scope_7123456789012345678",
    ])
    expect(res.warnings.some((w) => w.includes("thiếu quyền"))).toBe(false)
  })

  it("exchangeAuthCode trả scope dạng chuỗi (kể cả id 19 chữ số dạng chuỗi)", async () => {
    mockTikTok({
      "POST /oauth2/access_token/": ok({
        access_token: "t",
        scope: [4, "7123456789012345678"],
        advertiser_ids: [],
      }),
    })
    const res = await exchangeAuthCode({
      appId: "7000000000000000001",
      secret: "sec",
      authCode: "c",
    })
    expect(res.scope).toEqual(["4", "7123456789012345678"])
  })
})

describe("#3 tài khoản quảng cáo", () => {
  it("không yêu cầu advertiser_account_type (không có trong tài liệu)", async () => {
    const m = mockTikTok({
      "GET /oauth2/advertiser/get/": ok({
        list: [{ advertiser_id: "71", advertiser_name: "A" }],
      }),
      "GET /advertiser/info/": ok({
        list: [
          {
            advertiser_id: "71",
            name: "A",
            currency: "USD",
            timezone: "Etc/GMT",
            status: "STATUS_ENABLE",
          },
        ],
      }),
    })
    await tiktokProvider.listAccounts({ credentials: CREDS })
    expect(m.callsTo("GET /advertiser/info/")[0]!.query.fields).not.toContain(
      "advertiser_account_type"
    )
  })

  it("STATUS_CONTRACT_PENDING → pending", () => {
    expect(mapAccountStatus("STATUS_CONTRACT_PENDING")).toBe("pending")
  })
})

describe("#4 normalizeStatus", () => {
  it("*_DENY → rejected; PARTIAL_AUDIT_NO_DELIVERY → pending_review; *_UNAVAILABLE / CONTRACT_PENDING không active", () => {
    expect(normalizeStatus("ENABLE", "ADGROUP_STATUS_PARTIAL_AUDIT_DENY")).toBe(
      "rejected"
    )
    expect(normalizeStatus("ENABLE", "AD_STATUS_REVIEW_DENY")).toBe("rejected")
    expect(
      normalizeStatus("ENABLE", "AD_STATUS_PARTIAL_AUDIT_NO_DELIVERY")
    ).toBe("pending_review")
    expect(
      normalizeStatus("ENABLE", "ADGROUP_STATUS_ADVERTISER_ACCOUNT_UNAVAILABLE")
    ).toBe("disabled")
    expect(
      normalizeStatus("ENABLE", "CAMPAIGN_STATUS_ADVERTISER_CONTRACT_PENDING")
    ).toBe("disabled")
    // user pause still wins
    expect(
      normalizeStatus(
        "DISABLE",
        "ADGROUP_STATUS_ADVERTISER_ACCOUNT_UNAVAILABLE"
      )
    ).toBe("paused")
  })
})

describe("#5 Upgraded Smart+ current_budget", () => {
  it("ưu tiên current_budget cho UPGRADED_SMART_PLUS; Manual vẫn dùng budget", () => {
    const sp = {
      campaign_automation_type: "UPGRADED_SMART_PLUS",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 900,
      current_budget: 500,
    }
    expect(toBudget(sp, "campaign", "USD")).toEqual({
      type: "daily",
      amount: 500,
      currency: "USD",
      level: "campaign",
    })
    expect(
      toBudget({ ...sp, current_budget: undefined }, "campaign", "USD")?.amount
    ).toBe(900)
    expect(
      toBudget({ ...sp, campaign_automation_type: "MANUAL" }, "campaign", "USD")
        ?.amount
    ).toBe(900)
  })

  it("updateBudget lấy before = current_budget", async () => {
    mockTikTok({
      "GET /campaign/get/": ok({
        list: [
          {
            ...CAMPAIGN,
            campaign_automation_type: "UPGRADED_SMART_PLUS",
            budget_mode: "BUDGET_MODE_DAY",
            budget: 900,
            current_budget: 500,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const res = await tiktokProvider.updateBudget(
      makeCtx({ currency: "USD", timezone: "UTC" }),
      {
        level: "campaign",
        id: String(CAMPAIGN.campaign_id),
        type: "daily",
        amount: 600,
      },
      { dryRun: true }
    )
    expect(res.changes[0]).toMatchObject({ before: 500, after: 600 })
  })
})

describe("objects: configuredStatus cho isConfiguredOn", () => {
  it("ENABLE→ACTIVE, DISABLE→PAUSED, DELETE→DELETED", () => {
    expect(configuredStatus("ENABLE")).toBe("ACTIVE")
    expect(configuredStatus("DISABLE")).toBe("PAUSED")
    expect(configuredStatus("DELETE")).toBe("DELETED")
    expect(configuredStatus(undefined)).toBeNull()
    expect(
      toSummary("ad_group", { ...ADGROUP, operation_status: "DISABLE" }, "VND")
        .extra?.configuredStatus
    ).toBe("PAUSED")
    // ENABLE under a paused campaign: not delivering, but configured on
    const child = toSummary(
      "ad_group",
      {
        ...ADGROUP,
        operation_status: "ENABLE",
        secondary_status: "ADGROUP_STATUS_CAMPAIGN_DISABLE",
      },
      "VND"
    )
    expect(child.status).toBe("paused")
    expect(child.extra?.configuredStatus).toBe("ACTIVE")
  })
})

describe("#6 tiktok_create_adgroup: chế độ ngân sách", () => {
  const nonCbo = (extra: Record<string, unknown>) => ({
    "GET /campaign/get/": ok({
      list: [{ ...CAMPAIGN, budget_optimize_on: false, ...extra }],
      page_info: { total_page: 1 },
    }),
    "POST /adgroup/create/": ok({ adgroup_id: "1840000000000000001" }),
  })
  const base = {
    campaign_id: String(CAMPAIGN.campaign_id),
    name: "G",
    promotion_type: "WEBSITE",
    location_ids: ["1562822"],
    optimization_goal: "CLICK",
    schedule_start_time: FUTURE_START,
  }

  it("cho phép dynamic_daily ở cấp nhóm → BUDGET_MODE_DYNAMIC_DAILY_BUDGET (tính là ngân sách ngày)", async () => {
    const m = mockTikTok(nonCbo({ budget_mode: "BUDGET_MODE_INFINITE" }))
    const e = ext("tiktok_create_adgroup")
    const input = e.input.parse({
      ...base,
      budget_type: "dynamic_daily",
      budget: 12.345,
    })
    await e.run(makeCtx({ currency: "USD" }), input, {})
    const body = m.callsTo("POST /adgroup/create/")[0]!.body!
    expect(body.budget_mode).toBe("BUDGET_MODE_DYNAMIC_DAILY_BUDGET")
    expect(body.budget).toBe(12.35) // USD: max 2 decimals
    expect(e.moneyOf!(input)).toEqual([
      expect.objectContaining({ kind: "daily_budget", amount: 12.345 }),
    ])
  })

  it("chiến dịch REACH/VIDEO_VIEWS/ENGAGEMENT không CBO dùng BUDGET_MODE_DAY → chặn", async () => {
    mockTikTok(
      nonCbo({
        objective_type: "REACH",
        budget_mode: "BUDGET_MODE_DAY",
        budget: 100,
      })
    )
    const e = ext("tiktok_create_adgroup")
    await expect(
      e.run(
        makeCtx(),
        e.input.parse({
          ...base,
          optimization_goal: "REACH",
          budget_type: "daily",
          budget: 100000,
        }),
        { dryRun: true }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("chiến dịch ngân sách ngày không nhận nhóm lifetime", async () => {
    mockTikTok(nonCbo({ budget_mode: "BUDGET_MODE_DAY", budget: 100 }))
    const e = ext("tiktok_create_adgroup")
    await expect(
      e.run(
        makeCtx(),
        e.input.parse({
          ...base,
          budget_type: "lifetime",
          budget: 100000,
          schedule_end_time: "2099-01-01 00:00:00",
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(/trọn đời/)
  })

  it("SCHEDULE_FROM_NOW cần ngân sách ngày: chiến dịch CBO lifetime + không có ngày kết thúc → chặn", async () => {
    mockTikTok({
      "GET /campaign/get/": ok({
        list: [
          {
            ...CAMPAIGN,
            budget_optimize_on: true,
            budget_mode: "BUDGET_MODE_TOTAL",
            budget: 1000,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const e = ext("tiktok_create_adgroup")
    await expect(
      e.run(makeCtx(), e.input.parse(base), { dryRun: true })
    ).rejects.toThrow(/schedule_end_time/)
  })
})

describe("#7 báo cáo", () => {
  const base = {
    level: "campaign" as const,
    dateRange: { from: "2026-06-01", to: "2026-06-01" },
    granularity: "day" as const,
    metrics: "all" as const,
    limit: 100,
  }

  it("không còn chỉ số chưa xác nhận", () => {
    expect(UNCONFIRMED_METRICS.size).toBe(0)
  })

  it("lưới an toàn: 40002 nêu tên một chỉ số không cơ bản → bỏ chỉ số đó, thử lại 1 lần", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": (c: RecordedCall) =>
        (c.query.metrics as string[]).includes("follows")
          ? fail(40002, "Invalid metric: follows")
          : ok({ list: [], page_info: { page: 1, total_page: 1 } }),
    })
    const res = await getTikTokReport(makeCtx(), base)
    const calls = m.callsTo("GET /report/integrated/get/")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query.metrics).not.toContain("follows")
    expect(calls[1]!.query.metrics).toContain("spend")
    expect(res.warnings.join(" ")).toMatch(/follows/)
  })

  it("lưới an toàn không bỏ chỉ số cơ bản (spend) và khớp nguyên từ", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": fail(40002, "Invalid metric: spend"),
    })
    await expect(getTikTokReport(makeCtx(), base)).rejects.toBeInstanceOf(
      ProviderError
    )
    expect(m.callsTo("GET /report/integrated/get/")).toHaveLength(1)
  })

  it("độ trễ: hôm nay có thể trễ ≥2 giờ, reach/frequency ~16 giờ", () => {
    const w: string[] = []
    latencyWarning(
      { from: "2026-10-02", to: "2026-10-02" },
      "Asia/Ho_Chi_Minh",
      w,
      new Date("2026-10-02T05:00:00Z")
    )
    expect(w[0]).toMatch(/2 giờ/)
    expect(w[0]).toMatch(/16 giờ/)
  })
})

describe("#8 client: TIKTOK_BASE_URL + mã lỗi", () => {
  it("mặc định production; TIKTOK_BASE_URL đổi sang sandbox (bỏ dấu / cuối)", async () => {
    expect(tiktokBaseUrl()).toBe("https://business-api.tiktok.com/open_api")
    process.env.TIKTOK_BASE_URL = "https://sandbox-ads.tiktok.com/open_api/"
    expect(tiktokUrl("ad/get")).toBe(
      "https://sandbox-ads.tiktok.com/open_api/v1.3/ad/get/"
    )
    const m = mockTikTok({ "GET /campaign/get/": ok({ list: [] }) })
    await tiktokRequest({
      method: "GET",
      path: "campaign/get",
      auth: "tok",
      appId: "9",
    })
    expect(
      m.calls[0]!.url.startsWith(
        "https://sandbox-ads.tiktok.com/open_api/v1.3/campaign/get/"
      )
    ).toBe(true)
  })

  it("TIKTOK_BASE_URL không phải https → từ chối, không gửi token", async () => {
    process.env.TIKTOK_BASE_URL = "http://sandbox-ads.tiktok.com/open_api"
    const m = mockTikTok({})
    await expect(
      tiktokRequest({
        method: "GET",
        path: "campaign/get",
        auth: "tok",
        appId: "9",
      })
    ).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(m.calls).toHaveLength(0)
    process.env.TIKTOK_BASE_URL = "https://user:pw@evil.example/open_api"
    expect(() => tiktokBaseUrl()).toThrow(ProviderError)
  })

  it("40006/40051 → unsupported, gợi ý kiểm tra TIKTOK_API_VERSION; 40011 → invalid_request, chia nhỏ danh sách id", () => {
    for (const code of [40006, 40051]) {
      const e = mapTikTokError(code, "x")
      expect(e.code).toBe("unsupported")
      expect(e.hint).toContain("TIKTOK_API_VERSION")
    }
    const e = mapTikTokError(40011, "too many ids")
    expect(e.code).toBe("invalid_request")
    expect(e.hint).toMatch(/chia nhỏ/)
  })
})
