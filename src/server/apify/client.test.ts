import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createFakeApify,
  FAKE_BASE_URL,
  fakeToken,
} from "./__fixtures__/apify-fetch"
import {
  __setApifyRetryBaseMs,
  apifyApiBaseUrl,
  apifyPath,
  apifyRequest,
  DEFAULT_APIFY_API_BASE_URL,
  type FetchLike,
} from "./client"
import { ApifyError } from "./errors"

const TOKEN = fakeToken("client")

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("apifyRequest", () => {
  beforeEach(() => __setApifyRetryBaseMs(1))
  afterEach(() => __setApifyRetryBaseMs(500))

  it("gửi token qua header Bearer (không bao giờ ?token=), redirect error, no-store, Accept JSON; mở envelope data", async () => {
    const fake = createFakeApify()
    fake.accounts.set(TOKEN, {
      userId: "u1",
      username: "shop",
      usageUsd: 1,
      limitUsd: 5,
      cycleEndAt: "2026-11-01T00:00:00.000Z",
    })
    const seen: RequestInit[] = []
    const fetchImpl: FetchLike = (url, init) => {
      seen.push(init)
      return fake.fetch(url, init)
    }
    const res = await apifyRequest<{ id: string }>(
      TOKEN,
      { method: "GET", path: apifyPath("users", "me") },
      { fetchImpl, baseUrl: FAKE_BASE_URL }
    )
    expect(res.data.id).toBe("u1")
    const call = fake.calls[0]!
    expect(call.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.query.has("token")).toBe(false)
    expect(call.path).toBe("/v2/users/me")
    expect(seen[0]!.redirect).toBe("error")
    expect(seen[0]!.cache).toBe("no-store")
    expect(new Headers(seen[0]!.headers as HeadersInit).get("accept")).toBe(
      "application/json"
    )
  })

  it("từ chối query tên token, token có ký tự lạ (không gửi đi), path segment bất thường và base URL không phải https", async () => {
    const fetchImpl = vi.fn<FetchLike>()
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me", query: { token: TOKEN } },
        { fetchImpl, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toThrow(/query parameter/)
    await expect(
      apifyRequest(
        "apify_api_x\r\nX: y",
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({
      code: "invalid_token",
    })
    expect(() => apifyPath("actors", "../users")).toThrow(ApifyError)
    expect(() => apifyPath("actors", "a/b")).toThrow(ApifyError)
    expect(apifyPath("actors", "apify~web-scraper", "runs")).toBe(
      "/v2/actors/apify~web-scraper/runs"
    )
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl, baseUrl: "http://api.apify.com" }
      )
    ).rejects.toMatchObject({
      code: "config",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(apifyApiBaseUrl({})).toBe(DEFAULT_APIFY_API_BASE_URL)
    expect(
      apifyApiBaseUrl({ APIFY_API_BASE_URL: "https://double.example/" })
    ).toBe("https://double.example")
    expect(
      apifyApiBaseUrl({ APIFY_API_BASE_URL: "http://localhost:1" })
    ).toBeNull()
  })

  it("boolean query thành true/false; giá trị null/undefined bị bỏ", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      respond(200, { data: { items: [] } })
    )
    await apifyRequest(
      TOKEN,
      {
        method: "GET",
        path: "/v2/actor-runs",
        query: {
          desc: true,
          clean: false,
          status: undefined,
          x: null,
          limit: 5,
        },
      },
      { fetchImpl, baseUrl: FAKE_BASE_URL }
    )
    const url = new URL(fetchImpl.mock.calls[0]![0])
    expect(url.searchParams.get("desc")).toBe("true")
    expect(url.searchParams.get("clean")).toBe("false")
    expect(url.searchParams.has("status")).toBe(false)
    expect(url.searchParams.has("x")).toBe(false)
    expect(url.searchParams.get("limit")).toBe("5")
  })

  it("GET: thử lại 429 / 5xx / lỗi mạng tối đa 2 lần rồi thành công", async () => {
    const answers = [
      () =>
        respond(
          429,
          { error: { type: "rate-limit-exceeded" } },
          { "retry-after": "0" }
        ),
      () => {
        throw new TypeError("fetch failed https://apify.test/v2/x")
      },
      () => respond(200, { data: { ok: 1 } }),
    ]
    const fetchImpl = vi.fn<FetchLike>(async () => answers.shift()!())
    const res = await apifyRequest<{ ok: number }>(
      TOKEN,
      { method: "GET", path: "/v2/users/me" },
      { fetchImpl, baseUrl: FAKE_BASE_URL }
    )
    expect(res.data.ok).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("GET: quá 2 lần thử lại → ném lỗi cuối; 4xx không thử lại", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => respond(503, {}))
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({ code: "upstream" })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const f2 = vi.fn<FetchLike>(async () =>
      respond(401, { error: { type: "user-or-token-not-found" } })
    )
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl: f2, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({
      code: "invalid_token",
      rotate: "invalid",
    })
    expect(f2).toHaveBeenCalledTimes(1)
  })

  it("không có Retry-After → backoff luỹ thừa (không bao giờ thử lại ngay); Retry-After hợp lệ được dùng", async () => {
    const { parseRetryAfter } = await import("./client")
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter("")).toBeNull()
    expect(parseRetryAfter("soon")).toBeNull()
    expect(parseRetryAfter("2")).toBe(2)
    __setApifyRetryBaseMs(30)
    const times: number[] = []
    const fetchImpl = vi.fn<FetchLike>(async () => {
      times.push(Date.now())
      return times.length < 2
        ? respond(503, { error: { type: "service-unavailable" } })
        : respond(200, { data: { ok: 1 } })
    })
    await apifyRequest(TOKEN, { method: "GET", path: "/v2/users/me" }, { fetchImpl, baseUrl: FAKE_BASE_URL })
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(25)
    const err = await apifyRequest(
      TOKEN,
      { method: "GET", path: "/v2/users/me", retry: false },
      { fetchImpl: async () => respond(429, { error: { type: "rate-limit-exceeded" } }), baseUrl: FAKE_BASE_URL }
    ).catch((e: unknown) => e)
    expect((err as ApifyError).retryAfterSec).toBeNull()
  })

  it("POST không thử lại (trừ khi retry: true); Retry-After quá ngân sách 5 s → ném lỗi ngay", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => respond(503, {}))
    await expect(
      apifyRequest(
        TOKEN,
        { method: "POST", path: "/v2/actors/a~b/runs", body: {} },
        { fetchImpl, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({
      code: "upstream",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const f2 = vi.fn<FetchLike>(async () =>
      respond(200, { data: { valid: true } })
    )
    await apifyRequest(
      TOKEN,
      {
        method: "POST",
        path: "/v2/actors/a~b/validate-input",
        body: {},
        retry: true,
      },
      { fetchImpl: f2, baseUrl: FAKE_BASE_URL }
    )
    expect(f2).toHaveBeenCalledTimes(1)
    const f3 = vi.fn<FetchLike>(async () =>
      respond(
        429,
        { error: { type: "rate-limit-exceeded" } },
        { "retry-after": "30" }
      )
    )
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl: f3, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({
      code: "rate_limited",
    })
    expect(f3).toHaveBeenCalledTimes(1)
  })

  it("timeout → ApifyError timeout (không lộ URL), caller huỷ → aborted; lỗi mạng không mang theo message của fetch", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      )
    const t = apifyRequest(
      TOKEN,
      { method: "GET", path: "/v2/users/me" },
      { fetchImpl: hang, baseUrl: FAKE_BASE_URL, timeoutMs: 20 }
    )
    await expect(t).rejects.toMatchObject({ code: "timeout" })
    const ac = new AbortController()
    const p = apifyRequest(
      TOKEN,
      { method: "POST", path: "/v2/actors/a~b/runs" },
      { fetchImpl: hang, baseUrl: FAKE_BASE_URL, signal: ac.signal }
    )
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: "aborted" })
    const boom: FetchLike = async () => {
      throw new TypeError(
        `fetch failed for https://apify.test/v2/users/me?x=${TOKEN}`
      )
    }
    const err = await apifyRequest(
      TOKEN,
      { method: "POST", path: "/v2/users/me" },
      { fetchImpl: boom, baseUrl: FAKE_BASE_URL }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApifyError)
    expect((err as ApifyError).code).toBe("network")
    expect(String((err as Error).message)).not.toContain("apify.test")
    expect(JSON.stringify(err)).not.toContain(TOKEN)
    expect((err as Error).cause).toBeUndefined()
  })

  it("thân phản hồi quá lớn → response_too_large; JSON hỏng → invalid_response; raw trả nguyên mảng", async () => {
    const big: FetchLike = async () =>
      new Response("[" + '"x",'.repeat(2000) + '"x"]', { status: 200 })
    await expect(
      apifyRequest(
        TOKEN,
        {
          method: "GET",
          path: "/v2/datasets/d1/items",
          raw: true,
          maxBytes: 1000,
        },
        { fetchImpl: big, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({ code: "response_too_large" })
    const broken: FetchLike = async () => new Response("{oops", { status: 200 })
    await expect(
      apifyRequest(
        TOKEN,
        { method: "GET", path: "/v2/users/me" },
        { fetchImpl: broken, baseUrl: FAKE_BASE_URL }
      )
    ).rejects.toMatchObject({
      code: "invalid_response",
    })
    const arr: FetchLike = async () => respond(200, [{ data: 1 }])
    const res = await apifyRequest<unknown[]>(
      TOKEN,
      { method: "GET", path: "/v2/datasets/d1/items", raw: true },
      { fetchImpl: arr, baseUrl: FAKE_BASE_URL }
    )
    expect(res.data).toEqual([{ data: 1 }])
  })
})

describe("deadline của lời gọi", () => {
  it("clampToDeadline: cắt theo thời gian còn lại, tối thiểu 1 s; không có deadline → giữ nguyên", async () => {
    const { clampToDeadline } = await import("./client")
    expect(clampToDeadline(15_000, undefined)).toBe(15_000)
    const left = clampToDeadline(15_000, Date.now() + 4_000)
    expect(left).toBeGreaterThan(3_500)
    expect(left).toBeLessThanOrEqual(4_000)
    expect(clampToDeadline(15_000, Date.now() - 10_000)).toBe(1_000)
  })

  it("timeout của mỗi lần thử bị cắt theo deadline (không đợi đủ timeoutMs)", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    const started = Date.now()
    await expect(
      apifyRequest(TOKEN, { method: "GET", path: "/v2/users/me" }, { fetchImpl: hang, baseUrl: FAKE_BASE_URL, timeoutMs: 30_000, deadline: Date.now() + 200 })
    ).rejects.toMatchObject({ code: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})
