"use client"

// "Thay token": new bot token + password (+ TOTP) through the shared re-auth dialog. Never prefilled.
import * as React from "react"
import { toast } from "sonner"

import { ReauthDialog, SecretInput } from "@/components/app"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import { TELEGRAM_BOT_TOKEN_RE } from "@/lib/schemas/notifications"
import { replaceTelegramTokenAction } from "@/server/actions/notification-channels"

export function ReplaceTokenDialog({
  open,
  onOpenChange,
  channelId,
  credentialHint,
  twoFactorEnabled,
  onReplaced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelId: string
  credentialHint: string
  twoFactorEnabled: boolean
  onReplaced: () => void
}) {
  const [token, setToken] = React.useState("")
  const tokenOk = TELEGRAM_BOT_TOKEN_RE.test(token.trim())
  return (
    <ReauthDialog
      open={open}
      onOpenChange={(o) => {
        // drop the typed token whenever the dialog closes
        if (!o) setToken("")
        onOpenChange(o)
      }}
      twoFactorEnabled={twoFactorEnabled}
      idPrefix="tg-replace"
      texts={{
        title: m.replace.title,
        description: m.replace.description,
        submit: m.replace.submit,
      }}
      canSubmit={tokenOk}
      onSubmit={(fields) =>
        replaceTelegramTokenAction({
          channelId,
          botToken: token.trim(),
          ...fields,
        })
      }
      onSuccess={(_data, message) => {
        setToken("")
        toast.success(message ?? m.server.tokenReplaced)
        onReplaced()
      }}
    >
      <Field>
        <FieldLabel htmlFor="tg-replace-token">{m.replace.tokenLabel}</FieldLabel>
        <SecretInput
          id="tg-replace-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={m.form.botTokenPlaceholder}
          aria-invalid={token.trim() !== "" && !tokenOk ? true : undefined}
        />
        <FieldDescription>
          {token.trim() !== "" && !tokenOk ? (
            <span className="text-destructive">
              {/* same wording as the server-side zod error */}
              {m.errors.botTokenFormat}
            </span>
          ) : (
            <span className="font-mono">
              {m.replace.currentHint(credentialHint)}
            </span>
          )}
        </FieldDescription>
      </Field>
    </ReauthDialog>
  )
}
