// ads_set_status end to end: a provider hook (TikTok GMV Max: mustAlwaysConfirm) forces the two-step confirmation
// even on an MCP that disabled it - preview → confirm_token → execute → replay; a failing hook also requires
// confirmation; objects the hook does not flag, and platforms without the hook, keep executing directly.
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

import { registerProvider } from "@/server/providers/registry"
import type { AdsProvider } from "@/server/providers/types"
import { ALWAYS_CONFIRM_CHECK_FAILED } from "@/server/mcp/tools/common/set-status"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const GMV_REASON = "gmv1: Chiến dịch GMV Max: tạm dừng làm mất Bảo vệ ROI"

describe.skipIf(!hasDb)(
  "ads_set_status: provider-forced two-step confirmation (GMV Max)",
  { timeout: 300_000 },
  () => {
    let w: World
    let tiktok: ConnInfo
    let meta: ConnInfo
    const hook = { calls: 0, fail: false, flagged: "gmv1" }

    beforeAll(async () => {
      w = await World.create()
      const base = createFlowsProvider("tiktok", w.state)
      const withHook: AdsProvider = {
        ...base,
        async mustAlwaysConfirm(_ctx, level, ids) {
          hook.calls++
          if (hook.fail) throw new Error("gmv check failed")
          return level === "campaign" && ids.includes(hook.flagged)
            ? [GMV_REASON]
            : []
        },
      }
      registerProvider(withHook)
      tiktok = await w.connect(
        w.users.staff,
        "tiktok",
        demoAccounts(w.prefix, "tiktok")
      )
      meta = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(w.prefix, "meta")
      )
      for (const c of [tiktok, meta]) {
        w.seedObjects(c.accounts[0]!.externalId, [
          {
            id: "c1",
            level: "campaign",
            name: "C1",
            status: "active",
            parentId: null,
            budget: null,
          },
          {
            id: "gmv1",
            level: "campaign",
            name: "GMV",
            status: "active",
            parentId: null,
            budget: null,
          },
        ])
      }
    }, 120_000)
    afterAll(async () => {
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      hook.calls = 0
      hook.fail = false
      hook.flagged = "gmv1"
    })

    const mcpWith = (twoStepConfirm: boolean) =>
      w.mcp(w.users.staff, {
        settings: { twoStepConfirm },
        platforms: {
          tiktok: {
            permissions: ["read", "status"],
            connections: [{ conn: tiktok }],
          },
          meta: {
            permissions: ["read", "status"],
            connections: [{ conn: meta }],
          },
        },
      })
    const args = (c: ConnInfo, ids: string[]) => ({
      platform: c.platform,
      account_id: c.accounts[0]!.externalId,
      level: "campaign",
      ids,
      status: "paused",
    })

    it("confirmation off: a flagged campaign needs preview + confirm_token; the confirmed call executes once, then replays", async () => {
      const mcp = await mcpWith(false)
      const p = await w.call(mcp.key, "ads_set_status", args(tiktok, ["gmv1"]))
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect((p.sc.preview as { warnings: string[] }).warnings).toContain(
        GMV_REASON
      )
      expect(w.state.executions).toHaveLength(0)

      // other args with this token are refused
      const wrong = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1", "c1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(wrong.sc.code).toBe("confirm_args_mismatch")
      expect(w.state.executions).toHaveLength(0)

      const done = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect(done.sc.replayed).toBe(false)
      expect(w.state.executions).toHaveLength(1)
      const again = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(again.sc.replayed).toBe(true)
      expect(w.state.executions).toHaveLength(1)
    })

    it("confirmation off: a confirm_token issued at step 1 is always consumed, even when the hook would not flag the call any more", async () => {
      const mcp = await mcpWith(false)
      const p = await w.call(mcp.key, "ads_set_status", args(tiktok, ["gmv1"]))
      expect(p.sc.status).toBe("confirmation_required")
      const callsAfterPreview = hook.calls
      // e.g. the GMV Max check now fails open / the campaign is no longer detected: the token must still be consumed
      hook.flagged = "nothing"
      const done = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect(done.sc.replayed).toBe(false)
      expect(w.state.executions).toHaveLength(1)
      // the hook is not asked again on the confirmed call
      expect(hook.calls).toBe(callsAfterPreview)
      // same token again → replay of the consumed action, never a second execution
      const again = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(again.sc.replayed).toBe(true)
      expect(w.state.executions).toHaveLength(1)
    })

    it("confirmation off: a made-up confirm_token is refused (never executes around the confirmation)", async () => {
      const mcp = await mcpWith(false)
      const r = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["c1"]),
        confirm_token: "ct_made_up_token_value_1234567890",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("confirm_token_invalid")
      expect(w.state.executions).toHaveLength(0)
      // platform without the hook: unchanged (the token is ignored when two-step confirmation is off)
      const m = await w.call(mcp.key, "ads_set_status", {
        ...args(meta, ["c1"]),
        confirm_token: "ct_made_up_token_value_1234567890",
      })
      expect(m.sc.status).toBe("success")
      expect(w.state.executions).toHaveLength(1)
    })

    it("confirmation off: a campaign the hook does not flag executes directly (unchanged)", async () => {
      const mcp = await mcpWith(false)
      const r = await w.call(mcp.key, "ads_set_status", args(tiktok, ["c1"]))
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.status).toBe("success")
      expect(w.state.executions).toHaveLength(1)
      expect(hook.calls).toBe(1)
    })

    it("failing hook → confirmation required (fail closed)", async () => {
      const mcp = await mcpWith(false)
      hook.fail = true
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const p = await w.call(mcp.key, "ads_set_status", args(tiktok, ["c1"]))
      expect(p.sc.status).toBe("confirmation_required")
      expect((p.sc.preview as { warnings: string[] }).warnings).toContain(
        ALWAYS_CONFIRM_CHECK_FAILED
      )
      expect(w.state.executions).toHaveLength(0)
    })

    it("platform without the hook (Meta) executes directly even for the same ids", async () => {
      const mcp = await mcpWith(false)
      const r = await w.call(mcp.key, "ads_set_status", args(meta, ["gmv1"]))
      expect(r.sc.status).toBe("success")
      expect(w.state.executions).toHaveLength(1)
      expect(hook.calls).toBe(0)
    })

    it("confirmation already on: the hook is not asked, the usual two-step flow applies", async () => {
      const mcp = await mcpWith(true)
      const p = await w.call(mcp.key, "ads_set_status", args(tiktok, ["gmv1"]))
      expect(p.sc.status).toBe("confirmation_required")
      const done = await w.call(mcp.key, "ads_set_status", {
        ...args(tiktok, ["gmv1"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(done.sc.status).toBe("success")
      expect(hook.calls).toBe(0)
    })
  }
)
