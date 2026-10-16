// tiktok_create_smart_plus end to end (v1.1.6, E1): the REAL extension (TikTok API faked at fetch level) on the REAL MCP
// endpoint + DB. Listing by permission, money caps BEFORE anything is sent (dynamic daily 125 %), AUTO_BUDGET_INCREASE
// refused, two-step confirmation (preview sends nothing) → one execution (CTA → campaign → ad group → ad, all DISABLE)
// → replay, partial creation reported with the created ids + logged changes, logs without the token.
import { and, eq } from "drizzle-orm"
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
import { mcpCallLogs } from "@/server/db/schema"
import { __resetBuckets } from "@/server/providers/rate-limit"
import { registerProvider } from "@/server/providers/registry"
import {
  fail,
  mockTikTok,
  ok,
} from "@/server/providers/tiktok/__fixtures__/mock-fetch"
import { tiktokExtensions } from "@/server/providers/tiktok/extensions"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const TOOL = "tiktok_create_smart_plus"
const CAMPAIGN_ID = "1850000000000000001"
const ADGROUP_ID = "1850000000000000002"
const AD_ID = "1850000000000000003"
const CTA_ID = "1850000000000000099"
const FUTURE_START = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`

describe.skipIf(!hasDb)(
  "TikTok Upgraded Smart+ create (real extension, faked TikTok API)",
  { timeout: 120_000 },
  () => {
    let w: World
    let api: ReturnType<typeof mockTikTok>

    beforeAll(async () => {
      w = await World.create()
      const base = createFlowsProvider("tiktok", w.state)
      registerProvider({
        ...base,
        // the real adapter reads { accessToken, appId }; the flows fake keeps validating { token }
        parseCredentials: (raw) => {
          const c = base.parseCredentials(raw) as { token: string }
          return {
            ...c,
            accessToken: c.token,
            appId: "7000000000000000124",
            secret: "flows-secret",
          }
        },
        extensions: tiktokExtensions.filter((e) => e.name === TOOL),
      })
    }, 120_000)
    afterAll(async () => {
      vi.unstubAllGlobals()
      if (w) await w.cleanup()
    }, 60_000)

    const routes = (over: Record<string, unknown> = {}) => ({
      "GET /creative/cta/recommend/": ok({
        recommend_assets: [
          { asset_ids: ["201902"], asset_content: "Tìm hiểu thêm" },
        ],
      }),
      "POST /creative/portfolio/create/": ok({ creative_portfolio_id: CTA_ID }),
      "POST /smart_plus/campaign/create/": ok({ campaign_id: CAMPAIGN_ID }),
      "POST /smart_plus/adgroup/create/": ok({ adgroup_id: ADGROUP_ID }),
      "POST /smart_plus/ad/create/": ok({ smart_plus_ad_id: AD_ID }),
      "GET /smart_plus/campaign/get/": ok({
        list: [
          {
            campaign_id: CAMPAIGN_ID,
            campaign_name: "Smart+ Web",
            operation_status: "DISABLE",
          },
        ],
      }),
      "GET /smart_plus/adgroup/get/": ok({
        list: [
          {
            adgroup_id: ADGROUP_ID,
            adgroup_name: "VN",
            operation_status: "DISABLE",
          },
        ],
      }),
      "GET /smart_plus/ad/get/": ok({
        list: [
          {
            smart_plus_ad_id: AD_ID,
            ad_name: "VN",
            operation_status: "DISABLE",
          },
        ],
      }),
      ...over,
    })

    beforeEach(() => {
      w.reset()
      __resetBuckets()
      api = mockTikTok(routes())
    })

    const connect = (): Promise<ConnInfo> =>
      w.connect(
        w.users.staff,
        "tiktok",
        demoAccounts(w.prefix, "tiktok").map((a) => ({
          ...a,
          externalId: `${a.externalId}${Math.floor(Math.random() * 1e6)}`,
        }))
      )
    const writes = () => api.posts()
    const argsFor = (conn: ConnInfo, budget = 500_000) => ({
      account_id: conn.accounts[0]!.externalId, // VND account
      campaign: { name: "Smart+ Web", budget_type: "daily", budget },
      adgroup: {
        name: "VN",
        goal: "WEBSITE",
        optimization_goal: "CONVERT",
        pixel_id: "7200000000000000009",
        optimization_event: "SHOPPING",
        location_ids: ["1562822"],
        schedule_start_time: FUTURE_START,
      },
      ad: {
        creatives: [
          {
            identity_type: "TT_USER",
            identity_id: "id-abc",
            tiktok_item_id: "7300000000000000001",
          },
        ],
        landing_page_url: "https://shop.example.vn/sale",
      },
    })

    it("listed only with the create permission", async () => {
      const conn = await connect()
      const ro = await w.mcp(w.users.staff, {
        platforms: {
          tiktok: { permissions: ["read"], connections: [{ conn }] },
        },
      })
      const cr = await w.mcp(w.users.staff, {
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      expect((await w.tools(ro.key)).names).not.toContain(TOOL)
      expect((await w.tools(cr.key)).names).toContain(TOOL)
      const denied = await w.call(ro.key, TOOL, argsFor(conn))
      expect(denied.isError).toBe(true)
      expect(writes()).toHaveLength(0)
    })

    it("money caps before anything is sent: dynamic daily budget compared with 125 % of the amount", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true, maxDailyBudget: { VND: 600_000 } },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      // 500 000 × 1.25 = 625 000 > 600 000 → refused at preview, no TikTok call at all
      const r = await w.call(mcp.key, TOOL, argsFor(conn, 500_000))
      expect(r.isError, r.text).toBe(true)
      expect(r.sc.code).toBe("budget_cap_exceeded")
      expect(api.calls).toHaveLength(0)
      // 400 000 × 1.25 = 500 000 ≤ cap → preview with the 125 % note
      const p = await w.call(mcp.key, TOOL, argsFor(conn, 400_000))
      expect(p.isError, p.text).toBe(false)
      expect(
        (p.sc.preview as { warnings: string[] }).warnings.join(" ")
      ).toMatch(/125%/)
    })

    it("AUTO_BUDGET_INCREASE is refused (nothing sent)", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      const a = argsFor(conn)
      const r = await w.call(mcp.key, TOOL, {
        ...a,
        campaign: {
          ...a.campaign,
          budget_auto_adjust_strategy: "AUTO_BUDGET_INCREASE",
        },
      })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/AUTO_BUDGET_INCREASE/)
      expect(api.calls).toHaveLength(0)
    })

    it("preview sends nothing → confirm creates CTA + 3 levels once (all DISABLE) → replay; logs keep the ids, never the token", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      const args = argsFor(conn)
      const p = await w.call(mcp.key, TOOL, args)
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      const preview = p.sc.preview as {
        changes: Record<string, unknown>[]
        warnings: string[]
      }
      expect(preview.changes).toHaveLength(3)
      expect(preview.warnings.join(" ")).toMatch(/allowlist/)
      expect(preview.warnings.join(" ")).toMatch(/tạm dừng|TẮT/)
      expect(api.calls).toHaveLength(0)

      const done = await w.call(mcp.key, TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect((done.sc.result as { created_ids: string[] }).created_ids).toEqual(
        [CAMPAIGN_ID, ADGROUP_ID, AD_ID]
      )
      // the CTA portfolio is written only once the campaign + ad group exist, right before the ad
      expect(writes().map((c) => c.path)).toEqual([
        "/smart_plus/campaign/create/",
        "/smart_plus/adgroup/create/",
        "/creative/portfolio/create/",
        "/smart_plus/ad/create/",
      ])
      for (const c of writes().filter((x) => x.path.startsWith("/smart_plus/")))
        expect(c.body!.operation_status).toBe("DISABLE")
      // request_id: deterministic int64 strings, campaign ≠ ad group
      const rc = String(writes()[0]!.body!.request_id)
      const ra = String(writes()[1]!.body!.request_id)
      expect(rc).toMatch(/^\d+$/)
      expect(ra).toMatch(/^\d+$/)
      expect(rc).not.toBe(ra)

      const again = await w.call(mcp.key, TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(again.sc.replayed).toBe(true)
      expect(writes()).toHaveLength(4)

      await flushMcpLogs()
      const rows = await db
        .select()
        .from(mcpCallLogs)
        .where(
          and(eq(mcpCallLogs.mcpId, mcp.id), eq(mcpCallLogs.toolName, TOOL))
        )
      const logs = JSON.stringify(rows)
      expect(logs).toContain(CAMPAIGN_ID)
      expect(logs).toContain(AD_ID)
      expect(logs).not.toContain(conn.token)
    })

    it("not allowlisted: Vietnamese allowlist message, no ad group / ad created", async () => {
      api = mockTikTok(
        routes({
          "POST /smart_plus/campaign/create/": fail(
            40118,
            "The advertiser is not on the allowlist"
          ),
        })
      )
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      const r = await w.call(mcp.key, TOOL, argsFor(conn))
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("feature_not_enabled")
      expect(r.text).toMatch(/allowlist/)
      expect(api.callsTo("POST /smart_plus/adgroup/create/")).toHaveLength(0)
      // nothing at all was written (no CTA portfolio either)
      expect(writes().map((c) => c.path)).toEqual(["/smart_plus/campaign/create/"])
    })

    it("partial creation: error names the created (paused) campaign + how to continue; the log row records it", async () => {
      api = mockTikTok(
        routes({
          "POST /smart_plus/adgroup/create/": fail(
            40002,
            "promotion_type must be the same"
          ),
        })
      )
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      const r = await w.call(mcp.key, TOOL, argsFor(conn))
      expect(r.isError).toBe(true)
      expect(r.text).toContain(CAMPAIGN_ID)
      expect(JSON.stringify(r.sc)).toContain(`campaign_id=\\"${CAMPAIGN_ID}\\"`)
      expect(api.callsTo("POST /smart_plus/ad/create/")).toHaveLength(0)
      await flushMcpLogs()
      const rows = await db
        .select()
        .from(mcpCallLogs)
        .where(
          and(eq(mcpCallLogs.mcpId, mcp.id), eq(mcpCallLogs.toolName, TOOL))
        )
      const err = rows.find((x) => x.status !== "success")!
      expect(err.errorCode).toBe("smart_plus_partial_create")
      expect(JSON.stringify(err.changes)).toContain(CAMPAIGN_ID)
    })
  }
)
