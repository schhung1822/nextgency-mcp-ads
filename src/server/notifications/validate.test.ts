// Configuration check: getMe → getChat → getChatMember → thread rules. A fake Bot API routes by method name.
import { describe, expect, it } from "vitest"

import type { FetchLike } from "./telegram"
import {
  normalizeThreadId,
  TelegramValidationError,
  validateTelegramConfig,
} from "./validate"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"

type Handler = (payload: Record<string, unknown>) => {
  status?: number
  body: unknown
}

function fakeApi(handlers: Partial<Record<string, Handler>>): FetchLike {
  return async (url, init) => {
    const method = url.split("/").pop()!
    const h = handlers[method]
    const out = h
      ? h(JSON.parse(String(init.body ?? "{}")))
      : {
          status: 404,
          body: { ok: false, error_code: 404, description: "Not Found" },
        }
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 })
  }
}

const ok = (result: unknown) => ({ body: { ok: true, result } })
const fail = (code: number, description: string, parameters?: unknown) => ({
  status: code,
  body: { ok: false, error_code: code, description, parameters },
})
const me = () =>
  ok({ id: 987654, is_bot: true, first_name: "Ads Bot", username: "ads_bot" })

async function validationError(
  p: Promise<unknown>
): Promise<TelegramValidationError> {
  try {
    await p
  } catch (e) {
    if (e instanceof TelegramValidationError) return e
    throw e
  }
  throw new Error("expected TelegramValidationError")
}

describe("validateTelegramConfig", () => {
  it("supergroup forum + thread: lấy chat id chuẩn, title, cảnh báo phải gửi tin thử", async () => {
    const f = fakeApi({
      getMe: me,
      getChat: (p) =>
        p.chat_id === "@public_group"
          ? ok({
              id: -1001234567890,
              type: "supergroup",
              title: "Nhóm QC",
              is_forum: true,
            })
          : fail(400, "Bad Request: chat not found"),
      getChatMember: (p) =>
        p.user_id === 987654
          ? ok({ status: "member" })
          : fail(400, "Bad Request: user not found"),
    })
    const r = await validateTelegramConfig(
      { botToken: TOKEN, chatId: "@public_group", messageThreadId: 12 },
      { fetchImpl: f }
    )
    expect(r.bot).toEqual({
      id: "987654",
      username: "ads_bot",
      name: "Ads Bot",
    })
    expect(r.chat).toEqual({
      id: "-1001234567890",
      title: "Nhóm QC",
      type: "supergroup",
      isForum: true,
    })
    expect(r.messageThreadId).toBe(12)
    expect(r.warnings.some((w) => w.includes("Gửi tin thử"))).toBe(true)
  })

  it("token sai → lỗi ở trường botToken", async () => {
    const e = await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-1" },
        { fetchImpl: fakeApi({ getMe: () => fail(401, "Unauthorized") }) }
      )
    )
    expect(e.field).toBe("botToken")
    expect(e.message).toContain("@BotFather")
  })

  it("chat không tồn tại / bot chưa vào nhóm → lỗi ở trường chatId, nêu tên bot", async () => {
    const f = fakeApi({
      getMe: me,
      getChat: () => fail(400, "Bad Request: chat not found"),
    })
    const e = await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-100999" },
        { fetchImpl: f }
      )
    )
    expect(e.field).toBe("chatId")
    expect(e.message).toContain("@ads_bot")
  })

  it("kênh: bot phải là quản trị viên có quyền đăng tin", async () => {
    const chan = (member: unknown) =>
      fakeApi({
        getMe: me,
        getChat: () => ok({ id: -100777, type: "channel", title: "Kênh" }),
        getChatMember: () => ok(member),
      })
    await expect(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-100777" },
        {
          fetchImpl: chan({ status: "administrator", can_post_messages: true }),
        }
      )
    ).resolves.toMatchObject({
      chat: { type: "channel" },
    })
    const e = await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-100777" },
        {
          fetchImpl: chan({
            status: "administrator",
            can_post_messages: false,
          }),
        }
      )
    )
    expect(e.field).toBe("chatId")
    await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-100777" },
        { fetchImpl: chan({ status: "member" }) }
      )
    )
  })

  it("nhóm: bot bị kick / bị hạn chế không gửi được → lỗi; nhóm thường → cảnh báo", async () => {
    const grp = (member: unknown) =>
      fakeApi({
        getMe: me,
        getChat: () => ok({ id: -555, type: "group", title: "G" }),
        getChatMember: () => ok(member),
      })
    expect(
      (
        await validationError(
          validateTelegramConfig(
            { botToken: TOKEN, chatId: "-555" },
            { fetchImpl: grp({ status: "kicked" }) }
          )
        )
      ).field
    ).toBe("chatId")
    await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-555" },
        { fetchImpl: grp({ status: "restricted", can_send_messages: false }) }
      )
    )
    const r = await validateTelegramConfig(
      { botToken: TOKEN, chatId: "-555" },
      { fetchImpl: grp({ status: "member" }) }
    )
    expect(r.warnings.some((w) => w.includes("supergroup"))).toBe(true)
  })

  it("thread id chỉ hợp lệ với supergroup bật Topics; thread 1 = General → null", async () => {
    const f = fakeApi({
      getMe: me,
      getChat: () =>
        ok({ id: -100222, type: "supergroup", title: "S", is_forum: false }),
      getChatMember: () => ok({ status: "member" }),
    })
    const e = await validationError(
      validateTelegramConfig(
        { botToken: TOKEN, chatId: "-100222", messageThreadId: 5 },
        { fetchImpl: f }
      )
    )
    expect(e.field).toBe("messageThreadId")
    const r = await validateTelegramConfig(
      { botToken: TOKEN, chatId: "-100222", messageThreadId: 1 },
      { fetchImpl: f }
    )
    expect(r.messageThreadId).toBeNull()
    expect(normalizeThreadId(1)).toBeNull()
    expect(normalizeThreadId(9)).toBe(9)
  })

  it("nhóm đã nâng cấp supergroup → dùng chat id mới + cảnh báo", async () => {
    const f = fakeApi({
      getMe: me,
      getChat: (p) =>
        p.chat_id === "-555"
          ? fail(
              400,
              "Bad Request: group chat was upgraded to a supergroup chat",
              { migrate_to_chat_id: -100555 }
            )
          : ok({ id: -100555, type: "supergroup", title: "S" }),
      getChatMember: () => ok({ status: "member" }),
    })
    const r = await validateTelegramConfig(
      { botToken: TOKEN, chatId: "-555" },
      { fetchImpl: f }
    )
    expect(r.chat.id).toBe("-100555")
    expect(r.warnings.some((w) => w.includes("supergroup"))).toBe(true)
  })

  it("chat riêng: không kiểm tra thành viên, cảnh báo phải bấm Start", async () => {
    const f = fakeApi({
      getMe: me,
      getChat: () =>
        ok({ id: 42, type: "private", first_name: "An", last_name: "Nguyễn" }),
    })
    const r = await validateTelegramConfig(
      { botToken: TOKEN, chatId: "42" },
      { fetchImpl: f }
    )
    expect(r.chat).toMatchObject({
      id: "42",
      type: "private",
      title: "An Nguyễn",
    })
    expect(r.warnings.some((w) => w.includes("Start"))).toBe(true)
  })
})
