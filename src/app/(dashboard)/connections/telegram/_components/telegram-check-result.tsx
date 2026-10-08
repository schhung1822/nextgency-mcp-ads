"use client"

import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import type { TelegramCheckResult } from "@/lib/schemas/notifications"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

/** Result of "Kiểm tra" (getMe / getChat / getChatMember): bot, chat, topic + non-blocking warnings. */
export function TelegramCheckSummary({
  check,
  outdated,
}: {
  check: TelegramCheckResult
  /** the user edited token/chat/thread after this check */
  outdated?: boolean
}) {
  return (
    // announced by the form's always-mounted live region (a region mounted with its content is often missed)
    <div className="flex flex-col gap-3 rounded-xl border border-success/30 bg-success/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-success-strong">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
          aria-hidden
        />
        {m.check.okTitle}
      </p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Row label={m.check.bot}>
          <span className="font-medium">@{check.bot.username}</span>
          {check.bot.name && (
            <span className="block text-[13px] text-muted-foreground">
              {check.bot.name}
            </span>
          )}
        </Row>
        <Row label={m.check.chat}>
          <span className="font-medium">{check.chat.title ?? check.chat.id}</span>
          <span className="block text-[13px] text-muted-foreground">
            {m.ui.chatTypes[check.chat.type] ?? check.chat.type}
            {check.chat.isForum && ` · ${m.check.forum}`}
          </span>
        </Row>
        <Row label={m.check.thread}>
          {check.messageThreadId !== null ? (
            <span className="font-mono">#{check.messageThreadId}</span>
          ) : (
            <span className="text-muted-foreground">{m.ui.noThread}</span>
          )}
        </Row>
      </dl>
      {check.warnings.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
          {check.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="mt-px size-3.5 shrink-0"
                aria-hidden
              />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {outdated && (
        <p className="flex items-start gap-1.5 text-[13px] text-warning-strong">
          <HugeiconsIcon
            icon={Alert02Icon}
            strokeWidth={2}
            className="mt-px size-3.5 shrink-0"
            aria-hidden
          />
          {m.check.outdated}
        </p>
      )}
    </div>
  )
}

/** Telegram refused the configuration: what happened + how to fix (the message already contains the fix). */
export function TelegramCheckError({
  title = m.check.failTitle,
  message,
}: {
  title?: string
  message: string
}) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
