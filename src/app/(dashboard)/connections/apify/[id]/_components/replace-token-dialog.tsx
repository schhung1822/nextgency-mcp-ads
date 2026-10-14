"use client"

// "Thay token": new Apify API token + password (+ TOTP) through the shared re-auth dialog. Never prefilled.
import * as React from "react"
import { toast } from "sonner"

import { ReauthDialog, SecretInput } from "@/components/app"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { apify as a } from "@/lib/i18n/vi/apify"
import { APIFY_SCHEMA_MESSAGES, APIFY_TOKEN_RE } from "@/lib/schemas/apify"
import { replaceApifyTokenAction } from "@/server/actions/apify"

export function ReplaceApifyTokenDialog({
  open,
  onOpenChange,
  tokenId,
  credentialHint,
  twoFactorEnabled,
  onReplaced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tokenId: string
  credentialHint: string
  twoFactorEnabled: boolean
  onReplaced: () => void
}) {
  const [token, setToken] = React.useState("")
  const trimmed = token.trim()
  const tokenOk = APIFY_TOKEN_RE.test(trimmed)
  return (
    <ReauthDialog
      open={open}
      onOpenChange={(o) => {
        // drop the typed token whenever the dialog closes
        if (!o) setToken("")
        onOpenChange(o)
      }}
      twoFactorEnabled={twoFactorEnabled}
      idPrefix="apify-replace"
      texts={{
        title: a.replace.title,
        description: a.replace.description,
        submit: a.replace.submit,
      }}
      canSubmit={tokenOk}
      onSubmit={(fields) =>
        replaceApifyTokenAction({ id: tokenId, token: trimmed, ...fields })
      }
      onSuccess={(_data, message) => {
        setToken("")
        toast.success(message ?? a.server.tokenReplaced)
        onReplaced()
      }}
    >
      <Field>
        <FieldLabel htmlFor="apify-replace-token">
          {a.replace.tokenLabel}
        </FieldLabel>
        <SecretInput
          id="apify-replace-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={a.form.tokenPlaceholder}
          aria-invalid={trimmed !== "" && !tokenOk ? true : undefined}
          aria-describedby="apify-replace-token-help"
        />
        <FieldDescription id="apify-replace-token-help">
          {trimmed !== "" && !tokenOk ? (
            <span className="text-destructive">
              {/* same wording as the server-side zod error */}
              {APIFY_SCHEMA_MESSAGES.tokenFormat}
            </span>
          ) : (
            <span className="font-mono">
              {a.replace.currentHint(credentialHint)}
            </span>
          )}
        </FieldDescription>
      </Field>
    </ReauthDialog>
  )
}
