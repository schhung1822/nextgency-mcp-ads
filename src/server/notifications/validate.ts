// Telegram configuration check (wizard "Kiểm tra & lưu", "Kiểm tra lại", token replacement):
// getMe (token) → getChat (chat exists, type, forum, canonical id) → getChatMember(bot) (rights) → thread id only on
// forum supergroups. The Bot API cannot check a topic: "Gửi tin thử" is the final check. No "next/*" imports.
import { notifications as m } from "@/lib/i18n/vi/notifications"
import type { TelegramCheckResult } from "@/lib/schemas/notifications"

import {
  getChat,
  getChatMember,
  getMe,
  isTelegramError,
  TelegramError,
  type TelegramCallOptions,
  type TelegramChatInfo,
} from "./telegram"

export type TelegramConfigField = "botToken" | "chatId" | "messageThreadId"

/** Validation failure with a Vietnamese message attached to a form field (null = general error). */
export class TelegramValidationError extends Error {
  readonly field: TelegramConfigField | null
  readonly telegramError?: TelegramError
  constructor(
    message: string,
    field: TelegramConfigField | null,
    cause?: TelegramError
  ) {
    super(message)
    this.name = "TelegramValidationError"
    this.field = field
    this.telegramError = cause
  }
}

/** Thread id 1 = General topic (sent without message_thread_id) → null. */
export function normalizeThreadId(
  threadId: number | null | undefined
): number | null {
  return threadId && threadId > 1 ? threadId : null
}

function fieldFor(e: TelegramError): TelegramConfigField | null {
  if (e.kind === "unauthorized" || e.kind === "invalid_token") return "botToken"
  if (e.kind === "chat_not_found" || e.kind === "forbidden") return "chatId"
  if (e.kind === "thread_not_found") return "messageThreadId"
  return null
}

function rethrow(e: unknown, field?: TelegramConfigField | null): never {
  if (e instanceof TelegramValidationError) throw e
  if (isTelegramError(e))
    throw new TelegramValidationError(
      e.userMessageVi,
      field === undefined ? fieldFor(e) : field,
      e
    )
  throw e
}

export async function validateTelegramConfig(
  input: { botToken: string; chatId: string; messageThreadId?: number | null },
  opts: TelegramCallOptions = {}
): Promise<TelegramCheckResult> {
  const warnings: string[] = []
  let bot: Awaited<ReturnType<typeof getMe>>
  try {
    bot = await getMe(input.botToken, opts)
  } catch (e) {
    // any 4xx on getMe is a token problem
    if (
      isTelegramError(e) &&
      (e.kind === "bad_request" || e.kind === "forbidden")
    ) {
      rethrow(
        new TelegramError({
          kind: "unauthorized",
          code: e.code,
          userMessageVi: m.telegram.unauthorized,
        }),
        "botToken"
      )
    }
    rethrow(e)
  }
  const callOpts: TelegramCallOptions = {
    ...opts,
    botUsername: bot.username || null,
  }
  const label = bot.username ? `@${bot.username}` : "bot"

  let chat: TelegramChatInfo
  try {
    chat = await getChat(input.botToken, input.chatId.trim(), callOpts)
  } catch (e) {
    if (isTelegramError(e) && e.kind === "migrated" && e.migrateToChatId) {
      warnings.push(m.telegram.warnMigrated)
      try {
        chat = await getChat(input.botToken, e.migrateToChatId, callOpts)
      } catch (e2) {
        rethrow(e2)
      }
    } else {
      rethrow(e)
    }
  }

  if (chat.type === "private") {
    warnings.push(m.telegram.warnPrivate(label))
  } else {
    let member: Awaited<ReturnType<typeof getChatMember>>
    try {
      member = await getChatMember(input.botToken, chat.id, bot.id, callOpts)
    } catch (e) {
      rethrow(e)
    }
    if (chat.type === "channel") {
      const isAdmin =
        member.status === "administrator" || member.status === "creator"
      if (!isAdmin || member.canPostMessages === false)
        throw new TelegramValidationError(
          m.telegram.channelNotAdmin(label),
          "chatId"
        )
    } else {
      if (member.status === "left" || member.status === "kicked")
        throw new TelegramValidationError(m.telegram.notMember(label), "chatId")
      if (member.status === "restricted" && member.canSendMessages !== true) {
        throw new TelegramValidationError(
          m.telegram.restricted(label),
          "chatId"
        )
      }
      if (chat.type === "group") warnings.push(m.telegram.warnBasicGroup)
    }
  }

  const threadId = normalizeThreadId(input.messageThreadId)
  if (threadId !== null) {
    if (!(chat.type === "supergroup" && chat.isForum))
      throw new TelegramValidationError(
        m.telegram.threadNeedsForum,
        "messageThreadId"
      )
    warnings.push(m.telegram.warnThreadUnchecked)
  }

  return {
    bot: { id: bot.id, username: bot.username, name: bot.name },
    chat: {
      id: chat.id,
      title: chat.title,
      type: chat.type,
      isForum: chat.isForum,
    },
    messageThreadId: threadId,
    warnings,
  }
}
