// E2E for /mcp-servers (list → 4-step wizard → success → detail → reveal → rotate).
// Needs a running app + a signed-in STAFF user that owns ≥1 connection with ≥1 enabled ad account:
//   E2E_BASE_URL=http://localhost:3000
//   E2E_SESSION_COOKIE="better-auth.session_token=…"   (cookie header of that user's session)
//   E2E_PASSWORD=…                                       (that user's password: create/reveal/rotate re-auth;
//                                                         the user must NOT have 2FA for this spec)
//   E2E_SCREENSHOTS=dir                                  (optional: light/dark × 1440/390 screenshots)
// Skipped when the variables are missing.
import { expect, test, type BrowserContext, type Page } from "@playwright/test"

import { acceptDisclaimerIfAsked } from "./disclaimer-helpers"

const BASE = process.env.E2E_BASE_URL
const COOKIE = process.env.E2E_SESSION_COOKIE
const PASSWORD = process.env.E2E_PASSWORD
const SHOTS = process.env.E2E_SCREENSHOTS

test.skip(!BASE || !COOKIE, "E2E_BASE_URL / E2E_SESSION_COOKIE not set")

async function signIn(context: BrowserContext) {
  const url = new URL(BASE!)
  await context.addCookies(
    COOKIE!
      .split(/;\s*/)
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf("=")
        return {
          name: kv.slice(0, i),
          value: kv.slice(i + 1),
          domain: url.hostname,
          path: "/",
        }
      })
  )
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

test.describe("MCP servers", () => {
  test.beforeEach(async ({ context }) => signIn(context))

  test("create through the wizard, then reveal and rotate the link", async ({
    page,
  }) => {
    test.skip(
      !PASSWORD,
      "E2E_PASSWORD not set (creating an MCP requires re-authentication)"
    )
    const name = `E2E MCP ${Date.now()}`
    await page.goto(`${BASE}/mcp-servers`)
    await expect(
      page.getByRole("heading", { level: 1, name: "MCP" })
    ).toBeVisible()
    await page.getByRole("link", { name: "Tạo MCP" }).first().click()
    // "Miễn trừ trách nhiệm" popup before the wizard (shown once per user and version)
    await acceptDisclaimerIfAsked(page)

    // ① name — required
    await page.getByRole("button", { name: "Tiếp tục" }).click()
    await expect(page.getByText("Nhập tên MCP.")).toBeVisible()
    await page.fill("#mcp-name", name)
    await page.getByRole("button", { name: "Tiếp tục" }).click()

    // ② first available platform + its first connection ("Tất cả tài khoản")
    await page.getByRole("switch").first().click()
    const conn = page.locator('[id^="conn-"][role="checkbox"]').first()
    if ((await conn.getAttribute("data-state")) !== "checked")
      await conn.click()
    await page.getByRole("button", { name: "Tiếp tục" }).click()

    // ③ "Xem" is always on and cannot be unchecked
    const read = page.locator('[id$="-read"][role="checkbox"]').first()
    await expect(read).toBeDisabled()
    await expect(read).toHaveAttribute("data-state", "checked")
    // permission level = segmented control (radio group) per platform
    await page
      .getByRole("radio", { name: "Vận hành (xem + bật/tắt + sửa)" })
      .first()
      .click()
    await page.getByRole("button", { name: "Tiếp tục" }).click()

    // ④ protection defaults: two-step ON, 50 %, 60/min; invalid IP blocks submit
    await expect(
      page.getByRole("switch", { name: /Xác nhận 2 bước/ })
    ).toHaveAttribute("data-state", "checked")
    await expect(page.locator("#mcp-budget-pct")).toHaveValue("50")
    await expect(page.locator("#mcp-rate")).toHaveValue("60")
    await page.fill("#mcp-ips", "not-an-ip")
    await page.getByRole("button", { name: "Tạo MCP" }).click()
    await expect(page.getByText(/không phải địa chỉ IP/)).toBeVisible()
    // "Vận hành" can switch on / change budgets: a daily cap per currency in scope is mandatory
    await expect(
      page.getByText(/\(bắt buộc khi MCP có quyền ghi\)/).first()
    ).toBeVisible()
    const dailyCaps = page.locator(
      '[id^="mcp-maxDailyBudget-"][aria-required="true"]'
    )
    expect(await dailyCaps.count()).toBeGreaterThan(0)
    for (const input of await dailyCaps.all()) await input.fill("5000000")
    await page.fill("#mcp-ips", "")
    await page.getByRole("button", { name: "Tạo MCP" }).click()

    // re-authentication before the link is handed out
    const reauth = page.getByRole("dialog", { name: "Xác minh để tạo MCP" })
    await expect(reauth).toBeVisible()
    await page.fill("#create-mcp-password", "definitely-wrong-password")
    await reauth.getByRole("button", { name: "Xác minh và tạo MCP" }).click()
    await expect(
      reauth.getByText("Mật khẩu hoặc mã xác thực không đúng.")
    ).toBeVisible()
    await page.fill("#create-mcp-password", PASSWORD!)
    await reauth.getByRole("button", { name: "Xác minh và tạo MCP" }).click()

    // success: full URL once + guide
    await expect(
      page.getByText("Ai có link này đều dùng được MCP")
    ).toBeVisible()
    const url = await page
      .getByRole("textbox", { name: "Link MCP" })
      .first()
      .inputValue()
    expect(url).toMatch(/\/mcp\/amcp_[A-Za-z0-9_-]{43}$/)
    await page.getByRole("tab", { name: "Claude Code" }).click()
    await expect(
      page.getByText(`claude mcp add --transport http ads-noti ${url}`)
    ).toBeVisible()
    await shot(page, "e2e-success")

    // detail: masked link only
    await page.getByRole("link", { name: "Xem chi tiết MCP" }).click()
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole("tab", { name: "Kết nối AI" }).click()
    await expect(
      page.getByRole("textbox", { name: "Link MCP (đã che)" })
    ).toHaveValue(/••••/)
    await expect(page.locator("body")).not.toContainText(url)

    if (PASSWORD) {
      await page.getByRole("button", { name: "Xem lại link" }).first().click()
      await page.fill("#reveal-password", "definitely-wrong-password")
      await page.getByRole("button", { name: "Xác minh và xem link" }).click()
      await expect(
        page.getByText("Mật khẩu hoặc mã xác thực không đúng.")
      ).toBeVisible()
      await page.fill("#reveal-password", PASSWORD)
      await page.getByRole("button", { name: "Xác minh và xem link" }).click()
      await expect(
        page.getByRole("textbox", { name: "Link MCP" }).first()
      ).toHaveValue(url)
    }

    // rotate (re-auth required) → new URL differs
    await page.getByRole("tab", { name: "Bảo mật" }).click()
    if (PASSWORD) {
      await page.getByRole("button", { name: "Xoay key" }).first().click()
      await page.fill("#reveal-password", PASSWORD)
      await page.getByRole("button", { name: "Xác minh và xoay key" }).click()
      const dialog = page.getByRole("dialog", { name: "Link MCP mới" })
      await expect(dialog).toBeVisible()
      const rotated = await dialog.getByRole("textbox").inputValue()
      expect(rotated).toMatch(/\/mcp\/amcp_/)
      expect(rotated).not.toBe(url)
      await dialog.getByRole("button", { name: "Đóng" }).first().click()
    }

    // delete (type the name)
    await page.getByRole("button", { name: "Xoá MCP" }).click()
    await page.getByRole("alertdialog").getByRole("textbox").fill(name)
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Xoá MCP" })
      .click()
    await expect(page).toHaveURL(/\/mcp-servers$/)
    await expect(page.getByText(name)).toHaveCount(0)
  })

  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      test(`list + wizard render (${theme}, ${width}px)`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          colorScheme: theme,
          viewport: { width, height: 900 },
        })
        await signIn(context)
        const page = await context.newPage()
        await page.goto(`${BASE}/mcp-servers`)
        await expect(
          page.getByRole("heading", { level: 1, name: "MCP" })
        ).toBeVisible()
        await shot(page, `e2e-list-${theme}-${width}`)
        await page.goto(`${BASE}/mcp-servers/new`)
        await shot(page, `e2e-disclaimer-${theme}-${width}`)
        await acceptDisclaimerIfAsked(page)
        await expect(
          page.getByRole("heading", { level: 1, name: "Tạo MCP" })
        ).toBeVisible()
        await shot(page, `e2e-wizard-${theme}-${width}`)
        await context.close()
      })
    }
  }
})
