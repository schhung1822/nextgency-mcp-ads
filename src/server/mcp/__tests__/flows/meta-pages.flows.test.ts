// Facebook Pages end to end: REAL Meta adapter (Graph API faked at fetch level) + REAL services + REAL endpoint.
// Pages sync with the connection, per-Page MCP scopes, the 5 read-only tools, grant boundaries and secrets.
import { and, eq, inArray } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("server-only", () => ({}))

import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import { db } from "@/server/db/client"
import { activityLogs, mcpCallLogs, metaPages } from "@/server/db/schema"
import { metaProvider } from "@/server/providers/meta"
import { __clearPageTokenCache } from "@/server/providers/meta/pages"
import { json, mockGraph } from "@/server/providers/meta/test-utils"
import { __resetBuckets } from "@/server/providers/rate-limit"
import { registerProvider } from "@/server/providers/registry"
import { setMetaPagesEnabled } from "@/server/services/ad-accounts"
import {
  createConnection,
  getConnection,
  syncConnectionAccounts,
} from "@/server/services/connections"
import type { McpActor } from "@/server/services/mcp-servers"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const APP_ID = "123456789012345"
const APP_SECRET = "0123456789abcdef0123456789abcdef"
const SCOPES = [
  "ads_management",
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "business_management",
]
const PAGE_TOOLS = [
  "meta_get_page_insights",
  "meta_get_post",
  "meta_get_post_insights",
  "meta_list_page_posts",
  "meta_list_pages",
]

describe.skipIf(!hasDb)(
  "Facebook Pages (real Meta adapter, faked Graph API)",
  { timeout: 120_000 },
  () => {
    let w: World
    let graph: ReturnType<typeof mockGraph>
    // per-token answers of the fake Graph API
    const pagesOf: Record<
      string,
      { id: string; name: string; tasks: string[] }[]
    > = {}
    let seq = 0
    const uniq = () => `${Date.now() % 1_000_000_000}${++seq}`.padStart(10, "7")

    beforeAll(async () => {
      w = await World.create()
      registerProvider(metaProvider as never)
    }, 120_000)
    afterAll(async () => {
      vi.unstubAllGlobals()
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      __resetBuckets()
      __clearPageTokenCache()
      graph = mockGraph([
        [
          "GET",
          "debug_token",
          () =>
            json({
              data: {
                app_id: APP_ID,
                type: "USER",
                is_valid: true,
                expires_at: Math.floor(Date.now() / 1000) + 50 * 86_400,
                scopes: SCOPES,
                user_id: "99",
              },
            }),
        ],
        [
          "GET",
          "oauth/access_token",
          (c) =>
            json({
              access_token: c.params.fb_exchange_token,
              token_type: "bearer",
              expires_in: 50 * 86_400,
            }),
        ],
        ["GET", "me", () => json({ id: "99", name: "Via" })],
        [
          "GET",
          "me/adaccounts",
          (c) =>
            json({
              data: [
                {
                  id: `act_${c.params.access_token.slice(-6)}`,
                  account_id: c.params.access_token.slice(-6),
                  name: "Shop",
                  account_status: 1,
                  currency: "VND",
                  timezone_name: "Asia/Ho_Chi_Minh",
                },
              ],
            }),
        ],
        [
          "GET",
          "me/accounts",
          (c) =>
            json({
              data: (pagesOf[c.params.access_token] ?? []).map((p) => ({
                ...p,
                followers_count: 100,
              })),
            }),
        ],
        ["GET", "me/businesses", () => json({ data: [] })],
        // page token: "PT_<pageId>" (only for Pages the token sees)
        [
          "GET",
          /^\d+$/,
          (c) => {
            const page = c.path
            const known = Object.values(pagesOf).some((list) =>
              list.some((p) => p.id === page)
            )
            return json(
              known
                ? { id: page, access_token: `PT_${page}_secretpagetoken` }
                : { id: page }
            )
          },
        ],
        [
          "GET",
          /^\d+\/published_posts$/,
          (c) =>
            json({
              data: [
                {
                  id: `${c.path.split("/")[0]}_555`,
                  message: "Bài viết thử",
                  created_time: "2026-09-30T03:00:00+0000",
                  attachments: { data: [{ media_type: "photo" }] },
                  reactions: { summary: { total_count: 3 } },
                  comments: { summary: { total_count: 1 } },
                },
              ],
            }),
        ],
        [
          "GET",
          /^\d+_\d+$/,
          (c) =>
            json({
              id: c.path,
              message: "Toàn bộ nội dung",
              created_time: "2026-09-30T03:00:00+0000",
              attachments: { data: [] },
            }),
        ],
        [
          "GET",
          /^\d+\/insights$/,
          () =>
            json({
              data: [
                {
                  name: "page_media_view",
                  period: "day",
                  values: [{ value: 10, end_time: "2026-09-26T07:00:00+0000" }],
                },
              ],
            }),
        ],
        [
          "POST",
          "",
          (c) =>
            json(
              (JSON.parse(c.params.batch) as unknown[]).map(() => ({
                code: 200,
                body: JSON.stringify({
                  data: [
                    {
                      name: "post_media_view",
                      period: "lifetime",
                      values: [{ value: 42 }],
                    },
                  ],
                }),
              }))
            ),
        ],
      ])
    })

    async function connectMeta(
      actor: McpActor,
      pages: { id: string; name: string; tasks: string[] }[]
    ): Promise<ConnInfo & { pageIds: Record<string, string> }> {
      const token = `EAA${w.prefix}${uniq()}`
      pagesOf[token] = pages
      const { id } = await createConnection(actor, {
        platform: "meta",
        name: `${w.prefix} meta ${seq}`,
        credentials: {
          access_token: token,
          app_id: APP_ID,
          app_secret: APP_SECRET,
        },
      })
      const conn: ConnInfo = {
        id,
        platform: "meta",
        token,
        ownerId: actor.id,
        accounts: await w.accountRows(id),
      }
      return { ...conn, pageIds: await pageIdsOf(id) }
    }

    async function pageIdsOf(
      connectionId: string
    ): Promise<Record<string, string>> {
      const rows = await db
        .select()
        .from(metaPages)
        .where(eq(metaPages.connectionId, connectionId))
      return Object.fromEntries(rows.map((r) => [r.externalId, r.id]))
    }

    /** MCP input with Meta "read" on `conn` and the given Page scope (undefined = no Page). */
    function mcpInput(
      conn: ConnInfo,
      pageIds: string[] | null | undefined,
      extra: Record<string, unknown> = {}
    ) {
      const input = w.toInput({
        platforms: { meta: { permissions: ["read"], connections: [{ conn }] } },
      })
      if (pageIds !== undefined)
        (
          input.platforms[0]!.connections[0] as Record<string, unknown>
        ).pageIds = pageIds
      return { ...input, ...extra }
    }

    it("Pages sync with the connection: first sync enabled, later new Pages disabled, vanished Pages flagged", async () => {
      const actor = w.users.staff
      const a = uniq()
      const b = uniq()
      const conn = await connectMeta(actor, [
        { id: a, name: "Trang A", tasks: ["ANALYZE", "MANAGE"] },
        { id: b, name: "Trang B", tasks: ["MODERATE"] },
      ])
      let rows = await db
        .select()
        .from(metaPages)
        .where(eq(metaPages.connectionId, conn.id))
      expect(
        rows
          .map((r) => [r.externalId, r.isEnabled, r.isMissing, r.tasks])
          .sort()
      ).toEqual(
        [
          [a, true, false, ["ANALYZE", "MANAGE"]],
          [b, true, false, ["MODERATE"]],
        ].sort()
      )
      const detail = await getConnection(actor, conn.id)
      expect(detail.pagesSync).toMatchObject({ ok: true, count: 2 })
      expect(
        detail.pages.find((p) => p.externalId === a)!.capabilities
      ).toEqual({ posts: true, insights: true, adsPosts: false })

      // the token now sees C but no longer B
      const c = uniq()
      pagesOf[conn.token] = [
        { id: a, name: "Trang A", tasks: ["ANALYZE", "MANAGE"] },
        { id: c, name: "Trang C", tasks: ["ANALYZE"] },
      ]
      await syncConnectionAccounts(actor, conn.id)
      rows = await db
        .select()
        .from(metaPages)
        .where(eq(metaPages.connectionId, conn.id))
      const byId = Object.fromEntries(
        rows.map((r) => [r.externalId, [r.isEnabled, r.isMissing]])
      )
      expect(byId).toEqual({
        [a]: [true, false],
        [b]: [true, true],
        [c]: [false, false],
      })
      // no page token was ever requested during a sync
      expect(
        graph.calls.some((x) =>
          (x.params.fields ?? "").includes("access_token")
        )
      ).toBe(false)
    })

    it("an MCP that saved \"all Pages\" on a Page-less connection does not silently gain Pages later (L10)", async () => {
    const actor = w.users.staff
    const conn = await connectMeta(actor, [])
    const mcp = await w.mcpRaw(actor, mcpInput(conn, null))
    const a = uniq()
    pagesOf[conn.token] = [{ id: a, name: "Trang mới", tasks: ["ANALYZE"] }]
    await syncConnectionAccounts(actor, conn.id)
    const [row] = await db.select().from(metaPages).where(eq(metaPages.connectionId, conn.id))
    expect(row!.isEnabled).toBe(false)
    expect((await w.tools(mcp.key)).names.filter((n) => PAGE_TOOLS.includes(n))).toEqual([])
    // the sync activity records the Pages summary
    const sync = await db.select().from(activityLogs).where(and(eq(activityLogs.targetId, conn.id), eq(activityLogs.action, "connection.test")))
    expect(sync.at(-1)!.metadata).toMatchObject({ pages: { total: 1, inserted: 1, missing: 0 } })
  })

  it("tools appear only with Meta read + a Page in scope; list shows enabled in-scope Pages only", async () => {
      const actor = w.users.staff
      const a = uniq()
      const b = uniq()
      const conn = await connectMeta(actor, [
        { id: a, name: "Trang A", tasks: ["ANALYZE", "MANAGE"] },
        { id: b, name: "Trang B", tasks: ["MODERATE"] },
      ])
      const none = await w.mcpRaw(actor, mcpInput(conn, undefined))
      expect(
        (await w.tools(none.key)).names.filter((n) => PAGE_TOOLS.includes(n))
      ).toEqual([])

      const all = await w.mcpRaw(actor, mcpInput(conn, null))
      expect(
        (await w.tools(all.key)).names
          .filter((n) => PAGE_TOOLS.includes(n))
          .sort()
      ).toEqual(PAGE_TOOLS)
      let r = await w.call(all.key, "meta_list_pages", {})
      expect(r.isError, r.text).toBe(false)
      expect(
        (r.sc.pages as { page_id: string }[]).map((p) => p.page_id).sort()
      ).toEqual([a, b].sort())

      // switching a Page off removes it from every MCP at once (activity logged)
      await setMetaPagesEnabled(actor, {
        connectionId: conn.id,
        changes: [{ pageId: conn.pageIds[b]!, enabled: false }],
      })
      r = await w.call(all.key, "meta_list_pages", {})
      expect(
        (r.sc.pages as { page_id: string }[]).map((p) => p.page_id)
      ).toEqual([a])
      const logs = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.targetId, conn.id),
            eq(activityLogs.action, "connection.pages.toggle")
          )
        )
      expect(logs).toHaveLength(1)

      const picked = await w.mcpRaw(actor, mcpInput(conn, [conn.pageIds[a]!]))
      r = await w.call(picked.key, "meta_list_pages", {})
      expect(
        (r.sc.pages as { page_id: string }[]).map((p) => p.page_id)
      ).toEqual([a])
    })

    it("reads posts / insights with the Page token; out-of-scope Pages are refused before any Graph call; no token leaks", async () => {
      const actor = w.users.staff
      const a = uniq()
      const b = uniq()
      const conn = await connectMeta(actor, [
        { id: a, name: "Trang A", tasks: ["ANALYZE", "MANAGE"] },
        { id: b, name: "Trang B", tasks: ["MODERATE"] },
      ])
      const mcp = await w.mcpRaw(
        actor,
        mcpInput(conn, [conn.pageIds[a]!, conn.pageIds[b]!])
      )

      let r = await w.call(mcp.key, "meta_list_page_posts", { page_id: a })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.posts[0]).toMatchObject({
        post_id: `${a}_555`,
        media_type: "photo",
        counts: { reactions: 3, comments: 1, shares: 0 },
      })
      const edge = graph.calls.find((c) => c.path === `${a}/published_posts`)!
      expect(edge.params.access_token).toBe(`PT_${a}_secretpagetoken`)

      r = await w.call(mcp.key, "meta_get_post", { post_id: `${a}_555` })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.post.message).toBe("Toàn bộ nội dung")

      r = await w.call(mcp.key, "meta_get_post_insights", {
        post_ids: [`${a}_555`],
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.posts[0].metrics).toEqual({ post_media_view: 42 })

      r = await w.call(mcp.key, "meta_get_page_insights", {
        page_id: a,
        since: "2026-09-25",
        until: "2026-09-25",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc).toMatchObject({
        timezone: "America/Los_Angeles",
        rows: [{ date: "2026-09-25", page_media_view: 10 }],
      })

      // B: the via has no ANALYZE task → insights refused without calling Meta
      const before = graph.calls.length
      r = await w.call(mcp.key, "meta_get_page_insights", {
        page_id: b,
        date_preset: "last_7d",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("page_insights_unavailable")

      // a Page / post of a Page outside the scope
      const outside = uniq()
      for (const [tool, args] of [
        ["meta_list_page_posts", { page_id: outside }],
        ["meta_get_post", { post_id: `${outside}_1` }],
        ["meta_get_post_insights", { post_ids: [`${outside}_1`] }],
        [
          "meta_get_page_insights",
          { page_id: outside, date_preset: "last_7d" },
        ],
      ] as const) {
        r = await w.call(mcp.key, tool, args)
        expect(r.isError, tool).toBe(true)
        expect(r.sc.code, tool).toBe("page_not_in_scope")
      }
      expect(graph.calls.length).toBe(before)

      // the Page token never reaches the AI nor the call logs
      await flushMcpLogs()
      const logs = await db
        .select()
        .from(mcpCallLogs)
        .where(eq(mcpCallLogs.mcpId, mcp.id))
      expect(logs.length).toBeGreaterThanOrEqual(9)
      expect(JSON.stringify(logs)).not.toContain("secretpagetoken")
      expect(JSON.stringify(logs)).not.toContain(conn.token)
    })

    it("scope validation: staff cannot use another staff's Pages, Pages only on Meta, picked Page must be enabled", async () => {
      const a = uniq()
      const mine = await connectMeta(w.users.staff, [
        { id: a, name: "Trang A", tasks: ["ANALYZE"] },
      ])
      const other = await connectMeta(w.users.staff2, [
        { id: uniq(), name: "Trang X", tasks: ["ANALYZE"] },
      ])

      // a Page id of another connection on my connection
      const foreignPage = Object.values(other.pageIds)[0]!
      await expect(
        w.mcpRaw(w.users.staff, mcpInput(mine, [foreignPage]))
      ).rejects.toMatchObject({ code: "invalid" })

      // Pages on a non-Meta platform
      const openaiConn = await w.connect(w.users.staff, "openai_ads", demoAccounts(w.prefix, "openai_ads").map((a) => ({ ...a, externalId: `${a.externalId}pg` })))
      const ttInput = w.toInput({
        platforms: {
          openai_ads: { permissions: ["read"], connections: [{ conn: openaiConn }] },
        },
      })
      ;(
        ttInput.platforms[0]!.connections[0] as Record<string, unknown>
      ).pageIds = null
      await expect(w.mcpRaw(w.users.staff, ttInput)).rejects.toMatchObject({
        code: "invalid",
      })

      // a switched-off Page cannot be picked
      await setMetaPagesEnabled(w.users.staff, {
        connectionId: mine.id,
        changes: [{ pageId: mine.pageIds[a]!, enabled: false }],
      })
      await expect(
        w.mcpRaw(w.users.staff, mcpInput(mine, [mine.pageIds[a]!]))
      ).rejects.toMatchObject({ code: "invalid" })

      // staff2 cannot toggle my Pages
      await expect(
        setMetaPagesEnabled(w.users.staff2, {
          connectionId: mine.id,
          changes: [{ pageId: mine.pageIds[a]!, enabled: true }],
        })
      ).rejects.toThrow()
      const [row] = await db
        .select()
        .from(metaPages)
        .where(inArray(metaPages.id, [mine.pageIds[a]!]))
      expect(row!.isEnabled).toBe(false)
    })
  }
)
