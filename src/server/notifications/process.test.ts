// Integration tests (test Postgres; skipped without DATABASE_URL): enqueue dedupe / never throws, the notify.telegram
// handler (status updates, retry decisions, pacing claim), health transitions (once per day, recipients), MCP write
// scope check, sweep (lost jobs, expiry, update results) and retention cleanup. Telegram + pg-boss are fakes.
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { db } from "@/server/db/client"
import {
  connections,
  mcpNotificationScopes,
  mcpServers,
  notificationChannels,
  notificationDeliveries,
  systemUpdateRequests,
  user,
  type TelegramChannelConfig,
} from "@/server/db/schema"
import {
  encryptCredentials,
  refreshConnection,
} from "@/server/jobs/lib/connection-ops"
import { registerProvider } from "@/server/providers/registry"
import type { AdsProvider } from "@/server/providers/types"

import { encryptChannelToken } from "./deliver"
import { enqueueNotification } from "./enqueue"
import {
  healthTransition,
  notifyConnectionHealth,
  notifyMcpWrite,
  notifyRecentUpdateResults,
  vnDay,
} from "./events"
import {
  cleanupDeliveries,
  MAX_ATTEMPTS,
  processDelivery,
  retryDelaySec,
  sweepDeliveries,
} from "./process"
import { setNotificationJobSender, type NotifyJobData } from "./queue"
import type { FetchLike } from "./telegram"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-notif-q-${randomUUID().slice(0, 8)}`
const staffA = {
  id: `${PREFIX}-a`,
  email: `${PREFIX}-a@test.local`,
  role: "staff",
}
const staffB = {
  id: `${PREFIX}-b`,
  email: `${PREFIX}-b@test.local`,
  role: "staff",
}
const admin = {
  id: `${PREFIX}-admin`,
  email: `${PREFIX}-admin@test.local`,
  role: "admin",
}
const users = [staffA, staffB, admin]

const jobs: { name: string; data: NotifyJobData; startAfter?: number }[] = []

async function channel(
  ownerId: string,
  opts: {
    events?: string[]
    allConnections?: boolean
    status?: string
    chatType?: TelegramChannelConfig["chatType"]
    createdAt?: Date
  } = {}
) {
  const id = randomUUID()
  await db.insert(notificationChannels).values({
    id,
    ownerId,
    name: `${PREFIX} ch`,
    credentialsEncrypted: encryptChannelToken(id, TOKEN),
    credentialHint: "djfh",
    config: {
      chatId: "-100111",
      chatTitle: "Nhóm",
      chatType: opts.chatType ?? "supergroup",
      messageThreadId: null,
      botId: "1",
      botUsername: "ads_bot",
    },
    events: opts.events ?? ["connection_health"],
    allConnections: opts.allConnections ?? false,
    status: opts.status ?? "active",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  })
  return id
}

async function deliveriesOf(channelId: string) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))
}

function tgFetch(
  ...responses: (() => Response)[]
): FetchLike & { calls: number } {
  let i = 0
  const f = (async () => {
    f.calls++
    const r = responses[Math.min(i++, responses.length - 1)]!
    return r()
  }) as unknown as FetchLike & { calls: number }
  f.calls = 0
  return f
}
const okSend = () =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
    status: 200,
  })
const tgErr = (code: number, description: string, parameters?: unknown) => () =>
  new Response(
    JSON.stringify({ ok: false, error_code: code, description, parameters }),
    { status: code }
  )

const noSleep = async () => {}

describe.skipIf(!HAS_DB)("notifications queue + events (DB)", () => {
  beforeAll(async () => {
    await db
      .insert(user)
      .values(
        users.map((u) => ({
          id: u.id,
          name: u.id,
          email: u.email,
          role: u.role,
          emailVerified: true,
        }))
      )
    setNotificationJobSender(async (name, data, options) => {
      jobs.push({
        name,
        data: data as NotifyJobData,
        startAfter: options?.startAfter,
      })
    })
  })

  afterAll(async () => {
    const ids = users.map((u) => u.id)
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, ids))
    await db
      .delete(notificationChannels)
      .where(inArray(notificationChannels.ownerId, ids))
    await db.delete(connections).where(inArray(connections.ownerId, ids))
    await db.delete(user).where(inArray(user.id, ids))
    setNotificationJobSender(null)
  })

  beforeEach(() => {
    jobs.length = 0
  })

  // -------------------------------------------------------------------------
  it("enqueue: 1 delivery pending + 1 job mỗi kênh; dedupe theo kênh; kênh lỗi → failed ngay; kênh tắt → bỏ qua", async () => {
    const a = await channel(staffA.id)
    const broken = await channel(staffA.id, { status: "error" })
    const off = await channel(staffA.id, { status: "disabled" })
    const input = {
      channelIds: [a, broken, off],
      source: "system" as const,
      eventType: "update_available" as const,
      dedupeKey: `${PREFIX}:k1`,
      text: "<b>x</b>",
    }
    const r1 = await enqueueNotification(input)
    expect(r1.queued).toHaveLength(1)
    expect(r1.failed).toHaveLength(1)
    expect(jobs).toEqual([
      {
        name: "notify.telegram",
        data: { deliveryId: r1.queued[0], attempt: 0 },
        startAfter: undefined,
      },
    ])
    const r2 = await enqueueNotification(input)
    expect(r2).toEqual({ queued: [], failed: [] })
    expect(await deliveriesOf(a)).toHaveLength(1)
    expect((await deliveriesOf(broken))[0]!.status).toBe("failed")
    expect(await deliveriesOf(off)).toHaveLength(0)
    // no dedupe key → every call is sent
    await enqueueNotification({ ...input, channelIds: [a], dedupeKey: null })
    await enqueueNotification({ ...input, channelIds: [a], dedupeKey: null })
    expect(await deliveriesOf(a)).toHaveLength(3)
  })

  it("enqueue không bao giờ ném lỗi (lỗi DB, không queue được job, id rác)", async () => {
    const a = await channel(staffA.id)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // CHECK constraint violation on source → the insert throws inside enqueue
    await expect(
      enqueueNotification({
        channelIds: [a],
        source: "bogus" as never,
        eventType: "test",
        text: "x",
      })
    ).resolves.toEqual({ queued: [], failed: [] })
    expect(spy).toHaveBeenCalled()
    setNotificationJobSender(async () => {
      throw new Error("queue down")
    })
    const r = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "x",
    })
    expect(r.queued).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    setNotificationJobSender(async (name, data, options) => {
      jobs.push({
        name,
        data: data as NotifyJobData,
        startAfter: options?.startAfter,
      })
    })
    await expect(
      enqueueNotification({
        channelIds: ["not-a-uuid"],
        source: "system",
        eventType: "test",
        text: "x",
      })
    ).resolves.toEqual({ queued: [], failed: [] })
  })

  // -------------------------------------------------------------------------
  it("job gửi thành công: sent + message_id, xoá nội dung đầy đủ, cập nhật last_sent_at; job trùng bị bỏ qua", async () => {
    const a = await channel(staffA.id)
    const { queued } = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "<b>hi</b>",
    })
    const id = queued[0]!
    const f = tgFetch(okSend)
    expect(
      await processDelivery(
        { deliveryId: id, attempt: 0 },
        { fetchImpl: f, sleep: noSleep }
      )
    ).toEqual({ result: "sent", messageId: 99 })
    const [d] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id))
    expect(d).toMatchObject({
      status: "sent",
      attempts: 1,
      telegramMessageId: 99,
      message: null,
      preview: "hi",
    })
    const [ch] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, a))
    expect(ch!.lastSentAt).not.toBeNull()
    expect(
      (
        await processDelivery(
          { deliveryId: id, attempt: 0 },
          { fetchImpl: f, sleep: noSleep }
        )
      ).result
    ).toBe("skipped")
    expect(f.calls).toBe(1)
  })

  it("429 → thử lại sau retry_after + jitter; 5xx → 60 s rồi 5 phút; tối đa 4 lần rồi failed", async () => {
    const a = await channel(staffA.id, { chatType: "private" })
    const { queued } = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "x",
    })
    const id = queued[0]!
    jobs.length = 0
    const r1 = await processDelivery(
      { deliveryId: id, attempt: 0 },
      {
        fetchImpl: tgFetch(
          tgErr(429, "Too Many Requests: retry after 7", { retry_after: 7 })
        ),
        sleep: noSleep,
        rand: () => 0,
      }
    )
    expect(r1).toEqual({ result: "retry", afterSec: 8, attempts: 1 })
    expect(jobs.at(-1)).toMatchObject({
      data: { deliveryId: id, attempt: 1 },
      startAfter: 8,
    })
    // the stale attempt-0 job does nothing
    expect(
      (
        await processDelivery(
          { deliveryId: id, attempt: 0 },
          { sleep: noSleep }
        )
      ).result
    ).toBe("skipped")
    const r2 = await processDelivery(
      { deliveryId: id, attempt: 1 },
      { fetchImpl: tgFetch(tgErr(502, "Bad Gateway")), sleep: noSleep }
    )
    expect(r2).toEqual({ result: "retry", afterSec: 60, attempts: 2 })
    const r3 = await processDelivery(
      { deliveryId: id, attempt: 2 },
      { fetchImpl: tgFetch(tgErr(500, "Internal")), sleep: noSleep }
    )
    expect(r3).toEqual({ result: "retry", afterSec: 300, attempts: 3 })
    const r4 = await processDelivery(
      { deliveryId: id, attempt: 3 },
      { fetchImpl: tgFetch(tgErr(500, "Internal")), sleep: noSleep }
    )
    expect(r4.result).toBe("failed")
    const [d] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id))
    expect(d).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorCode: 500,
      message: null,
    })
    expect(retryDelaySec("network", 1, null)).toBe(10)
  })

  it("403 → failed ngay (không thử lại), kênh chuyển error kèm lý do; job sau đó của kênh lỗi bị bỏ", async () => {
    const a = await channel(staffA.id)
    const { queued } = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "x",
    })
    jobs.length = 0
    const r = await processDelivery(
      { deliveryId: queued[0]!, attempt: 0 },
      {
        fetchImpl: tgFetch(
          tgErr(403, "Forbidden: bot was kicked from the supergroup chat")
        ),
        sleep: noSleep,
      }
    )
    expect(r).toEqual({ result: "failed", reason: "forbidden" })
    expect(jobs).toHaveLength(0)
    const [ch] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, a))
    expect(ch!.status).toBe("error")
    expect(ch!.statusMessage).toContain("@ads_bot")
    // a delivery queued before the channel broke is skipped with an explanation
    await db
      .insert(notificationDeliveries)
      .values({
        channelId: a,
        source: "system",
        eventType: "test",
        status: "pending",
        preview: "p",
        message: "x",
      })
    const [p] = (await deliveriesOf(a)).filter((d) => d.status === "pending")
    expect(
      (
        await processDelivery(
          { deliveryId: p!.id, attempt: 0 },
          { sleep: noSleep }
        )
      ).result
    ).toBe("failed")
    const [after] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, p!.id))
    expect(after!.errorMessage).toContain("Kết nối Telegram đang lỗi")
  })

  it("nhóm migrate → cập nhật chat id của kênh; nhóm đã 19 tin/phút → hoãn, không tốn lượt", async () => {
    const a = await channel(staffA.id, { chatType: "group" })
    const { queued } = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "x",
    })
    const f = tgFetch(
      tgErr(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -100999,
      }),
      okSend
    )
    expect(
      (
        await processDelivery(
          { deliveryId: queued[0]!, attempt: 0 },
          { fetchImpl: f, sleep: noSleep }
        )
      ).result
    ).toBe("sent")
    const [ch] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, a))
    expect(ch!.config).toMatchObject({
      chatId: "-100999",
      chatType: "supergroup",
    })

    const now = Date.now()
    await db
      .insert(notificationDeliveries)
      .values(
        Array.from({ length: 19 }, () => ({
          channelId: a,
          source: "system",
          eventType: "test",
          status: "sent",
          preview: "",
          sentAt: new Date(now - 30_000),
        }))
      )
    const next = await enqueueNotification({
      channelIds: [a],
      source: "system",
      eventType: "test",
      text: "y",
    })
    jobs.length = 0
    const r = await processDelivery(
      { deliveryId: next.queued[0]!, attempt: 0 },
      { sleep: noSleep, now: () => now }
    )
    expect(r.result).toBe("deferred")
    expect(jobs[0]).toMatchObject({
      data: { deliveryId: next.queued[0], attempt: 0 },
    })
    const [d] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, next.queued[0]!))
    expect(d!.attempts).toBe(0)
  })

  // -------------------------------------------------------------------------
  it("chuyển trạng thái kết nối: đúng các cặp chuyển, gửi 1 lần/ngày, đúng người nhận", async () => {
    expect(healthTransition("active", "expiring")).toBe("connection_expiring")
    expect(healthTransition("expiring", "invalid")).toBe("connection_invalid")
    expect(healthTransition("invalid", "active")).toBe("connection_recovered")
    expect(healthTransition("active", "active")).toBeNull()
    expect(healthTransition("disabled", "active")).toBeNull()
    expect(healthTransition("invalid", "expiring")).toBeNull()

    const connId = randomUUID()
    await db
      .insert(connections)
      .values({
        id: connId,
        ownerId: staffA.id,
        platform: "meta",
        name: `${PREFIX} conn`,
        credentialsEncrypted: encryptCredentials(connId, {}),
      })
    const own = await channel(staffA.id)
    const otherStaff = await channel(staffB.id)
    const adminAll = await channel(admin.id, { allConnections: true })
    const adminOwnOnly = await channel(admin.id)
    const unsubscribed = await channel(staffA.id, { events: [] })

    const day1 = new Date("2026-10-08T10:00:00Z")
    await notifyConnectionHealth({
      connectionId: connId,
      before: "active",
      after: "invalid",
      statusMessage: "Token bị thu hồi",
      now: day1,
    })
    await notifyConnectionHealth({
      connectionId: connId,
      before: "active",
      after: "invalid",
      statusMessage: "Token bị thu hồi",
      now: day1,
    })
    await notifyConnectionHealth({
      connectionId: connId,
      before: "active",
      after: "active",
      now: day1,
    })
    expect(await deliveriesOf(own)).toHaveLength(1)
    expect(await deliveriesOf(adminAll)).toHaveLength(1)
    expect(await deliveriesOf(otherStaff)).toHaveLength(0)
    expect(await deliveriesOf(adminOwnOnly)).toHaveLength(0)
    expect(await deliveriesOf(unsubscribed)).toHaveLength(0)
    const [d] = await deliveriesOf(own)
    expect(d).toMatchObject({
      eventType: "connection_invalid",
      source: "system",
      dedupeKey: `conn:${connId}:invalid:${vnDay(day1)}`,
    })
    expect(d!.preview).toContain("Token bị thu hồi")
    // next Vietnamese day (UTC 17:00+ = next day in Asia/Ho_Chi_Minh) → a new message
    await notifyConnectionHealth({
      connectionId: connId,
      before: "active",
      after: "invalid",
      now: new Date("2026-10-08T18:00:00Z"),
    })
    expect(await deliveriesOf(own)).toHaveLength(2)
  })

  it("refreshConnection (job tokens.health) gửi cảnh báo khi kết nối chuyển sang invalid", async () => {
    const fake = {
      platform: "meta",
      async validateCredentials() {
        return {
          valid: false,
          tokenExpiresAt: null,
          scopes: null,
          warnings: ["Token Meta đã bị thu hồi."],
          meta: {},
        }
      },
    } as unknown as AdsProvider<unknown>
    registerProvider(fake)
    const connId = randomUUID()
    await db
      .insert(connections)
      .values({
        id: connId,
        ownerId: staffB.id,
        platform: "meta",
        name: `${PREFIX} conn2`,
        status: "active",
        credentialsEncrypted: encryptCredentials(connId, { accessToken: "x" }),
      })
    const ch = await channel(staffB.id)
    const res = await refreshConnection(connId, { syncAccounts: false })
    expect(res?.status).toBe("invalid")
    const ds = await deliveriesOf(ch)
    expect(ds).toHaveLength(1)
    expect(ds[0]!.eventType).toBe("connection_invalid")
    // still invalid on the next run: no transition, no new message
    await db
      .update(connections)
      .set({ status: "invalid" })
      .where(eq(connections.id, connId))
    await refreshConnection(connId, { syncAccounts: false })
    expect(await deliveriesOf(ch)).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  it("notifyMcpWrite chỉ gửi tới kênh nằm trong scope của chính MCP đó", async () => {
    const mcpId = randomUUID()
    await db
      .insert(mcpServers)
      .values({
        id: mcpId,
        ownerId: staffA.id,
        name: `${PREFIX} mcp`,
        keyHash: `h-${mcpId}`,
        keyPrefix: "amcp_x",
        keyEncrypted: "v1.x.y.z",
      })
    const inScope = await channel(staffA.id, { events: [] })
    const notInScope = await channel(staffA.id, { events: [] })
    await db.insert(mcpNotificationScopes).values({ mcpId, channelId: inScope })
    await notifyMcpWrite({
      mcpId,
      mcpName: "Báo cáo",
      channelIds: [inScope, notInScope],
      platform: "meta",
      accountId: "act_1",
      toolName: "ads_set_status",
      changes: [
        {
          objectId: "1",
          objectName: "QC A",
          level: "ad",
          field: "status",
          before: "ACTIVE",
          after: "PAUSED",
        },
      ],
      reason: "CPA cao",
    })
    const ds = await deliveriesOf(inScope)
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({
      source: "mcp_write",
      eventType: "mcp_write",
      mcpId,
    })
    expect(ds[0]!.message).toContain("AI đã tạm dừng 1 quảng cáo")
    expect(await deliveriesOf(notInScope)).toHaveLength(0)
    await expect(
      notifyMcpWrite({
        mcpId: "bad",
        mcpName: "x",
        channelIds: ["bad"],
        platform: "meta",
        toolName: "t",
        changes: [],
      })
    ).resolves.toBeUndefined()
  })

  it("sweep: queue lại job bị mất, bỏ delivery quá 1 giờ, báo kết quả cập nhật 1 lần cho kênh admin", async () => {
    const a = await channel(staffA.id)
    const now = new Date()
    const [lost] = await db
      .insert(notificationDeliveries)
      .values({
        channelId: a,
        source: "system",
        eventType: "test",
        status: "pending",
        preview: "",
        message: "x",
        createdAt: new Date(now.getTime() - 3 * 60_000),
      })
      .returning()
    const [stuck] = await db
      .insert(notificationDeliveries)
      .values({
        channelId: a,
        source: "system",
        eventType: "test",
        status: "pending",
        attempts: 2,
        preview: "",
        message: "x",
        createdAt: new Date(now.getTime() - 2 * 3600_000),
      })
      .returning()
    const adminCh = await channel(admin.id, {
      events: ["system_update"],
      createdAt: new Date(now.getTime() - 86_400_000),
    })
    const staffCh = await channel(staffA.id, { events: ["system_update"] }) // not admin → never
    const [req] = await db
      .insert(systemUpdateRequests)
      .values({
        fromVersion: "1.0.0",
        targetVersion: "1.0.9",
        status: "succeeded",
        message: "Đã cập nhật",
        finishedAt: now,
      })
      .returning()
    try {
      jobs.length = 0
      const r = await sweepDeliveries({ now })
      expect(r.requeued).toBeGreaterThanOrEqual(1)
      expect(jobs.map((j) => j.data.deliveryId)).toContain(lost!.id)
      const [s] = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, stuck!.id))
      expect(s).toMatchObject({ status: "failed", message: null })
      const updates = await deliveriesOf(adminCh)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        eventType: "update_succeeded",
        dedupeKey: `update-result:${req!.id}`,
      })
      expect(await deliveriesOf(staffCh)).toHaveLength(0)
      await notifyRecentUpdateResults({ now })
      expect(await deliveriesOf(adminCh)).toHaveLength(1)
    } finally {
      await db
        .delete(systemUpdateRequests)
        .where(eq(systemUpdateRequests.id, req!.id))
    }
  })

  it("cleanup xoá delivery cũ hơn số tháng lưu log MCP", async () => {
    const a = await channel(staffA.id)
    const old = new Date()
    old.setMonth(old.getMonth() - 5)
    await db.insert(notificationDeliveries).values([
      {
        channelId: a,
        source: "system",
        eventType: "test",
        status: "sent",
        preview: "old",
        createdAt: old,
      },
      {
        channelId: a,
        source: "system",
        eventType: "test",
        status: "sent",
        preview: "new",
      },
    ])
    expect(await cleanupDeliveries(3)).toBeGreaterThanOrEqual(1)
    expect((await deliveriesOf(a)).map((d) => d.preview)).toEqual(["new"])
  })
})
