// TikTok GMV Max writes end to end (phase 2, C1-C7) through the real MCP endpoint + DB:
// - the admin-only switch tiktok_gmv_max_write: staff cannot turn it on; off → opt-in tools not listed, adapters get
//   gmvMaxWrite=false; on (set by an admin) → listed, adapters get gmvMaxWrite=true + the strict daily-spend guard;
// - opt-in write tools are ALWAYS two-step confirmed even when the MCP disabled confirmation (C4);
// - the generic write tools ask the provider's mustAlwaysConfirm for update / copy (not only set_status);
// - fieldHistory reads executed changes back from mcp_call_logs (ROI history, C7);
// - the strict guard refuses a currency without a daily cap even on an MCP that has other caps.
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

import { and, eq } from "drizzle-orm"
import { db } from "@/server/db/client"
import { mcpCallLogs } from "@/server/db/schema"
import { resetStartedLedgerForTests } from "@/server/mcp/started-spend-ledger"
import { ProviderError, withErrorAudit } from "@/server/providers/errors"
import { registerProvider } from "@/server/providers/registry"
import type { TT } from "@/server/providers/tiktok/api"
import {
  assertStartedWithinCap,
  startedChange,
  startedRequestKey,
} from "@/server/providers/tiktok/gmv-max-write"
import { GMV_MAX_STARTED_HISTORY_UNAVAILABLE } from "@/server/providers/tiktok/gmv-max-text"
import {
  STARTED_MAX_DAILY_SPEND_FIELD,
  STARTED_SPEND_UNCERTAIN_LOG_CODE,
  type AdsProvider,
  type DailySpendCheck,
  type FieldHistoryEntry,
  type MutationOptions,
  type ProviderExtension,
  type StartedSpendEntry,
} from "@/server/providers/types"
import { z } from "zod"
import { gmvMaxLockedError } from "@/server/providers/tiktok/gmv-max-write"
import { gmvMaxLockedMessage } from "@/server/providers/tiktok/gmv-max-text"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()
const WRITE_TOOL = "tiktok_gmv_fake_update"
const START_TOOL = "tiktok_gmv_fake_start"
const REASON =
  "gmv1: chiến dịch GMV Max - mọi thay đổi luôn cần xác nhận 2 bước."

interface Seen {
  tool: MutationOptions[]
  status: MutationOptions[]
  budget: MutationOptions[]
  history: FieldHistoryEntry[][]
  hookOps: string[]
  guardCurrency: string | null
  copy: MutationOptions[]
  started: StartedSpendEntry[][]
}

describe.skipIf(!hasDb)(
  "TikTok GMV Max writes: admin switch, opt-in tools, always confirm, history",
  { timeout: 300_000 },
  () => {
    let w: World
    let staffConn: ConnInfo
    let adminConn: ConnInfo
    const seen: Seen = {
      tool: [],
      status: [],
      budget: [],
      history: [],
      hookOps: [],
      guardCurrency: null,
      copy: [],
      started: [],
    }

    beforeAll(async () => {
      w = await World.create()
      const base = createFlowsProvider("tiktok", w.state)
      const fakeWrite: ProviderExtension = {
        name: WRITE_TOOL,
        permission: "update",
        title: "Fake GMV Max update",
        description: "Dùng khi kiểm thử công cụ ghi GMV Max (opt-in).",
        input: z.object({ campaign_id: z.string(), roas_bid: z.number() }),
        write: true,
        requiresSetting: "tiktok_gmv_max_write",
        alwaysConfirm: true,
        moneyOf: () => [],
        async run(
          _ctx,
          input: { campaign_id: string; roas_bid: number },
          opts
        ) {
          seen.tool.push(opts)
          if (opts.gmvMaxWrite !== true)
            throw new Error("adapter gate: switch off")
          if (seen.guardCurrency)
            opts.dailySpendGuard!([
              {
                label: "test",
                amount: 1,
                currency: seen.guardCurrency,
              } satisfies DailySpendCheck,
            ])
          if (opts.startedSpend24h)
            seen.started.push(await opts.startedSpend24h())
          if (opts.fieldHistory)
            seen.history.push(
              await opts.fieldHistory({
                objectId: input.campaign_id,
                field: "roas_bid",
                sinceHours: 24,
              })
            )
          if (!opts.dryRun)
            w.state.executions.push({
              op: "gmv_update",
              account: _ctx.account.externalId,
              args: input,
              idem: opts.idempotencyKey ?? null,
            } as never)
          return {
            preview: !!opts.dryRun,
            changes: [
              {
                objectId: input.campaign_id,
                field: "roas_bid",
                before: 2,
                after: input.roas_bid,
              },
              // a "new" campaign starts running: its worst-case daily spend is recorded (S5)
              ...(input.campaign_id.startsWith("new")
                ? [
                    {
                      objectId: input.campaign_id,
                      field: STARTED_MAX_DAILY_SPEND_FIELD,
                      before: null,
                      after: 1_500_000,
                    },
                  ]
                : []),
            ],
            warnings: [],
          }
        },
      }
      // plays a GMV Max create through the REAL S5 check (assertStartedWithinCap) with mcp-core's ledger + history
      const fakeStart: ProviderExtension = {
        name: START_TOOL,
        permission: "update",
        title: "Fake GMV Max start",
        description: "Dùng khi kiểm thử trần cộng dồn GMV Max (opt-in).",
        input: z.object({
          campaign_id: z.string(),
          amount: z.number(),
          mode: z.enum(["ok", "uncertain", "fail"]).default("ok"),
          delay_ms: z.number().default(0),
          bulk: z.number().default(0),
        }),
        write: true,
        requiresSetting: "tiktok_gmv_max_write",
        alwaysConfirm: true,
        moneyOf: () => [],
        async run(
          ctx,
          input: {
            campaign_id: string
            amount: number
            mode: "ok" | "uncertain" | "fail"
            delay_ms: number
            bulk: number
          },
          opts
        ) {
          const tt = { currency: ctx.account.currency } as TT
          const key = startedRequestKey(`req-${input.campaign_id}`)
          const cap = await assertStartedWithinCap(tt, opts, [
            { id: null, amount: input.amount, key },
          ])
          if (opts.dryRun)
            return {
              preview: true,
              changes: [
                {
                  objectId: "(mới)",
                  field: "create",
                  before: null,
                  after: input.campaign_id,
                },
              ],
              warnings: cap.notes,
            }
          // the "TikTok call" - the ledger lock is NOT held here
          await new Promise((r) => setTimeout(r, input.delay_ms))
          if (input.mode === "fail") {
            cap.reservation?.release()
            throw new ProviderError({
              platform: "tiktok",
              code: "invalid_request",
              message: "rejected",
              userMessageVi: "TikTok từ chối.",
              upstream: { code: 40002 },
            })
          }
          if (input.mode === "uncertain")
            throw withErrorAudit(
              new ProviderError({
                platform: "tiktok",
                code: "timeout",
                message: "timeout",
                userMessageVi: "Hết thời gian chờ.",
              }),
              "tiktok",
              {
                errorCode: STARTED_SPEND_UNCERTAIN_LOG_CODE,
                changes: [startedChange(key, input.campaign_id, input.amount)],
              }
            )
          cap.reservation?.settle(key, {
            objectId: input.campaign_id,
            amount: input.amount,
          })
          const big = Array.from({ length: 400 }, (_, i) =>
            `17${i}`.padEnd(19, "0")
          )
          return {
            preview: false,
            changes: [
              ...Array.from({ length: input.bulk }, (_, i) => ({
                objectId: `p${i}`,
                objectName: "N".repeat(1_000),
                field: "item_group_ids",
                before: big,
                after: big,
              })),
              startedChange(input.campaign_id, "x".repeat(500), input.amount),
            ],
            warnings: cap.notes,
          }
        },
      }
      const provider: AdsProvider = {
        ...base,
        extensions: [...base.extensions, fakeWrite, fakeStart],
        async setStatus(ctx, level, ids, status, opts) {
          seen.status.push(opts ?? {})
          return base.setStatus(ctx, level, ids, status, opts)
        },
        async updateBudget(ctx, u, opts) {
          seen.budget.push(opts ?? {})
          return base.updateBudget(ctx, u, opts)
        },
        // like the TikTok adapter (S8): a GMV Max campaign on an MCP without the switch → locked, before cap checks
        async preflightWrite(_ctx, level, ids, _op, opts) {
          if (
            level === "campaign" &&
            ids.includes("gmv1") &&
            opts.gmvMaxWrite !== true
          )
            throw gmvMaxLockedError(["gmv1"])
        },
        async copyObject(ctx, r, opts) {
          seen.copy.push(opts ?? {})
          return base.copyObject(ctx, r, opts)
        },
        async mustAlwaysConfirm(_ctx, level, ids, op) {
          seen.hookOps.push(op)
          // gmvdel: a DELETED GMV Max campaign - flagged for copy / update / delete, not for on/off (S1)
          if (
            level === "campaign" &&
            ids.includes("gmvdel") &&
            op !== "active" &&
            op !== "paused"
          )
            return [REASON]
          return level === "campaign" && ids.includes("gmv1") ? [REASON] : []
        },
      }
      registerProvider(provider)
      staffConn = await w.connect(
        w.users.staff,
        "tiktok",
        demoAccounts(w.prefix, "tiktok")
      )
      adminConn = await w.connect(
        w.users.admin,
        "tiktok",
        demoAccounts(`${w.prefix}a`, "tiktok")
      )
      for (const c of [staffConn, adminConn]) {
        w.seedObjects(c.accounts[0]!.externalId, [
          {
            id: "c1",
            level: "campaign",
            name: "C1",
            status: "active",
            parentId: null,
            budget: { type: "daily", amount: 100, level: "campaign" },
          },
          {
            id: "gmv1",
            level: "campaign",
            name: "GMV",
            status: "active",
            parentId: null,
            budget: { type: "daily", amount: 100, level: "campaign" },
          },
          {
            id: "gmvdel",
            level: "campaign",
            name: "GMV deleted",
            // the fake platform has no "deleted" state: the hook below plays TikTok (deleted row, flagged for copy)
            status: "paused",
            parentId: null,
            budget: { type: "daily", amount: 100, level: "campaign" },
          },
        ])
      }
    }, 120_000)
    afterAll(async () => {
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      seen.tool = []
      seen.status = []
      seen.budget = []
      seen.history = []
      seen.hookOps = []
      seen.guardCurrency = null
      seen.copy = []
      seen.started = []
    })

    const cfg = (conn: ConnInfo, settings: Record<string, unknown> = {}) => ({
      settings: { twoStepConfirm: false, ...settings },
      platforms: {
        tiktok: {
          permissions: ["read", "status", "update", "copy"] as (
            "read" | "status" | "update" | "copy"
          )[],
          connections: [{ conn }],
        },
      },
    })
    const acct = (c: ConnInfo) => c.accounts[0]!.externalId

    it("staff cannot create an MCP with the switch on (server-side)", async () => {
      await expect(
        w.mcp(w.users.staff, cfg(staffConn, { tiktokGmvMaxWrite: true }))
      ).rejects.toMatchObject({
        code: "invalid",
        message: "Chỉ quản trị viên được bật quyền thay đổi GMV Max.",
      })
    })

    it("switch OFF: the opt-in tool is not listed nor callable; generic writes hand gmvMaxWrite=false to the adapter", async () => {
      const mcp = await w.mcp(w.users.staff, cfg(staffConn))
      const t = await w.tools(mcp.key)
      expect(t.names).not.toContain(WRITE_TOOL)
      expect(t.names).toContain("ads_set_status")
      const call = await w.call(mcp.key, WRITE_TOOL, {
        account_id: acct(staffConn),
        campaign_id: "gmv1",
        roas_bid: 2.5,
      })
      expect(call.isError).toBe(true)
      expect(seen.tool).toHaveLength(0)
      const s = await w.call(mcp.key, "ads_set_status", {
        platform: "tiktok",
        account_id: acct(staffConn),
        level: "campaign",
        ids: ["c1"],
        status: "paused",
      })
      expect(s.isError, s.text).toBe(false)
      expect(seen.status.every((o) => o.gmvMaxWrite === false)).toBe(true)
      expect(
        seen.status.every(
          (o) =>
            typeof o.dailySpendGuard === "function" &&
            typeof o.fieldHistory === "function"
        )
      ).toBe(true)
    })

    it("switch ON (admin): tool listed, ALWAYS confirmed although the MCP disabled confirmation; adapter gets gmvMaxWrite=true; history from mcp_call_logs", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      expect((await w.tools(mcp.key)).names).toContain(WRITE_TOOL)
      const args = {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.5,
      }
      const p = await w.call(mcp.key, WRITE_TOOL, args)
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect(w.state.executions).toHaveLength(0)
      expect(seen.tool[0]).toMatchObject({ gmvMaxWrite: true, dryRun: true })
      expect(seen.history[0]).toEqual([])
      const done = await w.call(mcp.key, WRITE_TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect(w.state.executions).toHaveLength(1)
      // the executed change is now in mcp_call_logs → the next preview sees it
      const p2 = await w.call(mcp.key, WRITE_TOOL, { ...args, roas_bid: 2.2 })
      expect(p2.sc.status).toBe("confirmation_required")
      const last = seen.history.at(-1)!
      expect(last).toHaveLength(1)
      expect(last[0]).toMatchObject({ before: 2, after: 2.5 })
      expect(last[0]!.at).toBeInstanceOf(Date)
    })

    it("strict guard: a currency without a daily cap is refused (budget_cap_missing) even though other caps exist", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      seen.guardCurrency = "XAF"
      const r = await w.call(mcp.key, WRITE_TOOL, {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.5,
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("budget_cap_missing")
      seen.guardCurrency = "VND"
      const ok = await w.call(mcp.key, WRITE_TOOL, {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.5,
      })
      expect(ok.isError, ok.text).toBe(false)
    })

    it("basic protection mode: GMV Max writes still ALWAYS confirm; no cap needed (guard no-op, S5 skipped); the adapter gets protectionMode=basic (create / copy refused there)", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true, protectionMode: "basic", twoStepConfirm: true })
      )
      seen.guardCurrency = "XAF" // no cap for it anywhere: refused in advanced (test above)
      const args = { account_id: acct(adminConn), campaign_id: "gmv1", roas_bid: 2.5 }
      const p = await w.call(mcp.key, WRITE_TOOL, args)
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect(seen.tool[0]).toMatchObject({ gmvMaxWrite: true, protectionMode: "basic", dryRun: true })
      const done = await w.call(mcp.key, WRITE_TOOL, { ...args, confirm_token: p.sc.confirm_token })
      expect(done.sc.status).toBe("success")
      // on/off of a GMV Max campaign: the provider hook still forces the confirmation (two-step is off in basic)
      const off = await w.call(mcp.key, "ads_set_status", {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        ids: ["gmv1"],
        status: "paused",
      })
      expect(off.sc.status).toBe("confirmation_required")
      expect(seen.status.at(-1)).toMatchObject({ protectionMode: "basic", dryRun: true })
      // a non-GMV Max write runs at once (no two-step confirmation in basic)
      const c1 = await w.call(mcp.key, "ads_set_status", {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        ids: ["c1"],
        status: "paused",
      })
      expect(c1.sc.status).toBe("success")
      // S5 cumulative check skipped: a start far above any cap passes the preview
      const start = await w.call(mcp.key, START_TOOL, { account_id: acct(adminConn), campaign_id: "newbasic", amount: 9e12 })
      expect(start.isError, start.text).toBe(false)
      expect(start.sc.status).toBe("confirmation_required")
      // the same MCP in advanced: the adapter gets "advanced"
      const adv = await w.mcp(w.users.admin, cfg(adminConn, { tiktokGmvMaxWrite: true }))
      seen.guardCurrency = null
      await w.call(adv.key, WRITE_TOOL, args)
      expect(seen.tool.at(-1)).toMatchObject({ protectionMode: "advanced" })
    })

    it("ads_update_budget asks the provider hook with op 'update': a flagged campaign needs confirmation; others execute directly", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      const base = {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        budget_type: "daily",
        amount: 110,
      }
      const p = await w.call(mcp.key, "ads_update_budget", {
        ...base,
        id: "gmv1",
      })
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect((p.sc.preview as { warnings: string[] }).warnings).toContain(
        REASON
      )
      expect(seen.hookOps).toContain("update")
      expect(seen.budget.every((o) => o.gmvMaxWrite === true)).toBe(true)
      const d = await w.call(mcp.key, "ads_update_budget", {
        ...base,
        id: "c1",
      })
      expect(d.isError, d.text).toBe(false)
      expect(d.sc.status).toBe("success")
    })

    it("an admin editing the staff MCP may turn the switch on; the staff owner then sees the tool", async () => {
      const mcp = await w.mcp(w.users.staff, cfg(staffConn))
      const input = {
        ...w.toInput(cfg(staffConn, { tiktokGmvMaxWrite: true })),
        id: mcp.id,
      }
      await expect(w.update(w.users.staff, input)).rejects.toMatchObject({
        code: "invalid",
      })
      // turning it on is a sensitive change: re-authentication first (S4)
      await expect(w.update(w.users.admin, input)).rejects.toMatchObject({
        code: "reauth_required",
      })
      expect(
        (await w.update(w.users.admin, input, async () => "ok" as const))
          .changed
      ).toBe(true)
      expect((await w.tools(mcp.key)).names).toContain(WRITE_TOOL)
    })

    it("S2: only an execution through a consumed confirmation reaches the adapter with confirmed=true", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      const args = {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.5,
      }
      const p = await w.call(mcp.key, WRITE_TOOL, args)
      expect(p.sc.status).toBe("confirmation_required")
      expect(seen.tool[0]!.confirmed).toBeUndefined()
      const done = await w.call(mcp.key, WRITE_TOOL, {
        ...args,
        confirm_token: p.sc.confirm_token,
      })
      expect(done.sc.status, done.text).toBe("success")
      expect(seen.tool.at(-1)).toMatchObject({ confirmed: true })
      // a direct execution (two-step off, the hook did not flag c1) is NOT confirmed → GMV Max adapters refuse it
      const base = {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        budget_type: "daily",
        amount: 110,
      }
      const d = await w.call(mcp.key, "ads_update_budget", {
        ...base,
        id: "c1",
      })
      expect(d.sc.status, d.text).toBe("success")
      expect(seen.budget.at(-1)).toMatchObject({ confirmed: false })
    })

    it("S1: copying a DELETED GMV Max campaign is confirmed although the MCP disabled two-step confirmation", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      const p = await w.call(mcp.key, "ads_copy_object", {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        id: "gmvdel",
      })
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect(seen.hookOps).toContain("copy")
      expect(w.state.executions).toHaveLength(0)
      expect(seen.copy.every((o) => o.dryRun === true)).toBe(true)
      // on/off of the deleted row is not flagged (nothing would be sent for it)
      seen.hookOps = []
      await w.call(mcp.key, "ads_set_status", {
        platform: "tiktok",
        account_id: acct(adminConn),
        level: "campaign",
        ids: ["gmvdel"],
        status: "paused",
      })
      expect(seen.hookOps).toEqual(["paused"])
    })

    it("S5: startedSpend24h reads back the worst-case spends THIS MCP recorded on this ad account (other MCPs not counted)", async () => {
      const mcp = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      const run = async (key: string, campaign: string) => {
        const args = {
          account_id: acct(adminConn),
          campaign_id: campaign,
          roas_bid: 2.5,
        }
        const p = await w.call(key, WRITE_TOOL, args)
        const done = await w.call(key, WRITE_TOOL, {
          ...args,
          confirm_token: p.sc.confirm_token,
        })
        expect(done.sc.status, done.text).toBe("success")
      }
      await run(mcp.key, "new1")
      seen.started = []
      const p = await w.call(mcp.key, WRITE_TOOL, {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.4,
      })
      expect(p.sc.status).toBe("confirmation_required")
      expect(seen.started[0]).toEqual([
        { objectId: "new1", amount: 1_500_000, at: expect.any(Date) },
      ])
      // another MCP on the same ad account starts from zero
      const other = await w.mcp(
        w.users.admin,
        cfg(adminConn, { tiktokGmvMaxWrite: true })
      )
      seen.started = []
      await w.call(other.key, WRITE_TOOL, {
        account_id: acct(adminConn),
        campaign_id: "gmv1",
        roas_bid: 2.4,
      })
      expect(seen.started[0]).toEqual([])
    })

    it("S8: switch OFF → enabling a GMV Max campaign answers 'locked' before the cap checks", async () => {
      const mcp = await w.mcp(
        w.users.staff,
        cfg(staffConn, { maxDailyBudget: { VND: 50 } })
      )
      const call = (id: string) =>
        w.call(mcp.key, "ads_set_status", {
          platform: "tiktok",
          account_id: acct(staffConn),
          level: "campaign",
          ids: [id],
          status: "active",
        })
      const r = await call("gmv1")
      expect(r.isError).toBe(true)
      expect(r.text).toContain(gmvMaxLockedMessage("gmv1"))
      expect(r.sc.code).not.toBe("budget_cap_exceeded")
      // a normal campaign above the cap still gets the cap refusal
      const c = await call("c1")
      expect(c.isError).toBe(true)
      expect(c.sc.code).toBe("budget_cap_exceeded")
    })

    // --- S5 cumulative cap: M1 (parallel), L1 (uncertain), M3 (log truncation), L5 (locked first) ------------------
    const capCfg = () =>
      cfg(adminConn, {
        tiktokGmvMaxWrite: true,
        maxDailyBudget: { VND: 2_000_000 },
      })
    const startArgs = (
      campaign: string,
      amount: number,
      extra: Record<string, unknown> = {}
    ) => ({
      account_id: acct(adminConn),
      campaign_id: campaign,
      amount,
      ...extra,
    })
    const preview = (key: string, args: Record<string, unknown>) =>
      w.call(key, START_TOOL, args)
    const confirm = (
      key: string,
      args: Record<string, unknown>,
      token: unknown
    ) => w.call(key, START_TOOL, { ...args, confirm_token: token })
    const startRows = (mcpId: string) =>
      db
        .select()
        .from(mcpCallLogs)
        .where(
          and(
            eq(mcpCallLogs.mcpId, mcpId),
            eq(mcpCallLogs.toolName, START_TOOL),
            eq(mcpCallLogs.actionKind, "write")
          )
        )

    it("M1: two confirmed GMV Max starts in parallel cannot both pass the cumulative cap (lock + reservation)", async () => {
      const mcp = await w.mcp(w.users.admin, capCfg())
      const a = startArgs("p1a", 1_500_000, { delay_ms: 400 })
      const b = startArgs("p1b", 1_500_000, { delay_ms: 400 })
      const pa = await preview(mcp.key, a)
      const pb = await preview(mcp.key, b)
      expect(pa.sc.status, pa.text).toBe("confirmation_required")
      expect(pb.sc.status, pb.text).toBe("confirmation_required")
      const [ra, rb] = await Promise.all([
        confirm(mcp.key, a, pa.sc.confirm_token),
        confirm(mcp.key, b, pb.sc.confirm_token),
      ])
      const results = [ra, rb]
      expect(
        results.filter((r) => !r.isError && r.sc.status === "success")
      ).toHaveLength(1)
      const refused = results.find((r) => r.isError)!
      expect(refused.sc.code, refused.text).toBe("budget_cap_exceeded")
      // the started one is counted from now on (reservation, then its log row)
      const more = await preview(mcp.key, startArgs("p1c", 600_000))
      expect(more.isError).toBe(true)
      expect(more.sc.code).toBe("budget_cap_exceeded")
      const fits = await preview(mcp.key, startArgs("p1d", 500_000))
      expect(fits.isError, fits.text).toBe(false)
      // after a restart (empty ledger) the success row alone keeps it counted
      resetStartedLedgerForTests()
      const again = await preview(mcp.key, startArgs("p1e", 600_000))
      expect(again.sc.code).toBe("budget_cap_exceeded")
    })

    it("M1: a definite failure releases the reservation (the next start is not blocked by it)", async () => {
      const mcp = await w.mcp(w.users.admin, capCfg())
      const a = startArgs("p2a", 1_500_000, { mode: "fail" })
      const pa = await preview(mcp.key, a)
      const ra = await confirm(mcp.key, a, pa.sc.confirm_token)
      expect(ra.isError).toBe(true)
      expect(ra.sc.code).toBe("invalid_request")
      const b = startArgs("p2b", 1_500_000)
      const pb = await preview(mcp.key, b)
      const rb = await confirm(mcp.key, b, pb.sc.confirm_token)
      expect(rb.sc.status, rb.text).toBe("success")
    })

    it("L1: an uncertain start (timeout, not found) stays counted - error row with the started change + dedicated code, also after a restart", async () => {
      const mcp = await w.mcp(w.users.admin, capCfg())
      const a = startArgs("p3a", 1_500_000, { mode: "uncertain" })
      const pa = await preview(mcp.key, a)
      const ra = await confirm(mcp.key, a, pa.sc.confirm_token)
      expect(ra.isError).toBe(true)
      // the client still sees the provider's code; the log row gets the dedicated one + the change
      expect(ra.sc.code).toBe("timeout")
      const rows = await startRows(mcp.id)
      const err = rows.find(
        (r) => r.status !== "success" && r.status !== "pending_confirmation"
      )!
      expect(err.errorCode).toBe(STARTED_SPEND_UNCERTAIN_LOG_CODE)
      expect(err.changes).toEqual([
        expect.objectContaining({
          object_id: startedRequestKey("req-p3a"),
          field: STARTED_MAX_DAILY_SPEND_FIELD,
          after: 1_500_000,
        }),
      ])
      for (const restart of [false, true]) {
        if (restart) resetStartedLedgerForTests()
        const b = await preview(mcp.key, startArgs("p3b", 1_000_000))
        expect(b.isError).toBe(true)
        expect(b.sc.code).toBe("budget_cap_exceeded")
      }
      expect((await preview(mcp.key, startArgs("p3c", 500_000))).isError).toBe(
        false
      )
    })

    it("M3: a huge executed write keeps its started row readable (array, capped names); a truncated changes row refuses the next start", async () => {
      const mcp = await w.mcp(w.users.admin, capCfg())
      const a = startArgs("p4a", 1_000_000, { bulk: 60 })
      const pa = await preview(mcp.key, a)
      const ra = await confirm(mcp.key, a, pa.sc.confirm_token)
      expect(ra.sc.status, ra.text).toBe("success")
      const ok = (await startRows(mcp.id)).find((r) => r.status === "success")!
      expect(Array.isArray(ok.changes)).toBe(true)
      const list = ok.changes as {
        object_id: string
        object_name: string | null
        field: string
        after: unknown
      }[]
      const started = list.find(
        (c) => c.field === STARTED_MAX_DAILY_SPEND_FIELD
      )!
      expect(started).toMatchObject({ object_id: "p4a", after: 1_000_000 })
      expect(started.object_name!.length).toBe(120)
      expect(list.at(-1)!.field).toBe("_changes_truncated")
      // counted: 1.0M + 1.5M > 2.0M
      expect(
        (await preview(mcp.key, startArgs("p4b", 1_500_000))).sc.code
      ).toBe("budget_cap_exceeded")
      // a pre-fix row whose changes column was replaced by capJson → unreadable → refused (fail closed)
      await db.insert(mcpCallLogs).values({
        mcpId: mcp.id,
        method: "tools/call",
        toolName: START_TOOL,
        platform: "tiktok",
        adAccountId: acct(adminConn),
        actionKind: "write",
        status: "success",
        changes: { _truncated: true, _bytes: 99_999, preview: "[{" },
      })
      const r = await preview(mcp.key, startArgs("p4c", 100_000))
      expect(r.isError).toBe(true)
      expect(r.text).toContain(GMV_MAX_STARTED_HISTORY_UNAVAILABLE)
    })

    it("L5: switch OFF → ads_update_budget / ads_update_object on a GMV Max campaign answer 'locked' before the cap checks", async () => {
      const mcp = await w.mcp(
        w.users.staff,
        cfg(staffConn, { maxDailyBudget: { VND: 50 }, maxBid: { VND: 1 } })
      )
      const budget = (id: string) =>
        w.call(mcp.key, "ads_update_budget", {
          platform: "tiktok",
          account_id: acct(staffConn),
          level: "campaign",
          id,
          budget_type: "daily",
          amount: 110,
        })
      const r = await budget("gmv1")
      expect(r.isError).toBe(true)
      expect(r.text).toContain(gmvMaxLockedMessage("gmv1"))
      const c = await budget("c1")
      expect(c.isError).toBe(true)
      expect(c.sc.code).toMatch(/^budget_/)
      const o = await w.call(mcp.key, "ads_update_object", {
        platform: "tiktok",
        account_id: acct(staffConn),
        level: "campaign",
        id: "gmv1",
        bid_amount: 5,
      })
      expect(o.isError).toBe(true)
      expect(o.text).toContain(gmvMaxLockedMessage("gmv1"))
    })
  }
)
