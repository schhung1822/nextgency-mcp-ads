import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { metaLookup } from "./lookup"
import { graphError, json, mockGraph, providerCtx } from "./test-utils"

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

  it("pages: promote_pages + Pages the via manages (me/accounts), de-duplicated, local name filter", async () => {
    mockGraph([
      ["GET", "act_1001/promote_pages", () => json({ data: [{ id: "888", name: "Shop VN" }, { id: "889", name: "Blog" }] })],
      ["GET", "me/accounts", () => json({ data: [{ id: "888", name: "Shop VN" }, { id: "890", name: "Shop HN" }] })],
    ])
    const res = await metaLookup(providerCtx(), "pages", { q: "shop" })
    expect(res.items).toEqual([
      { id: "888", name: "Shop VN", extra: { category: null, isPublished: null, source: "promote_pages" } },
      { id: "890", name: "Shop HN", extra: { category: null, isPublished: null, source: "me_accounts" } },
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
})
