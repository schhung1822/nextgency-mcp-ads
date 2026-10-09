// Bot API client: error mapping (401/403/400 chat/thread/parse/migrate, 429 retry_after, 5xx, network/timeout),
// token hygiene (never in an error / log line, no redirects), plain-text + migration recoveries. fetch is injected.
import { describe, expect, it, vi } from "vitest"

import {
  callTelegram,
  DEFAULT_TELEGRAM_API_BASE_URL,
  htmlToPlainText,
  isTelegramError,
  mapTelegramError,
  sendMessage,
  sendTelegramText,
  telegramApiBaseUrl,
  TelegramError,
  type FetchLike,
} from "./telegram"
import { creditFooter } from "./credit"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"

function tg(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
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

describe("mapTelegramError", () => {
  it("map đúng từng loại lỗi + thông điệp tiếng Việt kèm cách sửa", () => {
    expect(
      mapTelegramError(401, { error_code: 401, description: "Unauthorized" })
        .kind
    ).toBe("unauthorized")
    expect(
      mapTelegramError(404, { error_code: 404, description: "Not Found" }).kind
    ).toBe("unauthorized")
    const chat = mapTelegramError(
      400,
      { error_code: 400, description: "Bad Request: chat not found" },
      "my_bot"
    )
    expect(chat.kind).toBe("chat_not_found")
    expect(chat.userMessageVi).toContain("@my_bot")
    expect(chat.channelBroken).toBe(true)
    expect(
      mapTelegramError(400, {
        error_code: 400,
        description: "Bad Request: message thread not found",
      }).kind
    ).toBe("thread_not_found")
    const parse = mapTelegramError(400, {
      error_code: 400,
      description: "Bad Request: can't parse entities: Unsupported start tag",
    })
    expect(parse.kind).toBe("parse_entities")
    expect(parse.retryable).toBe(false)
    const mig = mapTelegramError(400, {
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -1001234567890 },
    })
    expect(mig.kind).toBe("migrated")
    expect(mig.migrateToChatId).toBe("-1001234567890")
    const blocked = mapTelegramError(
      403,
      {
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      },
      "my_bot"
    )
    expect(blocked.kind).toBe("forbidden")
    expect(blocked.userMessageVi).toContain("chặn")
    const kicked = mapTelegramError(
      403,
      {
        error_code: 403,
        description: "Forbidden: bot was kicked from the supergroup chat",
      },
      "my_bot"
    )
    expect(kicked.userMessageVi).toContain("Thêm @my_bot vào nhóm")
    expect(
      mapTelegramError(400, {
        error_code: 400,
        description:
          "Bad Request: not enough rights to send text messages to the chat",
      }).kind
    ).toBe("forbidden")
    const rl = mapTelegramError(429, {
      error_code: 429,
      description: "Too Many Requests: retry after 17",
      parameters: { retry_after: 17 },
    })
    expect(rl.kind).toBe("rate_limited")
    expect(rl.retryAfterSec).toBe(17)
    expect(rl.retryable).toBe(true)
    expect(mapTelegramError(502, null).kind).toBe("server")
    expect(
      mapTelegramError(400, {
        error_code: 400,
        description: "Bad Request: message text is empty",
      }).kind
    ).toBe("bad_request")
  })
})

describe("callTelegram", () => {
  it("POST JSON tới /bot<token>/<method>, không theo redirect, trả result", async () => {
    const f = vi.fn<FetchLike>(async () =>
      tg({ ok: true, result: { id: 1, username: "b" } })
    )
    const r = await callTelegram<{ id: number }>(
      TOKEN,
      "getMe",
      {},
      { fetchImpl: f }
    )
    expect(r.id).toBe(1)
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe(`${DEFAULT_TELEGRAM_API_BASE_URL}/bot${TOKEN}/getMe`)
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(JSON.parse(String(init.body))).toEqual({})
  })

  it("lỗi mạng / timeout không mang URL hay token trong message", async () => {
    const boom = vi.fn<FetchLike>(async (url) => {
      throw new TypeError(`fetch failed for ${url}`)
    })
    const e = await caught(
      callTelegram(TOKEN, "getMe", {}, { fetchImpl: boom })
    )
    expect(e.kind).toBe("network")
    expect(e.retryable).toBe(true)
    expect(`${e.message} ${e.userMessageVi} ${String(e.stack)}`).not.toContain(
      "AAEhBP0av28"
    )

    const slow = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    const t = await caught(
      callTelegram(TOKEN, "getMe", {}, { fetchImpl: slow, timeoutMs: 20 })
    )
    expect(t.kind).toBe("timeout")
  })

  it("description có token bị redact; token sai định dạng không bao giờ được gửi", async () => {
    const f = vi.fn<FetchLike>(async () =>
      err(400, `Bad Request: weird ${TOKEN}`)
    )
    const e = await caught(
      callTelegram(TOKEN, "sendMessage", {}, { fetchImpl: f })
    )
    expect(e.message).not.toContain("AAEhBP0av28")
    expect(e.description).not.toContain("AAEhBP0av28")
    const never = vi.fn<FetchLike>()
    const bad = await caught(
      callTelegram("123:abc/../../x", "getMe", {}, { fetchImpl: never })
    )
    expect(bad.kind).toBe("invalid_token")
    expect(never).not.toHaveBeenCalled()
  })

  it("5xx không phải JSON → server; 200 không đọc được → invalid_response", async () => {
    const e = await caught(
      callTelegram(
        TOKEN,
        "getMe",
        {},
        { fetchImpl: async () => new Response("<html>", { status: 502 }) }
      )
    )
    expect(e.kind).toBe("server")
    const i = await caught(
      callTelegram(
        TOKEN,
        "getMe",
        {},
        { fetchImpl: async () => new Response("nope", { status: 200 }) }
      )
    )
    expect(i.kind).toBe("invalid_response")
  })

  it("TELEGRAM_API_BASE_URL: https, hoặc http chỉ cho localhost; sai → config", async () => {
    expect(telegramApiBaseUrl({})).toBe(DEFAULT_TELEGRAM_API_BASE_URL)
    expect(
      telegramApiBaseUrl({ TELEGRAM_API_BASE_URL: "https://tg.example.com/" })
    ).toBe("https://tg.example.com")
    expect(
      telegramApiBaseUrl({ TELEGRAM_API_BASE_URL: "http://localhost:8081" })
    ).toBe("http://localhost:8081")
    expect(
      telegramApiBaseUrl({ TELEGRAM_API_BASE_URL: "http://evil.example.com" })
    ).toBeNull()
    expect(
      telegramApiBaseUrl({
        TELEGRAM_API_BASE_URL: "https://u:p@tg.example.com",
      })
    ).toBeNull()
    const never = vi.fn<FetchLike>()
    const e = await caught(
      callTelegram(
        TOKEN,
        "getMe",
        {},
        { fetchImpl: never, baseUrl: "http://evil.example.com" }
      )
    )
    expect(e.kind).toBe("config")
    expect(never).not.toHaveBeenCalled()
  })
})

describe("sendMessage / sendTelegramText", () => {
  it("HTML, tắt link preview, thread 1 (General) bị bỏ, thread khác được gửi", async () => {
    const f = vi.fn<FetchLike>(async () =>
      tg({ ok: true, result: { message_id: 42 } })
    )
    expect(
      (
        await sendMessage(
          TOKEN,
          { chatId: "-100123", text: "<b>x</b>", messageThreadId: 1 },
          { fetchImpl: f }
        )
      ).messageId
    ).toBe(42)
    const p1 = JSON.parse(String(f.mock.calls[0]![1].body))
    expect(p1).toEqual({
      chat_id: "-100123",
      text: "<b>x</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    await sendMessage(
      TOKEN,
      {
        chatId: "-100123",
        text: "x",
        messageThreadId: 7,
        disableNotification: true,
      },
      { fetchImpl: f }
    )
    const p2 = JSON.parse(String(f.mock.calls[1]![1].body))
    expect(p2.message_thread_id).toBe(7)
    expect(p2.disable_notification).toBe(true)
  })

  it("can't parse entities → gửi lại 1 lần dạng plain text", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        err(400, "Bad Request: can't parse entities: Can't find end tag")
      )
      .mockResolvedValueOnce(tg({ ok: true, result: { message_id: 5 } }))
    const r = await sendTelegramText(
      TOKEN,
      { chatId: "1", messageThreadId: null },
      "<b>A &amp; B</b>",
      { fetchImpl: f }
    )
    expect(r).toEqual({
      messageId: 5,
      migratedChatId: null,
      sentAsPlainText: true,
    })
    const second = JSON.parse(String(f.mock.calls[1]![1].body))
    expect(second.parse_mode).toBeUndefined()
    // the credit footer follows in its plain form (link spelled out)
    expect(second.text).toBe(`A & B${creditFooter().plain}`)
    const first = JSON.parse(String(f.mock.calls[0]![1].body))
    expect(first.text).toBe(`<b>A &amp; B</b>${creditFooter().html}`)
  })

  it("nhóm nâng cấp supergroup → gửi lại 1 lần tới chat id mới và báo lại id mới", async () => {
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        err(400, "Bad Request: group chat was upgraded to a supergroup chat", {
          migrate_to_chat_id: -1009,
        })
      )
      .mockResolvedValueOnce(tg({ ok: true, result: { message_id: 6 } }))
    const r = await sendTelegramText(
      TOKEN,
      { chatId: "-55", messageThreadId: null },
      "x",
      { fetchImpl: f }
    )
    expect(r.migratedChatId).toBe("-1009")
    expect(JSON.parse(String(f.mock.calls[1]![1].body)).chat_id).toBe("-1009")
  })

  it("429 / 403 không thử lại trong client (quyết định ở worker)", async () => {
    const f = vi.fn<FetchLike>(async () =>
      err(429, "Too Many Requests: retry after 3", { retry_after: 3 })
    )
    const e = await caught(
      sendTelegramText(TOKEN, { chatId: "1", messageThreadId: null }, "x", {
        fetchImpl: f,
      })
    )
    expect(e.kind).toBe("rate_limited")
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("htmlToPlainText bỏ thẻ và giải mã entity", () => {
    expect(htmlToPlainText("<b>a</b> &lt;b&gt; &amp;amp; &quot;q&quot;")).toBe(
      'a <b> &amp; "q"'
    )
  })
})
