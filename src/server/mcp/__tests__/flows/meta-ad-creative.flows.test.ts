// meta_update_ad_creative end to end (v1.1.4 E2): REAL Meta adapter (Graph API faked at fetch level) + REAL services +
// REAL endpoint. Listing by permission, two-step confirmation (preview creates nothing), execution = create creative →
// read back the greeting → swap, before / after in mcp_call_logs, replay, money guardrails silent, grant boundary.
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import { db } from "@/server/db/client"
import { mcpCallLogs } from "@/server/db/schema"
import { metaProvider } from "@/server/providers/meta"
import { json, mockGraph, type RecordedCall } from "@/server/providers/meta/test-utils"
import { __resetBuckets } from "@/server/providers/rate-limit"
import { registerProvider } from "@/server/providers/registry"
import { createConnection } from "@/server/services/connections"
import type { McpActor } from "@/server/services/mcp-servers"
import { loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const APP_ID = "123456789012345"
const APP_SECRET = "0123456789abcdef0123456789abcdef"
const SCOPES = ["ads_management", "ads_read", "pages_show_list", "pages_read_engagement", "business_management"]
const TOOL = "meta_update_ad_creative"

describe.skipIf(!hasDb)("meta_update_ad_creative (real Meta adapter, faked Graph API)", { timeout: 120_000 }, () => {
  let w: World
  let graph: ReturnType<typeof mockGraph>
  let seq = 0
  /** numeric ad account id of the connection under test (the ad belongs to it unless a test says otherwise) */
  let adAccount = ""
  let adOwner = ""
  let sentCreative: Record<string, string> = {}
  const uniq = () => `${Date.now() % 1_000_000}${++seq}`.padStart(8, "7").slice(-6)

  beforeAll(async () => {
    w = await World.create()
    registerProvider(metaProvider as never) // the real adapter instead of the flows fake
  }, 120_000)
  afterAll(async () => {
    vi.unstubAllGlobals()
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => {
    w.reset()
    __resetBuckets()
    sentCreative = {}
    graph = mockGraph([
      [
        "GET",
        "debug_token",
        () =>
          json({
            data: { app_id: APP_ID, type: "USER", is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 50 * 86_400, scopes: SCOPES, user_id: "99" },
          }),
      ],
      ["GET", "oauth/access_token", (c) => json({ access_token: c.params.fb_exchange_token, token_type: "bearer", expires_in: 50 * 86_400 })],
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
      ["GET", "me/accounts", () => json({ data: [{ id: "888", name: "Shop VN", tasks: ["ADVERTISE", "ANALYZE"] }] })],
      ["GET", "me/businesses", () => json({ data: [] })],
      ["GET", /^act_\d+\/promote_pages$/, () => json({ data: [{ id: "888", name: "Shop VN" }] })],
      [
        "GET",
        "11",
        (c) =>
          c.params.fields === "id,creative{id}"
            ? json({ id: "11", creative: { id: "900" } })
            : json({
                id: "11",
                name: "Ad tin nhắn",
                account_id: adOwner,
                campaign_id: "3001",
                adset_id: "2001",
                status: "ACTIVE",
                effective_status: "ACTIVE",
                adset: { id: "2001", status: "ACTIVE", effective_status: "ACTIVE", destination_type: "MESSENGER", promoted_object: { page_id: "888" }, optimization_goal: "CONVERSATIONS" },
                campaign: { id: "3001", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_SALES" },
                creative: { id: "100", object_story_id: "888_42", effective_object_story_id: "888_42" },
              }),
      ],
      [
        "POST",
        /^act_\d+\/adcreatives$/,
        (c) => {
          if ((c.params.execution_options ?? "").includes("validate_only")) return json({ success: true })
          sentCreative = c.params
          return json({ id: "900" })
        },
      ],
      ["GET", "900", () => json({ id: "900", account_id: adAccount, page_welcome_message: sentCreative.page_welcome_message })],
      ["POST", "11", () => json({ success: true })],
    ])
  })

  async function connectMeta(actor: McpActor): Promise<ConnInfo> {
    const token = `EAA${w.prefix}x${uniq()}`
    const { id } = await createConnection(actor, {
      platform: "meta",
      name: `${w.prefix} meta ${seq}`,
      credentials: { access_token: token, app_id: APP_ID, app_secret: APP_SECRET },
    })
    adAccount = token.slice(-6)
    adOwner = adAccount
    return { id, platform: "meta", token, ownerId: actor.id, accounts: await w.accountRows(id) }
  }

  const writes = (calls: RecordedCall[]) =>
    calls.filter((c) => c.method === "POST" && !(c.params.execution_options ?? "").includes("validate_only") && (c.path === "11" || /adcreatives$/.test(c.path)))

  it("is listed only with Meta update permission", async () => {
    const actor = w.users.staff
    const conn = await connectMeta(actor)
    const ro = await w.mcp(actor, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
    const create = await w.mcp(actor, { platforms: { meta: { permissions: ["read", "create"], connections: [{ conn }] } } })
    const upd = await w.mcp(actor, { platforms: { meta: { permissions: ["read", "update"], connections: [{ conn }] } } })
    expect((await w.tools(ro.key)).names).not.toContain(TOOL)
    expect((await w.tools(create.key)).names).not.toContain(TOOL)
    const names = (await w.tools(upd.key)).names
    expect(names).toContain(TOOL)
    expect(names).toContain("meta_update_targeting")
    // a read-only MCP cannot call it either (not registered → refused)
    const r = await w.call(ro.key, TOOL, { account_id: conn.accounts[0]!.externalId, ad_id: "11", welcome_message: "Chào" })
    expect(r.isError).toBe(true)
    expect(writes(graph.calls)).toHaveLength(0)
  })

  it("preview creates nothing → confirm executes once (create, read back, swap) → before / after logged → replay", async () => {
    const actor = w.users.staff
    const conn = await connectMeta(actor)
    const mcp = await w.mcp(actor, { settings: { twoStepConfirm: true }, platforms: { meta: { permissions: ["read", "update"], connections: [{ conn }] } } })
    const args = { account_id: conn.accounts[0]!.externalId, ad_id: "11", welcome_message: { text: "Chào {{user_first_name}}!", ice_breakers: [{ title: "Giá?", response: "Shop báo ngay" }] } }

    const p = await w.call(mcp.key, TOOL, args)
    expect(p.isError, p.text).toBe(false)
    expect(p.sc.status).toBe("confirmation_required")
    const preview = p.sc.preview as { changes: Record<string, unknown>[]; warnings: string[]; details?: { payload?: Record<string, unknown> } }
    expect(preview.changes[0]).toMatchObject({
      object_id: "11",
      field: "creative",
      before: { creative_id: "100", welcome_message: null },
      after: { creative_id: "(mới)", welcome_message: { text: "Chào {{user_first_name}}!", ice_breakers: [{ title: "Giá?", response: "Shop báo ngay" }] } },
    })
    expect(preview.warnings.join(" ")).toMatch(/giữ nguyên ID, trạng thái và số liệu/)
    expect(preview.warnings.join(" ")).toMatch(/duyệt lại/)
    expect(preview.warnings.some((x) => /ngân sách/i.test(x))).toBe(false)
    expect(preview.details?.payload).toMatchObject({ ad_id: "11", mode: "welcome_message" })
    expect(writes(graph.calls)).toHaveLength(0) // validate_only only
    expect(graph.calls.some((c) => /adcreatives$/.test(c.path) && (c.params.execution_options ?? "").includes("validate_only"))).toBe(true)

    const done = await w.call(mcp.key, TOOL, { ...args, confirm_token: p.sc.confirm_token })
    expect(done.isError, done.text).toBe(false)
    expect(done.sc.status).toBe("success")
    expect(writes(graph.calls).map((c) => c.path.replace(/^act_\d+/, "act"))).toEqual(["act/adcreatives", "11"])
    expect(sentCreative.object_story_id).toBe("888_42")
    expect(JSON.parse(sentCreative.page_welcome_message).type).toBe("VISUAL_EDITOR")
    expect(JSON.parse(writes(graph.calls)[1]!.params.creative)).toEqual({ creative_id: "900" })
    expect(done.sc.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "creative", before: expect.objectContaining({ creative_id: "100" }), after: expect.objectContaining({ creative_id: "900" }) }),
        expect.objectContaining({ object_id: "900", field: "created" }),
      ])
    )

    const again = await w.call(mcp.key, TOOL, { ...args, confirm_token: p.sc.confirm_token })
    expect(again.sc.replayed).toBe(true)
    expect(writes(graph.calls)).toHaveLength(2)

    await flushMcpLogs()
    const rows = await db.select().from(mcpCallLogs).where(and(eq(mcpCallLogs.mcpId, mcp.id), eq(mcpCallLogs.toolName, TOOL)))
    const executed = rows.find((r) => Array.isArray(r.changes) && (r.changes as { field: string }[]).some((c) => c.field === "creative" && JSON.stringify(c).includes("900")))
    expect(executed, JSON.stringify(rows.map((r) => r.changes))).toBeDefined()
    expect((executed!.changes as { field: string; before: unknown; after: unknown }[]).find((c) => c.field === "creative")).toMatchObject({
      before: { creative_id: "100", welcome_message: null },
      after: { creative_id: "900", welcome_message: { text: "Chào {{user_first_name}}!" } },
    })
    const logs = JSON.stringify(rows)
    expect(logs).not.toContain(conn.token)
    expect(logs).not.toContain(APP_SECRET)
  })

  it("an MCP without two-step confirmation and without money caps (legacy) executes directly: no money refusal / warning", async () => {
    const actor = w.users.staff
    const conn = await connectMeta(actor)
    const mcp = await w.mcp(actor, { settings: { twoStepConfirm: false }, platforms: { meta: { permissions: ["read", "update"], connections: [{ conn }] } } })
    await w.makeLegacy(mcp.id, { twoStepConfirm: false })
    const r = await w.call(mcp.key, TOOL, { account_id: conn.accounts[0]!.externalId, ad_id: "11", welcome_message: "Chào bạn" })
    expect(r.isError, r.text).toBe(false)
    expect(r.sc.status).toBe("success")
    expect((r.sc.warnings as string[]).some((x) => /ngân sách|trần/i.test(x))).toBe(false)
    expect(writes(graph.calls)).toHaveLength(2)
  })

  it("an ad of another ad account → not_found error, nothing created or swapped", async () => {
    const actor = w.users.staff
    const conn = await connectMeta(actor)
    adOwner = "424242"
    const mcp = await w.mcp(actor, { settings: { twoStepConfirm: false }, platforms: { meta: { permissions: ["read", "update"], connections: [{ conn }] } } })
    const r = await w.call(mcp.key, TOOL, { account_id: conn.accounts[0]!.externalId, ad_id: "11", welcome_message: "Chào" })
    expect(r.isError).toBe(true)
    expect(r.sc.code).toBe("not_found")
    expect(String(r.sc.message)).toMatch(/Không tìm thấy quảng cáo 11 trong tài khoản quảng cáo đã chọn/)
    expect(writes(graph.calls)).toHaveLength(0)
  })
})
