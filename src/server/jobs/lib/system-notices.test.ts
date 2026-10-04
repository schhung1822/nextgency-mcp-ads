import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  DEFAULT_NOTICES_URL,
  fetchSystemNotices,
  nextStoredNotices,
  NOTICES_MAX_BYTES,
  NOTICES_STALE_MS,
  readNoticesUrl,
  type StoredNotices,
} from "./system-notices"

const URL_ = "https://notices.example.test/hook"

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("readNoticesUrl (SYSTEM_NOTICES_URL)", () => {
  it("unset → the noti.vn webhook", () => {
    expect(readNoticesUrl({})).toBe(DEFAULT_NOTICES_URL)
  })
  it("empty / off / false / 0 → disabled", () => {
    for (const v of ["", " ", "off", "OFF", "false", "0", "disabled"])
      expect(readNoticesUrl({ SYSTEM_NOTICES_URL: v })).toBeNull()
  })
  it("only absolute https URLs without credentials", () => {
    expect(readNoticesUrl({ SYSTEM_NOTICES_URL: URL_ })).toBe(URL_)
    for (const v of [
      "http://x.test/h",
      "file:///etc/passwd",
      "https://u:p@x.test/h",
      "not a url",
      "javascript:alert(1)",
    ]) {
      expect(readNoticesUrl({ SYSTEM_NOTICES_URL: v })).toBeNull()
    }
  })
})

describe("fetchSystemNotices (never throws)", () => {
  it("GETs the URL once (no redirects) and parses the rows", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await fetchSystemNotices({
      url: URL_,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({ Id: 1, content: "Test", status: "on" })
      }) as unknown as typeof fetch,
    })
    expect(r).toEqual({ ok: true, items: [{ id: "n-1", content: "Test" }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe("GET")
    expect(calls[0]!.init.redirect).toBe("error")
  })

  it("disabled → no request at all", async () => {
    let called = false
    const r = await fetchSystemNotices({
      url: null,
      fetchImpl: (async () => {
        called = true
        return jsonResponse({})
      }) as unknown as typeof fetch,
    })
    expect(r).toEqual({ ok: false, code: "disabled" })
    expect(called).toBe(false)
  })

  it("204 / 404 / empty body → success with no notice", async () => {
    for (const res of [
      new Response(null, { status: 204 }),
      new Response("nope", { status: 404 }),
      jsonResponse(""),
    ]) {
      expect(
        await fetchSystemNotices({
          url: URL_,
          fetchImpl: (async () => res) as unknown as typeof fetch,
        })
      ).toEqual({ ok: true, items: [] })
    }
  })

  it("maps failures: HTTP 500, invalid JSON, oversized body, network error, timeout", async () => {
    const f = (impl: () => Promise<Response>) =>
      fetchSystemNotices({
        url: URL_,
        timeoutMs: 50,
        fetchImpl: impl as unknown as typeof fetch,
      })
    expect(await f(async () => new Response("x", { status: 500 }))).toEqual({
      ok: false,
      code: "http",
      status: 500,
    })
    expect(await f(async () => jsonResponse("{not json"))).toEqual({
      ok: false,
      code: "bad_response",
    })
    expect(
      await f(async () => jsonResponse("x".repeat(NOTICES_MAX_BYTES + 10)))
    ).toEqual({ ok: false, code: "too_large" })
    expect(
      await f(async () => {
        throw new TypeError("fetch failed")
      })
    ).toEqual({ ok: false, code: "network" })
    const slow = await fetchSystemNotices({
      url: URL_,
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          )
        })) as unknown as typeof fetch,
    })
    expect(slow).toEqual({ ok: false, code: "timeout" })
  })

  it("a webhook that sends headers then never finishes the body times out too (the job cannot hang)", async () => {
    const r = await fetchSystemNotices({
      url: URL_,
      timeoutMs: 30,
      fetchImpl: ((_u: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"content":'))
            init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
          },
        })
        return Promise.resolve(new Response(body, { status: 200 }))
      }) as unknown as typeof fetch,
    })
    expect(r).toEqual({ ok: false, code: "timeout" })
  })

  it("an HTML error page with status 200 (proxy in front of a dead webhook) is rejected, not shown", async () => {
    const r = await fetchSystemNotices({
      url: URL_,
      fetchImpl: (async () => new Response("<html>502 Bad Gateway</html>", { status: 200 })) as unknown as typeof fetch,
    })
    expect(r).toEqual({ ok: false, code: "bad_response" })
  })
})

describe("nextStoredNotices (what stays visible)", () => {
  const now = new Date("2026-10-04T10:00:00Z")
  const prev: StoredNotices = {
    items: [{ id: "n-1", content: "Cũ" }],
    fetchedAt: "2026-10-04T09:00:00Z",
    lastSuccessAt: "2026-10-04T09:00:00Z",
    error: null,
  }

  it("a success replaces the list; an empty success clears it", () => {
    expect(
      nextStoredNotices(
        prev,
        { ok: true, items: [{ id: "n-2", content: "Mới" }] },
        now
      ).items
    ).toEqual([{ id: "n-2", content: "Mới" }])
    const cleared = nextStoredNotices(prev, { ok: true, items: [] }, now)
    expect(cleared.items).toEqual([])
    expect(cleared.lastSuccessAt).toBe(now.toISOString())
  })

  it("a failure keeps the last good list (with the error) while it is younger than 24 h", () => {
    const kept = nextStoredNotices(
      prev,
      { ok: false, code: "http", status: 502 },
      now
    )
    expect(kept.items).toEqual(prev.items)
    expect(kept.error).toBe("http_502")
    expect(kept.lastSuccessAt).toBe(prev.lastSuccessAt)
  })

  it("after 24 h of failures the old notices are hidden", () => {
    const later = new Date(
      Date.parse(prev.lastSuccessAt!) + NOTICES_STALE_MS + 1
    )
    expect(
      nextStoredNotices(prev, { ok: false, code: "timeout" }, later).items
    ).toEqual([])
    expect(
      nextStoredNotices(null, { ok: false, code: "network" }, now).items
    ).toEqual([])
  })

  it("disabled clears everything", () => {
    expect(
      nextStoredNotices(prev, { ok: false, code: "disabled" }, now)
    ).toMatchObject({ items: [], lastSuccessAt: null })
  })
})

// --- real Postgres: fetch → app_settings → cached read ------------------------------------------
const hasDb = !!process.env.DATABASE_URL

describe.skipIf(!hasDb)("runNoticesFetch + getActiveNotices (DB)", () => {
  let saved: StoredNotices | null = null
  let mod: typeof import("./system-notices")
  const envBefore = process.env.SYSTEM_NOTICES_URL

  beforeAll(async () => {
    mod = await import("./system-notices")
    saved = await mod.readStoredNotices()
    process.env.SYSTEM_NOTICES_URL = URL_
  })
  afterAll(async () => {
    // put back whatever the dev database had (the web app may be showing it)
    const { db } = await import("@/server/db/client")
    const { appSettings } = await import("@/server/db/schema")
    const { eq } = await import("drizzle-orm")
    if (saved) await mod.writeStoredNotices(db, saved)
    else
      await db
        .delete(appSettings)
        .where(eq(appSettings.key, mod.SYSTEM_NOTICES_KEY))
    mod.resetNoticesCache()
    process.env.SYSTEM_NOTICES_URL = envBefore
  })

  it("stores the fetched notices and serves them from the cache; a later failure keeps them", async () => {
    const ok = async () =>
      jsonResponse([{ Id: 1, content: "Bảo trì lúc 22h", status: "on" }])
    const first = await mod.runNoticesFetch({
      url: URL_,
      fetchImpl: ok as unknown as typeof fetch,
    })
    expect(first.stored.items).toEqual([
      { id: "n-1", content: "Bảo trì lúc 22h" },
    ])
    expect(await mod.getActiveNotices()).toEqual(first.stored.items)

    const failing = async () => new Response("down", { status: 503 })
    const second = await mod.runNoticesFetch({
      url: URL_,
      fetchImpl: failing as unknown as typeof fetch,
    })
    expect(second.result).toEqual({ ok: false, code: "http", status: 503 })
    expect((await mod.readStoredNotices())?.items).toEqual(first.stored.items)
  })

  it("SYSTEM_NOTICES_URL disabled → nothing is shown even if rows are stored", async () => {
    process.env.SYSTEM_NOTICES_URL = "off"
    try {
      mod.resetNoticesCache()
      expect(await mod.getActiveNotices()).toEqual([])
    } finally {
      process.env.SYSTEM_NOTICES_URL = URL_
    }
  })
})
