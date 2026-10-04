// Facebook Pages adapter. Response shapes copied from the live probe of 2026-10-03 (providers/meta.md §10.7),
// ids and texts anonymised.
import { beforeEach, describe, expect, it } from "vitest"

import { __resetBuckets } from "../rate-limit"
import { appSecretProof, mapGraphError } from "./client"
import {
  __clearPageTokenCache,
  getMetaPageInsights,
  getMetaPagePost,
  getMetaPostInsights,
  insightDayFromEndTime,
  listMetaPagePosts,
  listMetaPages,
  normalizePageTasks,
  pageCapabilities,
  postBelongsToPage,
} from "./pages"
import {
  graphError,
  json,
  mockGraph,
  providerCtx,
  TEST_TOKEN,
} from "./test-utils"

const PAGE = "4036745737"
const PAGE_TOKEN = "EAApagetokenvalue000000000000000000"
const SECRET = "app-secret-123"
const ctx = () => providerCtx({}, { appId: "111", appSecret: SECRET })

beforeEach(() => {
  __resetBuckets()
  __clearPageTokenCache()
})

const tokenRoute = (): [string, string, () => ReturnType<typeof json>] => [
  "GET",
  PAGE,
  () => json({ access_token: PAGE_TOKEN, id: PAGE }),
]

describe("helpers", () => {
  it("normalises tasks (PROFILE_PLUS_ prefix of client_pages, unknown tasks dropped, stable order)", () => {
    expect(
      normalizePageTasks([
        "PROFILE_PLUS_ANALYZE",
        "PROFILE_PLUS_REVENUE",
        "MODERATE",
        "PROFILE_PLUS_FACEBOOK_ACCESS",
      ])
    ).toEqual(["ANALYZE", "MODERATE"])
    expect(normalizePageTasks(undefined)).toEqual([])
  })

  it("derives capabilities from tasks", () => {
    expect(pageCapabilities(["ANALYZE"])).toEqual({
      posts: false,
      insights: true,
      adsPosts: false,
    })
    expect(pageCapabilities(["MODERATE", "ADVERTISE"])).toEqual({
      posts: true,
      insights: false,
      adsPosts: true,
    })
    expect(pageCapabilities([])).toEqual({
      posts: false,
      insights: false,
      adsPosts: false,
    })
  })

  it("maps a daily end_time (next Los Angeles midnight) to its day, PDT and PST", () => {
    expect(insightDayFromEndTime("2026-09-26T07:00:00+0000")).toBe("2026-09-25")
    expect(insightDayFromEndTime("2026-12-02T08:00:00+0000")).toBe("2026-12-01")
    expect(insightDayFromEndTime("not a date")).toBeNull()
  })

  it("a post belongs to a Page only through its PAGEID_ prefix", () => {
    expect(postBelongsToPage(`${PAGE}_123`, PAGE)).toBe(true)
    expect(postBelongsToPage(`999_123`, PAGE)).toBe(false)
    expect(postBelongsToPage(`${PAGE}123`, PAGE)).toBe(false)
  })

  it("a Page edge called with the user token is NOT a dead token (190 without subcode / 210)", () => {
    const e190 = mapGraphError(
      {
        code: 190,
        message: "(#190) This method must be called with a Page Access Token",
      },
      400,
      null
    )
    expect(e190.code).toBe("invalid_request")
    const e210 = mapGraphError(
      {
        code: 210,
        message:
          "(#210) A page access token is required to request this resource.",
      },
      403,
      null
    )
    expect(e210.code).toBe("invalid_request")
    // a real expired token is still auth_invalid
    expect(
      mapGraphError(
        { code: 190, error_subcode: 463, message: "Session has expired" },
        400,
        null
      ).code
    ).toBe("auth_invalid")
  })
})

describe("listMetaPages", () => {
  it("merges /me/accounts with the Business Manager pages (sources, BM name, client tasks)", async () => {
    const m = mockGraph([
      [
        "GET",
        "me/accounts",
        () =>
          json({
            data: [
              {
                id: PAGE,
                name: "SiliconZ",
                category: "Brand",
                followers_count: 54957,
                tasks: ["MANAGE", "ANALYZE", "ADVERTISE"],
              },
              {
                id: "2001",
                name: "Demo",
                followers_count: 0,
                tasks: ["MODERATE"],
              },
            ],
          }),
      ],
      [
        "GET",
        "me/businesses",
        () => json({ data: [{ id: "77", name: "SiliconZ Corporation" }] }),
      ],
      [
        "GET",
        "77/owned_pages",
        () => json({ data: [{ id: PAGE, name: "SiliconZ" }] }),
      ],
      [
        "GET",
        "77/client_pages",
        () =>
          json({
            data: [
              {
                id: "3001",
                name: "Khách",
                permitted_tasks: ["PROFILE_PLUS_ANALYZE"],
              },
            ],
          }),
      ],
    ])
    const res = await listMetaPages(ctx())
    expect(res.ok).toBe(true)
    expect(
      res.pages.map((p) => [
        p.externalId,
        p.sources.join("+"),
        p.businessName,
        p.tasks.join(","),
      ])
    ).toEqual([
      ["2001", "me_accounts", null, "MODERATE"],
      ["3001", "client_pages", "SiliconZ Corporation", "ANALYZE"],
      [
        PAGE,
        "me_accounts+owned_pages",
        "SiliconZ Corporation",
        "ANALYZE,ADVERTISE,MANAGE",
      ],
    ])
    // the Page list never asks for page tokens
    expect(
      m.calls.every((c) => !(c.params.fields ?? "").includes("access_token"))
    ).toBe(true)
    expect(m.calls[0].params.fields).toContain("tasks")
  })

  it("without business_management the BM step is skipped silently", async () => {
    mockGraph([
      [
        "GET",
        "me/accounts",
        () =>
          json({ data: [{ id: PAGE, name: "SiliconZ", tasks: ["ANALYZE"] }] }),
      ],
      [
        "GET",
        "me/businesses",
        () =>
          graphError(
            200,
            undefined,
            { message: "(#200) Requires business_management permission" },
            403
          ),
      ],
    ])
    const res = await listMetaPages(ctx())
    expect(res).toMatchObject({ ok: true, warnings: [] })
    expect(res.pages).toHaveLength(1)
  })

  it("an unreadable /me/accounts is reported as not ok (stored Pages stay untouched)", async () => {
    mockGraph([
      [
        "GET",
        "me/accounts",
        () =>
          graphError(10, undefined, { message: "(#10) pages_show_list" }, 403),
      ],
    ])
    const res = await listMetaPages(ctx())
    expect(res.ok).toBe(false)
    expect(res.warnings[0]).toMatch(/pages_show_list/)
  })
})

describe("Page token + posts", () => {
  it("lists posts with the PAGE token (appsecret_proof computed from it), since/until in Vietnam time", async () => {
    const m = mockGraph([
      tokenRoute(),
      [
        "GET",
        `${PAGE}/published_posts`,
        () =>
          json({
            data: [
              {
                id: `${PAGE}_1429`,
                message: "x".repeat(600),
                created_time: "2025-12-31T06:27:22+0000",
                status_type: "added_video",
                is_published: true,
                promotable_id: `${PAGE}_1429`,
                attachments: { data: [{ media_type: "video" }] },
                shares: { count: 2 },
                reactions: { data: [], summary: { total_count: 99 } },
                comments: { data: [], summary: { total_count: 10 } },
              },
            ],
            paging: {
              cursors: { after: "AFTER1" },
              next: "https://graph.facebook.com/next",
            },
          }),
      ],
    ])
    const res = await listMetaPagePosts(ctx(), PAGE, {
      source: "published",
      since: "2025-12-20",
      until: "2025-12-26",
      limit: 10,
      includeCounts: true,
    })
    const tokenCall = m.calls.find((c) => c.path === PAGE)!
    expect(tokenCall.params.access_token).toBe(TEST_TOKEN)
    const edge = m.calls.find((c) => c.path === `${PAGE}/published_posts`)!
    expect(edge.params.access_token).toBe(PAGE_TOKEN)
    expect(edge.params.appsecret_proof).toBe(appSecretProof(PAGE_TOKEN, SECRET))
    // 2025-12-20 00:00 +07:00 and 2025-12-26 23:59:59 +07:00
    expect(edge.params.since).toBe(
      String(Date.parse("2025-12-20T00:00:00+07:00") / 1000)
    )
    expect(edge.params.until).toBe(
      String(Date.parse("2025-12-27T00:00:00+07:00") / 1000 - 1)
    )
    expect(res.nextCursor).toBe("AFTER1")
    expect(res.posts[0]).toMatchObject({
      postId: `${PAGE}_1429`,
      messageTruncated: true,
      mediaType: "video",
      counts: { reactions: 99, comments: 10, shares: 2 },
    })
    expect(res.posts[0].message!.length).toBe(501)
  })

  it("caches the page token and fetches a new one once when Meta rejects it", async () => {
    let edgeCalls = 0
    let tokenCalls = 0
    const m = mockGraph([
      [
        "GET",
        PAGE,
        () => (
          tokenCalls++,
          json({ access_token: `${PAGE_TOKEN}${tokenCalls}` })
        ),
      ],
      [
        "GET",
        `${PAGE}/feed`,
        () =>
          ++edgeCalls === 1
            ? graphError(190, 460, { message: "Error validating access token" })
            : json({ data: [] }),
      ],
    ])
    await listMetaPagePosts(ctx(), PAGE, {
      source: "feed",
      limit: 5,
      includeCounts: false,
    })
    expect(tokenCalls).toBe(2)
    await listMetaPagePosts(ctx(), PAGE, {
      source: "feed",
      limit: 5,
      includeCounts: false,
    })
    expect(tokenCalls).toBe(2) // cached
    expect(
      m.calls.filter((c) => c.path === `${PAGE}/feed`).at(-1)!.params
        .access_token
    ).toBe(`${PAGE_TOKEN}2`)
  })

  it("a page token rejected twice is a permission problem on that Page, never a dead connection", async () => {
    mockGraph([
      tokenRoute(),
      [
        "GET",
        `${PAGE}/feed`,
        () =>
          graphError(190, 460, { message: "Error validating access token" }),
      ],
    ])
    await expect(
      listMetaPagePosts(ctx(), PAGE, {
        source: "feed",
        limit: 5,
        includeCounts: false,
      })
    ).rejects.toMatchObject({
      code: "permission_denied",
    })
  })

  it("no page token (no role on the Page) → permission_denied", async () => {
    mockGraph([["GET", PAGE, () => json({ id: PAGE })]])
    await expect(
      listMetaPagePosts(ctx(), PAGE, {
        source: "published",
        limit: 5,
        includeCounts: false,
      })
    ).rejects.toMatchObject({
      code: "permission_denied",
    })
  })

  it("refuses a post of another Page before calling Meta", async () => {
    const m = mockGraph([])
    await expect(getMetaPagePost(ctx(), PAGE, "999_1")).rejects.toMatchObject({
      code: "invalid_request",
    })
    expect(m.calls).toHaveLength(0)
  })

  it("post detail maps attachments and the full message", async () => {
    mockGraph([
      tokenRoute(),
      [
        "GET",
        `${PAGE}_1425`,
        () =>
          json({
            id: `${PAGE}_1425`,
            message: "Vlogger công nghệ dùng gì mỗi ngày?",
            created_time: "2025-12-26T13:40:17+0000",
            is_eligible_for_promotion: true,
            attachments: {
              data: [
                {
                  media_type: "album",
                  type: "album",
                  title: "Ảnh từ bài viết",
                  unshimmed_url: "https://www.facebook.com/x",
                  subattachments: {
                    data: [
                      {
                        media_type: "photo",
                        media: { image: { src: "https://scontent/1.jpg" } },
                      },
                    ],
                  },
                },
              ],
            },
          }),
      ],
    ])
    const p = await getMetaPagePost(ctx(), PAGE, `${PAGE}_1425`)
    expect(p.message).toBe("Vlogger công nghệ dùng gì mỗi ngày?")
    expect(p.attachments[0]).toMatchObject({
      mediaType: "album",
      children: [{ mediaType: "photo", imageUrl: "https://scontent/1.jpg" }],
    })
  })
})

describe("token failures (security review M1/L1/L3)", () => {
  const dead = (sub = 460) => graphError(190, sub, { message: "Error validating access token" })

  it("post insights: a rejected cached Page token is refetched once, then reported as a Page permission problem (never auth_invalid)", async () => {
    let batches = 0
    mockGraph([tokenRoute(), ["POST", "", () => (batches++, dead())]])
    await expect(getMetaPostInsights(ctx(), PAGE, [`${PAGE}_1`], ["post_media_view"])).rejects.toMatchObject({ code: "permission_denied" })
    expect(batches).toBe(2)
  })

  it("post insights recover when the refetched Page token works", async () => {
    let batches = 0
    mockGraph([
      tokenRoute(),
      [
        "POST",
        "",
        () =>
          ++batches === 1
            ? dead()
            : json([{ code: 200, body: JSON.stringify({ data: [{ name: "post_media_view", period: "lifetime", values: [{ value: 5 }] }] }) }]),
      ],
    ])
    const res = await getMetaPostInsights(ctx(), PAGE, [`${PAGE}_1`], ["post_media_view"])
    expect(res[0].metrics).toEqual({ post_media_view: 5 })
  })

  it("a dead USER token (the refetch itself fails) stays auth_invalid - the connection really is invalid", async () => {
    let tokenCalls = 0
    mockGraph([
      ["GET", PAGE, () => (++tokenCalls === 1 ? json({ access_token: PAGE_TOKEN }) : dead(463))],
      ["GET", `${PAGE}/feed`, () => dead()],
    ])
    await expect(listMetaPagePosts(ctx(), PAGE, { source: "feed", limit: 5, includeCounts: false })).rejects.toMatchObject({
      code: "auth_invalid",
    })
    expect(tokenCalls).toBe(2)
  })

  it("posts of another Page are dropped from lists and refused in the detail", async () => {
    mockGraph([
      tokenRoute(),
      ["GET", `${PAGE}/feed`, () => json({ data: [{ id: `${PAGE}_1` }, { id: "999_2" }] })],
      ["GET", `${PAGE}_7`, () => json({ id: "999_7", message: "x" })],
    ])
    const list = await listMetaPagePosts(ctx(), PAGE, { source: "feed", limit: 5, includeCounts: false })
    expect(list.posts.map((p) => p.postId)).toEqual([`${PAGE}_1`])
    await expect(getMetaPagePost(ctx(), PAGE, `${PAGE}_7`)).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("Post Insights", () => {
  const series = (name: string, period: string, value: unknown) => ({
    name,
    period,
    values: [{ value }],
  })

  it("one batch for all posts, period=lifetime, the lifetime series wins over a day series", async () => {
    const m = mockGraph([
      tokenRoute(),
      [
        "POST",
        "",
        (c) =>
          json(
            (JSON.parse(c.params.batch) as { relative_url: string }[]).map(
              () => ({
                code: 200,
                body: JSON.stringify({
                  data: [
                    series("post_media_view", "lifetime", 3570),
                    series("post_video_views", "lifetime", 1281),
                    series("post_video_views", "day", 1),
                    series("post_clicks_by_type", "lifetime", {
                      "link clicks": 118,
                      "other clicks": 5,
                    }),
                  ],
                }),
              })
            )
          ),
      ],
    ])
    const res = await getMetaPostInsights(
      ctx(),
      PAGE,
      [`${PAGE}_1`, `${PAGE}_2`],
      ["post_media_view", "post_video_views", "post_clicks_by_type"]
    )
    const batch = m.calls.find((c) => c.method === "POST")!
    expect(batch.params.access_token).toBe(PAGE_TOKEN)
    const ops = JSON.parse(batch.params.batch) as { relative_url: string }[]
    expect(ops).toHaveLength(2)
    expect(decodeURIComponent(ops[0].relative_url)).toBe(
      `${PAGE}_1/insights?metric=post_media_view,post_video_views,post_clicks_by_type&period=lifetime`
    )
    expect(m.calls.some((c) => "ids" in c.params)).toBe(false)
    expect(res[0].metrics).toEqual({
      post_media_view: 3570,
      post_video_views: 1281,
      post_clicks_by_type: { "link clicks": 118, "other clicks": 5 },
    })
  })

  it("a dead metric fails the post request → retried metric by metric, reported in invalidMetrics", async () => {
    const dead = {
      code: 400,
      body: JSON.stringify({
        error: {
          code: 100,
          message: "(#100) The value must be a valid insights metric",
        },
      }),
    }
    mockGraph([
      tokenRoute(),
      [
        "POST",
        "",
        (c) => {
          const ops = JSON.parse(c.params.batch) as { relative_url: string }[]
          return json(
            ops.map((op) => {
              const url = decodeURIComponent(op.relative_url)
              if (url.includes("post_media_view,post_clicks")) return dead
              if (url.includes("metric=post_clicks&")) return dead
              return {
                code: 200,
                body: JSON.stringify({
                  data: [series("post_media_view", "lifetime", 7)],
                }),
              }
            })
          )
        },
      ],
    ])
    const res = await getMetaPostInsights(
      ctx(),
      PAGE,
      [`${PAGE}_1`],
      ["post_media_view", "post_clicks"]
    )
    expect(res[0]).toMatchObject({
      metrics: { post_media_view: 7 },
      invalidMetrics: ["post_clicks"],
      error: null,
    })
  })

  it("refuses posts of another Page", async () => {
    mockGraph([])
    await expect(
      getMetaPostInsights(
        ctx(),
        PAGE,
        [`${PAGE}_1`, "999_2"],
        ["post_media_view"]
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("Page Insights", () => {
  const NOW = new Date("2026-10-03T12:00:00Z")
  const day = (d: string, v: number) => ({
    value: v,
    end_time: `${d}T07:00:00+0000`,
  })

  it("asks for until + 1 day, labels values with the LA day, sums additive metrics only", async () => {
    const m = mockGraph([
      tokenRoute(),
      [
        "GET",
        `${PAGE}/insights`,
        () =>
          json({
            data: [
              {
                name: "page_media_view",
                period: "day",
                values: [day("2026-09-26", 44), day("2026-09-27", 68)],
              },
              {
                name: "page_follows",
                period: "day",
                values: [day("2026-09-26", 54992), day("2026-09-27", 54990)],
              },
            ],
          }),
      ],
    ])
    const res = await getMetaPageInsights(
      ctx(),
      PAGE,
      {
        since: "2026-09-25",
        until: "2026-09-26",
        period: "day",
        metrics: ["page_media_view", "page_follows"],
      },
      NOW
    )
    const call = m.calls.find((c) => c.path === `${PAGE}/insights`)!
    expect(call.params).toMatchObject({
      since: "2026-09-25",
      until: "2026-09-27",
      period: "day",
      access_token: PAGE_TOKEN,
    })
    expect(res.timezone).toBe("America/Los_Angeles")
    expect(res.rows).toEqual([
      { date: "2026-09-25", page_media_view: 44, page_follows: 54992 },
      { date: "2026-09-26", page_media_view: 68, page_follows: 54990 },
    ])
    expect(res.totals).toEqual({ page_media_view: 112 })
  })

  it("splits long ranges into ≤ 90-day requests", async () => {
    const m = mockGraph([
      tokenRoute(),
      ["GET", `${PAGE}/insights`, () => json({ data: [] })],
    ])
    await getMetaPageInsights(
      ctx(),
      PAGE,
      {
        since: "2026-04-01",
        until: "2026-10-02",
        period: "day",
        metrics: ["page_media_view"],
      },
      NOW
    )
    const ranges = m.calls
      .filter((c) => c.path === `${PAGE}/insights`)
      .map((c) => [c.params.since, c.params.until])
    expect(ranges).toEqual([
      ["2026-04-01", "2026-06-30"],
      ["2026-06-30", "2026-09-28"],
      ["2026-09-28", "2026-10-03"],
    ])
  })

  it("skips day-only metrics for week/days_28 and drops dead metrics after one per-metric retry", async () => {
    const m = mockGraph([
      tokenRoute(),
      [
        "GET",
        `${PAGE}/insights`,
        (c) =>
          c.params.metric.includes(",") ||
          c.params.metric === "page_views_total"
            ? graphError(100, undefined, {
                message: "(#100) The value must be a valid insights metric",
              })
            : json({
                data: [
                  {
                    name: c.params.metric,
                    period: "week",
                    values: [day("2026-09-27", 5)],
                  },
                ],
              }),
      ],
    ])
    const res = await getMetaPageInsights(
      ctx(),
      PAGE,
      {
        since: "2026-09-20",
        until: "2026-09-26",
        period: "week",
        metrics: ["page_media_view", "page_follows", "page_views_total"],
      },
      NOW
    )
    expect(res.skippedMetrics).toEqual(["page_follows"])
    expect(res.invalidMetrics).toEqual(["page_views_total"])
    expect(res.rows).toEqual([{ date: "2026-09-26", page_media_view: 5 }])
    expect(res.totals).toEqual({})
    expect(m.calls.some((c) => c.params.metric?.includes("page_follows"))).toBe(
      false
    )
  })

  it("week = rolling 7-day windows ending every day → keeps non-overlapping weeks ending on until", async () => {
    const days = Array.from({ length: 15 }, (_, i) => `2026-09-${String(13 + i).padStart(2, "0")}`) // end_times 13..27 → days 12..26
    mockGraph([
      tokenRoute(),
      ["GET", `${PAGE}/insights`, () => json({ data: [{ name: "page_media_view", period: "week", values: days.map((d, i) => day(d, i)) }] })],
    ])
    const res = await getMetaPageInsights(ctx(), PAGE, { since: "2026-09-12", until: "2026-09-26", period: "week", metrics: ["page_media_view"] }, NOW)
    expect(res.rows.map((r) => r.date)).toEqual(["2026-09-12", "2026-09-19", "2026-09-26"])
    expect(res.warnings.join(" ")).toMatch(/tổng 7 ngày/)
  })

  it("validates the range (2 years back, since ≤ until)", async () => {
    mockGraph([])
    await expect(
      getMetaPageInsights(
        ctx(),
        PAGE,
        {
          since: "2026-09-10",
          until: "2026-09-01",
          period: "day",
          metrics: ["page_media_view"],
        },
        NOW
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(
      getMetaPageInsights(
        ctx(),
        PAGE,
        {
          since: "2023-01-01",
          until: "2023-01-10",
          period: "day",
          metrics: ["page_media_view"],
        },
        NOW
      )
    ).rejects.toMatchObject({
      code: "invalid_request",
    })
  })
})
