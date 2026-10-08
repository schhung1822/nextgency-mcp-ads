import { describe, expect, it } from "vitest"

import { connectionStatus as cs } from "@/lib/i18n/vi/connection-status"
import { dashboard as td } from "@/lib/i18n/vi/dashboard"

import { alertText } from "./alert-text"

const base = {
  platform: "meta",
  daysLeft: 6 as number | null,
  message: null as string | null,
  hint: null as string | null,
}

describe("alertText (Overview 'Cảnh báo')", () => {
  it("shows what happened and then the next step", () => {
    const msg = cs.message.invalid
    expect(
      alertText({
        ...base,
        kind: "invalid",
        message: msg,
        hint: cs.hint.invalid.meta,
      })
    ).toEqual({ message: msg, hint: cs.hint.invalid.meta })
  })

  it("shows the next step once when the message already carries it", () => {
    const hint = cs.hint.invalid.openai_ads
    const out = alertText({
      ...base,
      platform: "openai_ads",
      kind: "invalid",
      message: `API key bị từ chối (401). ${hint}`,
      hint,
    })
    expect(out.hint).toBeNull()
    expect(out.message).toContain(hint)
  })

  it("falls back to a generic line when there is no message", () => {
    expect(alertText({ ...base, kind: "invalid" }).message).toBe(
      td.alerts.invalid
    )
    expect(alertText({ ...base, kind: "expiring", daysLeft: 3 }).message).toBe(
      td.alerts.expiresIn(3)
    )
    expect(
      alertText({ ...base, kind: "expiring", daysLeft: null }).message
    ).toBe(td.alerts.expiring)
    expect(alertText({ ...base, kind: "expiring", daysLeft: -1 }).message).toBe(
      td.alerts.expiresIn(-1)
    )
  })

  it("gives a token that is close to its expiry (status still active) the 'expiring' next step", () => {
    for (const platform of ["meta", "tiktok", "google_ads", "openai_ads"]) {
      expect(alertText({ ...base, platform, kind: "expiring" }).hint).toBe(
        cs.hint.expiring[platform as keyof typeof cs.hint.expiring]
      )
    }
    // an invalid token never borrows the expiring hint, and an unknown platform gets none
    expect(alertText({ ...base, kind: "invalid" }).hint).toBeNull()
    expect(
      alertText({ ...base, platform: "other", kind: "expiring" }).hint
    ).toBeNull()
  })

  it("keeps the server's hint when there is one", () => {
    expect(
      alertText({
        ...base,
        kind: "expiring",
        message: cs.message.expiring(3, "06/10/2026"),
        hint: cs.hint.retry,
      }).hint
    ).toBe(cs.hint.retry)
  })
})
