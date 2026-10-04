"use client"

import { ReauthDialog } from "@/components/app"
import type { ActionResult } from "@/lib/action-result"
import { mcp as t } from "@/lib/i18n/vi/mcp"

export type RevealActionFn = (
  input: unknown
) => Promise<ActionResult<{ url: string }>>

export interface ReauthTexts {
  title: string
  description: string
  submit: string
}

const REVEAL_TEXTS: ReauthTexts = {
  title: t.reveal.title,
  description: t.reveal.description,
  submit: t.reveal.submit,
}

/**
 * Re-authentication (password + TOTP when 2FA is on) before an action that hands out the MCP URL
 * ("Xem lại link" by default; also used for "Xoay key" with other texts).
 */
export function RevealDialog({
  open,
  onOpenChange,
  mcpId,
  twoFactorEnabled,
  revealAction,
  onRevealed,
  texts = REVEAL_TEXTS,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mcpId: string
  twoFactorEnabled: boolean
  revealAction: RevealActionFn
  onRevealed: (url: string) => void
  texts?: ReauthTexts
}) {
  return (
    <ReauthDialog
      open={open}
      onOpenChange={onOpenChange}
      twoFactorEnabled={twoFactorEnabled}
      idPrefix="reveal"
      passwordLabel={t.reveal.passwordLabel}
      hint={null}
      texts={{ ...texts, submitting: t.reveal.submitting }}
      onSubmit={(fields) => revealAction({ id: mcpId, ...fields })}
      onSuccess={(data) => onRevealed(data.url)}
    />
  )
}
