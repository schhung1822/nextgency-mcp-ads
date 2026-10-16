import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { advertisablePages, metaLookup } from "./lookup"
import { forgetPageTokens } from "./pages"
import { graphError, json, mockGraph, providerCtx, type Route } from "./test-utils"

beforeEach(() => __resetBuckets())

describe("metaLookup", () => {
  it("interests: /search?type=adinterest, requires q", async () => {
    const m = mockGraph([
      [
        "GET",
        "search",
        () =>
          json({
            data: [
              { id: "6003139266461", name: "Thời trang", audience_size_lower_bound: 1000000, audience_size_upper_bound: 1200000, path: ["Mua sắm", "Thời trang"] },
            ],
          }),
      ],
    ])
    await expect(metaLookup(providerCtx(), "interests", {})).rejects.toMatchObject({ code: "invalid_request" })
    const res = await metaLookup(providerCtx(), "interests", { q: "thời trang", limit: 10 })
    expect(m.calls[0].params).toMatchObject({ type: "adinterest", q: "thời trang", limit: "10" })
    expect(res.items[0]).toMatchObject({ id: "6003139266461", name: "Thời trang", extra: { audienceSizeLowerBound: 1000000 } })
  })

  it("locations: countries use country_code, regions/cities use key", async () => {
    const m = mockGraph([
      [
        "GET",
        "search",
        () =>
          json({
            data: [
              { key: "VN", name: "Vietnam", type: "country", country_code: "VN" },
              { key: "3016", name: "Ho Chi Minh City", type: "region", country_code: "VN", country_name: "Vietnam" },
            ],
          }),
      ],
    ])
    const res = await metaLookup(providerCtx(), "locations", { q: "Ho Chi Minh" })
    expect(m.calls[0].params.type).toBe("adgeolocation")
    expect(res.items.map((i) => i.id)).toEqual(["VN", "3016"])
  })

  it("pages: promote_pages + Pages the via may advertise for (me/accounts with ADVERTISE), de-duplicated, local name filter", async () => {
    const m = mockGraph([
      ["GET", "act_1001/promote_pages", () => json({ data: [{ id: "888", name: "Shop VN" }, { id: "889", name: "Blog" }] })],
      [
        "GET",
        "me/accounts",
        () =>
          json({
            data: [
              { id: "888", name: "Shop VN", tasks: ["ADVERTISE"] },
              { id: "890", name: "Shop HN", tasks: ["ANALYZE", "ADVERTISE", "MODERATE"] },
              { id: "891", name: "Shop DN", tasks: ["MODERATE", "CREATE_CONTENT"] },
              { id: "892", name: "Shop HP" },
            ],
          }),
      ],
    ])
    const res = await metaLookup(providerCtx(), "pages", { q: "shop" })
    expect(res.items).toEqual([
      { id: "888", name: "Shop VN", extra: { category: null, isPublished: null, source: "promote_pages" } },
      { id: "890", name: "Shop HN", extra: { category: null, isPublished: null, source: "me_accounts" } },
    ])
    expect(m.calls.find((c) => c.path === "me/accounts")!.params.fields).toBe("id,name,category,is_published,tasks")
  })

  it("advertisablePages: every promote_pages entry is kept (no task needed); me/accounts only with ADVERTISE", async () => {
    mockGraph([
      ["GET", "act_1001/promote_pages", () => json({ data: [{ id: "700", name: "BM Page" }] })],
      ["GET", "me/accounts", () => json({ data: [{ id: "701", name: "Mod only", tasks: ["MODERATE"] }, { id: "702", name: "Ads", tasks: ["ADVERTISE"] }] })],
    ])
    expect((await advertisablePages(providerCtx())).map((p) => [p.id, p.source])).toEqual([
      ["700", "promote_pages"],
      ["702", "me_accounts"],
    ])
  })

  it("pages: me/accounts permission error falls back to promote_pages only", async () => {
    mockGraph([
      ["GET", "act_1001/promote_pages", () => json({ data: [{ id: "888", name: "Shop VN" }] })],
      ["GET", "me/accounts", () => graphError(200)],
    ])
    const res = await metaLookup(providerCtx(), "pages")
    expect(res.items.map((i) => i.id)).toEqual(["888"])
  })

  it("identities is TikTok-only (and never calls Meta)", async () => {
    mockGraph([])
    await expect(metaLookup(providerCtx(), "identities")).rejects.toMatchObject({ code: "unsupported" })
  })
})

describe("advertisablePages cache (D4)", () => {
  const routes = (pages: () => { id: string; name: string }[]): Route[] => [
    ["GET", "act_1001/promote_pages", () => json({ data: pages() })],
    ["GET", "me/accounts", () => json({ data: [] })],
  ]
  const pairs = (m: ReturnType<typeof mockGraph>) => m.calls.filter((c) => c.path === "act_1001/promote_pages").length

  it("2 calls within 5 minutes = 1 pair of GETs; concurrent calls share one fetch", async () => {
    const m = mockGraph([...routes(() => [{ id: "888", name: "Shop VN" }])])
    const [a, b] = await Promise.all([advertisablePages(providerCtx()), advertisablePages(providerCtx())])
    expect(a.map((p) => p.id)).toEqual(["888"])
    expect(b.map((p) => p.id)).toEqual(["888"])
    expect((await advertisablePages(providerCtx())).map((p) => p.id)).toEqual(["888"])
    expect(pairs(m)).toBe(1)
    expect(m.calls.filter((c) => c.path === "me/accounts")).toHaveLength(1)
  })

  it("fresh reads Meta again and refreshes the cache; ads_lookup kind=pages is always fresh", async () => {
    let pages = [{ id: "888", name: "Shop VN" }]
    const m = mockGraph([...routes(() => pages)])
    await advertisablePages(providerCtx())
    pages = [...pages, { id: "889", name: "Mới gán" }]
    expect((await advertisablePages(providerCtx())).map((p) => p.id)).toEqual(["888"]) // cached
    expect((await advertisablePages(providerCtx(), { fresh: true })).map((p) => p.id)).toEqual(["888", "889"])
    expect((await advertisablePages(providerCtx())).map((p) => p.id)).toEqual(["888", "889"]) // refreshed
    expect(pairs(m)).toBe(2)
    await metaLookup(providerCtx(), "pages")
    expect(pairs(m)).toBe(3)
  })

  it("another token or another ad account misses the cache; the raw token is never a cache key", async () => {
    const m = mockGraph([
      ...routes(() => [{ id: "888", name: "Shop VN" }]),
      ["GET", "act_2002/promote_pages", () => json({ data: [{ id: "999", name: "Khác" }] })],
    ])
    await advertisablePages(providerCtx())
    await advertisablePages(providerCtx({}, { accessToken: "EAAanothertoken000000000000000000" }))
    expect(pairs(m)).toBe(2)
    expect((await advertisablePages(providerCtx({ externalId: "act_2002" }))).map((p) => p.id)).toEqual(["999"])
    const state = (globalThis as unknown as { __adsMcpMetaAdvPages: { cache: { keys(): Iterable<string> } } }).__adsMcpMetaAdvPages
    for (const key of state.cache.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/)
      expect(key).not.toContain("EAA")
    }
  })

  it("errors are not cached: the next call reads Meta again", async () => {
    let fail = true
    const m = mockGraph([
      ["GET", "act_1001/promote_pages", () => (fail ? graphError(2) : json({ data: [{ id: "888", name: "Shop VN" }] }))],
      ["GET", "me/accounts", () => json({ data: [] })],
    ])
    await expect(advertisablePages(providerCtx())).rejects.toMatchObject({ code: "upstream_error" })
    fail = false
    const before = pairs(m)
    expect((await advertisablePages(providerCtx())).map((p) => p.id)).toEqual(["888"])
    expect(pairs(m)).toBe(before + 1)
  })

  it("forgetPageTokens(connection) also drops its cached Page lists", async () => {
    const m = mockGraph([...routes(() => [{ id: "888", name: "Shop VN" }])])
    await advertisablePages(providerCtx())
    forgetPageTokens("conn-1")
    await advertisablePages(providerCtx())
    expect(pairs(m)).toBe(2)
  })

  it("a cached answer cannot be mutated by a caller", async () => {
    mockGraph([...routes(() => [{ id: "888", name: "Shop VN" }])])
    const first = await advertisablePages(providerCtx())
    first.length = 0
    expect((await advertisablePages(providerCtx())).map((p) => p.id)).toEqual(["888"])
  })
})
