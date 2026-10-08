import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import { makeRequestId, mapTikTokError, tiktokRequest, tiktokUrl } from "./client"
import { exchangeAuthCode } from "./credentials"
import { fail, mockTikTok, ok } from "./__fixtures__/mock-fetch"

const AUTH = "tok_test_abcdef123456"

beforeEach(() => __resetBuckets())
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TIKTOK_API_VERSION
})

describe("TikTok client", () => {
  it("gọi URL có dấu / cuối, header Access-Token và JSON-encode tham số GET", async () => {
    const m = mockTikTok({ "GET /campaign/get/": ok({ list: [] }) })
    await tiktokRequest({
      method: "GET",
      path: "campaign/get",
      query: { advertiser_id: "71", filtering: { campaign_ids: ["1", "2"] }, fields: ["campaign_id"] },
      auth: AUTH,
      appId: "1",
    })
    const call = m.calls[0]!
    expect(call.url.startsWith("https://business-api.tiktok.com/open_api/v1.3/campaign/get/?")).toBe(true)
    expect(new URL(call.url).pathname.endsWith("/")).toBe(true)
    expect(call.headers["access-token"]).toBe(AUTH)
    expect(call.headers.authorization).toBeUndefined()
    expect(new URL(call.url).searchParams.get("filtering")).toBe('{"campaign_ids":["1","2"]}')
    expect(call.query.fields).toEqual(["campaign_id"])
  })

  it("đọc version từ TIKTOK_API_VERSION", () => {
    process.env.TIKTOK_API_VERSION = "v1.4"
    expect(tiktokUrl("/ad/get")).toBe("https://business-api.tiktok.com/open_api/v1.4/ad/get/")
  })

  it("map HTTP 200 + code 40105 thành auth_invalid, lấy request_id trong body", async () => {
    mockTikTok({ "GET /user/info/": fail(40105, "Access token is incorrect or has been revoked.") })
    const events: unknown[] = []
    const err = await tiktokRequest({ method: "GET", path: "user/info", auth: AUTH, appId: "2", onUpstream: (e) => events.push(e) }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe("auth_invalid")
    expect(err.upstream.code).toBe(40105)
    expect(err.upstream.requestId).toBe("req-err-40105")
    expect(err.message).not.toContain(AUTH)
    expect(events).toHaveLength(1)
    expect((events[0] as { requestId: string }).requestId).toBe("req-err-40105")
  })

  it.each([
    [40001, "permission_denied"],
    [40125, "permission_denied"],
    [40102, "auth_invalid"],
    [40104, "auth_invalid"],
    [40106, "auth_invalid"],
    [40113, "auth_invalid"],
    [40002, "invalid_request"],
    [40007, "not_found"],
    [40118, "feature_not_enabled"],
    [40133, "rate_limited"],
    [40202, "conflict"],
    [50000, "upstream_error"],
    [51305, "upstream_error"],
    [60001, "upstream_error"],
  ])("map code %i → %s", (code, expected) => {
    const e = mapTikTokError(code, "x", "rid")
    expect(e.code).toBe(expected)
    expect(e.platform).toBe("tiktok")
    expect(e.userMessageVi.length).toBeGreaterThan(5)
  })

  it("40100: trả rate_limited và tạm dừng endpoint 5 phút (không gọi lại fetch)", async () => {
    const m = mockTikTok({ "GET /report/integrated/get/": fail(40100, "Too many requests") })
    const e1 = await tiktokRequest({ method: "GET", path: "report/integrated/get", auth: AUTH, appId: "3" }).catch((e) => e)
    expect(e1.code).toBe("rate_limited")
    expect(e1.retryAfterMs).toBe(5 * 60_000)
    const e2 = await tiktokRequest({ method: "GET", path: "report/integrated/get", auth: AUTH, appId: "3" }).catch((e) => e)
    expect(e2.code).toBe("rate_limited")
    expect(m.calls).toHaveLength(1)
    // a different endpoint of the same app is not blocked
    mockTikTok({ "GET /campaign/get/": ok({ list: [] }) })
    await expect(tiktokRequest({ method: "GET", path: "campaign/get", auth: AUTH, appId: "3" })).resolves.toBeTruthy()
  })

  it("GET thử lại khi code 50000 rồi thành công; POST mặc định không thử lại", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const m = mockTikTok({
      "GET /campaign/get/": (_c: unknown, n: number) => (n === 0 ? fail(50000, "System error") : ok({ list: [{ campaign_id: "1" }] })),
      "POST /campaign/update/": fail(50000, "System error"),
    })
    const res = await tiktokRequest<{ list: unknown[] }>({ method: "GET", path: "campaign/get", auth: AUTH, appId: "4" })
    expect(res.data.list).toHaveLength(1)
    expect(m.callsTo("GET /campaign/get/")).toHaveLength(2)
    const err = await tiktokRequest({ method: "POST", path: "campaign/update", body: {}, auth: AUTH, appId: "4" }).catch((e) => e)
    expect(err.code).toBe("upstream_error")
    expect(m.callsTo("POST /campaign/update/")).toHaveLength(1)
  }, 20_000)

  it("code 20001 (thành công một phần) không phải lỗi", async () => {
    mockTikTok({ "POST /adgroup/status/update/": { body: { code: 20001, message: "partial", request_id: "r", data: { adgroup_ids: ["1"] } } } })
    const res = await tiktokRequest({ method: "POST", path: "adgroup/status/update", body: {}, auth: AUTH, appId: "5" })
    expect(res.code).toBe(20001)
  })

  it("request_id: chuỗi int64 dương, cố định theo idempotencyKey", () => {
    const a = makeRequestId("key-1", "campaign")
    expect(a).toMatch(/^\d{1,19}$/)
    expect(BigInt(a) > BigInt(0)).toBe(true)
    expect(BigInt(a) <= BigInt("9223372036854775807")).toBe(true)
    expect(makeRequestId("key-1", "campaign")).toBe(a)
    expect(makeRequestId("key-1", "adgroup")).not.toBe(a)
    expect(makeRequestId()).not.toBe(makeRequestId())
  })
})

describe("exchangeAuthCode", () => {
  it("POST JSON tới /oauth2/access_token/ không kèm Access-Token, trả token + scope", async () => {
    const m = mockTikTok({
      "POST /oauth2/access_token/": ok({ access_token: "new_token_xyz", scope: [1, 2, 4, 6, 8], advertiser_ids: ["71", "72"] }),
    })
    const res = await exchangeAuthCode({ appId: "7000000000000000001", secret: "sec", authCode: "code123" })
    expect(res).toEqual({ accessToken: "new_token_xyz", scope: ["1", "2", "4", "6", "8"], advertiserIds: ["71", "72"] })
    const call = m.calls[0]!
    expect(call.headers["access-token"]).toBeUndefined()
    expect(call.headers["content-type"]).toBe("application/json")
    expect(call.body).toEqual({ app_id: "7000000000000000001", secret: "sec", auth_code: "code123", return_advertiser_ids: true })
  })

  it("auth_code hết hạn → lỗi tiếng Việt", async () => {
    mockTikTok({ "POST /oauth2/access_token/": fail(40110, "The auth_code is canceled.") })
    const err = await exchangeAuthCode({ appId: "7000000000000000001", secret: "sec", authCode: "old" }).catch((e) => e)
    expect(err.code).toBe("invalid_request")
    expect(err.userMessageVi).toContain("auth_code")
  })
})
