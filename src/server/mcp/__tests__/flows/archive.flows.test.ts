// v1.1.6 common-tool changes end to end (real services + real endpoint, fake platforms):
//  - D3: ads_set_status status "archived" - Meta only (AdsProvider.archiveObjects), needs the delete permission too,
//    ALWAYS two-step confirmation (also with confirmation off / basic protection mode), other platforms → unsupported;
//  - D1: ads_update_object tiktok_creative - TikTok ads only (changes.creative reaches the adapter), refused elsewhere;
//  - B1 / F1: a token error while reading the parent budgets of an activation reaches mcp-core unchanged (connection
//    marked invalid), not budget_unverifiable;
//  - the shared fake failure hook (w.failNext) used by other flows.
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

import { ProviderError } from "@/server/providers/errors"
import { ARCHIVE_PREVIEW_WARNING } from "@/server/mcp/tools/common/set-status"
import type { ObjectUpdate } from "@/server/providers/types"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()

describe.skipIf(!hasDb)(
  "v1.1.6: archived status, TikTok creative edits, budget-check errors",
  { timeout: 300_000 },
  () => {
    let w: World
    const conns = {} as Record<
      "meta" | "tiktok" | "google_ads" | "openai_ads",
      ConnInfo
    >
    const acc = (p: keyof typeof conns) => conns[p].accounts[0]!.externalId

    const seed = () => {
      for (const c of Object.values(conns)) {
        for (const a of c.accounts) {
          w.seedObjects(a.externalId, [
            {
              id: "c1",
              level: "campaign",
              name: "C1",
              status: "active",
              parentId: null,
              budget: null,
            },
            {
              id: "c2",
              level: "campaign",
              name: "C2",
              status: "paused",
              parentId: null,
              budget: null,
            },
            {
              id: "c3",
              level: "campaign",
              name: "C3",
              status: "archived",
              parentId: null,
              budget: null,
            },
            {
              id: "g1",
              level: "ad_group",
              name: "G1",
              status: "active",
              parentId: "c1",
              budget: { type: "daily", amount: 100, level: "ad_group" },
            },
            {
              id: "a1",
              level: "ad",
              name: "A1",
              status: "paused",
              parentId: "g1",
              campaignId: "c1",
            },
          ])
        }
      }
    }

    beforeAll(async () => {
      w = await World.create()
      for (const p of ["meta", "tiktok", "google_ads", "openai_ads"] as const) {
        conns[p] = await w.connect(w.users.staff, p, demoAccounts(w.prefix, p))
      }
    }, 120_000)
    afterAll(async () => {
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      seed()
    })

    const allPerms = ["read", "status", "update", "delete"] as const
    const mcpWith = (
      settings: Record<string, unknown> = { twoStepConfirm: false }
    ) =>
      w.mcp(w.users.staff, {
        settings,
        platforms: Object.fromEntries(
          (Object.keys(conns) as (keyof typeof conns)[]).map((p) => [
            p,
            { permissions: [...allPerms], connections: [{ conn: conns[p] }] },
          ])
        ),
      })
    const archiveArgs = (p: keyof typeof conns, ids: string[]) => ({
      platform: p,
      account_id: acc(p),
      level: "campaign",
      ids,
      status: "archived",
    })

    // -------------------------------------------------------------------------------------------
    // D3: archived
    // -------------------------------------------------------------------------------------------
    it("Meta archived with two-step confirmation OFF still needs preview + confirm_token, then archives once", async () => {
      const mcp = await mcpWith()
      const p = await w.call(
        mcp.key,
        "ads_set_status",
        archiveArgs("meta", ["c2"])
      )
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect((p.sc.preview as { warnings: string[] }).warnings).toContain(
        ARCHIVE_PREVIEW_WARNING
      )
      expect(w.state.executions).toHaveLength(0)

      const done = await w.call(mcp.key, "ads_set_status", {
        ...archiveArgs("meta", ["c2"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(done.sc.status).toBe("success")
      expect(w.state.executions.map((e) => e.op)).toEqual(["archive"])
      expect(
        w.state.objects.get(acc("meta"))!.find((o) => o.id === "c2")!.status
      ).toBe("archived")
      const again = await w.call(mcp.key, "ads_set_status", {
        ...archiveArgs("meta", ["c2"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(again.sc.replayed).toBe(true)
      expect(w.state.executions).toHaveLength(1)
    })

    it("basic protection mode: archived is still confirmed in two steps", async () => {
      const mcp = await mcpWith({
        protectionMode: "basic",
        twoStepConfirm: false,
      })
      const p = await w.call(
        mcp.key,
        "ads_set_status",
        archiveArgs("meta", ["c1"])
      )
      expect(p.isError, p.text).toBe(false)
      expect(p.sc.status).toBe("confirmation_required")
      expect(w.state.executions).toHaveLength(0)
    })

    it("an object already archived is skipped with a warning (nothing sent for it)", async () => {
      const mcp = await mcpWith()
      const p = await w.call(
        mcp.key,
        "ads_set_status",
        archiveArgs("meta", ["c3"])
      )
      expect(p.sc.status).toBe("confirmation_required")
      expect(JSON.stringify(p.sc.preview)).toContain("đã được lưu trữ từ trước")
      const done = await w.call(mcp.key, "ads_set_status", {
        ...archiveArgs("meta", ["c3"]),
        confirm_token: p.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      expect(w.state.executions).toHaveLength(0)
    })

    it.each(["tiktok", "google_ads", "openai_ads"] as const)(
      "%s: archived → unsupported, nothing reaches the platform",
      async (p) => {
        const mcp = await mcpWith()
        const r = await w.call(
          mcp.key,
          "ads_set_status",
          archiveArgs(p, ["c1"])
        )
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("unsupported")
        expect(r.text).toContain("lưu trữ")
        expect(w.state.executions).toHaveLength(0)
      }
    )

    it("active / paused are unchanged (paused executes directly when confirmation is off)", async () => {
      const mcp = await mcpWith()
      const r = await w.call(mcp.key, "ads_set_status", {
        ...archiveArgs("meta", ["c1"]),
        status: "paused",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.status).toBe("success")
      expect(w.state.executions.map((e) => e.op)).toEqual(["set_status"])
    })

    // -------------------------------------------------------------------------------------------
    // D1: tiktok_creative
    // -------------------------------------------------------------------------------------------
    it("tiktok_creative on a TikTok ad reaches the adapter as changes.creative", async () => {
      const mcp = await mcpWith()
      const r = await w.call(mcp.key, "ads_update_object", {
        platform: "tiktok",
        account_id: acc("tiktok"),
        level: "ad",
        id: "a1",
        tiktok_creative: {
          ad_text: "Giảm 30% hôm nay",
          call_to_action: "LEARN_MORE",
        },
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.status).toBe("success")
      const exec = w.state.executions.find((e) => e.op === "update_object")!
      expect((exec.args as ObjectUpdate).changes).toEqual({
        creative: { adText: "Giảm 30% hôm nay", callToAction: "LEARN_MORE" },
      })
    })

    it.each(["meta", "google_ads", "openai_ads"] as const)(
      "tiktok_creative on %s → unsupported_field (nothing sent)",
      async (p) => {
        const mcp = await mcpWith()
        const r = await w.call(mcp.key, "ads_update_object", {
          platform: p,
          account_id: acc(p),
          level: "ad",
          id: "a1",
          tiktok_creative: { ad_text: "x" },
        })
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("unsupported_field")
        expect(w.state.executions).toHaveLength(0)
      }
    )

    it("tiktok_creative: campaign level refused; unknown key / bad CTA rejected by the schema; empty → nothing_to_update", async () => {
      const mcp = await mcpWith()
      const base = { platform: "tiktok", account_id: acc("tiktok") }
      const lvl = await w.call(mcp.key, "ads_update_object", {
        ...base,
        level: "campaign",
        id: "c1",
        tiktok_creative: { ad_text: "x" },
      })
      expect(lvl.sc.code).toBe("unsupported_field")
      const unknownKey = await w.call(mcp.key, "ads_update_object", {
        ...base,
        level: "ad",
        id: "a1",
        tiktok_creative: { auto_message_id: "1" },
      })
      expect(unknownKey.isError).toBe(true)
      const badCta = await w.call(mcp.key, "ads_update_object", {
        ...base,
        level: "ad",
        id: "a1",
        tiktok_creative: { call_to_action: "learn more" },
      })
      expect(badCta.isError).toBe(true)
      const empty = await w.call(mcp.key, "ads_update_object", {
        ...base,
        level: "ad",
        id: "a1",
        tiktok_creative: {},
      })
      expect(empty.sc.code).toBe("nothing_to_update")
      expect(w.state.executions).toHaveLength(0)
    })

    // -------------------------------------------------------------------------------------------
    // fake failure hook (shared with the other agents' flows)
    // -------------------------------------------------------------------------------------------
    it("w.failNext: the platform POST fails once with rate_limited (preview unaffected), then works again", async () => {
      const mcp = await mcpWith()
      w.failNext(
        "tiktok",
        "setStatus",
        () =>
          new ProviderError({
            platform: "tiktok",
            code: "rate_limited",
            message: "40100",
            userMessageVi: "TikTok giới hạn tần suất.",
            retryable: true,
            retryAfterMs: 30_000,
          })
      )
      const args = {
        platform: "tiktok",
        account_id: acc("tiktok"),
        level: "campaign",
        ids: ["c1"],
        status: "paused",
      }
      const r = await w.call(mcp.key, "ads_set_status", args)
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("rate_limited")
      expect(w.state.executions).toHaveLength(0)
      const ok = await w.call(mcp.key, "ads_set_status", args)
      expect(ok.isError, ok.text).toBe(false)
      expect(w.state.executions).toHaveLength(1)
    })

    // -------------------------------------------------------------------------------------------
    // B1 / F1 (last: it invalidates its own connection)
    // -------------------------------------------------------------------------------------------
    it("activation: rate_limited while reading the budgets → rate_limited (not budget_unverifiable)", async () => {
      const mcp = await mcpWith()
      w.failNext(
        "meta",
        "getObject",
        () =>
          new ProviderError({
            platform: "meta",
            code: "rate_limited",
            message: "17",
            userMessageVi: "Meta giới hạn tần suất.",
            retryable: true,
          }),
        { times: 5 }
      )
      const r = await w.call(mcp.key, "ads_set_status", {
        platform: "meta",
        account_id: acc("meta"),
        level: "ad",
        ids: ["a1"],
        status: "active",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("rate_limited")
      expect(w.state.executions).toHaveLength(0)
    })

    it("activation: invalid token on the parent ad set → auth_invalid reaches mcp-core and the connection is marked invalid", async () => {
      const own = await w.connect(w.users.staff, "meta", [
        {
          externalId: `act_${w.prefix.replace(/\D/g, "").padEnd(6, "7").slice(0, 6)}99`,
          name: "F1",
          currency: "VND",
          timezone: "Asia/Ho_Chi_Minh",
          status: "active",
          statusRaw: "ACTIVE",
        },
      ])
      const id = own.accounts[0]!.externalId
      w.seedObjects(id, [
        {
          id: "a9",
          level: "ad",
          name: "A9",
          status: "paused",
          parentId: "auth_fail",
          campaignId: null,
        },
      ])
      const mcp = await w.mcp(w.users.staff, {
        platforms: {
          meta: {
            permissions: ["read", "status"],
            connections: [{ conn: own }],
          },
        },
        settings: { twoStepConfirm: false },
      })
      const r = await w.call(mcp.key, "ads_set_status", {
        platform: "meta",
        account_id: id,
        level: "ad",
        ids: ["a9"],
        status: "active",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("auth_invalid")
      expect(w.state.executions).toHaveLength(0)
      expect((await w.connRow(own.id)).status).toBe("invalid")
    })
  }
)
