import { describe, expect, it } from "vitest"
import { ProviderError } from "../errors"
import { buildOaUrl, createIdempotencyKey, oaRequest, routeTemplate } from "./client"
import { API_KEY, apiError, calls, clone, fx, json, makeCtx, route, setupHarness, writes } from "./__fixtures__/harness"

setupHarness()

async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    return e as ProviderError
  }
  throw new Error("expected rejection")
}

describe("OpenAI Ads client", () => {
  it("gửi Bearer API key và KHÔNG gửi OpenAI-Ad-Account", async () => {
    route("get", "/ad_account", fx.adAccount)
    await oaRequest(makeCtx(), { method: "GET", path: "/ad_account" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
    expect(calls[0]!.headers.get("openai-ad-account")).toBeNull()
  })

  it("mã hoá mảng thành key[] lặp lại (fields[], time_ranges[])", () => {
    const url = new URL(buildOaUrl("/ad_account/insights", { fields: ["campaign.id", "spend"], limit: 5, after: undefined }))
    expect(url.searchParams.getAll("fields[]")).toEqual(["campaign.id", "spend"])
    expect(url.searchParams.get("limit")).toBe("5")
    expect(url.searchParams.has("after")).toBe(false)
    expect(routeTemplate("/campaigns/cmpn_1/pause")).toBe("/campaigns/{id}/pause")
    expect(routeTemplate("/ad_account/insights")).toBe("/ad_account/insights")
  })

  it("401 invalid_api_key → auth_invalid, giữ x-request-id, không lộ key", async () => {
    route("get", "/ad_account", () => apiError(401, "Incorrect API key provided", "invalid_api_key"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "GET", path: "/ad_account" }))
    expect(e.code).toBe("auth_invalid")
    expect(e.upstream?.requestId).toBe("req_test_1")
    expect(e.upstream?.code).toBe("invalid_api_key")
    expect(JSON.stringify(e.toJSON())).not.toContain(API_KEY)
    expect(e.message).not.toContain(API_KEY)
  })

  it("403/404 trên endpoint bị gate → feature_not_enabled; 404 thường → not_found", async () => {
    route("get", "/conversions/event_settings", () => apiError(404, "Not found"))
    route("get", "/ad_account/spend_limit_windows", () => apiError(403, "Forbidden", null, "permission_error"))
    route("get", "/campaigns/cmpn_x", () => apiError(404, "Campaign not found"))
    const ctx = makeCtx()
    expect((await catchErr(oaRequest(ctx, { method: "GET", path: "/conversions/event_settings", gated: true }))).code).toBe(
      "feature_not_enabled"
    )
    expect((await catchErr(oaRequest(ctx, { method: "GET", path: "/ad_account/spend_limit_windows", gated: true }))).code).toBe(
      "feature_not_enabled"
    )
    expect((await catchErr(oaRequest(ctx, { method: "GET", path: "/campaigns/cmpn_x" }))).code).toBe("not_found")
  })

  it("403 'not enabled' trên endpoint thường → feature_not_enabled", async () => {
    route("post", "/campaigns", () => apiError(403, "Conversion bidding is not enabled"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "POST", path: "/campaigns", body: {}, idempotencyKey: "k1" }))
    expect(e.code).toBe("feature_not_enabled")
  })

  it("409 ('Ad Account is missing details') được thử lại đúng 1 lần", async () => {
    route("get", "/ad_account", (_c, n) => (n === 1 ? apiError(409, "Ad Account is missing details") : json(fx.adAccount)))
    const res = await oaRequest<{ id: string }>(makeCtx(), { method: "GET", path: "/ad_account" })
    expect(res.id).toBe("adacct_123")
    expect(calls).toHaveLength(2)
  })

  it("409 lặp lại → lỗi conflict sau 2 lần gọi", async () => {
    route("get", "/ad_account", () => apiError(409, "Ad Account is missing details"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "GET", path: "/ad_account" }))
    expect(e.code).toBe("conflict")
    expect(calls).toHaveLength(2)
  })

  it("429 khi tạo: thử lại với CÙNG Idempotency-Key", async () => {
    route("post", "/campaigns", (_c, n) => (n === 1 ? apiError(429, "Rate limit reached", "rate_limit_exceeded") : json(fx.campaign)))
    await oaRequest(makeCtx(), { method: "POST", path: "/campaigns", body: { name: "x" }, idempotencyKey: "idem-123" })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.headers.get("idempotency-key"))).toEqual(["idem-123", "idem-123"])
  })

  it("503 khi tạo: thử lại với cùng Idempotency-Key (API trả object đã tạo)", async () => {
    route("post", "/ads", (_c, n) => (n === 1 ? apiError(503, "Service unavailable", null, "server_error") : json(fx.ad)))
    const res = await oaRequest<{ id: string }>(makeCtx(), { method: "POST", path: "/ads", body: {}, idempotencyKey: "idem-ad" })
    expect(res.id).toBe("ad_301")
    expect(writes().map((c) => c.headers.get("idempotency-key"))).toEqual(["idem-ad", "idem-ad"])
  })

  it("503 khi ghi (không phải tạo): đọc lại trước - đã lưu thì KHÔNG gửi lại", async () => {
    route("post", "/campaigns/cmpn_101/pause", () => apiError(503, "Service unavailable", null, "server_error"))
    route("get", "/campaigns/cmpn_101", clone(fx.campaign, { status: "paused" }))
    let verified = 0
    const res = await oaRequest<{ status: string }>(makeCtx(), {
      method: "POST",
      path: "/campaigns/cmpn_101/pause",
      verify: async () => {
        verified++
        const r = await oaRequest<{ status: string }>(makeCtx(), { method: "GET", path: "/campaigns/cmpn_101" })
        return r.status === "paused" ? r : null
      },
    })
    expect(res.status).toBe("paused")
    expect(verified).toBe(1)
    expect(writes()).toHaveLength(1)
  })

  it("503 khi ghi: đọc lại thấy CHƯA lưu → thử lại đúng 1 lần", async () => {
    route("post", "/campaigns/cmpn_101/pause", (_c, n) =>
      n === 1 ? apiError(503, "Service unavailable") : json(clone(fx.campaign, { status: "paused" }))
    )
    const res = await oaRequest<{ status: string }>(makeCtx(), {
      method: "POST",
      path: "/campaigns/cmpn_101/pause",
      verify: async () => null,
    })
    expect(res.status).toBe("paused")
    expect(writes()).toHaveLength(2)
  })

  it("503 khi ghi không có verify → không retry mù, báo có thể đã lưu", async () => {
    route("post", "/campaigns/cmpn_101", () => apiError(503, "Service unavailable"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "POST", path: "/campaigns/cmpn_101", body: { name: "abc" } }))
    expect(e.code).toBe("upstream_error")
    expect(e.retryable).toBe(false)
    expect(e.userMessageVi).toContain("CÓ THỂ đã được lưu")
    expect(writes()).toHaveLength(1)
  })

  it("422 budget_window_amount_below_spend → invalid_request với thông báo tiếng Việt", async () => {
    route("post", "/campaigns/cmpn_101", () => apiError(422, "Budget is below the amount already spent", "budget_window_amount_below_spend"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "POST", path: "/campaigns/cmpn_101", body: {} }))
    expect(e.code).toBe("invalid_request")
    expect(e.userMessageVi).toContain("đã chi")
  })

  it("5xx khi tạo hết lượt thử → retryable=false + gợi ý kiểm tra trước khi thử lại", async () => {
    route("post", "/ads", () => apiError(503, "Service unavailable", null, "server_error"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "POST", path: "/ads", body: {}, idempotencyKey: "idem-x" }))
    expect(e.retryable).toBe(false)
    expect(e.hint).toMatch(/Có thể đã tạo/)
    expect(writes().map((c) => c.headers.get("idempotency-key")).every((k) => k === "idem-x")).toBe(true)
  })

  it("409 khi sửa (không phải tạo) không có rebuild → KHÔNG gửi lại body cũ", async () => {
    route("post", "/campaigns/cmpn_101", () => apiError(409, "Revision conflict"))
    const e = await catchErr(oaRequest(makeCtx(), { method: "POST", path: "/campaigns/cmpn_101", body: { name: "abc" } }))
    expect(e.code).toBe("conflict")
    expect(writes()).toHaveLength(1)
  })

  it("409 khi sửa có rebuild → gửi body mới đã ghép lại (1 lần)", async () => {
    route("post", "/campaigns/cmpn_101", (_c, n) => (n === 1 ? apiError(409, "Revision conflict") : json(fx.campaign)))
    await oaRequest(makeCtx(), { method: "POST", path: "/campaigns/cmpn_101", body: { name: "old" }, rebuild: async () => ({ name: "re-merged" }) })
    expect(writes().map((w) => w.body)).toEqual([{ name: "old" }, { name: "re-merged" }])
  })

  it("createIdempotencyKey tất định, không ngẫu nhiên; khác nhau theo key gọi/tool/input", () => {
    const a = createIdempotencyKey("adacct_1", "t", { b: 1, a: [1, 2] })
    expect(createIdempotencyKey("adacct_1", "t", { a: [1, 2], b: 1 })).toBe(a) // key order does not matter
    expect(createIdempotencyKey("adacct_1", "t", { a: [2, 1], b: 1 })).not.toBe(a)
    expect(createIdempotencyKey("adacct_2", "t", { b: 1, a: [1, 2] })).not.toBe(a)
    expect(createIdempotencyKey("adacct_1", "t", {}, "pending-1")).toBe(createIdempotencyKey("adacct_1", "t", { x: 1 }, "pending-1"))
    expect(createIdempotencyKey("adacct_1", "t", {}, "pending-1")).not.toBe(createIdempotencyKey("adacct_1", "t", {}, "pending-2"))
  })

  it("5xx khi đọc được thử lại", async () => {
    route("get", "/ad_account", (_c, n) => (n === 1 ? apiError(502, "Bad gateway") : json(fx.adAccount)))
    await oaRequest(makeCtx(), { method: "GET", path: "/ad_account" })
    expect(calls).toHaveLength(2)
  })
})
