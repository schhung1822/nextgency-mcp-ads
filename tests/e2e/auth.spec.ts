// E2E (policy of 2026-10-02: 2FA is OPTIONAL by default, passwords need ≥ 8 characters, admins can enforce
// 2FA in Cài đặt → require_2fa_admin / require_2fa_all):
// first-run setup (lands on the dashboard, no forced 2FA) → admin opts in to 2FA from /account → admin creates
// staff → staff login → forced password change → staff cannot open /users (404) → admin logs in again with TOTP
// → activity log has the events → enforcement switches (require_2fa_all / require_2fa_admin) change the UI.
// Runs against the throwaway <db>_e2e database prepared by playwright.config.ts.
import { createHmac } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"
import pg from "pg"

test.describe.configure({ mode: "serial" })

const ADMIN = { name: "Quản trị E2E", email: "admin.e2e@example.com", password: "Admin-Pass-2026!" }
const STAFF = { name: "Nhân viên E2E", email: "staff.e2e@example.com", temp: "Temp-Pass-2026-xyz", next: "Staff-New-Pass-2026!" }
let totpSecret = ""

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — same parameters as the Better Auth twoFactor plugin config.
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(c)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 1_000_000).padStart(6, "0")
}

let lastTotp = ""

/** Avoid typing a code that expires mid-request, and never reuse the previous code (replay protection). */
async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const remaining = 30 - (Math.floor(Date.now() / 1000) % 30)
    if (remaining < 4 || totp(secret) === lastTotp) {
      await new Promise((r) => setTimeout(r, remaining * 1000 + 500))
      continue
    }
    lastTotp = totp(secret)
    return lastTotp
  }
}

/** Flip an app_settings row directly in the e2e database (what Cài đặt → Bảo mật saves). */
async function setSetting(key: string, value: unknown) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL })
  await client.connect()
  try {
    await client.query(
      "insert into app_settings(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value",
      [key, JSON.stringify(value)]
    )
  } finally {
    await client.end()
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
}

test("thiết lập lần đầu: /login chuyển sang /setup khi chưa có người dùng", async ({ page }) => {
  await page.goto("/login")
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole("heading", { name: "Thiết lập Ads MCP" })).toBeVisible()
})

test("sai SETUP_TOKEN bị từ chối", async ({ page }) => {
  await page.goto("/setup")
  await page.getByLabel("Họ tên").fill(ADMIN.name)
  await page.getByLabel("Email").fill(ADMIN.email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(ADMIN.password)
  await page.getByLabel("Nhập lại mật khẩu").fill(ADMIN.password)
  await page.getByLabel("Mã thiết lập (SETUP_TOKEN)").fill("sai-ma-thiet-lap")
  await page.getByRole("button", { name: "Tạo quản trị viên" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Mã thiết lập không đúng." })).toBeVisible()
})

test("mật khẩu ngắn hơn 8 ký tự bị chặn ngay trên form thiết lập", async ({ page }) => {
  await page.goto("/setup")
  await expect(page.getByText("Ít nhất 8 ký tự")).toBeVisible()
  await page.getByLabel("Họ tên").fill(ADMIN.name)
  await page.getByLabel("Email").fill(ADMIN.email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill("Ab1!xyz")
  await page.getByLabel("Nhập lại mật khẩu").fill("Ab1!xyz")
  await page.getByLabel("Mã thiết lập (SETUP_TOKEN)").fill(process.env.E2E_SETUP_TOKEN!)
  await page.getByRole("button", { name: "Tạo quản trị viên" }).click()
  await expect(page.getByText("Mật khẩu cần ít nhất 8 ký tự.")).toBeVisible()
  await expect(page).toHaveURL(/\/setup$/)
})

test("tạo admin đầu tiên → vào thẳng Tổng quan (2FA không bắt buộc) → tự bật 2FA ở Tài khoản", async ({ page }) => {
  await page.goto("/setup")
  await page.getByLabel("Họ tên").fill(ADMIN.name)
  await page.getByLabel("Email").fill(ADMIN.email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(ADMIN.password)
  await page.getByLabel("Nhập lại mật khẩu").fill(ADMIN.password)
  await page.getByLabel("Mã thiết lập (SETUP_TOKEN)").fill(process.env.E2E_SETUP_TOKEN!)
  await page.getByRole("button", { name: "Tạo quản trị viên" }).click()
  // 2FA is optional by default: no forced enrolment, the admin lands on the dashboard.
  await page.waitForURL((u) => u.pathname === "/")

  // /account offers (does not force) 2FA.
  await page.goto("/account")
  await expect(page.getByRole("heading", { name: "Tài khoản", level: 1 })).toBeVisible()
  await expect(page.getByText("Không bắt buộc, nhưng nên bật")).toBeVisible()
  await page.getByRole("link", { name: "Bật xác thực 2 bước" }).click()
  await expect(page).toHaveURL(/\/security\/enable-2fa$/)
  // optional enrolment keeps an escape hatch back to the account page
  await expect(page.getByRole("link", { name: "Quay lại Tài khoản" })).toBeVisible()

  await page.getByLabel("Mật khẩu hiện tại").fill(ADMIN.password)
  await page.getByRole("button", { name: "Tiếp tục" }).click()
  await expect(page.getByTestId("totp-qr")).toBeVisible()
  // the key is shown grouped in blocks of 4 for manual entry
  totpSecret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "")
  expect(totpSecret).toMatch(/^[A-Z2-7]+=*$/)

  await page.locator("#enable2fa-code").fill(await freshTotp(totpSecret))
  const codes = page.getByTestId("backup-codes").locator("li")
  await expect(codes).toHaveCount(10)
  await page.getByLabel("Tôi đã lưu mã dự phòng ở nơi an toàn").check()
  await page.getByRole("button", { name: "Hoàn tất" }).click()
  await page.waitForURL((u) => u.pathname === "/account")
  await expect(page.getByText("Đã bật", { exact: true })).toBeVisible()

  // /setup is gone once a user exists.
  const setup = await page.goto("/setup")
  expect(setup?.status()).toBe(404)
})

test("admin tạo nhân viên với mật khẩu tạm", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password)
  await expect(page).toHaveURL(/\/login\/2fa/)
  // Trust-device checkbox is hidden for admins.
  await expect(page.getByLabel("Tin thiết bị này trong 14 ngày")).toHaveCount(0)
  await page.locator("#otp-code").fill(await freshTotp(totpSecret))
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))

  await page.goto("/users")
  await expect(page.getByRole("heading", { name: "Người dùng", level: 1 })).toBeVisible()
  await page.getByRole("button", { name: "Thêm người dùng" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Họ tên").fill(STAFF.name)
  await dialog.getByLabel("Email").fill(STAFF.email)
  await dialog.locator("#new-user-password").fill(STAFF.temp)
  await dialog.getByRole("button", { name: "Tạo người dùng" }).click()
  await expect(dialog.getByRole("heading", { name: "Đã tạo người dùng" })).toBeVisible()
  await expect(dialog.locator("#created-password")).toHaveValue(STAFF.temp)
  await dialog.getByRole("button", { name: "Xong" }).click()

  const table = page.getByRole("table", { name: "Danh sách người dùng" })
  await expect(table.getByRole("row").filter({ hasText: STAFF.email })).toContainText("Chờ đổi mật khẩu")
})

test("nhân viên đăng nhập, bị buộc đổi mật khẩu, không vào được /users", async ({ page }) => {
  await login(page, STAFF.email, "mat-khau-sai-123")
  await expect(page.getByRole("alert").filter({ hasText: "Email hoặc mật khẩu không đúng." })).toBeVisible()

  await login(page, STAFF.email, STAFF.temp)
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
  await page.goto("/account")
  await expect(page).toHaveURL(/\/security\/change-password$/)

  await page.getByLabel("Mật khẩu hiện tại").fill(STAFF.temp)
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill(STAFF.next)
  await page.getByLabel("Nhập lại mật khẩu mới").fill(STAFF.next)
  await page.getByRole("button", { name: "Đổi mật khẩu" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/security"))

  await page.goto("/account")
  await expect(page.getByRole("heading", { name: "Tài khoản", level: 1 })).toBeVisible()
  await expect(page.getByTestId("profile-email")).toHaveText(STAFF.email)

  const res = await page.goto("/users")
  expect(res?.status()).toBe(404)

  // Better Auth's own admin endpoints do not exist over HTTP (only the app pages/actions).
  const list = await page.request.get("/api/auth/admin/list-users")
  expect(list.status()).toBe(404)
  const imp = await page.request.post("/api/auth/admin/impersonate-user", { data: { userId: "x" } })
  expect(imp.status()).toBe(404)
})

test("nhật ký: admin thấy các sự kiện đăng nhập/2FA/tạo người dùng", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password)
  await expect(page).toHaveURL(/\/login\/2fa/)
  await page.locator("#otp-code").fill(await freshTotp(totpSecret))
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
  await page.goto("/account")
  const activity = page.getByTestId("my-activity")
  await expect(activity).toContainText("Bật xác thực 2 bước")
  await expect(activity).toContainText("Tạo người dùng")
  await expect(activity).toContainText("Đăng nhập")
  await expect(activity).toContainText("Thiết lập quản trị viên đầu tiên")

})

test("mọi endpoint /api/auth/admin/* trả 404 kể cả với cookie admin hợp lệ", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password)
  await expect(page).toHaveURL(/\/login\/2fa/)
  await page.locator("#otp-code").fill(await freshTotp(totpSecret))
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))

  const origin = new URL(page.url()).origin
  const me = await page.request.get("/api/auth/get-session")
  expect(me.status()).toBe(200)
  const myId = ((await me.json()) as { user: { id: string; role: string } }).user.id

  const paths = [
    "set-role",
    "get-user",
    "create-user",
    "update-user",
    "list-users",
    "list-user-sessions",
    "unban-user",
    "ban-user",
    "impersonate-user",
    "stop-impersonating",
    "revoke-user-session",
    "revoke-user-sessions",
    "remove-user",
    "set-user-password",
    "has-permission",
  ]
  const body = { userId: myId, role: "staff", newPassword: "Another-Pass-2026!", email: "x@example.com", password: "Another-Pass-2026!", name: "x" }
  for (const p of paths) {
    const get = await page.request.get(`/api/auth/admin/${p}?userId=${myId}`)
    expect(get.status(), `GET ${p}`).toBe(404)
    const post = await page.request.post(`/api/auth/admin/${p}`, { data: body, headers: { origin } })
    expect(post.status(), `POST ${p}`).toBe(404)
  }

  // nothing changed: still an admin, session still valid
  const after = await page.request.get("/api/auth/get-session")
  expect(((await after.json()) as { user: { role: string } }).user.role).toBe("admin")
})

test("khi admin bật 'bắt buộc 2FA cho mọi người', nhân viên chưa có 2FA bị đưa tới bước bật 2FA", async ({ page }) => {
  // Better Auth allows 5 sign-ins / 60 s per client IP and this serial suite signs in a lot → own IP.
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "10.77.0.1" })
  await setSetting("require_2fa_all", true)
  try {
    await login(page, STAFF.email, STAFF.next)
    await page.waitForURL((u) => !u.pathname.startsWith("/login"))
    await page.goto("/account")
    await expect(page).toHaveURL(/\/security\/enable-2fa$/)
    await expect(page.getByText("Hệ thống yêu cầu mọi người dùng bật xác thực 2 bước")).toBeVisible()
    // forced: no way back to the app, only sign out
    await expect(page.getByRole("link", { name: "Quay lại Tài khoản" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible()
  } finally {
    await setSetting("require_2fa_all", false)
  }
})

test("khi admin bật 'bắt buộc 2FA cho quản trị viên', thẻ 2FA báo không thể tắt", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "10.77.0.2" })
  await setSetting("require_2fa_admin", true)
  try {
    await login(page, ADMIN.email, ADMIN.password)
    await expect(page).toHaveURL(/\/login\/2fa/)
    await page.locator("#otp-code").fill(await freshTotp(totpSecret))
    await page.waitForURL((u) => !u.pathname.startsWith("/login"))
    await page.goto("/account")
    await expect(page.getByText("Hệ thống bắt buộc quản trị viên dùng 2FA nên không thể tắt.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Tắt xác thực 2 bước" })).toHaveCount(0)
  } finally {
    await setSetting("require_2fa_admin", false)
  }
})
