import { describe, expect, it } from "vitest"

import {
  ApifyError,
  apifyErrorText,
  cleanUpstreamText,
  mapApifyError,
} from "./errors"

const body = (type: string, message = "") => ({ error: { type, message } })

describe("mapApifyError: phân loại lỗi Apify + hướng xoay token", () => {
  const cases: [number, unknown, string, ApifyError["rotate"]][] = [
    // token rejected → mark invalid
    [
      401,
      body(
        "user-or-token-not-found",
        "User was not found or authentication token is not valid"
      ),
      "invalid_token",
      "invalid",
    ],
    [401, body("invalid-token"), "invalid_token", "invalid"],
    [401, null, "invalid_token", "invalid"],
    [403, body("user-disabled"), "invalid_token", "invalid"],
    // header missing: our bug, never an empty wallet
    [401, body("token-not-provided"), "token_missing", null],
    [
      402,
      body("x402-payment-required", "Payment required"),
      "token_missing",
      null,
    ],
    // out of credit → the whole account until the cycle ends
    [
      402,
      body("", "User exceeded their usage limit"),
      "out_of_credit",
      "exhausted",
    ],
    [402, body("some-new-type"), "out_of_credit", "exhausted"],
    [
      403,
      body("platform-feature-disabled", "Monthly usage hard limit exceeded"),
      "out_of_credit",
      "exhausted",
    ],
    [
      400,
      body("not-enough-usage-to-run-paid-actor"),
      "out_of_credit",
      "exhausted",
    ],
    [
      403,
      body("forbidden", "You have exceeded your usage limit"),
      "out_of_credit",
      "exhausted",
    ],
    // account busy / plan / scoped token → skip this time
    [
      402,
      body(
        "actor-memory-limit-exceeded",
        "By launching this job you will exceed the memory limit"
      ),
      "account_busy",
      "busy",
    ],
    [400, body("memory-limit-exceeded"), "account_busy", "busy"],
    [429, body("concurrent-runs-limit-exceeded"), "account_busy", "busy"],
    [403, body("cannot-start-actor-runs"), "account_busy", "busy"],
    [
      403,
      body("apify-plan-required-to-use-paid-actor"),
      "paid_plan_required",
      "busy",
    ],
    [403, body("insufficient-permissions"), "insufficient_permissions", "busy"],
    // not a token problem → fail at once
    [
      403,
      body("full-permission-actor-not-approved"),
      "actor_not_allowed",
      null,
    ],
    [403, body("public-actor-disabled"), "actor_not_allowed", null],
    [
      400,
      body("invalid-input", "Field input.url is required"),
      "input_invalid",
      null,
    ],
    [
      400,
      body("max-total-charge-usd-below-minimum"),
      "charge_limit_invalid",
      null,
    ],
    [400, body("invalid-value"), "bad_request", null],
    [413, body("request-too-large"), "bad_request", null],
    [
      404,
      body("record-not-found", "Actor run was not found"),
      "not_found",
      null,
    ],
    [429, body("rate-limit-exceeded"), "rate_limited", null],
    [500, null, "upstream", null],
    [503, body("service-unavailable"), "upstream", null],
    [403, body("something-else"), "forbidden", null],
  ]
  it.each(cases)("HTTP %i %j → %s (rotate %s)", (status, b, code, rotate) => {
    const e = mapApifyError(status, b)
    expect(e.code).toBe(code)
    expect(e.rotate).toBe(rotate)
    expect(e.httpStatus).toBe(status)
    expect(e.userMessageVi.length).toBeGreaterThan(10)
  })

  it("retryable chỉ cho 429 / 5xx / timeout / mạng; Retry-After được giữ lại", () => {
    expect(
      mapApifyError(429, body("rate-limit-exceeded"), { retryAfterSec: 2 })
    ).toMatchObject({ retryable: true, retryAfterSec: 2 })
    expect(mapApifyError(502, null).retryable).toBe(true)
    expect(new ApifyError("timeout").retryable).toBe(true)
    expect(new ApifyError("network").retryable).toBe(true)
    expect(mapApifyError(401, null).retryable).toBe(false)
    expect(mapApifyError(400, body("invalid-input")).retryable).toBe(false)
  })

  it("thông điệp kỹ thuật không chứa URL / token; thông điệp upstream được che token, bỏ ký tự điều khiển và cắt ngắn", () => {
    const token = "apify_api_" + "A1b2C3".repeat(5)
    const e = mapApifyError(
      401,
      body(
        "user-or-token-not-found",
        `bad token ${token} at https://api.apify.com/v2/users/me\u202e\u0007 ${"x".repeat(500)}`
      )
    )
    expect(e.message).toBe("apify invalid_token 401 user-or-token-not-found")
    expect(e.upstreamMessage).not.toContain(token)
    expect(e.upstreamMessage).toContain("apify_api_…[redacted]")
    expect(e.upstreamMessage).not.toMatch(/[\u202e\u0007]/)
    expect(e.upstreamMessage!.length).toBeLessThanOrEqual(300)
    expect(apifyErrorText(e)).toContain("Thay token")
    expect(cleanUpstreamText("  ")).toBeNull()
    expect(cleanUpstreamText(42)).toBeNull()
  })
})

describe("ApifyError: dữ liệu upstream không tin cậy", () => {
  it("apifyType chỉ giữ chữ thường / số / gạch nối; thông điệp upstream rất dài được cắt TRƯỚC khi redact", () => {
    const RLO = String.fromCharCode(0x202e)
    const e = mapApifyError(400, { error: { type: `Invalid-Input<script>${RLO} x`, message: "m" } })
    expect(e.apifyType).toBe("invalid-inputscriptx")
    expect(new ApifyError("bad_request", { apifyType: `${RLO}<>` }).apifyType).toBeNull()
    const huge = "apify_api_" + "Z".repeat(30) + " " + "y".repeat(2_000_000)
    const started = Date.now()
    const cleaned = cleanUpstreamText(huge)
    expect(Date.now() - started).toBeLessThan(500)
    expect(cleaned!.length).toBeLessThanOrEqual(300)
    expect(cleaned).toContain("apify_api_…[redacted]")
  })

  it("daily_budget_exceeded: không retry, không xoay token, thông điệp tiếng Việt có số tiền", () => {
    const e = new ApifyError("daily_budget_exceeded", { message: "MCP đã dùng khoảng 9.5 USD hôm nay" })
    expect(e).toMatchObject({ retryable: false, rotate: null, code: "daily_budget_exceeded" })
    expect(e.userMessageVi).toContain("9.5 USD")
    expect(e.hint).toMatch(/MCP → Cấu hình → Bảo vệ/)
  })
})
