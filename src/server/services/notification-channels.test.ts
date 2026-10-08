// Integration tests for the notification channels service (Telegram) against the test Postgres (skipped without
// DATABASE_URL). The Bot API is a fake `fetch` - no network.
import { randomUUID } from "node:crypto"
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

const hooks = vi.hoisted(() => ({ failLog: false }))

vi.mock("server-only", () => ({}))
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...mod,
    logActivity: async (
      entry: Parameters<typeof mod.logActivity>[0],
      tx?: Parameters<typeof mod.logActivity>[1]
    ) => {
      if (hooks.failLog) throw new Error("simulated activity log failure")
      return mod.logActivity({ ...entry, ip: null, userAgent: null }, tx)
    },
  }
})

import { aad, decryptSecret } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  activityLogs,
  mcpNotificationScopes,
  mcpServers,
  notificationChannels,
  user,
} from "@/server/db/schema"

import {
  assertChannelsUsableForMcp,
  channelsUsableForMcp,
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannel,
  listChannelsForMcpScope,
  listNotificationChannels,
  listNotificationDeliveries,
  NotificationServiceError,
  recheckNotificationChannel,
  replaceNotificationChannelToken,
  sendNotificationChannelTest,
  setNotificationChannelEnabled,
  updateNotificationChannel,
  type Actor,
} from "./notification-channels"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const TOKEN2 = "123456789:BBBhBP0av28dfjdk3rn4kbhfh2-8sdjfsXYZW"

// ---------------------------------------------------------------------------
// Fake Bot API
// ---------------------------------------------------------------------------

const api = {
  calls: [] as { method: string; payload: Record<string, unknown> }[],
  validTokens: new Set([TOKEN, TOKEN2]),
  chats: new Map<
    string,
    { id: number; type: string; title: string; is_forum?: boolean }
  >(),
  /** method → forced error response */
  fail: new Map<string, { code: number; description: string }>(),
}

function resetApi() {
  api.calls = []
  api.fail.clear()
  api.chats.clear()
  api.chats.set("-100111", {
    id: -100111,
    type: "supergroup",
    title: "Nhóm QC",
    is_forum: true,
  })
  api.chats.set("-100222", { id: -100222, type: "supergroup", title: "Nhóm 2" })
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function fakeFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url = String(input)
  const m = /\/bot([^/]+)\/(\w+)$/.exec(url)
  if (!m)
    return respond(
      { ok: false, error_code: 404, description: "Not Found" },
      404
    )
  const [, token, method] = m as unknown as [string, string, string]
  const payload = JSON.parse(String(init?.body ?? "{}")) as Record<
    string,
    unknown
  >
  api.calls.push({ method, payload })
  if (!api.validTokens.has(token))
    return respond(
      { ok: false, error_code: 401, description: "Unauthorized" },
      401
    )
  const forced = api.fail.get(method)
  if (forced)
    return respond(
      { ok: false, error_code: forced.code, description: forced.description },
      forced.code
    )
  const botId = token === TOKEN ? 987654 : 111222
  if (method === "getMe")
    return respond({
      ok: true,
      result: {
        id: botId,
        is_bot: true,
        first_name: "Bot",
        username: token === TOKEN ? "ads_bot" : "new_bot",
      },
    })
  if (method === "getChat") {
    const c = api.chats.get(String(payload.chat_id))
    return c
      ? respond({ ok: true, result: c })
      : respond(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: chat not found",
          },
          400
        )
  }
  if (method === "getChatMember")
    return respond({ ok: true, result: { status: "member" } })
  if (method === "sendMessage")
    return respond({ ok: true, result: { message_id: 77 } })
  return respond({ ok: false, error_code: 404, description: "Not Found" }, 404)
}

// ---------------------------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-notif-svc-${randomUUID().slice(0, 8)}`
const staffA: Actor = {
  id: `${PREFIX}-a`,
  email: `${PREFIX}-a@test.local`,
  role: "staff",
}
const staffB: Actor = {
  id: `${PREFIX}-b`,
  email: `${PREFIX}-b@test.local`,
  role: "staff",
}
const admin: Actor = {
  id: `${PREFIX}-admin`,
  email: `${PREFIX}-admin@test.local`,
  role: "admin",
}
const actors = [staffA, staffB, admin]

function newChannel(
  owner: Actor,
  name: string,
  extra: Partial<Parameters<typeof createNotificationChannel>[1]> = {}
) {
  return createNotificationChannel(owner, {
    name: `${PREFIX} ${name}`,
    botToken: TOKEN,
    chatId: "-100111",
    messageThreadId: null,
    events: ["connection_health"],
    allConnections: false,
    ...extra,
  })
}

async function newMcp(owner: Actor, name: string) {
  const id = randomUUID()
  await db
    .insert(mcpServers)
    .values({
      id,
      ownerId: owner.id,
      name: `${PREFIX} ${name}`,
      keyHash: `h-${id}`,
      keyPrefix: "amcp_x",
      keyEncrypted: "v1.x.y.z",
    })
  return id
}

describe.skipIf(!HAS_DB)("notification channels service (DB)", () => {
  beforeAll(async () => {
    await db
      .insert(user)
      .values(
        actors.map((a) => ({
          id: a.id,
          name: a.id,
          email: a.email,
          role: a.role,
          emailVerified: true,
        }))
      )
  })

  afterAll(async () => {
    const ids = actors.map((a) => a.id)
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, ids))
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, ids))
    await db
      .delete(notificationChannels)
      .where(inArray(notificationChannels.ownerId, ids))
    await db.delete(user).where(inArray(user.id, ids))
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    resetApi()
    hooks.failLog = false
    vi.stubGlobal("fetch", vi.fn(fakeFetch))
  })

  it("mã hoá bot token (AAD gắn id), lưu hint + chat chuẩn + activity log; token không bao giờ có trong kết quả", async () => {
    const { id, check } = await newChannel(staffA, "encrypt", {
      messageThreadId: 5,
    })
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
    expect(row!.credentialsEncrypted).not.toContain(TOKEN)
    expect(
      decryptSecret(
        row!.credentialsEncrypted,
        aad.notificationChannelCredentials(id)
      )
    ).toBe(TOKEN)
    expect(() =>
      decryptSecret(
        row!.credentialsEncrypted,
        aad.notificationChannelCredentials(randomUUID())
      )
    ).toThrow()
    expect(row!.credentialHint).toBe("djfh")
    expect(row!.config).toMatchObject({
      chatId: "-100111",
      chatTitle: "Nhóm QC",
      chatType: "supergroup",
      messageThreadId: 5,
      botId: "987654",
      botUsername: "ads_bot",
    })
    expect(check.bot.username).toBe("ads_bot")
    expect(api.calls.map((c) => c.method)).toEqual([
      "getMe",
      "getChat",
      "getChatMember",
    ])

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.targetId, id),
          eq(activityLogs.action, "notification_channel.create")
        )
      )
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(TOKEN)

    await sendNotificationChannelTest(staffA, id)
    const outputs = [
      check,
      await listNotificationChannels(staffA),
      await getNotificationChannel(staffA, id),
      await listNotificationDeliveries(staffA, id),
      await listChannelsForMcpScope(staffA),
    ]
    for (const o of outputs) {
      const s = JSON.stringify(o)
      expect(s).not.toContain(TOKEN)
      expect(s).not.toContain(row!.credentialsEncrypted)
      expect(s).not.toContain("credentialsEncrypted")
    }
  })

  it("activity log lỗi → không lưu kênh (cùng transaction)", async () => {
    hooks.failLog = true
    await expect(newChannel(staffA, "tx-fail")).rejects.toThrow()
    hooks.failLog = false
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.name, `${PREFIX} tx-fail`))
    expect(rows).toHaveLength(0)
  })

  it("staff không thấy / không dùng được kênh của người khác; admin thấy tất cả kèm người tạo nhưng MCP chỉ dùng kênh của chủ MCP", async () => {
    const { id } = await newChannel(staffA, "owner")
    expect(
      (await listNotificationChannels(staffB)).find((c) => c.id === id)
    ).toBeUndefined()
    expect(
      (await listChannelsForMcpScope(staffB)).find((c) => c.id === id)
    ).toBeUndefined()
    const seen = (await listNotificationChannels(admin)).find(
      (c) => c.id === id
    )
    expect(seen?.owner.email).toBe(staffA.email)
    // MCP options = channels of the MCP owner only: an admin's own MCP never lists a staff channel
    expect(
      (await listChannelsForMcpScope(admin)).find((c) => c.id === id)
    ).toBeUndefined()
    // an admin editing staffA's MCP gets staffA's channels
    expect(
      (await listChannelsForMcpScope({ id: staffA.id })).find(
        (c) => c.id === id
      )?.owner.email
    ).toBe(staffA.email)
    for (const run of [
      () => getNotificationChannel(staffB, id),
      () => updateNotificationChannel(staffB, { channelId: id, name: "hack" }),
      () => replaceNotificationChannelToken(staffB, { channelId: id, botToken: TOKEN2 }),
      () => recheckNotificationChannel(staffB, id),
      () => sendNotificationChannelTest(staffB, id),
      () => setNotificationChannelEnabled(staffB, { channelId: id, enabled: false }),
      () => deleteNotificationChannel(staffB, id),
      () => listNotificationDeliveries(staffB, id),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(NotificationServiceError)
    }
    await expect(
      assertChannelsUsableForMcp(staffB, [id])
    ).rejects.toBeInstanceOf(NotificationServiceError)
    await expect(assertChannelsUsableForMcp(staffA, [id])).resolves.toEqual([
      id,
    ])
    await expect(
      assertChannelsUsableForMcp(admin, [id])
    ).rejects.toBeInstanceOf(NotificationServiceError)
    await expect(channelsUsableForMcp(admin, [id])).resolves.toEqual([])
    await expect(channelsUsableForMcp(staffA, [id, id])).resolves.toEqual([id])
  })

  it("system_update / mọi kết nối chỉ dành cho kênh của admin", async () => {
    await expect(
      newChannel(staffA, "x", { events: ["system_update"] })
    ).rejects.toBeInstanceOf(NotificationServiceError)
    await expect(
      newChannel(staffA, "y", { allConnections: true })
    ).rejects.toBeInstanceOf(NotificationServiceError)
    const { id } = await newChannel(staffA, "staff-own")
    // an admin editing a staff channel cannot subscribe it to admin-only events either
    await expect(
      updateNotificationChannel(admin, {
        channelId: id,
        events: ["system_update"],
      })
    ).rejects.toBeInstanceOf(NotificationServiceError)
    const adminCh = await newChannel(admin, "admin", {
      events: ["connection_health", "system_update"],
      allConnections: true,
    })
    expect(
      (await getNotificationChannel(admin, adminCh.id)).events.sort()
    ).toEqual(["connection_health", "system_update"])
  })

  it("chat sai → lỗi ở trường chatId; đổi tên không gọi Telegram; đổi chat được kiểm tra lại", async () => {
    await expect(
      newChannel(staffA, "bad-chat", { chatId: "-100999" })
    ).rejects.toMatchObject({ fieldErrors: { chatId: expect.any(String) } })
    const { id } = await newChannel(staffA, "edit")
    api.calls = []
    const renamed = await updateNotificationChannel(staffA, {
      channelId: id,
      name: `${PREFIX} renamed`,
    })
    expect(renamed.name).toBe(`${PREFIX} renamed`)
    expect(api.calls).toHaveLength(0)
    const moved = await updateNotificationChannel(staffA, {
      channelId: id,
      chatId: "-100222",
    })
    expect(moved.chatTitle).toBe("Nhóm 2")
    expect(api.calls.map((c) => c.method)).toContain("getChat")
    await expect(
      updateNotificationChannel(staffA, { channelId: id, messageThreadId: 9 })
    ).rejects.toMatchObject({
      fieldErrors: { messageThreadId: expect.any(String) },
    })
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.targetId, id),
          eq(activityLogs.action, "notification_channel.update")
        )
      )
    expect(logs).toHaveLength(2)
  })

  it("gửi tin thử: ghi delivery source test; 403 → kênh lỗi + lý do; gửi lại được → kênh hoạt động lại", async () => {
    const { id } = await newChannel(staffA, "test-send")
    const ok1 = await sendNotificationChannelTest(staffA, id)
    expect(ok1).toMatchObject({
      ok: true,
      error: null,
      channelStatus: "active",
    })
    const send = api.calls.find((c) => c.method === "sendMessage")!
    expect(send.payload).toMatchObject({
      chat_id: "-100111",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })

    api.fail.set("sendMessage", {
      code: 403,
      description: "Forbidden: bot was kicked from the supergroup chat",
    })
    const bad = await sendNotificationChannelTest(staffA, id)
    expect(bad.ok).toBe(false)
    expect(bad.channelStatus).toBe("error")
    expect(bad.error).toContain("@ads_bot")
    const detail = await getNotificationChannel(staffA, id)
    expect(detail.status).toBe("error")
    expect(detail.statusMessage).toContain("Kiểm tra lại")

    api.fail.clear()
    expect((await sendNotificationChannelTest(staffA, id)).channelStatus).toBe(
      "active"
    )
    const deliveries = await listNotificationDeliveries(staffA, id)
    expect(deliveries.map((d) => [d.source, d.status])).toEqual([
      ["test", "sent"],
      ["test", "failed"],
      ["test", "sent"],
    ])
    expect(deliveries[1]!.errorCode).toBe(403)
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.targetId, id),
          eq(activityLogs.action, "notification_channel.test")
        )
      )
    expect(logs.map((l) => l.status).sort()).toEqual([
      "failure",
      "success",
      "success",
    ])
  })

  it("gửi tin thử: trạng thái kênh + activity log trong cùng transaction (log lỗi → kênh không đổi, delivery vẫn ghi)", async () => {
    const { id } = await newChannel(staffA, "test-send-tx")
    await db
      .update(notificationChannels)
      .set({ status: "error", statusMessage: "bot bị kick" })
      .where(eq(notificationChannels.id, id))
    hooks.failLog = true
    await expect(sendNotificationChannelTest(staffA, id)).rejects.toThrow()
    hooks.failLog = false
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
    // Telegram accepted the message, but the status change rolled back with the failed activity log
    expect(row!.status).toBe("error")
    expect(row!.lastSentAt).toBeNull()
    expect(
      (await listNotificationDeliveries(staffA, id)).map((d) => d.status)
    ).toEqual(["sent"])

    const ok = await sendNotificationChannelTest(staffA, id)
    expect(ok).toMatchObject({ ok: true, channelStatus: "active" })
    const [after] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
    expect(after!.status).toBe("active")
    expect(after!.lastSentAt).not.toBeNull()
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.targetId, id),
          eq(activityLogs.action, "notification_channel.test")
        )
      )
    expect(logs).toHaveLength(1)
    expect(logs[0]!.metadata).toMatchObject({
      kind: "send",
      before: { status: "error" },
      after: { status: "active" },
    })
  })

  it("kiểm tra lại: lỗi cấu hình → error; Telegram không phản hồi → giữ trạng thái", async () => {
    const { id } = await newChannel(staffA, "recheck")
    api.fail.set("getChat", {
      code: 400,
      description: "Bad Request: chat not found",
    })
    const r = await recheckNotificationChannel(staffA, id)
    expect(r).toMatchObject({ ok: false, status: "error" })
    api.fail.set("getChat", { code: 502, description: "Bad Gateway" })
    expect((await recheckNotificationChannel(staffA, id)).status).toBe("error")
    api.fail.clear()
    expect(await recheckNotificationChannel(staffA, id)).toMatchObject({
      ok: true,
      status: "active",
      statusMessage: null,
    })
  })

  it("thay token: kiểm tra token mới với chat hiện tại, cập nhật hint/bot, activity token.replace", async () => {
    const { id } = await newChannel(staffA, "replace")
    const res = await replaceNotificationChannelToken(staffA, {
      channelId: id,
      botToken: TOKEN2,
    })
    expect(res.bot.username).toBe("new_bot")
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
    expect(
      decryptSecret(
        row!.credentialsEncrypted,
        aad.notificationChannelCredentials(id)
      )
    ).toBe(TOKEN2)
    expect(row!.credentialHint).toBe("XYZW")
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.targetId, id),
          eq(activityLogs.action, "notification_channel.token.replace")
        )
      )
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(TOKEN2)
  })

  it("tắt/bật ghi log; xoá mềm: xoá token, bỏ khỏi scope MCP, báo MCP đang dùng", async () => {
    const { id } = await newChannel(staffA, "lifecycle")
    expect(
      (
        await setNotificationChannelEnabled(staffA, {
          channelId: id,
          enabled: false,
        })
      ).status
    ).toBe("disabled")
    await expect(
      sendNotificationChannelTest(staffA, id)
    ).rejects.toBeInstanceOf(NotificationServiceError)
    expect(
      (
        await setNotificationChannelEnabled(staffA, {
          channelId: id,
          enabled: true,
        })
      ).status
    ).toBe("active")
    const actions = (
      await db.select().from(activityLogs).where(eq(activityLogs.targetId, id))
    ).map((l) => l.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        "notification_channel.disable",
        "notification_channel.enable",
      ])
    )

    const mcpA = await newMcp(staffA, "mcp-a")
    const mcpAdmin = await newMcp(admin, "mcp-admin")
    await db.insert(mcpNotificationScopes).values([
      { mcpId: mcpA, channelId: id },
      { mcpId: mcpAdmin, channelId: id },
    ])
    expect((await getNotificationChannel(staffA, id)).usedBy).toEqual(
      expect.arrayContaining([
        { id: mcpA, name: `${PREFIX} mcp-a`, ownedByViewer: true },
        { id: null, name: null, ownedByViewer: false },
      ])
    )
    const del = await deleteNotificationChannel(staffA, id)
    expect(del).toEqual({ affectedMcpIds: [mcpA], affectedMcpCount: 2 })
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
    expect(row!.deletedAt).not.toBeNull()
    expect(
      decryptSecret(
        row!.credentialsEncrypted,
        aad.notificationChannelCredentials(id)
      )
    ).toBe("")
    expect(
      await db
        .select()
        .from(mcpNotificationScopes)
        .where(eq(mcpNotificationScopes.channelId, id))
    ).toHaveLength(0)
    await expect(getNotificationChannel(staffA, id)).rejects.toBeInstanceOf(
      NotificationServiceError
    )
    expect(
      (
        await db
          .select()
          .from(activityLogs)
          .where(
            and(
              eq(activityLogs.targetId, id),
              eq(activityLogs.action, "notification_channel.delete")
            )
          )
      ).length
    ).toBe(1)
  })
})
