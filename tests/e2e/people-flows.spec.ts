// Browser flows around the 2FA policy and the owner-lockout rules (users seeded straight into the e2e database):
//  1. an admin who opted into 2FA can turn it off again from /account while the policy does not require it
//     (regression: the action used to refuse every admin),
//  2. an admin WITHOUT 2FA switches "Bắt buộc 2FA cho quản trị viên" on in /settings, is sent to the enrolment
//     step on the next page, completes it and gets back in (no lock-out deadlock); switching it OFF again relaxes
//     security and asks for the password + TOTP first,
//  3. typos at the login form: friendly error, no session cookie, no 5xx — the owner is not locked out,
//  4. the sign-in lockout: attackers from ONE IP cannot lock the owner out, and the owner's usual IP always works.
import { expect, request as pwRequest, test, type Page } from "@playwright/test"

import { BASE, db, nextIp, PASSWORD, seedUser, setPolicy, totp } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(240_000)

async function uiLogin(page: Page, email: string, opts: { twoFactor?: boolean } = {}) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextIp() })
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
  if (opts.twoFactor) {
    await expect(page).toHaveURL(/\/login\/2fa/)
    await page.locator("#otp-code").fill(totp())
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
}

test.afterAll(async () => {
  await setPolicy({ admin: false, all: false })
})

test("admin đã bật 2FA tự tắt được ở Tài khoản khi chính sách không bắt buộc", async ({ page }) => {
  await setPolicy({ admin: false, all: false })
  const { email, id } = await seedUser({ key: "flow2fa", role: "admin", twoFactor: true })
  await uiLogin(page, email, { twoFactor: true })
  await page.goto("/account")
  await expect(page.getByText("Đã bật", { exact: true })).toBeVisible()
  await expect(page.getByText("Hệ thống bắt buộc")).toHaveCount(0)

  await page.getByRole("button", { name: "Tắt xác thực 2 bước" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Mật khẩu").fill(PASSWORD)
  await dialog.getByLabel("Mã xác thực 6 số").fill(totp())
  await dialog.getByRole("button", { name: "Tắt 2FA" }).click()
  await expect(page.getByText("Chưa bật", { exact: true })).toBeVisible()
  const row = await db((c) => c.query(`select two_factor_enabled from "user" where id = $1`, [id]))
  expect(row.rows[0].two_factor_enabled).toBe(false)
  const log = await db((c) =>
    c.query(`select status from activity_logs where actor_id = $1 and action = 'auth.2fa.disable'`, [id])
  )
  expect(log.rows.map((r) => r.status)).toContain("success")
})

test("khi bật 'bắt buộc 2FA cho quản trị viên' trong Cài đặt: admin chưa có 2FA được đưa tới bước bật rồi vào lại được", async ({ page }) => {
  await setPolicy({ admin: false, all: false })
  const { email } = await seedUser({ key: "flowpolicy", role: "admin" })
  await uiLogin(page, email)

  await page.goto("/settings")
  await page.getByLabel("Bắt buộc xác thực 2 bước cho quản trị viên").click()
  await page.getByRole("button", { name: "Lưu", exact: true }).click()
  await expect(page.getByText("Có thay đổi chưa lưu")).toHaveCount(0)
  const stored = await db((c) => c.query(`select value from app_settings where key = 'require_2fa_admin'`))
  expect(stored.rows[0].value).toBe(true)

  // the very next page: forced enrolment (and nowhere else to go but sign out)
  await page.goto("/users")
  await expect(page).toHaveURL(/\/security\/enable-2fa$/)
  await expect(page.getByRole("link", { name: "Quay lại Tài khoản" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible()

  // …but enrolment itself works (password step is allowed while the policy is pending)
  await page.getByLabel("Mật khẩu hiện tại").fill(PASSWORD)
  await page.getByRole("button", { name: "Tiếp tục" }).click()
  await expect(page.getByTestId("totp-qr")).toBeVisible()
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "")
  expect(secret).toMatch(/^[A-Z2-7]+=*$/)
  // the seeded helper only knows its own key: compute the code for the one the server just generated
  const { createHmac } = await import("node:crypto")
  const codeAt = (offsetMs: number) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    let bits = 0
    let value = 0
    const bytes: number[] = []
    for (const ch of secret.replace(/=+$/, "")) {
      value = (value << 5) | alphabet.indexOf(ch)
      bits += 5
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff)
        bits -= 8
      }
    }
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor((Date.now() + offsetMs) / 1000 / 30)))
    const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest()
    const off = h[h.length - 1]! & 0x0f
    const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
    return String(bin % 1_000_000).padStart(6, "0")
  }
  await page.locator("#enable2fa-code").fill(codeAt(0))
  await expect(page.getByTestId("backup-codes").locator("li")).toHaveCount(10)
  await page.getByLabel("Tôi đã lưu mã dự phòng ở nơi an toàn").check()
  await page.getByRole("button", { name: "Hoàn tất" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/security"))
  const res = await page.goto("/users")
  expect(res?.status()).toBe(200)

  // switching the requirement OFF again relaxes security: password + TOTP first
  await page.goto("/settings")
  await page.getByLabel("Bắt buộc xác thực 2 bước cho quản trị viên").click()
  await page.getByRole("button", { name: "Lưu", exact: true }).click()
  const reauth = page.getByRole("dialog")
  await expect(reauth.getByRole("heading", { name: "Xác nhận thay đổi bảo mật" })).toBeVisible()
  await reauth.locator("#settings-reauth-password").fill("sai-mat-khau-1")
  await reauth.getByLabel("Mã xác thực 6 số").fill(codeAt(30_000))
  await reauth.getByRole("button", { name: "Lưu thay đổi" }).click()
  await expect(reauth.getByRole("alert")).toBeVisible()
  const still = await db((c) => c.query(`select value from app_settings where key = 'require_2fa_admin'`))
  expect(still.rows[0].value).toBe(true)
  await reauth.locator("#settings-reauth-password").fill(PASSWORD)
  await reauth.getByLabel("Mã xác thực 6 số").fill(codeAt(30_000))
  await reauth.getByRole("button", { name: "Lưu thay đổi" }).click()
  await expect
    .poll(async () => (await db((c) => c.query(`select value from app_settings where key = 'require_2fa_admin'`))).rows[0].value)
    .toBe(false)
  await setPolicy({ admin: false, all: false })
})

test("gõ sai mật khẩu ở form đăng nhập: báo lỗi thân thiện, không có phiên, không bị khoá sau vài lần gõ nhầm", async ({ page }) => {
  await setPolicy({ admin: false, all: false })
  const { email } = await seedUser({ key: "flowtypo", role: "staff" })
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextIp() })
  await page.goto("/login")
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  const serverErrors: number[] = []
  page.on("response", (r) => {
    if (r.status() >= 500) serverErrors.push(r.status())
  })
  for (let i = 0; i < 3; i++) {
    await page.getByLabel("Email").fill(email)
    await page.getByLabel("Mật khẩu", { exact: true }).fill(`sai-mat-khau-${i}`)
    await page.getByRole("button", { name: "Đăng nhập" }).click()
    await expect(page.getByRole("alert").filter({ hasText: "Email hoặc mật khẩu không đúng." })).toBeVisible()
    // the password field is cleared, the email kept, still on /login
    await expect(page.getByLabel("Mật khẩu", { exact: true })).toHaveValue("")
    await expect(page).toHaveURL(/\/login$/)
  }
  expect((await page.context().cookies()).some((c) => /session_token/.test(c.name))).toBe(false)
  expect(errors).toEqual([])
  expect(serverErrors).toEqual([])
  // after the typos the right password still signs the owner in (3 failures is far below the lock)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
})

test("khoá đăng nhập: kẻ tấn công từ một IP không khoá được chủ hệ thống; IP quen thuộc luôn vào được", async () => {
  await setPolicy({ admin: false, all: false })
  const { email } = await seedUser({ key: "flowlock", role: "admin" })
  const ownerIp = nextIp()
  const attackerIp = nextIp()
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } })
  const signIn = (password: string, ip: string) =>
    ctx.post("/api/auth/sign-in/email", { data: { email, password }, headers: { "x-forwarded-for": ip } })

  // the owner signs in from his usual IP once (this IP becomes "known")
  expect((await signIn(PASSWORD, ownerIp)).status()).toBe(200)

  // an attacker guesses from ONE address (Better Auth allows 5 sign-ins / minute / IP; the exact 10-failure and
  // 50-failure thresholds are covered with the counters themselves in src/server/auth/auth-hardening.test.ts)
  for (let i = 0; i < 4; i++) expect((await signIn(`guess-${i}-xxxxxxxx`, attackerIp)).status()).toBe(401)
  // the owner (different IP) is NOT affected, and neither is a brand-new IP
  expect((await signIn(PASSWORD, ownerIp)).status()).toBe(200)
  expect((await signIn(PASSWORD, nextIp())).status()).toBe(200)
  await ctx.dispose()
})
