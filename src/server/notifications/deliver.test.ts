// Integration (test Postgres; skipped without DATABASE_URL): sendChannelMessageNow with a file (multipart send,
// "[Ảnh: …]" preview, photo → document fallback reported), the dedupe key (a duplicate sends nothing and returns the
// earlier delivery; pending → "đang được gửi"; a failed one never blocks a retry), and the credit footer on every
// path - test message, queued
// system message (stored message / preview stay footer-free) - exactly once. Telegram + pg-boss are fakes.
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { notifications as m } from "@/lib/i18n/vi/notifications"
import { db } from "@/server/db/client"
import {
  notificationChannels,
  notificationDeliveries,
  user,
} from "@/server/db/schema"

import { creditFooter, TELEGRAM_CREDIT_URL } from "./credit"
import { encryptChannelToken, sendChannelMessageNow } from "./deliver"
import { enqueueNotification } from "./enqueue"
import { buildAiCaption, buildTestMessage } from "./format"
import type { OutgoingMedia } from "./media"
import { processDelivery } from "./process"
import { setNotificationJobSender } from "./queue"
import type { FetchLike } from "./telegram"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const HAS_DB = !!process.env.DATABASE_URL
const PREFIX = `t-notif-d-${randomUUID().slice(0, 8)}`
const OWNER = { id: `${PREFIX}-a`, email: `${PREFIX}-a@test.local` }

async function channel(): Promise<string> {
  const id = randomUUID()
  await db.insert(notificationChannels).values({
    id,
    ownerId: OWNER.id,
    name: `${PREFIX} ch`,
    credentialsEncrypted: encryptChannelToken(id, TOKEN),
    credentialHint: "djfh",
    config: {
      chatId: "-100111",
      chatTitle: "Nhóm",
      chatType: "supergroup",
      messageThreadId: null,
      botId: "1",
      botUsername: "ads_bot",
    },
    events: ["connection_health"],
    allConnections: false,
    status: "active",
  })
  return id
}

const deliveriesOf = (channelId: string) =>
  db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))

const ok = (id: number) =>
  new Response(JSON.stringify({ ok: true, result: { message_id: id } }), {
    status: 200,
  })

const photo: OutgoingMedia = {
  kind: "photo",
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
  fileName: "chi-tieu.jpg",
  mime: "image/jpeg",
  sizeBytes: 1258291,
}

describe.skipIf(!HAS_DB)(
  "sendChannelMessageNow: media + dedupe + footer (DB)",
  () => {
    beforeAll(async () => {
      await db.insert(user).values({
        id: OWNER.id,
        name: OWNER.id,
        email: OWNER.email,
        role: "staff",
        emailVerified: true,
      })
    })

    afterAll(async () => {
      await db
        .delete(notificationChannels)
        .where(eq(notificationChannels.ownerId, OWNER.id))
      await db.delete(user).where(inArray(user.id, [OWNER.id]))
      setNotificationJobSender(null)
    })

    it("gửi kèm ảnh: multipart sendPhoto, chú thích có footer, preview “[Ảnh: …] …”, delivery sent", async () => {
      const ch = await channel()
      const f = vi.fn<FetchLike>(async () => ok(501))
      const html = buildAiCaption({
        mcpName: "Báo cáo",
        text: "Chi tiêu hôm nay",
      })
      const r = await sendChannelMessageNow({
        channelId: ch,
        html,
        source: "mcp_tool",
        eventType: "mcp_message",
        media: photo,
        fetchImpl: f,
      })
      expect(r).toMatchObject({ ok: true, messageId: 501, sentAs: "photo" })
      expect(r.ok && r.duplicate).toBeFalsy()
      expect(String(f.mock.calls[0]![0]).endsWith("/sendPhoto")).toBe(true)
      const form = f.mock.calls[0]![1].body as FormData
      expect(form.get("caption")).toBe(`${html}${creditFooter().html}`)
      const [d] = await deliveriesOf(ch)
      expect(d).toMatchObject({ status: "sent", telegramMessageId: 501 })
      expect(d!.preview).toBe(
        "[Ảnh: chi-tieu.jpg · 1,2 MB] 🤖 Tin từ AI · MCP Báo cáo Chi tiêu hôm nay"
      )
      expect(d!.preview).not.toContain(TELEGRAM_CREDIT_URL)
    })

    it("ảnh bị từ chối → gửi lại dạng tệp, kết quả báo sentAs document", async () => {
      const ch = await channel()
      const f = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: PHOTO_INVALID_DIMENSIONS",
            }),
            { status: 400 }
          )
        )
        .mockResolvedValueOnce(ok(502))
      const r = await sendChannelMessageNow({
        channelId: ch,
        html: "x",
        source: "mcp_tool",
        eventType: "mcp_message",
        media: photo,
        fetchImpl: f,
      })
      expect(r).toMatchObject({ ok: true, messageId: 502, sentAs: "document" })
    })

    it("dedupe key: lần 2 không gửi lại, trả delivery cũ (đã gửi); không gọi reserve; chỉ 1 dòng", async () => {
      const ch = await channel()
      const f = vi.fn<FetchLike>(async () => ok(601))
      const reserve = vi.fn(async () => {})
      const args = {
        channelId: ch,
        html: "x",
        source: "mcp_tool" as const,
        eventType: "mcp_message" as const,
        media: photo,
        dedupeKey: "cgf:file-1:123",
        fetchImpl: f,
        reserve,
      }
      const first = await sendChannelMessageNow(args)
      expect(first).toMatchObject({ ok: true, messageId: 601 })
      const second = await sendChannelMessageNow(args)
      expect(second).toEqual({
        ok: true,
        duplicate: true,
        deliveryId: first.deliveryId,
        messageId: 601,
        channelStatus: "active",
      })
      expect(f).toHaveBeenCalledTimes(1)
      expect(reserve).toHaveBeenCalledTimes(1)
      const rows = await deliveriesOf(ch)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.dedupeKey).toBe("cgf:file-1:123")
    })

    it("dedupe key trùng delivery còn pending → không gửi, thông báo tiếng Việt; onSettled vẫn được gọi 1 lần", async () => {
      const ch = await channel()
      await db.insert(notificationDeliveries).values({
        channelId: ch,
        source: "mcp_tool",
        eventType: "mcp_message",
        dedupeKey: "cgf:file-2:1",
        status: "pending",
        preview: "x",
      })
      const f = vi.fn<FetchLike>(async () => ok(1))
      const settled = vi.fn(async () => {})
      const r = await sendChannelMessageNow({
        channelId: ch,
        html: "x",
        source: "mcp_tool",
        eventType: "mcp_message",
        dedupeKey: "cgf:file-2:1",
        fetchImpl: f,
        onSettled: settled,
      })
      expect(r).toMatchObject({
        ok: false,
        duplicate: true,
        kind: "duplicate",
        error: m.errors.duplicateDelivery,
      })
      expect(f).not.toHaveBeenCalled()
      expect(settled).toHaveBeenCalledTimes(1)
      // two concurrent duplicates: one sends, the other returns the earlier delivery (unique index)
      const g = vi.fn<FetchLike>(async () => ok(700))
      const both = await Promise.all(
        [1, 2].map(() =>
          sendChannelMessageNow({
            channelId: ch,
            html: "y",
            source: "mcp_tool",
            eventType: "mcp_message",
            dedupeKey: "cgf:file-3:1",
            fetchImpl: g,
          })
        )
      )
      expect(g).toHaveBeenCalledTimes(1)
      expect(both.filter((x) => x.duplicate)).toHaveLength(1)
    })

    it("dedupe key trùng delivery THẤT BẠI → không chặn: gửi lại; dòng cũ giữ key đã thu hồi; lần sau mới là trùng", async () => {
      const ch = await channel()
      const key = "cgf:mcp-x:0123456789abcdef0123456789abcdef:1"
      const args = {
        channelId: ch,
        html: "x",
        source: "mcp_tool" as const,
        eventType: "mcp_message" as const,
        dedupeKey: key,
      }
      const down = vi.fn<FetchLike>(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 500,
              description: "Internal Server Error",
            }),
            { status: 500 }
          )
      )
      const first = await sendChannelMessageNow({ ...args, fetchImpl: down })
      expect(first.ok).toBe(false)
      expect(!first.ok && first.kind).not.toBe("duplicate")
      const f = vi.fn<FetchLike>(async () => ok(801))
      const retry = await sendChannelMessageNow({ ...args, fetchImpl: f })
      expect(retry).toMatchObject({ ok: true, messageId: 801 })
      expect(retry.ok && retry.duplicate).toBeFalsy()
      expect(f).toHaveBeenCalledTimes(1)
      const rows = await deliveriesOf(ch)
      expect(rows).toHaveLength(2)
      const failed = rows.find((r) => r.status === "failed")!
      expect(failed.dedupeKey).toBe(`${key}:failed:${failed.id}`)
      expect(rows.find((r) => r.status === "sent")!.dedupeKey).toBe(key)
      // now the key belongs to the sent delivery: a third call is a duplicate of it
      const third = await sendChannelMessageNow({ ...args, fetchImpl: f })
      expect(third).toMatchObject({ ok: true, duplicate: true, messageId: 801 })
      expect(f).toHaveBeenCalledTimes(1)
    })

    it("tin thử (sync) và tin hệ thống qua hàng đợi: footer đúng 1 lần; message/preview lưu trong DB không có footer", async () => {
      const ch = await channel()
      const f = vi.fn<FetchLike>(async () => ok(801))
      const test = await sendChannelMessageNow({
        channelId: ch,
        html: buildTestMessage({ channelName: "Nhóm" }),
        source: "test",
        eventType: "test",
        allowErrorStatus: true,
        fetchImpl: f,
      })
      expect(test.ok).toBe(true)
      const sentTest = JSON.parse(String(f.mock.calls[0]![1].body)) as {
        text: string
        link_preview_options: unknown
      }
      expect(sentTest.text.split(TELEGRAM_CREDIT_URL)).toHaveLength(2)
      expect(sentTest.text.endsWith(creditFooter().html)).toBe(true)
      expect(sentTest.link_preview_options).toEqual({ is_disabled: true })

      setNotificationJobSender(async () => "job")
      const { queued } = await enqueueNotification({
        channelIds: [ch],
        source: "system",
        eventType: "update_available",
        text: "<b>Có bản cập nhật mới</b>",
      })
      const [pending] = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, queued[0]!))
      expect(pending!.message).toBe("<b>Có bản cập nhật mới</b>")
      expect(pending!.preview).not.toContain(TELEGRAM_CREDIT_URL)
      const r = await processDelivery(
        { deliveryId: queued[0]!, attempt: 0 },
        { fetchImpl: f, sleep: async () => {} }
      )
      expect(r).toEqual({ result: "sent", messageId: 801 })
      const sent = JSON.parse(String(f.mock.calls[1]![1].body)) as {
        text: string
      }
      expect(sent.text).toBe(`<b>Có bản cập nhật mới</b>${creditFooter().html}`)
    })
  }
)
