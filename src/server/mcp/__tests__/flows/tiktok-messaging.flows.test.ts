// TikTok messaging helper tools end to end (v1.1.5): the REAL tiktok_messaging_assets / tiktok_create_welcome_message
// extensions (TikTok API faked at fetch level) on the REAL MCP endpoint + DB. Listing by permission, read call, two-step
// confirmation (preview creates nothing) → one create → replay, no money guardrail misfire, logs without the token.
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
  mockTikTok,
  ok,
} from "@/server/providers/tiktok/__fixtures__/mock-fetch"
import { tiktokExtensions } from "@/server/providers/tiktok/extensions"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const READ_TOOL = "tiktok_messaging_assets"
const WRITE_TOOL = "tiktok_create_welcome_message"

describe.skipIf(!hasDb)(
  "TikTok messaging tools (real extensions, faked TikTok API)",
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
            appId: "7000000000000000123",
            secret: "flows-secret",
          }
        },
        extensions: tiktokExtensions.filter(
          (e) => e.name === READ_TOOL || e.name === WRITE_TOOL
        ),
      })
    }, 120_000)
    afterAll(async () => {
      vi.unstubAllGlobals()
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      __resetBuckets()
      api = mockTikTok({
        "GET /creative/auto_message/get/": ok({
          list: [
            {
              auto_message_id: "1855000000000000000001",
              auto_message_type: "WELCOME_MESSAGE",
              audit_status: "PASS",
              welcome_message: {
                title: "Chào",
                content: "Xin chào!",
                suggested_questions: [{ question: "Giá?", answer: "Inbox" }],
              },
            },
          ],
          page_info: { page: 1, total_page: 1, total_number: 1 },
        }),
        "POST /creative/auto_message/create/": ok({
          auto_message_id: "1855000000000000000099",
        }),
      })
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
    const creates = () => api.callsTo("POST /creative/auto_message/create/")

    it("read tool listed with read permission; welcome message only with create", async () => {
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
      const roNames = (await w.tools(ro.key)).names
      expect(roNames).toContain(READ_TOOL)
      expect(roNames).not.toContain(WRITE_TOOL)
      expect((await w.tools(cr.key)).names).toEqual(
        expect.arrayContaining([READ_TOOL, WRITE_TOOL])
      )

      const r = await w.call(ro.key, READ_TOOL, {
        account_id: conn.accounts[0]!.externalId,
        kind: "welcome_messages",
      })
      expect(r.isError, r.text).toBe(false)
      const result = r.sc.result as { items: { auto_message_id: string }[] }
      expect(result.items[0]!.auto_message_id).toBe("1855000000000000000001")
      expect(
        api.callsTo("GET /creative/auto_message/get/")[0]!.headers[
          "access-token"
        ]
      ).toBe(conn.token)

      // a read-only MCP cannot create a welcome message (not registered → refused, nothing sent)
      const denied = await w.call(ro.key, WRITE_TOOL, {
        account_id: conn.accounts[0]!.externalId,
        content: "Chào bạn",
      })
      expect(denied.isError).toBe(true)
      expect(creates()).toHaveLength(0)
    })

    it("preview creates nothing → confirm creates once → replay; no money warning; logs keep the id, never the token", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: true },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      const args = {
        account_id: conn.accounts[0]!.externalId,
        content: "Chào bạn! Shop giúp gì được ạ?",
        suggested_questions: [
          { question: "Giá bao nhiêu?", answer: "Shop báo giá ngay." },
        ],
      }
      const p = await w.call(mcp.key, WRITE_TOOL, args)
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      const preview = p.sc.preview as {
        changes: Record<string, unknown>[]
        warnings: string[]
      }
      expect(preview.changes[0]).toMatchObject({
        field: "welcome_message",
        after: expect.objectContaining({ content: args.content }),
      })
      expect(preview.warnings.some((x) => /ngân sách|trần/i.test(x))).toBe(
        false
      )
      // a welcome message is not an ad object: no "created paused" note
      expect(preview.warnings.some((x) => /tạm dừng/.test(x))).toBe(false)
      expect(creates()).toHaveLength(0)

      const done = await w.call(mcp.key, WRITE_TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect((done.sc.result as { created_ids: string[] }).created_ids).toEqual(
        ["1855000000000000000099"]
      )
      expect(creates()).toHaveLength(1)
      expect(creates()[0]!.body).toMatchObject({
        auto_message_type: "WELCOME_MESSAGE",
        welcome_message: { content: args.content },
      })

      const again = await w.call(mcp.key, WRITE_TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(again.sc.replayed).toBe(true)
      expect(creates()).toHaveLength(1)

      await flushMcpLogs()
      const rows = await db
        .select()
        .from(mcpCallLogs)
        .where(
          and(
            eq(mcpCallLogs.mcpId, mcp.id),
            eq(mcpCallLogs.toolName, WRITE_TOOL)
          )
        )
      const logs = JSON.stringify(rows)
      expect(logs).toContain("1855000000000000000099")
      expect(logs).not.toContain(conn.token)
    })

    it("an MCP without money caps (legacy) and without confirmation creates directly: no money refusal", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: {
          tiktok: { permissions: ["read", "create"], connections: [{ conn }] },
        },
      })
      await w.makeLegacy(mcp.id, { twoStepConfirm: false })
      const r = await w.call(mcp.key, WRITE_TOOL, {
        account_id: conn.accounts[0]!.externalId,
        content: "Chào bạn",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.status).toBe("success")
      expect(
        (r.sc.warnings as string[]).some((x) => /ngân sách|trần/i.test(x))
      ).toBe(false)
      expect((r.sc.warnings as string[]).join(" ")).toMatch(/câu mặc định/)
      expect(creates()).toHaveLength(1)
    })
  }
)
