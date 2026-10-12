import { beforeEach, describe, expect, it } from "vitest"

import { isProviderError, type ProviderError } from "../errors"
import { __resetBuckets, blockedForMs } from "../rate-limit"
import type { UpstreamEvent } from "../types"
import { appSecretProof, graph, graphBatch, mapGraphError } from "./client"
import { TEST_TOKEN, graphError, json, mockGraph } from "./test-utils"

beforeEach(() => __resetBuckets())

async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    if (isProviderError(e)) return e
    throw e
  }
  throw new Error("expected a ProviderError")
}

describe("appsecret_proof", () => {
  it("is HMAC-SHA256(token, app_secret) in hex (RFC 4231-style known vector)", () => {
    expect(appSecretProof("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    )
  })

  it("is sent with GET (query) and POST (body) when app secret is configured, and never leaks into reported URLs", async () => {
    const m = mockGraph([
      ["GET", "me", () => json({ id: "1", name: "SU" })],
      ["POST", "123", () => json({ success: true })],
    ])
    const events: UpstreamEvent[] = []
    const ctx = {
      credentials: { accessToken: TEST_TOKEN, appId: "12345", appSecret: "0123456789abcdef0123456789abcdef" },
      onUpstream: (e: UpstreamEvent) => events.push(e),
    }
    await graph(ctx, { method: "GET", path: "me", params: { fields: "id,name" }, idempotent: true })
    await graph(ctx, { method: "POST", path: "123", params: { status: "PAUSED" } })
    const proof = appSecretProof(TEST_TOKEN, "0123456789abcdef0123456789abcdef")
    expect(m.calls[0].url.searchParams.get("appsecret_proof")).toBe(proof)
    expect(m.calls[1].url.search).toBe("") // POST: token & proof in body, not URL
    expect(m.calls[1].params.appsecret_proof).toBe(proof)
    expect(m.calls[1].params.access_token).toBe(TEST_TOKEN)
    for (const e of events) expect(e.url).not.toContain(TEST_TOKEN)
  })

  it("is not sent without an app secret", async () => {
    const m = mockGraph([["GET", "me", () => json({ id: "1" })]])
    await graph({ credentials: { accessToken: TEST_TOKEN } }, { method: "GET", path: "me", idempotent: true })
    expect(m.calls[0].url.searchParams.has("appsecret_proof")).toBe(false)
  })
})

describe("Graph error mapping", () => {
  it("190 → auth_invalid, not retryable, no retry", async () => {
    const m = mockGraph([["GET", "me", () => graphError(190, 463)]])
    const e = await catchErr(graph({ credentials: { accessToken: TEST_TOKEN } }, { method: "GET", path: "me", idempotent: true }))
    expect(e.code).toBe("auth_invalid")
    expect(e.retryable).toBe(false)
    expect(e.upstream?.code).toBe(190)
    expect(e.upstream?.subcode).toBe(463)
    expect(e.upstream?.requestId).toBe("TRACE123")
    expect(e.userMessageVi).toContain("hết hạn")
    expect(e.message).not.toContain(TEST_TOKEN)
    expect(m.calls).toHaveLength(1)
  })

  it.each([
    [17, 2446079],
    [613, 1487742],
    [80004, undefined],
    [4, undefined],
  ])("throttle code %i → rate_limited + circuit breaker (no immediate retry)", async (code, sub) => {
    const m = mockGraph([["GET", "act_1001/campaigns", () => graphError(code, sub)]])
    const ctx = { credentials: { accessToken: TEST_TOKEN }, accountId: "act_1001" }
    const e = await catchErr(graph(ctx, { method: "GET", path: "act_1001/campaigns", idempotent: true }))
    expect(e.code).toBe("rate_limited")
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBeGreaterThan(0)
    expect(m.calls).toHaveLength(1)
    expect(blockedForMs("meta:act_1001")).toBeGreaterThan(0)
  })

  it("613/1487632 (budget changed too often) → quota_exceeded", () => {
    const e = mapGraphError({ code: 613, error_subcode: 1487632, message: "x" }, 400, null)
    expect(e.code).toBe("quota_exceeded")
  })

  it("100/4834011 → invalid_request with ABO hint", () => {
    const e = mapGraphError({ code: 100, error_subcode: 4834011, message: "Invalid parameter" }, 400, null)
    expect(e.code).toBe("invalid_request")
    expect(e.retryable).toBe(false)
    expect(e.hint).toMatch(/ABO/)
  })

  it("uses error_user_msg for invalid requests", () => {
    const e = mapGraphError(
      { code: 100, message: "Invalid parameter", error_user_title: "Ngân sách quá thấp", error_user_msg: "Tối thiểu 26.484đ" },
      400,
      null
    )
    expect(e.userMessageVi).toBe("Ngân sách quá thấp: Tối thiểu 26.484đ")
  })

  it("31 (pending user action, e.g. security checkpoint) → action_required, not retryable, with hint", () => {
    const e = mapGraphError(
      {
        code: 31,
        error_subcode: 3858385,
        message: "This request requires the user to take a pending action",
        error_user_title: "Vui lòng xác thực tài khoản",
        error_user_msg: "Bạn sẽ không thể tạo hoặc chỉnh sửa quảng cáo cho đến khi xác thực tài khoản.",
      },
      200,
      null
    )
    expect(e.code).toBe("action_required")
    expect(e.retryable).toBe(false)
    expect(e.userMessageVi).toBe(
      "Vui lòng xác thực tài khoản: Bạn sẽ không thể tạo hoặc chỉnh sửa quảng cáo cho đến khi xác thực tài khoản."
    )
    expect(e.hint).toMatch(/Trình quản lý quảng cáo/)
    expect(mapGraphError({ code: 31, message: "x" }, 400, null).userMessageVi).toMatch(/xác thực/)
  })

  it("10 / 200 / 294 → permission_denied", () => {
    for (const code of [10, 200, 294]) expect(mapGraphError({ code }, 403, null).code).toBe("permission_denied")
  })

  it("does not retry a failed create (POST, non-idempotent) on 5xx", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ error: { code: 2, message: "Service temporarily unavailable" } }, 500)]])
    const e = await catchErr(
      graph({ credentials: { accessToken: TEST_TOKEN } }, { method: "POST", path: "act_1001/campaigns", params: { name: "x" } })
    )
    expect(e.code).toBe("upstream_error")
    expect(m.calls).toHaveLength(1)
  })
})

describe("usage headers", () => {
  it("X-Business-Use-Case-Usage with estimated_time_to_regain_access cools the account bucket down", async () => {
    mockGraph([
      [
        "GET",
        "act_1001",
        () =>
          json({ id: "act_1001" }, 200, {
            "x-business-use-case-usage": JSON.stringify({
              "1001": [{ type: "ads_management", call_count: 100, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 5 }],
            }),
          }),
      ],
    ])
    await graph({ credentials: { accessToken: TEST_TOKEN }, accountId: "act_1001" }, { method: "GET", path: "act_1001", idempotent: true })
    const blocked = blockedForMs("meta:act_1001")
    expect(blocked).toBeGreaterThan(4 * 60_000)
    expect(blocked).toBeLessThanOrEqual(5 * 60_000)
  })

  it("low utilisation does not block", async () => {
    mockGraph([
      ["GET", "act_1001", () => json({ id: "act_1001" }, 200, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 12.5, reset_time_duration: 0 }) })],
    ])
    await graph({ credentials: { accessToken: TEST_TOKEN }, accountId: "act_1001" }, { method: "GET", path: "act_1001", idempotent: true })
    expect(blockedForMs("meta:act_1001")).toBe(0)
  })
})

describe("batch", () => {
  it("posts ≤50 ops per call with relative_url/body and reports each result", async () => {
    const m = mockGraph([
      [
        "POST",
        "",
        (c) => {
          const ops = JSON.parse(c.params.batch) as unknown[]
          return json(
            ops.map((_, i) =>
              i === 1
                ? { code: 400, body: JSON.stringify({ error: { code: 100, message: "bad" } }) }
                : { code: 200, body: JSON.stringify({ success: true }) }
            )
          )
        },
      ],
    ])
    const ops = Array.from({ length: 51 }, (_, i) => ({ method: "POST" as const, relative_url: String(100 + i), body: "status=PAUSED" }))
    const res = await graphBatch({ credentials: { accessToken: TEST_TOKEN } }, ops)
    expect(m.calls).toHaveLength(2)
    expect(JSON.parse(m.calls[0].params.batch)).toHaveLength(50)
    expect(JSON.parse(m.calls[1].params.batch)).toHaveLength(1)
    expect(m.calls[0].params.include_headers).toBe("false")
    expect(res).toHaveLength(51)
    expect(res.filter((r) => r.ok)).toHaveLength(50)
    expect(res[1].ok).toBe(false)
  })
})
