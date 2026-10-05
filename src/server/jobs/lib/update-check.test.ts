// GitHub release check: response parsing, tag fallback, error mapping (private repo / 401 / rate limit / timeout),
// token hygiene and note sanitising. fetch is injected, so no network and no database are involved.
import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_UPDATE_REPO,
  fetchLatestRelease,
  NOTES_MAX_CHARS,
  readUpdateSource,
  sanitizeNotes,
  UpdateCheckError,
  type UpdateSource,
} from "./update-check"

const TOKEN = "github_pat_SECRET_TOKEN_0123456789abcdef"
const NOW = new Date("2026-10-03T10:00:00Z")
const source: UpdateSource = { repo: "notivn/ads-mcp-simple", token: null }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init })
}

function release(over: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.3.0",
    name: "v1.3.0",
    body: "## Có gì mới\n- Cập nhật tự động",
    html_url: "https://github.com/notivn/ads-mcp-simple/releases/tag/v1.3.0",
    published_at: "2026-10-01T08:30:00Z",
    draft: false,
    prerelease: false,
    ...over,
  }
}

/** Routes by URL suffix: `/releases/latest` and `/tags?...`. */
function router(routes: { latest?: Response | (() => Response); tags?: Response | (() => Response) }) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    const pick = url.includes("/releases/latest") ? routes.latest : url.includes("/tags") ? routes.tags : undefined
    if (!pick) throw new Error(`unexpected url ${url}`)
    return typeof pick === "function" ? pick() : pick.clone()
  })
}

const run = (fetchImpl: typeof fetch, s: UpdateSource = source) => fetchLatestRelease({ source: s, fetchImpl, now: NOW })

describe("readUpdateSource", () => {
  it("mặc định notivn/ads-mcp-simple, không token", () => {
    expect(readUpdateSource({})).toEqual({ repo: DEFAULT_UPDATE_REPO, token: null })
    expect(DEFAULT_UPDATE_REPO).toBe("notivn/ads-mcp-simple")
  })
  it("đọc UPDATE_REPO và UPDATE_GITHUB_TOKEN, bỏ khoảng trắng", () => {
    expect(readUpdateSource({ UPDATE_REPO: " acme/app ", UPDATE_GITHUB_TOKEN: ` ${TOKEN} ` })).toEqual({ repo: "acme/app", token: TOKEN })
    expect(readUpdateSource({ UPDATE_REPO: "  ", UPDATE_GITHUB_TOKEN: " " })).toEqual({ repo: DEFAULT_UPDATE_REPO, token: null })
  })
})

describe("fetchLatestRelease - /releases/latest", () => {
  it("đọc bản phát hành mới nhất", async () => {
    const f = router({ latest: json(release()) })
    const r = await run(f as unknown as typeof fetch)
    expect(r).toEqual({
      version: "1.3.0",
      tag: "v1.3.0",
      publishedAt: "2026-10-01T08:30:00.000Z",
      notes: "## Có gì mới\n- Cập nhật tự động",
      url: "https://github.com/notivn/ads-mcp-simple/releases/tag/v1.3.0",
      checkedAt: NOW.toISOString(),
    })
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0]![0])).toBe("https://api.github.com/repos/notivn/ads-mcp-simple/releases/latest")
  })

  it("gửi header GitHub chuẩn; token chỉ nằm trong Authorization", async () => {
    const f = router({ latest: json(release()) })
    await run(f as unknown as typeof fetch, { repo: "notivn/ads-mcp-simple", token: TOKEN })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers.Accept).toBe("application/vnd.github+json")
    expect(headers["X-GitHub-Api-Version"]).toBeTruthy()
    expect(url).not.toContain(TOKEN)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("không gửi Authorization khi không có token", async () => {
    const f = router({ latest: json(release()) })
    await run(f as unknown as typeof fetch)
    const init = f.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it("url lạ (không phải github.com) bị thay bằng url chuẩn của tag", async () => {
    const f = router({ latest: json(release({ html_url: "https://evil.example/phish" })) })
    expect((await run(f as unknown as typeof fetch)).url).toBe("https://github.com/notivn/ads-mcp-simple/releases/tag/v1.3.0")
  })

  it("published_at hỏng -> null; body null -> ghi chú rỗng", async () => {
    const f = router({ latest: json(release({ published_at: "không phải ngày", body: null })) })
    const r = await run(f as unknown as typeof fetch)
    expect(r.publishedAt).toBeNull()
    expect(r.notes).toBe("")
  })

  it("release nháp/pre-release hoặc tag lạ -> rơi về danh sách tag", async () => {
    for (const latest of [json(release({ prerelease: true })), json(release({ draft: true })), json(release({ tag_name: "nightly" }))]) {
      const f = router({ latest, tags: json([{ name: "v1.4.0" }, { name: "v1.10.0" }, { name: "v2.0.0-rc1" }]) })
      const r = await run(f as unknown as typeof fetch)
      expect(r.version).toBe("1.10.0")
    }
  })

  it("ghi chú bị cắt ở 4000 ký tự và bỏ ký tự điều khiển", async () => {
    const f = router({ latest: json(release({ body: `a\u0000b\r\n${"x".repeat(5000)}` })) })
    const r = await run(f as unknown as typeof fetch)
    expect(r.notes.length).toBeLessThanOrEqual(NOTES_MAX_CHARS)
    expect(r.notes.startsWith("ab\nxxx")).toBe(true)
    expect(r.notes.endsWith("…")).toBe(true)
  })

  it("trả về lỗi bad_response khi JSON sai hình dạng", async () => {
    const f = router({ latest: json({ message: "lạ" }) })
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ code: "bad_response" })
    const g = router({ latest: new Response("<html>", { status: 200 }) })
    await expect(run(g as unknown as typeof fetch)).rejects.toMatchObject({ code: "bad_response" })
  })
})

describe("fetchLatestRelease - /tags (không có release)", () => {
  it("404 ở /releases/latest -> lấy tag semver cao nhất, bỏ tag lạ", async () => {
    const f = router({
      latest: new Response("{}", { status: 404 }),
      tags: json([{ name: "v1.9.0" }, { name: "v1.10.2" }, { name: "dev" }, { name: "1.99.0" }, { name: "v1.10.2-rc1" }]),
    })
    const r = await run(f as unknown as typeof fetch)
    expect(r).toMatchObject({
      version: "1.10.2",
      tag: "v1.10.2",
      notes: "",
      publishedAt: null,
      url: "https://github.com/notivn/ads-mcp-simple/releases/tag/v1.10.2",
    })
    expect(String(f.mock.calls[1]![0])).toContain("/tags?per_page=100")
  })

  it("không có tag hợp lệ -> no_release", async () => {
    const f = router({ latest: new Response("{}", { status: 404 }), tags: json([{ name: "main" }, { name: "v1.0.0-beta" }]) })
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ code: "no_release" })
    const g = router({ latest: new Response("{}", { status: 404 }), tags: json([]) })
    await expect(run(g as unknown as typeof fetch)).rejects.toMatchObject({ code: "no_release" })
  })

  it("kho riêng tư không token (404 cả hai) -> no_release, thông báo nhắc UPDATE_GITHUB_TOKEN", async () => {
    const f = router({ latest: new Response("{}", { status: 404 }), tags: new Response("{}", { status: 404 }) })
    const err = await run(f as unknown as typeof fetch).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpdateCheckError)
    expect((err as UpdateCheckError).code).toBe("no_release")
    expect((err as UpdateCheckError).message).toContain("UPDATE_GITHUB_TOKEN")
  })
})

describe("fetchLatestRelease - lỗi GitHub", () => {
  const cases: [string, Response, string][] = [
    ["401 token sai/hết hạn", new Response("{}", { status: 401 }), "unauthorized"],
    ["403 hết lượt (x-ratelimit-remaining: 0)", new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate_limited"],
    ["403 có retry-after (secondary limit)", new Response("{}", { status: 403, headers: { "retry-after": "60" } }), "rate_limited"],
    ["403 thân thư báo rate limit", new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4" }), { status: 403 }), "rate_limited"],
    ["429", new Response("{}", { status: 429 }), "rate_limited"],
    ["403 không đủ quyền", new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }), "forbidden"],
    ["500", new Response("oops", { status: 500 }), "unavailable"],
    ["503", new Response("oops", { status: 503 }), "unavailable"],
  ]
  it.each(cases)("%s", async (_name, res, code) => {
    const f = router({ latest: res })
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ name: "UpdateCheckError", code })
  })

  it("rate limit có x-ratelimit-reset -> thông báo nêu thời gian chờ", async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 25 * 60
    const f = router({ latest: new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }) })
    const err = (await run(f as unknown as typeof fetch).catch((e: unknown) => e)) as UpdateCheckError
    expect(err.code).toBe("rate_limited")
    expect(err.message).toContain("25 phút")
  })

  it("lỗi 5xx ở /tags sau khi /releases/latest là 404", async () => {
    const f = router({ latest: new Response("{}", { status: 404 }), tags: new Response("x", { status: 502 }) })
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ code: "unavailable" })
  })

  it("lỗi mạng -> network; hết giờ -> timeout", async () => {
    const net = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    await expect(run(net as unknown as typeof fetch)).rejects.toMatchObject({ code: "network" })
    const slow = vi.fn(async (_u: unknown, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
      return json(release())
    })
    await expect(
      fetchLatestRelease({ source, fetchImpl: slow as unknown as typeof fetch, timeoutMs: 20, now: NOW })
    ).rejects.toMatchObject({ code: "timeout" })
  })

  it("repo sai định dạng bị từ chối trước khi gọi mạng", async () => {
    const f = vi.fn()
    for (const repo of ["../etc/passwd", "a/b/c", "noslash", "a b/c", "a/b?x=1", "a/b#", "../..", "./.", "a/..", "../b"]) {
      await expect(fetchLatestRelease({ source: { repo, token: TOKEN }, fetchImpl: f as unknown as typeof fetch })).rejects.toMatchObject({ code: "bad_repo" })
    }
    expect(f).not.toHaveBeenCalled()
  })

  it("token không bao giờ xuất hiện trong thông điệp lỗi hay dữ liệu trả về", async () => {
    const withToken = { repo: "notivn/ads-mcp-simple", token: TOKEN }
    const failures = [
      new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 }),
      new Response(JSON.stringify({ message: `rate limit ${TOKEN}` }), { status: 403 }),
      new Response(`boom ${TOKEN}`, { status: 500 }),
    ]
    for (const res of failures) {
      const err = (await run(router({ latest: res }) as unknown as typeof fetch, withToken).catch((e: unknown) => e)) as Error
      expect(err.message).not.toContain(TOKEN)
      expect(JSON.stringify(err)).not.toContain(TOKEN)
      expect(String(err.stack)).not.toContain(TOKEN)
    }
    const netErr = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED Authorization: Bearer ${TOKEN}`)
    })
    const e2 = (await run(netErr as unknown as typeof fetch, withToken).catch((e: unknown) => e)) as Error
    expect(e2.message).not.toContain(TOKEN)
    const ok = await run(router({ latest: json(release({ body: "ghi chú bình thường" })) }) as unknown as typeof fetch, withToken)
    expect(JSON.stringify(ok)).not.toContain(TOKEN)
  })
})

describe("fetchLatestRelease - chuyển hướng (redirect)", () => {
  const redirect = (location: string, status = 301) => new Response(null, { status, headers: { location } })
  const withToken = { repo: "notivn/ads-mcp-simple", token: TOKEN }

  it("301 sang api.github.com (repo đổi tên) được theo, vẫn gửi token, không để fetch tự theo", async () => {
    const moved = "https://api.github.com/repositories/1/releases/latest"
    const f = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input) === moved ? json(release()) : redirect(moved)
    )
    const r = await run(f as unknown as typeof fetch, withToken)
    expect(r.version).toBe("1.3.0")
    expect(f).toHaveBeenCalledTimes(2)
    const [url2, init2] = f.mock.calls[1] as unknown as [string, RequestInit]
    expect(url2).toBe(moved)
    expect((init2.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    for (const [, init] of f.mock.calls as unknown as [string, RequestInit][]) expect(init.redirect).toBe("manual")
  })

  it("302 sang tên miền khác -> unavailable, không gọi tiếp (token không rời api.github.com)", async () => {
    const f = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => redirect("https://evil.example/", 302))
    await expect(run(f as unknown as typeof fetch, withToken)).rejects.toMatchObject({ name: "UpdateCheckError", code: "unavailable" })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("quá 2 lần chuyển hướng -> unavailable", async () => {
    let n = 0
    const f = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => redirect(`https://api.github.com/repositories/1/hop${++n}`))
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ code: "unavailable" })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it("3xx không có Location hoặc Location hỏng -> unavailable", async () => {
    const none = vi.fn(async () => new Response(null, { status: 307 }))
    await expect(run(none as unknown as typeof fetch)).rejects.toMatchObject({ code: "unavailable" })
    const bad = vi.fn(async () => redirect("http://[::1"))
    await expect(run(bad as unknown as typeof fetch)).rejects.toMatchObject({ code: "unavailable" })
    expect(bad).toHaveBeenCalledTimes(1)
  })
})

describe("fetchLatestRelease - kích thước phản hồi", () => {
  it("phản hồi quá lớn bị coi là dữ liệu không đọc được", async () => {
    const big = JSON.stringify(release({ body: "x".repeat(1_200_000) }))
    const f = router({ latest: new Response(big, { status: 200, headers: { "content-type": "application/json" } }) })
    await expect(run(f as unknown as typeof fetch)).rejects.toMatchObject({ code: "bad_response" })
    const g = router({ latest: new Response("{}", { status: 200, headers: { "content-length": "5000000" } }) })
    await expect(run(g as unknown as typeof fetch)).rejects.toMatchObject({ code: "bad_response" })
  })
})

describe("sanitizeNotes", () => {
  it("bỏ ký tự đảo chiều văn bản và ký tự rộng bằng không", () => {
    expect(sanitizeNotes("a\u202Eb\u200Bc\u2066d\uFEFFe")).toBe("abcde")
  })
  it("chuẩn hoá xuống dòng và giữ nguyên chữ có dấu", () => {
    expect(sanitizeNotes("  Dòng 1\r\nDòng 2\rDòng 3  ")).toBe("Dòng 1\nDòng 2\nDòng 3")
  })
  it("không cắt đôi cặp surrogate ở ranh giới", () => {
    const s = "a".repeat(NOTES_MAX_CHARS - 2) + "😀😀"
    const out = sanitizeNotes(s)
    expect(out.length).toBeLessThanOrEqual(NOTES_MAX_CHARS)
    expect(() => encodeURIComponent(out)).not.toThrow() // a lone surrogate would throw URIError
  })
  it("giữ nguyên HTML dưới dạng chữ (UI sẽ escape khi hiển thị)", () => {
    expect(sanitizeNotes("<script>alert(1)</script>")).toBe("<script>alert(1)</script>")
  })
  it("null/undefined -> chuỗi rỗng", () => {
    expect(sanitizeNotes(null)).toBe("")
    expect(sanitizeNotes(undefined)).toBe("")
  })
})
