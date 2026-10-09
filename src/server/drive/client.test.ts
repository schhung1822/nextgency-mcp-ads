// Drive / Sheets request helper: Google error → DriveError (each reason, api_key vs service account), API key only
// as `key=` (never an Authorization header), bearer token + one refresh on 401, resource-key header, retries only
// for JSON calls (429 / 403 rate limit / 5xx), redirects limited to Google hosts, timeouts, no secret in errors.
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  __clearGoogleTokenCache,
  GoogleAuthError,
} from "../google/service-account"
import {
  googleError,
  hangUntilAborted,
  isToken,
  json,
  keyAuth,
  mockGoogleFetch,
  saAuth,
  streamResponse,
  TEST_API_KEY,
} from "./__fixtures__/google-fetch"
import {
  __setDriveRetryBaseMs,
  DRIVE_API_BASE,
  driveJson,
  driveStream,
  isAllowedGoogleHost,
  isGoogleAuthHost,
  mapGoogleError,
  resourceKeysHeader,
  toDriveError,
} from "./client"
import { DriveError } from "./errors"

const URL_FILES = `${DRIVE_API_BASE}/files/abc1234567890`
const req = (over: Partial<Parameters<typeof driveJson>[1]> = {}) => ({
  url: URL_FILES,
  timeoutMs: 5_000,
  ...over,
})

async function driveErr(p: Promise<unknown>): Promise<DriveError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(DriveError)
  return e as DriveError
}

beforeEach(() => {
  __clearGoogleTokenCache()
  __setDriveRetryBaseMs(1)
})
afterEach(() => __setDriveRetryBaseMs(1_000))

describe("mapGoogleError", () => {
  const sa = { type: "service_account" } as const
  const key = { type: "api_key" } as const
  const body = (
    status: number,
    reason: string | null,
    o: { message?: string; status?: string; details?: string[] } = {}
  ) =>
    ({
      error: {
        code: status,
        message: o.message ?? "x",
        status: o.status,
        errors: reason ? [{ reason }] : [],
        details: (o.details ?? []).map((r) => ({ reason: r })),
      },
    }) as const

  it.each([
    [404, "notFound", sa, "not_found"],
    [404, "notFound", key, "not_public"],
    [403, "insufficientFilePermissions", sa, "permission_denied"],
    [403, "insufficientFilePermissions", key, "not_public"],
    [403, "forbidden", sa, "permission_denied"],
    [403, "fileNotDownloadable", sa, "not_downloadable"],
    [403, "cannotDownloadAbusiveFile", sa, "abusive_file"],
    [403, "abuse", key, "abusive_file"],
    [403, "rateLimitExceeded", sa, "rate_limited"],
    [403, "userRateLimitExceeded", sa, "rate_limited"],
    [429, null, sa, "rate_limited"],
    [403, "accessNotConfigured", sa, "api_disabled"],
    [400, "keyInvalid", key, "api_key_invalid"],
    [401, null, sa, "auth_failed"],
    [401, null, key, "not_public"],
    [416, null, sa, "range_not_satisfiable"],
    [500, null, sa, "upstream_error"],
    [400, "invalid", sa, "upstream_error"],
  ] as const)("%i %s (%o) → %s", (status, reason, auth, code) => {
    const e = mapGoogleError(status, body(status, reason), auth)
    expect(e.code).toBe(code)
    expect(e.httpStatus).toBe(status)
  })

  it("lỗi dạng google.rpc (status / details.reason) và thông điệp 'API key not valid'", () => {
    expect(
      mapGoogleError(
        403,
        body(403, null, {
          status: "PERMISSION_DENIED",
          details: ["SERVICE_DISABLED"],
        }),
        sa
      ).code
    ).toBe("api_disabled")
    expect(
      mapGoogleError(
        400,
        body(400, null, {
          status: "INVALID_ARGUMENT",
          details: ["API_KEY_INVALID"],
        }),
        key
      ).code
    ).toBe("api_key_invalid")
    expect(
      mapGoogleError(
        403,
        body(403, null, { details: ["API_KEY_SERVICE_BLOCKED"] }),
        key
      ).code
    ).toBe("api_key_invalid")
    expect(
      mapGoogleError(
        400,
        body(400, "badRequest", {
          message: "API key not valid. Please pass a valid API key.",
        }),
        key
      ).code
    ).toBe("api_key_invalid")
    expect(
      mapGoogleError(429, body(429, null, { status: "RESOURCE_EXHAUSTED" }), sa)
        .code
    ).toBe("rate_limited")
    expect(mapGoogleError(404, null, sa).code).toBe("not_found")
    expect(mapGoogleError(502, "<html>", sa).retryable).toBe(true)
    expect(mapGoogleError(400, null, sa).retryable).toBe(false)
  })
})

describe("toDriveError", () => {
  it("GoogleAuthError → auth_failed / timeout / upstream_error", () => {
    const badJson = new GoogleAuthError("invalid_json", {
      userMessageVi: "Khoá hỏng",
    })
    expect(toDriveError(badJson)).toMatchObject({
      code: "auth_failed",
      userMessageVi: "Khoá hỏng",
    })
    expect(
      toDriveError(new GoogleAuthError("invalid_grant", { httpStatus: 400 }))
        .code
    ).toBe("auth_failed")
    expect(
      toDriveError(new GoogleAuthError("network", { timedOut: true })).code
    ).toBe("timeout")
    expect(toDriveError(new GoogleAuthError("network")).code).toBe(
      "upstream_error"
    )
    expect(
      toDriveError(new GoogleAuthError("upstream", { httpStatus: 503 }))
    ).toMatchObject({ code: "upstream_error", retryable: true })
    expect(toDriveError(new DOMException("x", "AbortError")).code).toBe(
      "timeout"
    )
    expect(toDriveError(new Error("boom")).code).toBe("upstream_error")
  })
})

describe("driveJson - xác thực", () => {
  it("api_key: chỉ gửi key= trong query, không có header Authorization, không xin token", async () => {
    const m = mockGoogleFetch()
    m.on(
      () => true,
      () => json({ id: "abc1234567890" })
    )
    await driveJson(keyAuth(), req({ query: { fields: "id" } }))
    const c = m.calls[0]!
    expect(c.url.searchParams.get("key")).toBe(TEST_API_KEY)
    expect(c.url.searchParams.get("fields")).toBe("id")
    expect(c.headers.authorization).toBeUndefined()
    expect(m.tokenCalls()).toHaveLength(0)
  })

  it("service account: Bearer token, không có key=", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json({ id: "x" })
    )
    await driveJson(saAuth(), req())
    const c = m.api()[0]!
    expect(c.headers.authorization).toBe("Bearer ya29.test-token-1")
    expect(c.url.searchParams.has("key")).toBe(false)
  })

  it("401 → làm mới token đúng 1 lần rồi gọi lại", async () => {
    const m = mockGoogleFetch()
    m.once(
      (c) => c.url.hostname === "www.googleapis.com",
      () => googleError(401, "authError")
    )
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => json({ ok: true })
    )
    expect(await driveJson(saAuth(), req())).toEqual({ ok: true })
    expect(m.tokenCalls()).toHaveLength(2)
    expect(m.api().map((c) => c.headers.authorization)).toEqual([
      "Bearer ya29.test-token-1",
      "Bearer ya29.test-token-2",
    ])
  })

  it("401 hai lần → auth_failed", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => googleError(401, "authError")
    )
    expect((await driveErr(driveJson(saAuth(), req()))).code).toBe(
      "auth_failed"
    )
    expect(m.api()).toHaveLength(2)
  })

  it("header X-Goog-Drive-Resource-Keys", async () => {
    const m = mockGoogleFetch()
    m.on(
      () => true,
      () => json({})
    )
    await driveJson(
      keyAuth(),
      req({
        resourceKeys: [
          { id: "abc1234567890", key: "0-rk" },
          { id: "zzz", key: null },
        ],
      })
    )
    expect(m.calls[0]!.headers["x-goog-drive-resource-keys"]).toBe(
      "abc1234567890/0-rk"
    )
    expect(resourceKeysHeader([{ id: "a", key: undefined }])).toBeNull()
  })

  it("chỉ gọi host cố định", async () => {
    mockGoogleFetch()
    expect(
      (
        await driveErr(
          driveJson(
            keyAuth(),
            req({ url: "https://evil.example.com/drive/v3/files" })
          )
        )
      ).code
    ).toBe("upstream_error")
    expect(
      (
        await driveErr(
          driveJson(
            keyAuth(),
            req({ url: "http://www.googleapis.com/drive/v3/files" })
          )
        )
      ).code
    ).toBe("upstream_error")
    expect(isAllowedGoogleHost("lh3.googleusercontent.com")).toBe(true)
    expect(isAllowedGoogleHost("googleusercontent.com.evil.com")).toBe(false)
    expect(isAllowedGoogleHost(".googleusercontent.com")).toBe(false)
  })
})

describe("driveJson - thử lại", () => {
  it.each([
    ["429", () => googleError(429, "rateLimitExceeded")],
    [
      "403 userRateLimitExceeded",
      () => googleError(403, "userRateLimitExceeded"),
    ],
    ["503", () => json({}, 503)],
  ])("%s → thử lại rồi thành công", async (_, fail) => {
    const m = mockGoogleFetch()
    m.once(() => true, fail)
    m.once(() => true, fail)
    m.on(
      () => true,
      () => json({ ok: 1 })
    )
    expect(await driveJson(keyAuth(), req())).toEqual({ ok: 1 })
    expect(m.calls).toHaveLength(3)
  })

  it("tối đa 2 lần thử lại → rate_limited", async () => {
    const m = mockGoogleFetch()
    m.on(
      () => true,
      () => googleError(429, "rateLimitExceeded")
    )
    expect((await driveErr(driveJson(keyAuth(), req()))).code).toBe(
      "rate_limited"
    )
    expect(m.calls).toHaveLength(3)
  })

  it("không thử lại 404 / 403 quyền / retries: 0", async () => {
    const m = mockGoogleFetch()
    m.once(
      (c) => !isToken(c),
      () => googleError(404, "notFound")
    )
    m.once(
      (c) => !isToken(c),
      () => googleError(403, "insufficientFilePermissions")
    )
    m.once(
      (c) => !isToken(c),
      () => json({}, 503)
    )
    expect((await driveErr(driveJson(saAuth(), req()))).code).toBe("not_found")
    expect((await driveErr(driveJson(saAuth(), req()))).code).toBe(
      "permission_denied"
    )
    expect(
      (await driveErr(driveJson(saAuth(), req({ retries: 0 })))).code
    ).toBe("upstream_error")
    expect(m.api()).toHaveLength(3)
  })
})

describe("driveJson - chuyển hướng, thời gian chờ, bí mật", () => {
  it("theo chuyển hướng tới host Google (≤ 3)", async () => {
    const m = mockGoogleFetch()
    m.once(
      (c) => c.url.pathname.endsWith("abc1234567890"),
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://www.googleapis.com/drive/v3/files/other123456",
          },
        })
    )
    m.on(
      (c) => c.url.pathname.endsWith("other123456"),
      () => json({ moved: true })
    )
    expect(await driveJson(keyAuth(), req())).toEqual({ moved: true })
  })

  it("chuyển hướng ra ngoài Google → dừng, không gửi token tới host lạ", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/steal" },
        })
    )
    const e = await driveErr(driveJson(saAuth(), req()))
    expect(e.code).toBe("upstream_error")
    expect(m.calls.some((c) => c.url.hostname === "attacker.example")).toBe(
      false
    )
  })

  it("L5: chuyển hướng tới host googleusercontent không ghim → bỏ Authorization + resource key", async () => {
    const m = mockGoogleFetch()
    m.once(
      (c) => c.url.hostname === "www.googleapis.com",
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://doc-0s-9c-docs.googleusercontent.com/x/y",
          },
        })
    )
    m.on(
      (c) => c.url.hostname === "doc-0s-9c-docs.googleusercontent.com",
      () => json({ moved: true })
    )
    expect(
      await driveJson(
        saAuth(),
        req({ resourceKeys: [{ id: "abc1234567890", key: "0-rk" }] })
      )
    ).toEqual({ moved: true })
    const [first, second] = m.api()
    expect(first!.headers.authorization).toBe("Bearer ya29.test-token-1")
    expect(first!.headers["x-goog-drive-resource-keys"]).toBe(
      "abc1234567890/0-rk"
    )
    expect(second!.url.hostname).toBe("doc-0s-9c-docs.googleusercontent.com")
    expect(second!.headers.authorization).toBeUndefined()
    expect(second!.headers["x-goog-drive-resource-keys"]).toBeUndefined()
  })

  it("L5: Authorization chỉ gửi tới host ghim (API + lh3–lh6 / drive-thirdparty); host khác không xin token", async () => {
    expect(isGoogleAuthHost("www.googleapis.com")).toBe(true)
    expect(isGoogleAuthHost("sheets.googleapis.com")).toBe(true)
    expect(isGoogleAuthHost("LH3.googleusercontent.com")).toBe(true)
    expect(isGoogleAuthHost("lh6.googleusercontent.com")).toBe(true)
    expect(isGoogleAuthHost("drive-thirdparty.googleusercontent.com")).toBe(
      true
    )
    expect(isGoogleAuthHost("lh7.googleusercontent.com")).toBe(false)
    expect(isGoogleAuthHost("attacker.googleusercontent.com")).toBe(false)
    expect(isGoogleAuthHost("oauth2.googleapis.com")).toBe(false)

    const m = mockGoogleFetch()
    m.on(
      (c) => !isToken(c),
      () => json({ ok: 1 })
    )
    await driveJson(
      saAuth(),
      req({ url: "https://someone.googleusercontent.com/p" })
    )
    expect(m.api()[0]!.headers.authorization).toBeUndefined()
    expect(m.tokenCalls()).toHaveLength(0)
    await driveJson(
      saAuth(),
      req({ url: "https://lh3.googleusercontent.com/p" })
    )
    expect(m.api()[1]!.headers.authorization).toMatch(/^Bearer /)
  })

  it("quá 3 lần chuyển hướng → lỗi", async () => {
    const m = mockGoogleFetch()
    m.on(
      () => true,
      (c) =>
        new Response(null, {
          status: 307,
          headers: { location: `${c.url.origin}${c.url.pathname}x` },
        })
    )
    expect((await driveErr(driveJson(keyAuth(), req()))).code).toBe(
      "upstream_error"
    )
    expect(m.calls).toHaveLength(4)
  })

  it("hết thời gian chờ → timeout", async () => {
    const m = mockGoogleFetch()
    m.on(() => true, hangUntilAborted)
    expect(
      (await driveErr(driveJson(keyAuth(), req({ timeoutMs: 30 })))).code
    ).toBe("timeout")
  })

  it("signal của người gọi bị huỷ → timeout", async () => {
    const m = mockGoogleFetch()
    m.on(() => true, hangUntilAborted)
    const ac = new AbortController()
    const p = driveJson(keyAuth(), req({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 10)
    expect((await driveErr(p)).code).toBe("timeout")
  })

  it("lỗi không chứa API key, token hay URL", async () => {
    const m = mockGoogleFetch()
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () =>
        googleError(400, "keyInvalid", {
          message: `API key not valid ${TEST_API_KEY}`,
        })
    )
    for (const auth of [keyAuth(), saAuth()]) {
      const e = await driveErr(
        driveJson(
          auth,
          req({ resourceKeys: [{ id: "abc1234567890", key: "0-secretrk" }] })
        )
      )
      const dump = `${e.message} ${e.userMessageVi} ${e.hintVi} ${JSON.stringify(e)} ${String(e.cause ?? "")}`
      expect(dump).not.toContain(TEST_API_KEY)
      expect(dump).not.toContain("ya29.")
      expect(dump).not.toContain("0-secretrk")
      expect(dump).not.toContain("googleapis.com")
    }
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => {
        throw new TypeError(`fetch failed ${URL_FILES}?key=${TEST_API_KEY}`)
      }
    )
    const e = await driveErr(driveJson(keyAuth(), req()))
    expect(e.code).toBe("upstream_error")
    expect(`${e.message} ${String(e.cause ?? "")}`).not.toContain(TEST_API_KEY)
  })
})

describe("driveStream", () => {
  it("không thử lại (503 → 1 lượt), lỗi được map", async () => {
    const m = mockGoogleFetch()
    m.on(
      () => true,
      () => json({}, 503)
    )
    expect((await driveErr(driveStream(keyAuth(), req()))).code).toBe(
      "upstream_error"
    )
    expect(m.calls).toHaveLength(1)
  })

  it("401 → làm mới token 1 lần", async () => {
    const m = mockGoogleFetch()
    m.once(
      (c) => c.url.hostname === "www.googleapis.com",
      () => googleError(401, null)
    )
    m.on(
      (c) => c.url.hostname === "www.googleapis.com",
      () => streamResponse([new Uint8Array([1, 2])])
    )
    const r = await driveStream(saAuth(), req())
    expect(Buffer.from(await new Response(r.body).arrayBuffer())).toEqual(
      Buffer.from([1, 2])
    )
    expect(m.tokenCalls()).toHaveLength(2)
  })

  it("im lặng quá idleMs giữa 2 phần → stream lỗi timeout, request gốc bị huỷ", async () => {
    const m = mockGoogleFetch()
    let upstream: AbortSignal | null = null
    m.on(
      () => true,
      (c) => {
        upstream = c.signal
        let sent = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(ctl) {
              if (!sent) {
                sent = true
                ctl.enqueue(new Uint8Array([1]))
              }
              // then never another chunk
              return new Promise(() => {})
            },
          })
        )
      }
    )
    const r = await driveStream(keyAuth(), req(), 30)
    const reader = r.body.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    const e = await reader.read().then(
      () => null,
      (x: unknown) => x
    )
    expect(e).toBeInstanceOf(DriveError)
    expect((e as DriveError).code).toBe("timeout")
    expect(upstream!.aborted).toBe(true)
  })

  it("người nhận huỷ stream → request gốc bị huỷ", async () => {
    const m = mockGoogleFetch()
    let upstream: AbortSignal | null = null
    m.on(
      () => true,
      (c) => {
        upstream = c.signal
        return new Response(
          new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
        )
      }
    )
    const r = await driveStream(keyAuth(), req())
    await r.body.cancel()
    expect(upstream!.aborted).toBe(true)
  })
})
