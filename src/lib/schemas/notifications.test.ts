import { describe, expect, it } from "vitest"

import {
  createTelegramChannelSchema,
  messageThreadIdSchema,
  updateTelegramChannelSchema,
} from "./notifications"

const TOKEN = "123456789:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh"

describe("notification channel schemas", () => {
  it("tên kết nối: từ chối ký tự điều khiển và ký tự đảo chiều (như tên MCP)", () => {
    const base = { botToken: TOKEN, chatId: "-1001234567890" }
    const rlo = String.fromCharCode(0x202e)
    const isolate = String.fromCharCode(0x2066)
    const bell = String.fromCharCode(7)
    for (const name of [`ok${rlo}gpj`, `a${isolate}b`, "a\nb", `a${bell}b`]) {
      const r = createTelegramChannelSchema.safeParse({ ...base, name })
      expect(r.success, JSON.stringify(name)).toBe(false)
    }
    expect(
      updateTelegramChannelSchema.safeParse({
        channelId: "0198f0a0-0000-7000-8000-000000000001",
        name: `x${rlo}`,
      }).success
    ).toBe(false)
    expect(
      createTelegramChannelSchema.safeParse({ ...base, name: "Nhóm QC 😀 ✅" })
        .success
    ).toBe(true)
  })

  it("bot token đúng định dạng BotFather; chat id số âm hoặc @username", () => {
    const base = {
      name: "Nhóm QC",
      botToken: ` ${TOKEN} `,
      chatId: "-1001234567890",
    }
    const ok = createTelegramChannelSchema.parse(base)
    expect(ok).toMatchObject({
      botToken: TOKEN,
      events: [],
      allConnections: false,
    })
    expect(ok.messageThreadId).toBeUndefined()
    expect(createTelegramChannelSchema.parse({ ...base, messageThreadId: "" }).messageThreadId).toBeNull()
    expect(
      createTelegramChannelSchema.safeParse({ ...base, chatId: "@my_channel" })
        .success
    ).toBe(true)
    for (const botToken of [
      "",
      "abc",
      "123:short",
      `${TOKEN}/../x`,
      "12345678901234567:AAEhBP0av28dfjdk3rn4kbhfh2-8sdjfskdjfh",
    ]) {
      expect(
        createTelegramChannelSchema.safeParse({ ...base, botToken }).success,
        botToken
      ).toBe(false)
    }
    for (const chatId of ["", "abc", "@ab", "-100 123", "https://t.me/x"]) {
      expect(
        createTelegramChannelSchema.safeParse({ ...base, chatId }).success,
        chatId
      ).toBe(false)
    }
  })

  it("message thread id: số / chuỗi số / rỗng / null; số âm, 0, chữ → lỗi", () => {
    expect(messageThreadIdSchema.parse("12")).toBe(12)
    expect(messageThreadIdSchema.parse(7)).toBe(7)
    expect(messageThreadIdSchema.parse("")).toBeNull()
    expect(messageThreadIdSchema.parse(null)).toBeNull()
    expect(messageThreadIdSchema.parse(undefined)).toBeNull()
    for (const v of ["0", "-3", "1.5", "abc", 0, 99_999_999_999])
      expect(messageThreadIdSchema.safeParse(v).success, String(v)).toBe(false)
  })

  it("sự kiện chỉ nhận danh mục, bỏ trùng; cập nhật để trống = không đổi", () => {
    const base = { name: "x", botToken: TOKEN, chatId: "-1" }
    expect(
      createTelegramChannelSchema.parse({
        ...base,
        events: ["connection_health", "connection_health"],
      }).events
    ).toEqual(["connection_health"])
    expect(
      createTelegramChannelSchema.safeParse({ ...base, events: ["mcp_write"] })
        .success
    ).toBe(false)
    const u = updateTelegramChannelSchema.parse({
      channelId: "0199b3a0-0000-7000-8000-000000000001",
      name: "y",
    })
    expect(u.messageThreadId).toBeUndefined()
    expect(u.chatId).toBeUndefined()
  })
})
