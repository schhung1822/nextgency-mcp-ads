"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { ArrowLeft01Icon, SearchList01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { BrandIcon, SecretInput } from "@/components/app"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { notifications as m } from "@/lib/i18n/vi/notifications"
import {
  telegramChannelFormSchema,
  type TelegramChannelFormValues,
  type TelegramCheckResult,
} from "@/lib/schemas/notifications"
import {
  createTelegramChannelAction,
  previewTelegramChannelAction,
} from "@/server/actions/notification-channels"

import {
  TelegramCheckError,
  TelegramCheckSummary,
} from "../../_components/telegram-check-result"
import { TelegramSettingsFields } from "../../_components/telegram-settings-fields"

type Check =
  | { state: "idle" }
  | { state: "ok"; result: TelegramCheckResult; key: string }
  | { state: "error"; message: string }

const FIELD_KEYS = [
  "name",
  "botToken",
  "chatId",
  "messageThreadId",
  "events",
  "allConnections",
] as const

/** what a check depends on: re-check needed when any of these changes */
const checkKey = (v: {
  botToken?: string
  chatId?: string
  messageThreadId?: string
}) =>
  JSON.stringify([
    (v.botToken ?? "").trim(),
    (v.chatId ?? "").trim(),
    (v.messageThreadId ?? "").trim(),
  ])

export function TelegramNewForm({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter()
  const [check, setCheck] = React.useState<Check>({ state: "idle" })
  const [checking, setChecking] = React.useState(false)
  // the result block (check summary / error box) is brought into view after each run
  const resultRef = React.useRef<HTMLDivElement>(null)
  const [resultRuns, setResultRuns] = React.useState(0)
  // always-mounted polite live region: a freshly mounted region is often not announced
  const [announcement, setAnnouncement] = React.useState("")
  React.useEffect(() => {
    if (resultRuns === 0) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    resultRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    })
  }, [resultRuns])
  const form = useForm<TelegramChannelFormValues>({
    resolver: zodResolver(telegramChannelFormSchema),
    defaultValues: {
      name: "",
      botToken: "",
      chatId: "",
      messageThreadId: "",
      events: ["connection_health"],
      allConnections: false,
    },
    mode: "onTouched",
  })
  const watched = useWatch({
    control: form.control,
    name: ["botToken", "chatId", "messageThreadId"],
  })
  const currentKey = checkKey({
    botToken: watched[0],
    chatId: watched[1],
    messageThreadId: watched[2],
  })

  /** server field errors → the matching field; anything else → the error box */
  const applyFailure = (error: string, fieldErrors?: Record<string, string>) => {
    let placed = false
    for (const k of FIELD_KEYS) {
      const msg = fieldErrors?.[k]
      if (msg) {
        form.setError(k, { message: msg })
        placed = true
      }
    }
    if (!placed) {
      setCheck({ state: "error", message: error })
      setResultRuns((n) => n + 1)
    }
  }

  const runCheck = async () => {
    const valid = await form.trigger(["botToken", "chatId", "messageThreadId"])
    if (!valid) return
    const v = form.getValues()
    setChecking(true)
    setAnnouncement("")
    const res = await previewTelegramChannelAction({
      botToken: v.botToken,
      chatId: v.chatId,
      messageThreadId: v.messageThreadId,
    })
    setChecking(false)
    if (!res.ok) {
      setCheck({ state: "idle" })
      applyFailure(res.error, res.fieldErrors)
      return
    }
    setCheck({ state: "ok", result: res.data, key: checkKey(v) })
    setResultRuns((n) => n + 1)
    setAnnouncement(
      m.check.announceOk(res.data.chat.title ?? res.data.chat.id)
    )
    toast.success(m.check.okTitle)
  }

  const onSubmit = form.handleSubmit(async (v) => {
    setCheck((c) => (c.state === "error" ? { state: "idle" } : c))
    const res = await createTelegramChannelAction({
      name: v.name,
      botToken: v.botToken,
      chatId: v.chatId,
      messageThreadId: v.messageThreadId,
      events: v.events,
      allConnections: isAdmin ? v.allConnections : false,
    })
    if (!res.ok) {
      applyFailure(res.error, res.fieldErrors)
      return
    }
    toast.success(res.message ?? m.server.created)
    // the token never stays in the browser after saving
    form.reset()
    router.push(`/connections/telegram/${res.data.id}?created=1`)
  })

  const submitting = form.formState.isSubmitting
  const busy = submitting || checking

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BrandIcon brand="telegram" />
            {m.form.cardTitle}
          </CardTitle>
          <CardDescription>{m.form.cardDescription}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <TelegramSettingsFields
            control={form.control}
            isAdmin={isAdmin}
            idPrefix="tg-new"
            afterName={
              <Controller
                control={form.control}
                name="botToken"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="tg-new-token">
                      {m.form.botTokenLabel}
                    </FieldLabel>
                    <SecretInput
                      id="tg-new-token"
                      name={field.name}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      ref={field.ref}
                      placeholder={m.form.botTokenPlaceholder}
                      aria-invalid={fieldState.invalid || undefined}
                      aria-describedby="tg-new-token-help"
                    />
                    <FieldDescription id="tg-new-token-help">
                      {m.form.botTokenHelp}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            }
          />

          <div ref={resultRef} className="scroll-mt-24 empty:hidden">
            {check.state === "ok" && (
              <TelegramCheckSummary
                check={check.result}
                outdated={check.key !== currentKey}
              />
            )}
            {check.state === "error" && (
              <TelegramCheckError message={check.message} />
            )}
          </div>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col-reverse gap-2 border-t sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="lg"
            className={cn(
              "w-full sm:w-auto",
              busy && "pointer-events-none opacity-50"
            )}
            asChild
          >
            <Link
              href="/connections/new"
              aria-disabled={busy || undefined}
              tabIndex={busy ? -1 : undefined}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                data-icon="inline-start"
                aria-hidden
              />
              {m.form.back}
            </Link>
          </Button>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => void runCheck()}
              disabled={busy}
            >
              {checking ? (
                <Spinner aria-hidden />
              ) : (
                <HugeiconsIcon
                  icon={SearchList01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                  aria-hidden
                />
              )}
              {checking ? m.form.checking : m.form.check}
            </Button>
            <Button
              type="submit"
              variant="brand"
              size="lg"
              className="w-full sm:w-auto"
              disabled={busy}
            >
              {submitting && <Spinner aria-hidden />}
              {submitting ? m.form.saving : m.form.save}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  )
}
