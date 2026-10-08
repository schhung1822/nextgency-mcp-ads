// Telegram in the MCP (14-telegram-notifications.md §6): channel scope saved by the MCP service (owner rules),
// grant + tools/list, telegram_list_channels (no token / chat id), telegram_send_message (scope, setting, hourly
// quota, delivery log) and the summary sent after a successful write. The Bot API is a fake `fetch`; the pg-boss
// sender is a fake (no worker).
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

import { db } from "@/server/db/client"
import {
  activityLogs,
  mcpNotificationScopes,
  notificationChannels,
  notificationDeliveries,
} from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { encryptChannelToken } from "@/server/notifications/deliver"
import { setNotificationJobSender } from "@/server/notifications/queue"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const CHAT_ID = "-100777000111"

const api = { sent: [] as Record<string, unknown>[], fail: false }

async function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url = String(input)
  const m = /\/bot([^/]+)\/(\w+)$/.exec(url)
  if (!m) return new Response("{}", { status: 404 })
  const payload = JSON.parse(String(init?.body ?? "{}")) as Record<
    string,
    unknown
  >
  if (m[2] === "sendMessage") {
    if (api.fail)
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was kicked from the group chat",
        }),
        { status: 403 }
      )
    api.sent.push(payload)
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 1000 + api.sent.length,
          chat: { id: Number(CHAT_ID) },
        },
      }),
      { status: 200 }
    )
  }
  return new Response(
    JSON.stringify({ ok: false, error_code: 400, description: "unexpected" }),
    { status: 400 }
  )
}

describe.skipIf(!hasDb)(
  "Telegram channels in the MCP (services → endpoint)",
  { timeout: 180_000 },
  () => {
    let w: World
    let metaConn: ConnInfo
    let staffCh: string
    let staff2Ch: string
    let disabledCh: string
    const jobs: unknown[] = []

    const channel = async (
      ownerId: string,
      name: string,
      status: "active" | "error" | "disabled" = "active"
    ) => {
      const id = crypto.randomUUID()
      await db.insert(notificationChannels).values({
        id,
        ownerId,
        type: "telegram",
        name,
        credentialsEncrypted: encryptChannelToken(id, TOKEN),
        credentialHint: TOKEN.slice(-4),
        config: {
          chatId: CHAT_ID,
          chatTitle: `Chat ${name}`,
          chatType: "supergroup",
          messageThreadId: null,
          botId: "123456789",
          botUsername: "ads_test_bot",
        },
        status,
      })
      return id
    }

    beforeAll(async () => {
      w = await World.create()
      metaConn = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(w.prefix, "meta")
      )
      for (const a of metaConn.accounts) {
        w.seedObjects(a.externalId, [
          {
            id: "c1",
            level: "campaign",
            name: "Chiến dịch <A>",
            status: "active",
            parentId: null,
            budget: null,
          },
        ])
      }
      staffCh = await channel(w.users.staff.id, `${w.prefix} staff`)
      staff2Ch = await channel(w.users.staff2.id, `${w.prefix} staff2`)
      disabledCh = await channel(
        w.users.staff.id,
        `${w.prefix} off`,
        "disabled"
      )
      setNotificationJobSender(async (_name, data) => {
        jobs.push(data)
        return "job"
      })
    }, 120_000)

    afterAll(async () => {
      setNotificationJobSender(null)
      vi.unstubAllGlobals()
      if (!w) return
      const owners = [w.users.staff.id, w.users.staff2.id, w.users.admin.id]
      await db
        .delete(notificationChannels)
        .where(inArray(notificationChannels.ownerId, owners))
      await w.cleanup()
    }, 60_000)

    beforeEach(() => {
      w.reset()
      api.sent.length = 0
      api.fail = false
      jobs.length = 0
      vi.stubGlobal("fetch", vi.fn(fakeFetch))
    })

    const metaRead = () => ({
      meta: {
        permissions: ["read" as const],
        connections: [{ conn: metaConn }],
      },
    })

    it("an MCP may only scope channels of its OWN owner (admins too); the scope is saved with an activity-log diff", async () => {
      await expect(
        w.mcp(w.users.staff, {
          platforms: metaRead(),
          notificationChannelIds: [staff2Ch],
        })
      ).rejects.toThrow()
      const mine = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
      })
      const scoped = await db
        .select()
        .from(mcpNotificationScopes)
        .where(eq(mcpNotificationScopes.mcpId, mine.id))
      expect(scoped.map((s) => s.channelId)).toEqual([staffCh])
      const adminConn = await w.connect(
        w.users.admin,
        "meta",
        demoAccounts(`${w.prefix}a`, "meta")
      )
      const adminPlatforms = {
        meta: {
          permissions: ["read" as const],
          connections: [{ conn: adminConn }],
        },
      }
      // security-first: an admin MCP cannot use a staff channel (its owner could re-point it and read the MCP's
      // notifications)
      await expect(
        w.mcp(w.users.admin, {
          platforms: adminPlatforms,
          notificationChannelIds: [staff2Ch],
        })
      ).rejects.toThrow()
      const adminCh = await channel(w.users.admin.id, `${w.prefix} admin`)
      const adminMcp = await w.mcp(w.users.admin, {
        platforms: adminPlatforms,
        notificationChannelIds: [adminCh],
        settings: { telegramTool: true },
      })
      const adminScoped = await db
        .select()
        .from(mcpNotificationScopes)
        .where(eq(mcpNotificationScopes.mcpId, adminMcp.id))
      expect(adminScoped.map((s) => s.channelId)).toEqual([adminCh])

      // a legacy scope row (written when an admin MCP could use any channel) is ignored by the grant...
      await db
        .insert(mcpNotificationScopes)
        .values({ mcpId: adminMcp.id, channelId: staff2Ch })
      invalidateGrantCache()
      const listed = await w.call(adminMcp.key, "telegram_list_channels", {})
      expect(
        (listed.sc.channels as { channel_id: string }[]).map(
          (c) => c.channel_id
        )
      ).toEqual([adminCh])
      const viaForeign = await w.call(adminMcp.key, "telegram_send_message", {
        channel_id: staff2Ch,
        text: "x",
      })
      expect(viaForeign.sc.code).toBe("channel_not_in_scope")
      // ...and pruned on the next save, even when the form re-sends it (a NEW foreign id is still refused)
      const adminInput = w.toInput({
        platforms: adminPlatforms,
        settings: { telegramTool: true },
      })
      await w.update(w.users.admin, {
        ...adminInput,
        id: adminMcp.id,
        notificationChannelIds: [adminCh, staff2Ch],
      })
      expect(
        (
          await db
            .select()
            .from(mcpNotificationScopes)
            .where(eq(mcpNotificationScopes.mcpId, adminMcp.id))
        ).map((s) => s.channelId)
      ).toEqual([adminCh])
      await expect(
        w.update(w.users.admin, {
          ...adminInput,
          id: adminMcp.id,
          notificationChannelIds: [adminCh, staffCh],
        })
      ).rejects.toThrow()

      // update: omitted = keep; [] = clear (logged as a channels diff)
      const input = w.toInput({ platforms: metaRead() })
      await w.update(w.users.staff, { ...input, id: mine.id, name: input.name })
      expect(
        await db
          .select()
          .from(mcpNotificationScopes)
          .where(eq(mcpNotificationScopes.mcpId, mine.id))
      ).toHaveLength(1)
      await w.update(w.users.staff, {
        ...input,
        id: mine.id,
        name: input.name,
        notificationChannelIds: [],
      })
      expect(
        await db
          .select()
          .from(mcpNotificationScopes)
          .where(eq(mcpNotificationScopes.mcpId, mine.id))
      ).toHaveLength(0)
      const logs = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.action, "mcp.update"),
            eq(activityLogs.targetId, mine.id)
          )
        )
      expect(
        logs.some((l) => JSON.stringify(l.metadata).includes(staffCh))
      ).toBe(true)
    })

    it("tools/list: telegram_list_channels with ≥1 usable channel, telegram_send_message only with telegram_tool; disabled channels are dropped", async () => {
      const none = await w.mcp(w.users.staff, { platforms: metaRead() })
      expect(
        (await w.tools(none.key)).names.filter((n) => n.startsWith("telegram_"))
      ).toEqual([])
      const listOnly = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh, disabledCh],
      })
      expect(
        (await w.tools(listOnly.key)).names.filter((n) =>
          n.startsWith("telegram_")
        )
      ).toEqual(["telegram_list_channels"])
      const r = await w.call(listOnly.key, "telegram_list_channels", {})
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.channels).toEqual([
        {
          channel_id: staffCh,
          name: `${w.prefix} staff`,
          chat_title: `Chat ${w.prefix} staff`,
          has_thread: false,
        },
      ])
      expect(r.sc.can_send).toBe(false)
      // never the bot token or the raw chat id
      expect(r.text).not.toContain(CHAT_ID)
      expect(r.text).not.toContain(TOKEN.slice(10))
      // the tool is not registered: a direct call is refused
      expect(
        (await w.call(listOnly.key, "telegram_send_message", { text: "hi" }))
          .isError
      ).toBe(true)

      const sender = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
        settings: { telegramTool: true },
      })
      expect(
        (await w.tools(sender.key)).names
          .filter((n) => n.startsWith("telegram_"))
          .sort()
      ).toEqual(["telegram_list_channels", "telegram_send_message"])

      // channel switched off later → gone from the grant (cache invalidated by the channel service in the app)
      await db
        .update(notificationChannels)
        .set({ status: "disabled" })
        .where(eq(notificationChannels.id, staffCh))
      invalidateGrantCache()
      expect(
        (await w.tools(sender.key)).names.filter((n) =>
          n.startsWith("telegram_")
        )
      ).toEqual([])
      await db
        .update(notificationChannels)
        .set({ status: "active" })
        .where(eq(notificationChannels.id, staffCh))
      invalidateGrantCache()
    })

    it("telegram_send_message: escaped text under a fixed title, channel must be in scope, hourly quota, deliveries logged", async () => {
      const mcp = await w.mcp(w.users.staff, {
        name: `${w.prefix} gửi <tin>`,
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
        settings: { telegramTool: true, telegramMessagesPerHour: 2 },
      })
      const ok = await w.call(mcp.key, "telegram_send_message", {
        text: "Chi tiêu <b>hôm nay</b> & mai",
        silent: true,
      })
      expect(ok.isError, ok.text).toBe(false)
      expect(ok.sc).toMatchObject({
        status: "sent",
        channel_id: staffCh,
        sent_last_hour: 1,
        messages_per_hour: 2,
      })
      expect(api.sent).toHaveLength(1)
      const sent = api.sent[0]!
      expect(String(sent.text)).toContain(
        "Chi tiêu &lt;b&gt;hôm nay&lt;/b&gt; &amp; mai"
      )
      expect(String(sent.text)).toContain("gửi &lt;tin&gt;")
      expect(sent.parse_mode).toBe("HTML")
      expect(sent.disable_notification).toBe(true)

      const foreign = await w.call(mcp.key, "telegram_send_message", {
        channel_id: staff2Ch,
        text: "x",
      })
      expect(foreign.isError).toBe(true)
      expect(foreign.sc.code).toBe("channel_not_in_scope")

      expect(
        (
          await w.call(mcp.key, "telegram_send_message", {
            channel_id: staffCh,
            text: "2",
          })
        ).isError
      ).toBe(false)
      const limited = await w.call(mcp.key, "telegram_send_message", {
        text: "3",
      })
      expect(limited.isError).toBe(true)
      expect(limited.sc.code).toBe("telegram_rate_limited")
      expect(api.sent).toHaveLength(2)

      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.mcpId, mcp.id))
      expect(rows.map((r) => [r.source, r.eventType, r.status])).toEqual([
        ["mcp_tool", "mcp_message", "sent"],
        ["mcp_tool", "mcp_message", "sent"],
      ])
    })

    it("telegram_send_message: the hourly quota is a DB-level guarantee - two concurrent calls with room for one → one rate-limited", async () => {
      const mcp = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
        settings: { telegramTool: true, telegramMessagesPerHour: 1 },
      })
      const results = await Promise.all([
        w.call(mcp.key, "telegram_send_message", { text: "một" }),
        w.call(mcp.key, "telegram_send_message", { text: "hai" }),
      ])
      expect(results.filter((r) => !r.isError)).toHaveLength(1)
      const limited = results.filter((r) => r.isError)
      expect(limited).toHaveLength(1)
      expect(limited[0]!.sc.code).toBe("telegram_rate_limited")
      expect(api.sent).toHaveLength(1)
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.mcpId, mcp.id))
      expect(rows).toHaveLength(1)
    })

    it("telegram_send_message: a Telegram failure is a tool error (Vietnamese), counted in the quota", async () => {
      const mcp = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
        settings: { telegramTool: true },
      })
      api.fail = true
      const r = await w.call(mcp.key, "telegram_send_message", {
        text: "hello",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("telegram_send_failed")
      expect(r.text).not.toContain(TOKEN)
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.mcpId, mcp.id))
      expect(rows.map((x) => x.status)).toEqual(["failed"])
      // the channel is flagged by the delivery bookkeeping: put it back for the next tests
      await db
        .update(notificationChannels)
        .set({ status: "active", statusMessage: null })
        .where(eq(notificationChannels.id, staffCh))
    })

    it("after a successful write: one mcp_write summary per execution when telegram_notify_writes is on (never for previews)", async () => {
      const acc = metaConn.accounts[0]!.externalId
      const writes = (notify: boolean, twoStep: boolean) =>
        w.mcp(w.users.staff, {
          platforms: {
            meta: {
              permissions: ["read", "status"],
              connections: [{ conn: metaConn }],
            },
          },
          notificationChannelIds: [staffCh],
          settings: { telegramNotifyWrites: notify, twoStepConfirm: twoStep },
        })
      const waitRows = async (mcpId: string, n: number) => {
        for (let i = 0; i < 50; i++) {
          const rows = await db
            .select()
            .from(notificationDeliveries)
            .where(eq(notificationDeliveries.mcpId, mcpId))
          if (rows.length >= n) return rows
          await new Promise((r) => setTimeout(r, 50))
        }
        return db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.mcpId, mcpId))
      }

      const off = await writes(false, false)
      expect(
        (
          await w.call(off.key, "ads_set_status", {
            platform: "meta",
            account_id: acc,
            level: "campaign",
            ids: ["c1"],
            status: "paused",
          })
        ).isError
      ).toBe(false)
      await new Promise((r) => setTimeout(r, 200))
      expect(
        await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.mcpId, off.id))
      ).toHaveLength(0)

      const on = await writes(true, true)
      const args = {
        platform: "meta",
        account_id: acc,
        level: "campaign",
        ids: ["c1"],
        status: "paused",
        reason: "CPA <cao>",
      }
      const preview = await w.call(on.key, "ads_set_status", args)
      expect(preview.sc.status).toBe("confirmation_required")
      await new Promise((r) => setTimeout(r, 200))
      expect(
        await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.mcpId, on.id))
      ).toHaveLength(0)
      const done = await w.call(on.key, "ads_set_status", {
        ...args,
        confirm_token: preview.sc.confirm_token,
      })
      expect(done.isError, done.text).toBe(false)
      const rows = await waitRows(on.id, 1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        channelId: staffCh,
        source: "mcp_write",
        eventType: "mcp_write",
      })
      expect(rows[0]!.preview).toContain("c1")
      // the AI's reason is untrusted text: escaped in the HTML that will be sent
      expect(rows[0]!.message).toContain("CPA &lt;cao&gt;")
      // a replay of the consumed token does not announce again
      await w.call(on.key, "ads_set_status", {
        ...args,
        confirm_token: preview.sc.confirm_token,
      })
      await new Promise((r) => setTimeout(r, 200))
      expect(
        await db
          .select()
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.mcpId, on.id))
      ).toHaveLength(1)
      expect(jobs.length).toBeGreaterThanOrEqual(1)
    })
  }
)
