// Credit footer (§10.1) + media sending (§10.2): footer appended exactly once at the send layer (text, caption,
// plain fallback), length budgets incl. the footer, multipart body (fields, file name, caption, thread id), the
// one-shot recoveries (photo → document, migrated chat, plain caption), 413 / media 400 mapping, upload timeout.
// fetch is injected; attemptSend runs on an in-memory channel row (token encrypted with the test key, no DB).
import { describe, expect, it, vi } from "vitest"

import { notifications as m } from "@/lib/i18n/vi/notifications"

import { creditFooter, TELEGRAM_CREDIT_URL } from "./credit"
import { attemptSend, encryptChannelToken, type ChannelRow } from "./deliver"
import {
  buildAiCaption,
  buildAiMessage,
  buildTestMessage,
  buildUpdateAvailableMessage,
  fitMessage,
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_MESSAGE,
} from "./format"
import { TELEGRAM_CAPTION_TEXT_MAX, type OutgoingMedia } from "./media"
import {
  callTelegramMultipart,
  htmlToPlainText,
  isTelegramError,
  mapTelegramError,
  sendTelegramMedia,
  sendTelegramText,
  TelegramError,
  type FetchLike,
} from "./telegram"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"
const TARGET = { chatId: "-100123", messageThreadId: null }

function tg(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
const ok = (id = 42) => tg({ ok: true, result: { message_id: id } })
function err(
  code: number,
  description: string,
  parameters?: Record<string, unknown>
): Response {
  return tg(
    {
      ok: false,
      error_code: code,
      description,
      ...(parameters ? { parameters } : {}),
    },
    code
  )
}

async function caught(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p
  } catch (e) {
    if (isTelegramError(e)) return e
    throw e
  }
  throw new Error("expected a TelegramError")
}

const methodOf = (f: ReturnType<typeof vi.fn<FetchLike>>, i: number) =>
  String(f.mock.calls[i]![0]).split("/").pop()
const formOf = (f: ReturnType<typeof vi.fn<FetchLike>>, i: number) =>
  f.mock.calls[i]![1].body as FormData
const jsonOf = (f: ReturnType<typeof vi.fn<FetchLike>>, i: number) =>
  JSON.parse(String(f.mock.calls[i]![1].body)) as Record<string, unknown>

const count = (s: string, sub: string) => s.split(sub).length - 1

function media(over: Partial<OutgoingMedia> = {}): OutgoingMedia {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  return {
    kind: "photo",
    bytes,
    fileName: "ảnh báo cáo.jpg",
    mime: "image/jpeg",
    sizeBytes: bytes.length,
    ...over,
  }
}

function channelRow(over: Partial<ChannelRow> = {}): ChannelRow {
  const id = "00000000-0000-4000-8000-000000000001"
  return {
    id,
    ownerId: "u1",
    name: "Nhóm",
    type: "telegram",
    credentialsEncrypted: encryptChannelToken(id, TOKEN),
    credentialHint: "djfh",
    config: {
      chatId: "-100123",
      chatTitle: "Nhóm",
      chatType: "supergroup",
      messageThreadId: null,
      botId: "1",
      botUsername: "ads_bot",
    },
    events: [],
    allConnections: false,
    status: "active",
    statusMessage: null,
    lastSentAt: null,
    lastErrorAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  } as ChannelRow
}

describe("credit footer (§10.1)", () => {
  it("HTML + plain đúng nguyên văn, link cố định", () => {
    expect(TELEGRAM_CREDIT_URL).toBe("https://s.noti.vn/s/ads-mcp-simple")
    expect(creditFooter()).toEqual({
      html: '\n\n<i><a href="https://s.noti.vn/s/ads-mcp-simple">Ads MCP Simple</a></i>',
      plain:
        "\n\nAds MCP Simple: https://s.noti.vn/s/ads-mcp-simple",
    })
  })

  it("sendTelegramText thêm footer đúng 1 lần, vẫn tắt link preview; footer: null = không thêm", async () => {
    const f = vi.fn<FetchLike>(async () => ok())
    await sendTelegramText(TOKEN, TARGET, "<b>x</b>", { fetchImpl: f })
    const p = jsonOf(f, 0)
    expect(p.text).toBe(`<b>x</b>${creditFooter().html}`)
    expect(p.link_preview_options).toEqual({ is_disabled: true })
    await sendTelegramText(TOKEN, TARGET, "<b>x</b>", {
      fetchImpl: f,
      footer: null,
    })
    expect(jsonOf(f, 1).text).toBe("<b>x</b>")
  })

  it.each([
    [
      "tin thử",
      buildTestMessage({ channelName: "Nhóm", actorEmail: "a@b.vn" }),
    ],
    ["hệ thống", buildUpdateAvailableMessage({ version: "1.0.6" })],
    ["tin AI", buildAiMessage({ mcpName: "Báo cáo", text: "Chi tiêu & ROAS" })],
  ])("attemptSend (%s): footer có đúng 1 lần ở cuối tin", async (_l, html) => {
    const f = vi.fn<FetchLike>(async () => ok())
    const { outcome } = await attemptSend(channelRow(), html, { fetchImpl: f })
    expect(outcome.ok).toBe(true)
    const text = String(jsonOf(f, 0).text)
    expect(text.endsWith(creditFooter().html)).toBe(true)
    expect(count(text, TELEGRAM_CREDIT_URL)).toBe(1)
    expect(text.startsWith(html)).toBe(true)
  })

  it("parse entities → bản plain có link đầy đủ, footer vẫn 1 lần", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(err(400, "Bad Request: can't parse entities"))
      .mockResolvedValueOnce(ok(7))
    const { outcome } = await attemptSend(channelRow(), "<b>A &amp; B</b>", {
      fetchImpl: f,
    })
    expect(outcome).toMatchObject({ ok: true, sentAsPlainText: true })
    const text = String(jsonOf(f, 1).text)
    expect(text).toBe(`A & B${creditFooter().plain}`)
    expect(text).toContain(TELEGRAM_CREDIT_URL)
    expect(jsonOf(f, 1).parse_mode).toBeUndefined()
  })

  it("tin rất dài: cắt phần nội dung, kết thúc bằng <a> footer nguyên vẹn, tổng ≤ 4096 (cả bản plain)", async () => {
    const html = `<b>Báo cáo</b>\n${"Chi tiêu &amp; ROAS ".repeat(400)}`
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(err(400, "Bad Request: can't parse entities"))
      .mockResolvedValueOnce(ok())
    await attemptSend(channelRow(), html, { fetchImpl: f })
    const text = String(jsonOf(f, 0).text)
    expect(text.endsWith(creditFooter().html)).toBe(true)
    expect(htmlToPlainText(text).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE
    )
    await attemptSend(channelRow(), html, { fetchImpl: f })
    const plain = String(jsonOf(f, 2).text)
    expect(plain.endsWith(creditFooter().plain)).toBe(true)
    expect(plain.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE)
  })

  it("fitMessage chừa chỗ cho footer (tin 4096 / chú thích 1024)", () => {
    const reserve = creditFooter().plain.length
    const long = "x".repeat(5000)
    expect(fitMessage(long, reserve).length + reserve).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE
    )
    expect(
      fitMessage(long, reserve, TELEGRAM_MAX_CAPTION).length + reserve
    ).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION)
    expect(fitMessage("<b>ngắn</b>", reserve, TELEGRAM_MAX_CAPTION)).toBe(
      "<b>ngắn</b>"
    )
  })
})

describe("buildAiCaption", () => {
  it("tiêu đề cố định (tên MCP ≤ 60) + nội dung đã redact/escape ≤ 800; không có nội dung → chỉ tiêu đề", () => {
    const c = buildAiCaption({
      mcpName: "M".repeat(100),
      text: `<b>x</b> & ${TOKEN} ${"y".repeat(900)}`,
    })
    expect(c.startsWith("<b>🤖 Tin từ AI · MCP ")).toBe(true)
    expect(c).toContain(`${"M".repeat(59)}…</b>`)
    expect(c).not.toContain("M".repeat(61))
    expect(c).toContain("&lt;b&gt;x&lt;/b&gt; &amp;")
    expect(c).not.toContain(TOKEN.slice(12))
    const body = htmlToPlainText(c.split("</b>\n\n")[1]!)
    expect(body.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_TEXT_MAX)
    expect(buildAiCaption({ mcpName: "A", text: "  " })).toBe(
      "<b>🤖 Tin từ AI · MCP A</b>"
    )
  })

  it("chú thích tối đa + footer ≤ 1024 ký tự khi gửi kèm tệp", async () => {
    const f = vi.fn<FetchLike>(async () => ok())
    const html = buildAiCaption({
      mcpName: "Đ".repeat(60),
      text: "&".repeat(TELEGRAM_CAPTION_TEXT_MAX),
    })
    const { outcome } = await attemptSend(channelRow(), html, {
      fetchImpl: f,
      media: media(),
    })
    expect(outcome).toMatchObject({ ok: true, sentAs: "photo" })
    const caption = String(formOf(f, 0).get("caption"))
    expect(caption.endsWith(creditFooter().html)).toBe(true)
    expect(htmlToPlainText(caption).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_CAPTION
    )
    // nothing had to be cut: title + 800 characters + footer fit
    expect(caption.startsWith(html)).toBe(true)
  })
})

describe("callTelegramMultipart / sendTelegramMedia", () => {
  it("multipart: không tự đặt content-type, chặn redirect, lỗi không chứa token", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/x`)
    })
    const form = new FormData()
    form.append("chat_id", "1")
    const e = await caught(
      callTelegramMultipart(TOKEN, "sendDocument", form, { fetchImpl: f })
    )
    expect(e.kind).toBe("network")
    expect(e.message).not.toContain(TOKEN)
    const init = f.mock.calls[0]![1]
    expect(init.redirect).toBe("error")
    expect(init.body).toBe(form)
    expect(
      Object.keys(init.headers as Record<string, string>).map((k) =>
        k.toLowerCase()
      )
    ).not.toContain("content-type")
  })

  it("upload quá thời gian → timeout với thông điệp tải tệp", async () => {
    const f = vi.fn<FetchLike>(
      (_u, init) =>
        new Promise((_r, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        )
    )
    const e = await caught(
      sendTelegramMedia(TOKEN, TARGET, media(), "x", {
        fetchImpl: f,
        timeoutMs: 20,
      })
    )
    expect(e.kind).toBe("timeout")
    expect(e.userMessageVi).toBe(m.telegram.uploadTimeout)
  })

  it("sendPhoto: field photo + tên tệp + chú thích có footer + parse_mode + thread > 1 + im lặng", async () => {
    const f = vi.fn<FetchLike>(async () => ok(77))
    const r = await sendTelegramMedia(
      TOKEN,
      { chatId: "-100123", messageThreadId: 7 },
      media(),
      "<b>Ảnh</b>",
      { fetchImpl: f, disableNotification: true }
    )
    expect(r).toEqual({
      messageId: 77,
      migratedChatId: null,
      sentAsPlainText: false,
      sentAs: "photo",
    })
    expect(methodOf(f, 0)).toBe("sendPhoto")
    const form = formOf(f, 0)
    expect(form.get("chat_id")).toBe("-100123")
    expect(form.get("message_thread_id")).toBe("7")
    expect(form.get("caption")).toBe(`<b>Ảnh</b>${creditFooter().html}`)
    expect(form.get("parse_mode")).toBe("HTML")
    expect(form.get("disable_notification")).toBe("true")
    expect(form.get("supports_streaming")).toBeNull()
    expect(form.get("link_preview_options")).toBeNull()
    const file = form.get("photo") as File
    expect(file.name).toBe("ảnh báo cáo.jpg")
    expect(file.type).toBe("image/jpeg")
    expect(Buffer.from(await file.arrayBuffer())).toEqual(media().bytes)
  })

  it("sendVideo có supports_streaming; sendDocument dùng field document; thread 1 (General) bị bỏ", async () => {
    const f = vi.fn<FetchLike>(async () => ok())
    await sendTelegramMedia(
      TOKEN,
      { chatId: "1", messageThreadId: 1 },
      media({ kind: "video", fileName: "v.mp4", mime: "video/mp4" }),
      "",
      { fetchImpl: f }
    )
    expect(methodOf(f, 0)).toBe("sendVideo")
    const v = formOf(f, 0)
    expect(v.get("supports_streaming")).toBe("true")
    expect(v.get("message_thread_id")).toBeNull()
    expect((v.get("video") as File).name).toBe("v.mp4")
    // no caption text: the footer alone, without the leading blank line
    expect(v.get("caption")).toBe(creditFooter().html.trimStart())
    await sendTelegramMedia(
      TOKEN,
      TARGET,
      media({ kind: "document", fileName: "a.pdf", mime: "application/pdf" }),
      "x",
      { fetchImpl: f }
    )
    expect(methodOf(f, 1)).toBe("sendDocument")
    expect((formOf(f, 1).get("document") as File).name).toBe("a.pdf")
  })

  it("ảnh bị Telegram từ chối kích thước → gửi lại 1 lần dạng tệp", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(err(400, "Bad Request: PHOTO_INVALID_DIMENSIONS"))
      .mockResolvedValueOnce(ok(8))
    const r = await sendTelegramMedia(TOKEN, TARGET, media(), "c", {
      fetchImpl: f,
    })
    expect(r.sentAs).toBe("document")
    expect(methodOf(f, 1)).toBe("sendDocument")
    const doc = formOf(f, 1)
    expect((doc.get("document") as File).name).toBe("ảnh báo cáo.jpg")
    expect(doc.get("photo")).toBeNull()
    expect(doc.get("caption")).toBe(`c${creditFooter().html}`)
  })

  it("tệp (document) bị từ chối thì không thử lại; IMAGE_PROCESS_FAILED cũng chuyển sang tệp", async () => {
    const f = vi.fn<FetchLike>(async () =>
      err(400, "Bad Request: IMAGE_PROCESS_FAILED")
    )
    const e = await caught(
      sendTelegramMedia(TOKEN, TARGET, media(), "c", { fetchImpl: f })
    )
    expect(e.kind).toBe("bad_request")
    expect(e.userMessageVi).toBe(m.telegram.mediaRejected)
    expect(f).toHaveBeenCalledTimes(2)
    expect(methodOf(f, 1)).toBe("sendDocument")
  })

  it("nhóm nâng cấp → gửi lại tới chat mới; parse entities → chú thích plain có link", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        err(400, "Bad Request: group chat was upgraded to a supergroup chat", {
          migrate_to_chat_id: -1009,
        })
      )
      .mockResolvedValueOnce(
        err(400, "Bad Request: can't parse entities: Unsupported start tag")
      )
      .mockResolvedValueOnce(ok(9))
    const r = await sendTelegramMedia(
      TOKEN,
      TARGET,
      media(),
      "<b>A &amp; B</b>",
      {
        fetchImpl: f,
      }
    )
    expect(r).toEqual({
      messageId: 9,
      migratedChatId: "-1009",
      sentAsPlainText: true,
      sentAs: "photo",
    })
    const last = formOf(f, 2)
    expect(last.get("chat_id")).toBe("-1009")
    expect(last.get("caption")).toBe(`A & B${creditFooter().plain}`)
    expect(last.get("parse_mode")).toBeNull()
  })

  it("413 (JSON hoặc trang HTML của proxy) → file_too_large, không thử lại, không làm hỏng kênh", async () => {
    const json = mapTelegramError(413, {
      error_code: 413,
      description: "Request Entity Too Large",
    })
    expect(json.kind).toBe("file_too_large")
    expect(json.retryable).toBe(false)
    expect(json.channelBroken).toBe(false)
    expect(json.userMessageVi).toBe(m.telegram.fileTooLarge)
    const f = vi.fn<FetchLike>(
      async () =>
        new Response("<html>413 Request Entity Too Large</html>", {
          status: 413,
        })
    )
    const e = await caught(
      sendTelegramMedia(TOKEN, TARGET, media({ kind: "document" }), "x", {
        fetchImpl: f,
      })
    )
    expect(e.kind).toBe("file_too_large")
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("lỗi media 400 khác → bad_request với thông điệp tiếng Việt", () => {
    for (const d of [
      "Bad Request: wrong file identifier/HTTP URL specified",
      "Bad Request: failed to get HTTP URL content",
      "Bad Request: wrong type of the web page content",
    ]) {
      const e = mapTelegramError(400, { error_code: 400, description: d })
      expect(e.kind).toBe("bad_request")
      expect(e.userMessageVi).toBe(m.telegram.mediaRejected)
    }
  })

  it("attemptSend với media lỗi 413 → outcome không retry, kênh giữ trạng thái", async () => {
    const f = vi.fn<FetchLike>(async () => err(413, "Request Entity Too Large"))
    const { outcome, patch } = await attemptSend(channelRow(), "x", {
      fetchImpl: f,
      media: media({ kind: "document" }),
    })
    expect(outcome).toMatchObject({
      ok: false,
      kind: "file_too_large",
      retryable: false,
      channelStatus: "active",
    })
    expect(patch?.status).toBeUndefined()
  })
})
