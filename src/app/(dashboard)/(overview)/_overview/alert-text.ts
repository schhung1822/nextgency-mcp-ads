// What the Overview "Cảnh báo" card says about one connection: what happened (statusMessage) and the next step
// (statusHint). Pure, so it can be tested without rendering.
import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"
import { dashboard as td } from "@/lib/i18n/vi/dashboard"
import { visibleStatusHint } from "@/lib/schemas/connections"

export interface AlertTextInput {
  kind: "invalid" | "expiring"
  platform: string
  /** whole days left (null when no expiry) */
  daysLeft: number | null
  message: string | null
  hint: string | null
}

export function alertText(a: AlertTextInput): {
  message: string
  hint: string | null
} {
  const message =
    a.message?.trim() ||
    (a.kind === "invalid"
      ? td.alerts.invalid
      : a.daysLeft !== null
        ? td.alerts.expiresIn(a.daysLeft)
        : td.alerts.expiring)
  // the server derives the hint from the stored status; a token that is merely close to its expiry date while the
  // status is still "active" has none, but the next step is the same as for "expiring"
  const expiringFallback =
    a.kind === "expiring" && a.platform in cs.hint.expiring
      ? cs.hint.expiring[a.platform as keyof typeof cs.hint.expiring]
      : null
  return { message, hint: visibleStatusHint(message, a.hint ?? expiringFallback) }
}
