// Telegram in the MCP (14-telegram-notifications.md §6): channel scope saved by the MCP service (owner rules),
// grant + tools/list, telegram_list_channels (no token / chat id), telegram_send_message (scope, setting, hourly
// quota, delivery log, attachments §10.2) and the summary sent after a successful write. The Bot API is a fake
// `fetch` (JSON + multipart uploads); file downloads use a fake media fetch; the pg-boss sender is a fake (no worker).
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
import { quotaId } from "@/server/db/quota"
import {
  activityLogs,
  mcpCallLogs,
  mcpNotificationScopes,
  notificationChannels,
  notificationDeliveries,
  verification,
} from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { chatgptDedupeKey } from "@/server/mcp/tools/telegram/attachment"
import { MEDIA_ATTEMPTS } from "@/server/mcp/tools/telegram/send-message"
import { TELEGRAM_CREDIT_URL as CREDIT_URL } from "@/server/notifications/credit"
import { encryptChannelToken } from "@/server/notifications/deliver"
import { setMediaFetchImpl } from "@/server/notifications/media"
import { setNotificationJobSender } from "@/server/notifications/queue"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const CHAT_ID = "-100777000111"

const api = {
  sent: [] as Record<string, unknown>[],
  fail: false,
  multipart: 0,
}

const MEDIA_METHODS = new Set(["sendPhoto", "sendVideo", "sendDocument"])

/** multipart upload (never JSON.parse'd): string fields as-is, the file as { name, type, size, bytes } */
async function multipartFields(
  method: string,
  form: FormData
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { method }
  for (const [k, v] of form.entries()) {
    out[k] =
      typeof v === "string"
        ? v
        : {
            name: v.name,
            type: v.type,
            size: v.size,
            bytes: Buffer.from(await v.arrayBuffer()),
          }
  }
  return out
}

async function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url = String(input)
  const m = /\/bot([^/]+)\/(\w+)$/.exec(url)
  if (!m) return new Response("{}", { status: 404 })
  if (init?.body instanceof FormData) {
    api.multipart++
    if (!MEDIA_METHODS.has(m[2]!))
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "unexpected" }),
        { status: 400 }
      )
    api.sent.push(await multipartFields(m[2]!, init.body))
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 1000 + api.sent.length },
      }),
      { status: 200 }
    )
  }
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

// file downloads (file_url / ChatGPT download_url) - by path; setup.png is an EXE in disguise
const FILES = "https://files.example.com"
const OAI = "https://files.oaiusercontent.com"
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1")
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom\0\0\0\0isommp42", "latin1"),
  Buffer.alloc(32, 2),
])
const EXE = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(64, 0)])
const media = { requests: [] as string[] }

async function mediaFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input)
  media.requests.push(url)
  const path = new URL(url).pathname
  const [bytes, type] = path.endsWith("/photo.png")
    ? [PNG, "image/png"]
    : path.endsWith("/movie.mp4")
      ? [MP4, "video/mp4"]
      : path.endsWith("/setup.png")
        ? [EXE, "image/png"]
        : path.startsWith("/files/abc/")
          ? [PDF, "application/octet-stream"]
          : [null, ""]
  if (!bytes) return new Response("not found", { status: 404 })
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type, "content-length": String(bytes.length) },
  })
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
    /** media-attempt quota rows (db/quota.ts) of the MCPs created by sender() */
    const quotaRows: string[] = []

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
      setMediaFetchImpl(mediaFetch as typeof fetch)
    }, 120_000)

    afterAll(async () => {
      setNotificationJobSender(null)
      setMediaFetchImpl(null)
      vi.unstubAllGlobals()
      if (!w) return
      if (quotaRows.length)
        await db.delete(verification).where(inArray(verification.id, quotaRows))
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
      api.multipart = 0
      media.requests.length = 0
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

    // -----------------------------------------------------------------------
    // Attachments (§10.2): photo / video / document, ChatGPT file object, text file written by the AI
    // -----------------------------------------------------------------------
    const sender = async (perHour = 20) => {
      const mcp = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
        settings: { telegramTool: true, telegramMessagesPerHour: perHour },
      })
      quotaRows.push(quotaId("telegram-media", mcp.id))
      return mcp
    }
    /** wait so that the next calls fall in one 2-minute ChatGPT dedupe bucket */
    const sameDedupeBucket = async () => {
      const toBoundary = 120_000 - (Date.now() % 120_000)
      if (toBoundary < 10_000)
        await new Promise((res) => setTimeout(res, toBoundary + 50))
    }
    const deliveriesOf = (mcpId: string) =>
      db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.mcpId, mcpId))
    const callLogsOf = (mcpId: string) =>
      db.select().from(mcpCallLogs).where(eq(mcpCallLogs.mcpId, mcpId))

    it("telegram_send_message text-only: unchanged, the credit footer is appended once (no attachment in the output)", async () => {
      const mcp = await sender()
      const r = await w.call(mcp.key, "telegram_send_message", {
        text: "Báo cáo hôm nay",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.attachment).toBeUndefined()
      expect(r.sc.duplicate).toBeUndefined()
      expect(api.sent).toHaveLength(1)
      const text = String(api.sent[0]!.text)
      expect(text).toContain("Báo cáo hôm nay")
      expect(text.split("Ads MCP Simple")).toHaveLength(2)
      expect(text).toContain(`<a href="${CREDIT_URL}">Ads MCP Simple</a>`)
      expect(api.sent[0]!.link_preview_options).toEqual({ is_disabled: true })
      expect(api.multipart).toBe(0)
    })

    it("tools/list: telegram_send_message carries _meta openai/fileParams and the 4-property ChatGPT file schema", async () => {
      const mcp = await sender()
      const { msg } = await w.rpc(mcp.key, "tools/list")
      type ToolDesc = {
        name: string
        _meta?: Record<string, unknown>
        description: string
        outputSchema: { type: string }
        inputSchema: {
          required?: string[]
          properties: Record<
            string,
            {
              type?: string
              required?: string[]
              properties?: Record<string, unknown>
              additionalProperties?: unknown
            }
          >
        }
      }
      const tools = msg.result.tools as ToolDesc[]
      const send = tools.find((t) => t.name === "telegram_send_message")!
      expect(send._meta).toEqual({ "openai/fileParams": ["file"] })
      const file = send.inputSchema.properties.file!
      expect(file.type).toBe("object")
      expect(Object.keys(file.properties ?? {}).sort()).toEqual([
        "download_url",
        "file_id",
        "file_name",
        "mime_type",
      ])
      expect([...(file.required ?? [])].sort()).toEqual([
        "download_url",
        "file_id",
      ])
      expect(file.additionalProperties).toBe(false)
      // text is optional now (a file may go without caption); the handler requires it without a file
      expect(send.inputSchema.required ?? []).not.toContain("text")
      expect(send.description.startsWith("Dùng khi")).toBe(true)
      expect(send.description.length).toBeLessThanOrEqual(1500)
      expect(send.outputSchema.type).toBe("object")
      expect(
        tools.find((t) => t.name === "telegram_list_channels")!._meta
      ).toBeUndefined()
    })

    it("telegram_send_message file_url photo: downloaded by the server, multipart sendPhoto with the caption + footer; no query string in any log", async () => {
      const mcp = await sender()
      const r = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/anh/photo.png?X-Amz-Signature=SECRETSIG#x`,
        text: "Ảnh <mới>",
        silent: true,
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc).toMatchObject({
        status: "sent",
        channel_id: staffCh,
        sent_last_hour: 1,
        attachment: {
          kind: "photo",
          file_name: "photo.png",
          size_bytes: PNG.length,
          mime: "image/png",
        },
      })
      expect(media.requests).toEqual([
        `${FILES}/anh/photo.png?X-Amz-Signature=SECRETSIG#x`,
      ])
      expect(api.sent).toHaveLength(1)
      const sent = api.sent[0]!
      expect(sent.method).toBe("sendPhoto")
      expect(sent.chat_id).toBe(CHAT_ID)
      expect(sent.parse_mode).toBe("HTML")
      expect(sent.disable_notification).toBe("true")
      expect(sent.message_thread_id).toBeUndefined()
      const caption = String(sent.caption)
      expect(caption).toContain("Tin từ AI")
      expect(caption).toContain("Ảnh &lt;mới&gt;")
      expect(caption.split("Ads MCP Simple")).toHaveLength(2)
      expect(sent.photo).toMatchObject({
        name: "photo.png",
        type: "image/png",
        size: PNG.length,
      })
      const rows = await deliveriesOf(mcp.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("sent")
      expect(rows[0]!.preview?.startsWith("[Ảnh: photo.png · ")).toBe(true)
      const logs = await callLogsOf(mcp.id)
      const json = JSON.stringify(logs)
      expect(json).not.toContain("SECRETSIG")
      const call = logs.find((l) => l.toolName === "telegram_send_message")!
      expect((call.request as Record<string, unknown>).file_url).toBe(
        `${FILES}/anh/photo.png?[redacted]`
      )
      expect(JSON.stringify(call.changes)).toContain("Ảnh photo.png (")
    })

    it("telegram_send_message file_content: CSV written by the AI → sendDocument with BOM + neutralised formulas; logged as a length", async () => {
      const mcp = await sender()
      const csv = 'chien_dich,chi_tieu\n=HYPERLINK("http://x"),100\nA,200\n'
      const r = await w.call(mcp.key, "telegram_send_message", {
        text: "Báo cáo tuần",
        file_content: csv,
        file_name: "bao cao tuan.csv",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.attachment).toMatchObject({
        kind: "document",
        file_name: "bao cao tuan.csv",
        mime: "text/csv",
      })
      expect(media.requests).toEqual([])
      const sent = api.sent[0]!
      expect(sent.method).toBe("sendDocument")
      const doc = sent.document as { name: string; bytes: Buffer }
      expect(doc.name).toBe("bao cao tuan.csv")
      expect([...doc.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      expect(doc.bytes.toString("utf8")).toContain(`'=HYPERLINK`)
      const call = (await callLogsOf(mcp.id)).find(
        (l) => l.toolName === "telegram_send_message"
      )!
      expect((call.request as Record<string, unknown>).file_content).toBe(
        `${csv.length} ký tự`
      )
      expect((await deliveriesOf(mcp.id))[0]!.preview).toMatch(
        /^\[Tệp: bao cao tuan\.csv · /
      )
    })

    it("telegram_send_message ChatGPT file: downloaded from download_url (never logged); a duplicate call with the same file_id sends nothing again", async () => {
      // both calls must fall in the same 2-minute dedupe bucket
      const toBoundary = 120_000 - (Date.now() % 120_000)
      if (toBoundary < 10_000)
        await new Promise((res) => setTimeout(res, toBoundary + 50))
      const mcp = await sender(5)
      const file = {
        download_url: `${OAI}/files/abc/download?sig=TOPSECRET`,
        file_id: `file_${w.prefix}`,
        mime_type: "application/pdf",
        file_name: "Báo cáo.pdf",
      }
      const first = await w.call(mcp.key, "telegram_send_message", {
        file,
        text: "Báo cáo PDF",
      })
      expect(first.isError, first.text).toBe(false)
      expect(first.sc).toMatchObject({
        sent_last_hour: 1,
        attachment: {
          kind: "document",
          file_name: "Báo cáo.pdf",
          mime: "application/pdf",
        },
      })
      expect(first.sc.duplicate).toBeUndefined()
      expect(api.sent[0]!.method).toBe("sendDocument")
      const second = await w.call(mcp.key, "telegram_send_message", {
        file: { ...file, download_url: `${OAI}/files/abc/download?sig=OTHERSECRET` },
        text: "Báo cáo PDF",
      })
      expect(second.isError, second.text).toBe(false)
      expect(second.sc).toMatchObject({
        duplicate: true,
        message_id: first.sc.message_id,
        sent_last_hour: 1,
      })
      // sent once, downloaded once (the duplicate is answered before any download), one delivery, the quota counts 1
      expect(api.sent).toHaveLength(1)
      expect(media.requests).toHaveLength(1)
      const rows = await deliveriesOf(mcp.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.dedupeKey).toMatch(
        new RegExp(`^cgf:${mcp.id}:[0-9a-f]{32}:\\d+$`)
      )
      expect(rows[0]!.dedupeKey).not.toContain(file.file_id)
      const json = JSON.stringify(await callLogsOf(mcp.id))
      expect(json).not.toContain("TOPSECRET")
      expect(json).not.toContain("OTHERSECRET")
      expect(json).not.toContain("oaiusercontent")
      expect(json).toContain("[redacted]")
    })

    it("telegram_send_message ChatGPT file whose earlier call is still pending → telegram_duplicate (never 'đã gửi'), nothing downloaded", async () => {
      await sameDedupeBucket()
      const mcp = await sender()
      const fileId = `file_p_${w.prefix}`
      await db.insert(notificationDeliveries).values({
        channelId: staffCh,
        source: "mcp_tool",
        eventType: "mcp_message",
        mcpId: mcp.id,
        dedupeKey: chatgptDedupeKey(mcp.id, fileId),
        status: "pending",
        preview: "x",
      })
      const r = await w.call(mcp.key, "telegram_send_message", {
        file: { download_url: `${OAI}/files/abc/download?sig=X`, file_id: fileId },
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("telegram_duplicate")
      expect(`${String(r.sc.message)} ${String(r.sc.hint)}`).not.toMatch(
        /đã (được )?gửi/
      )
      expect(media.requests).toEqual([])
      expect(api.sent).toHaveLength(0)
    })

    it("telegram_send_message: hourly quota already full → refused BEFORE any download, for every file source (ChatGPT file too)", async () => {
      await sameDedupeBucket()
      const mcp = await sender(1)
      const first = await w.call(mcp.key, "telegram_send_message", {
        text: "1",
      })
      expect(first.isError, first.text).toBe(false)
      for (const args of [
        { file_url: `${FILES}/anh/photo.png` },
        {
          file: {
            download_url: `${OAI}/files/abc/download?sig=X`,
            file_id: `file_q_${w.prefix}`,
          },
        },
        { file_content: "a,b", file_name: "a.csv" },
      ]) {
        const r = await w.call(mcp.key, "telegram_send_message", args)
        expect(r.sc.code).toBe("telegram_rate_limited")
      }
      expect(media.requests).toEqual([])
      expect(api.sent).toHaveLength(1)
    })

    it("telegram_send_message: every media attempt is counted before the download (failed ones too); past the limit → telegram_media_rate_limited, text unaffected", async () => {
      const mcp = await sender(200)
      const id = quotaId("telegram-media", mcp.id)
      const missing = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/missing/none.png`,
      })
      expect(missing.sc.code).toBe("telegram_file_fetch_failed")
      const [row] = await db
        .select()
        .from(verification)
        .where(eq(verification.id, id))
      expect(JSON.parse(row!.value)).toMatchObject({ count: 1 })
      // the window is now full
      await db
        .update(verification)
        .set({
          value: JSON.stringify({
            count: MEDIA_ATTEMPTS.perWindow,
            windowStart: Date.now(),
          }),
        })
        .where(eq(verification.id, id))
      media.requests.length = 0
      const limited = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/anh/photo.png`,
      })
      expect(limited.isError).toBe(true)
      expect(limited.sc.code).toBe("telegram_media_rate_limited")
      expect(String(limited.sc.message)).toContain("10 phút")
      expect(media.requests).toEqual([])
      expect(api.sent).toHaveLength(0)
      const log = (await callLogsOf(mcp.id)).find(
        (l) => l.errorCode === "telegram_media_rate_limited"
      )
      expect(log?.status).toBe("rate_limited")
      const text = await w.call(mcp.key, "telegram_send_message", {
        text: "vẫn gửi được tin chữ",
      })
      expect(text.isError, text.text).toBe(false)
    })

    it("telegram_send_message ChatGPT mobile chat_upload:// string → clear error, nothing downloaded or sent", async () => {
      const mcp = await sender()
      const r = await w.call(mcp.key, "telegram_send_message", {
        file: "chat_upload://image_0",
        text: "Ảnh",
      })
      expect(r.isError).toBe(true)
      expect(r.sc.code).toBe("chatgpt_file_unavailable")
      expect(String(r.sc.message)).toContain("chat_upload")
      expect(media.requests).toEqual([])
      expect(api.sent).toHaveLength(0)
      expect(await deliveriesOf(mcp.id)).toHaveLength(0)
    })

    it("telegram_send_message: two sources → error; a file without text is fine (title + footer only, MP4 as streaming video)", async () => {
      const mcp = await sender()
      const two = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/anh/photo.png`,
        file_content: "a,b",
        file_name: "a.csv",
      })
      expect(two.isError).toBe(true)
      expect(two.sc.code).toBe("attachment_conflict")
      const noText = await w.call(mcp.key, "telegram_send_message", {
        text: "   ",
      })
      expect(noText.sc.code).toBe("text_required")

      const video = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/clip/movie.mp4`,
      })
      expect(video.isError, video.text).toBe(false)
      expect(video.sc.attachment).toMatchObject({ kind: "video", mime: "video/mp4" })
      const sent = api.sent[0]!
      expect(sent.method).toBe("sendVideo")
      expect(sent.supports_streaming).toBe("true")
      const caption = String(sent.caption)
      expect(caption.startsWith("<b>🤖 Tin từ AI · MCP ")).toBe(true)
      expect(caption).toContain("Ads MCP Simple")
      expect(await deliveriesOf(mcp.id)).toHaveLength(1)
    })

    it("telegram_send_message: caption over 800 characters with a file, or a disallowed file type → error, quota untouched", async () => {
      const mcp = await sender()
      const long = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/anh/photo.png`,
        text: "x".repeat(801),
      })
      expect(long.isError).toBe(true)
      expect(long.sc.code).toBe("caption_too_long")
      expect(media.requests).toEqual([])
      const exe = await w.call(mcp.key, "telegram_send_message", {
        file_url: `${FILES}/bin/setup.png`,
        text: "cài đặt",
      })
      expect(exe.isError).toBe(true)
      expect(exe.sc.code).toBe("telegram_file_type_not_allowed")
      expect(String(exe.sc.hint ?? "")).toContain("PDF")
      expect(api.sent).toHaveLength(0)
      expect(await deliveriesOf(mcp.id)).toHaveLength(0)
      // the quota is still whole: a real message goes through and is the first of the hour
      const ok = await w.call(mcp.key, "telegram_send_message", { text: "ok" })
      expect(ok.sc.sent_last_hour).toBe(1)
    })

    it("telegram_send_message with a file is refused when telegram_tool is off (tool not registered)", async () => {
      const off = await w.mcp(w.users.staff, {
        platforms: metaRead(),
        notificationChannelIds: [staffCh],
      })
      const r = await w.call(off.key, "telegram_send_message", {
        file_url: `${FILES}/anh/photo.png`,
      })
      expect(r.isError).toBe(true)
      expect(media.requests).toEqual([])
      expect(api.sent).toHaveLength(0)
    })
  }
)
