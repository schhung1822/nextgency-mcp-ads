// The "Miễn trừ trách nhiệm" popup in front of /connections/new, /connections/telegram/new, /connections/drive/new and
// /mcp-servers/new: read it like a person would (scroll to the end, wait for the 10 s countdown), tick, confirm.
import { expect, type Locator, type Page } from "@playwright/test"

export const DISCLAIMER_TITLE = /Miễn trừ trách nhiệm - vui lòng đọc kỹ/

export function disclaimerDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: DISCLAIMER_TITLE })
}

/** The wrapper around the gated flow: data-disclaimer = "checking" (before hydration) | "open" | "accepted". */
export function disclaimerGateState(page: Page): Locator {
  return page.locator("[data-disclaimer]")
}

/** The popup is not asked on this page (the user already accepted the current version): the flow is usable. */
export async function expectNoDisclaimer(page: Page): Promise<void> {
  await expect(disclaimerGateState(page)).toHaveAttribute(
    "data-disclaimer",
    "accepted"
  )
  await expect(disclaimerDialog(page)).toHaveCount(0)
}

/**
 * Accept the popup only if this user is asked (shown once per user and version - e.g. a shared e2e account may have
 * accepted it in an earlier run).
 */
export async function acceptDisclaimerIfAsked(page: Page): Promise<void> {
  const gate = disclaimerGateState(page)
  await expect(gate).toHaveAttribute("data-disclaimer", /^(open|accepted)$/)
  if ((await gate.getAttribute("data-disclaimer")) === "open")
    await acceptDisclaimer(page)
}

/** Accept the popup that is open on `page` (fails if none appears). */
export async function acceptDisclaimer(page: Page): Promise<void> {
  const dialog = disclaimerDialog(page)
  await expect(dialog).toBeVisible()
  const agree = dialog.getByRole("checkbox", {
    name: /Tôi đã đọc kỹ, hiểu và đồng ý/,
  })
  await dialog
    .getByRole("region", { name: "Nội dung miễn trừ trách nhiệm" })
    .evaluate((el) => el.scrollTo(0, el.scrollHeight))
  // minimum reading time: 10 s from the moment the popup opened
  await expect(agree).toBeEnabled({ timeout: 20_000 })
  await agree.click()
  await dialog.getByRole("button", { name: "Tôi đồng ý và bắt đầu" }).click()
  await expect(dialog).toBeHidden()
}
