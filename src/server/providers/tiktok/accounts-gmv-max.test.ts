// D6: non-fatal GMV Max readiness probe in validateTikTokCredentials + GMV Max content of the TikTok guide.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import {
  CREDS,
  fail,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import {
  GMV_PROBE_BUDGET_MS,
  GMV_PROBE_MAX_ADVERTISERS,
  GMV_PROBE_REUSE_MS,
  probeGmvMax,
  reusableGmvMaxProbe,
} from "./accounts"
import { tiktokGuide } from "./credentials"
import { tiktokProvider } from "./index"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

/** One shop of GET /gmv_max/store/list/, shaped like the official example (doc 1822001044479041). */
function shop(
  storeId: string,
  available: boolean,
  exclusiveAdvertiserId: string
) {
  return {
    exclusive_authorized_advertiser_info: {
      advertiser_id: exclusiveAdvertiserId,
      advertiser_name: `Adv ${exclusiveAdvertiserId}`,
      advertiser_status: "STATUS_ENABLE",
    },
    is_gmv_max_available: available,
    is_owner_bc: true,
    store_authorized_bc_id: "7000000000000000777",
    store_authorized_bc_info: {
      bc_id: "7000000000000000777",
      bc_name: "BC Shop ABC",
      bc_profile_image: "https://example.invalid/bc.png",
      user_role: "ADMIN",
    },
    store_code: `VNCODE${storeId}`,
    store_id: storeId,
    store_name: `Shop ${storeId}`,
    store_role: "AD_PROMOTION",
    store_status: "ACTIVE",
    targeting_region_codes: ["VN"],
    thumbnail_url: "https://example.invalid/thumb.png",
  }
}

function advertisers(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    advertiser_id: `71000000000000000${String(i + 1).padStart(2, "0")}`,
    advertiser_name: `TKQC ${i + 1}`,
  }))
}

function mockValidate(
  list: { advertiser_id: string; advertiser_name: string }[],
  storeList: (call: RecordedCall, nth: number) => unknown
) {
  return mockTikTok({
    "GET /user/info/": ok({ core_user_id: "7000", display_name: "ads-admin" }),
    "GET /oauth2/advertiser/get/": ok({ list }),
    "GET /gmv_max/store/list/": storeList,
  })
}

const gmvLines = (warnings: string[]) =>
  warnings.filter((w) => w.includes("GMV Max"))

describe("validateCredentials - GMV Max probe (D6)", () => {
  it("cửa hàng sẵn sàng = is_gmv_max_available + đúng TKQC độc quyền; ghi meta.gmvMax, không lộ secret/tên shop", async () => {
    const list = advertisers(2)
    const [a1, a2] = list.map((a) => a.advertiser_id) as [string, string]
    const m = mockValidate(list, (call) =>
      call.query.advertiser_id === a1
        ? ok({
            store_list: [
              shop("7494000000000000001", true, a1), // ready
              shop("7494000000000000002", true, "7199999999999999999"), // GMV Max account is another ad account
              shop("7494000000000000003", false, a1), // not available
            ],
          })
        : ok({ store_list: [] })
    )
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(res.valid).toBe(true)
    expect(gmvLines(res.warnings)).toEqual([
      "GMV Max (TikTok Shop): tài khoản TKQC 1 đã sẵn sàng với 1 cửa hàng.",
    ])
    const calls = m.callsTo("GET /gmv_max/store/list/")
    expect(calls.map((c) => c.query.advertiser_id)).toEqual([a1, a2])
    expect(calls[0]!.headers["access-token"]).toBe(CREDS.accessToken)
    const meta = res.meta.gmvMax as Record<string, unknown>
    expect(meta).toMatchObject({
      advertisers: [
        { advertiserId: a1, shops: 3, ready: 1 },
        { advertiserId: a2, shops: 0, ready: 0 },
      ],
      notChecked: 0,
      permissionDenied: false,
      failed: false,
      appId: CREDS.appId,
    })
    expect(typeof meta.checkedAt).toBe("string")
    const json = JSON.stringify(res.meta)
    expect(json).not.toContain(CREDS.secret)
    expect(json).not.toContain(CREDS.accessToken)
    expect(json).not.toContain("Shop 7494")
  })

  it("nhiều TKQC sẵn sàng → 1 dòng gộp (tối đa 3 tên + số còn lại)", async () => {
    const list = advertisers(5)
    mockValidate(list, (call) =>
      ok({
        store_list: [
          shop(
            `74940000000000000${String(call.query.advertiser_id).slice(-2)}`,
            true,
            String(call.query.advertiser_id)
          ),
        ],
      })
    )
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(gmvLines(res.warnings)).toEqual([
      "GMV Max (TikTok Shop): 5 tài khoản đã sẵn sàng - TKQC 1 (1 cửa hàng), TKQC 2 (1 cửa hàng), TKQC 3 (1 cửa hàng) và 2 tài khoản khác.",
    ])
  })

  it("không TKQC nào có cửa hàng GMV Max → không thêm dòng nào (tránh nhiễu)", async () => {
    mockValidate(advertisers(3), () => ok({ store_list: [] }))
    const res = await tiktokProvider.validateCredentials({
      credentials: CREDS,
      connectionMeta: { scope: ["1", "2", "4", "6", "8"] },
    })
    expect(res.warnings).toEqual([])
    expect(
      (res.meta.gmvMax as { advertisers: unknown[] }).advertisers
    ).toHaveLength(3)
  })

  it("thiếu quyền GMV Max (40001) → dừng sau 2 lần bị từ chối, 1 dòng lưu ý trung tính, vẫn hợp lệ", async () => {
    const m = mockValidate(advertisers(6), () =>
      fail(40001, "No permission to perform the related operation")
    )
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(res.valid).toBe(true)
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(2)
    expect(gmvLines(res.warnings)).toEqual([
      "Token chưa có quyền GMV Max (Store Management / GMV MAX Report) - xem hướng dẫn GMV Max nếu bạn dùng TikTok Shop.",
    ])
    expect(res.meta.gmvMax).toMatchObject({
      advertisers: [],
      permissionDenied: true,
      notChecked: 4,
      failed: false,
    })
  })

  it("bị từ chối ở 1 TKQC nhưng TKQC khác đọc được → không báo thiếu quyền", async () => {
    const list = advertisers(2)
    mockValidate(list, (_call, nth) =>
      nth === 0 ? fail(40001) : ok({ store_list: [] })
    )
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(gmvLines(res.warnings)).toEqual([])
    expect(res.meta.gmvMax).toMatchObject({
      permissionDenied: false,
      advertisers: [{ advertiserId: list[1]!.advertiser_id }],
    })
  })

  it("lỗi khác (máy chủ TikTok, endpoint không khả dụng) → không thử lại, dừng probe, không cảnh báo, không chặn lưu", async () => {
    const m = mockValidate(advertisers(3), () => fail(50000, "Internal error"))
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(res.valid).toBe(true)
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(1)
    expect(gmvLines(res.warnings)).toEqual([])
    expect(res.meta.gmvMax).toMatchObject({
      failed: true,
      advertisers: [],
      notChecked: 3,
    })

    const m2 = mockValidate(advertisers(2), () =>
      fail(40006, "API version not available")
    )
    const res2 = await tiktokProvider.validateCredentials({
      credentials: CREDS,
    })
    expect(res2.valid).toBe(true)
    expect(m2.callsTo("GET /gmv_max/store/list/")).toHaveLength(1)
    expect(gmvLines(res2.warnings)).toEqual([])
  })

  it(`chỉ kiểm tra tối đa ${GMV_PROBE_MAX_ADVERTISERS} TKQC đầu tiên`, async () => {
    const m = mockValidate(advertisers(12), () => ok({ store_list: [] }))
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(
      GMV_PROBE_MAX_ADVERTISERS
    )
    expect(res.meta.gmvMax).toMatchObject({
      notChecked: 12 - GMV_PROBE_MAX_ADVERTISERS,
    })
  })

  it("không có TKQC nào được uỷ quyền → không gọi GMV Max", async () => {
    const m = mockValidate([], () => ok({ store_list: [] }))
    const res = await tiktokProvider.validateCredentials({ credentials: CREDS })
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(0)
    expect(res.meta.gmvMax).toMatchObject({ advertisers: [], notChecked: 0 })
  })
})

describe("tiktokGuide - GMV Max", () => {
  it("bước scope nhắc quyền GMV MAX; có bước chuẩn bị GMV Max (tuỳ chọn) và lưu ý cho AI", () => {
    const scopeStep = tiktokGuide.steps.find((s) => s.title.includes("scope"))!
    expect(scopeStep.detail).toContain("GMV MAX (Store Management)")
    expect(scopeStep.detail).toContain("GMV MAX Report")
    const prep = tiktokGuide.steps.at(-1)!
    expect(prep.title).toContain("GMV Max")
    expect(prep.title).toContain("tuỳ chọn")
    expect(prep.detail).toContain("Set up GMV Max")
    expect(prep.link?.url).toMatch(
      /^https:\/\/ads\.tiktok\.com\/help\/article\//
    )
    expect(
      tiktokGuide.requiredScopes!.some((s) => s.includes("GMV MAX Report"))
    ).toBe(true)
    const w = tiktokGuide.warnings!.join(" ")
    expect(w).toContain("1 tài khoản quảng cáo GMV Max")
    expect(w).toContain("xem và phân tích")
    // the original first steps are unchanged (auth_code flow still documented)
    expect(tiktokGuide.steps.some((s) => s.detail.includes("auth_code"))).toBe(
      true
    )
  })
})

describe("GMV Max probe - reuse in the periodic token check + hard deadline", () => {
  const list = advertisers(2)
  const ids = list.map((a) => a.advertiser_id)
  const recent = (over: Record<string, unknown> = {}) => ({
    checkedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    appId: CREDS.appId,
    advertisers: [
      { advertiserId: ids[0], shops: 2, ready: 1 },
      { advertiserId: ids[1], shops: 0, ready: 0 },
    ],
    notChecked: 0,
    permissionDenied: false,
    failed: false,
    ...over,
  })

  it("a recent complete result (< 24 h, same app, same advertisers) is reused: no GMV Max call, same warnings", async () => {
    const m = mockValidate(list, () => ok({ store_list: [] }))
    const previous = recent()
    const res = await tiktokProvider.validateCredentials({
      credentials: CREDS,
      connectionMeta: { gmvMax: previous },
    })
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(0)
    expect(res.meta.gmvMax).toEqual(previous)
    expect(gmvLines(res.warnings)).toEqual([
      "GMV Max (TikTok Shop): tài khoản TKQC 1 đã sẵn sàng với 1 cửa hàng.",
    ])
  })

  it("probes again when the result is old, from another app, incomplete, refused, or misses an advertiser", () => {
    const now = Date.now()
    expect(reusableGmvMaxProbe(recent(), CREDS.appId, ids, now)).not.toBeNull()
    for (const p of [
      recent({ checkedAt: new Date(now - GMV_PROBE_REUSE_MS - 1).toISOString() }),
      recent({ appId: "7000000000000000999" }),
      recent({ appId: undefined }),
      recent({ failed: true }),
      recent({ permissionDenied: true }),
      recent({ advertisers: [{ advertiserId: ids[0], shops: 0, ready: 0 }] }),
      recent({ checkedAt: "garbage" }),
      null,
      "x",
    ]) {
      expect(reusableGmvMaxProbe(p, CREDS.appId, ids, now)).toBeNull()
    }
  })

  it("an old result is not reused: the shops are read again", async () => {
    const m = mockValidate(list, () => ok({ store_list: [] }))
    await tiktokProvider.validateCredentials({
      credentials: CREDS,
      connectionMeta: {
        gmvMax: recent({
          checkedAt: new Date(Date.now() - GMV_PROBE_REUSE_MS - 60_000).toISOString(),
        }),
      },
    })
    expect(m.callsTo("GET /gmv_max/store/list/")).toHaveLength(2)
  })

  it("time budget spent → stops before the next advertiser (failed, rest not checked)", async () => {
    const m = mockTikTok({ "GET /gmv_max/store/list/": ok({ store_list: [] }) })
    let t = 0
    const now = () => t
    const out = await probeGmvMax(
      { credentials: CREDS },
      advertisers(3),
      () => {
        const v = now()
        t += GMV_PROBE_BUDGET_MS / 2 + 1
        return v
      }
    )
    expect(m.callsTo("GET /gmv_max/store/list/").length).toBeLessThan(3)
    expect(out.meta.failed).toBe(true)
    expect(out.meta.notChecked).toBeGreaterThan(0)
  })

  it("an in-flight call is aborted through the probe signal (never hangs the validation)", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")))
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const started = Date.now()
    const out = await probeGmvMax({ credentials: CREDS, signal: ac.signal }, advertisers(2))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.meta).toMatchObject({ failed: true, advertisers: [], permissionDenied: false })
    expect(out.warnings).toEqual([])
  })
})
