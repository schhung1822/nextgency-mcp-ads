// User management through the real /users UI (admin session, seeded users): create an ADMIN (re-auth gate),
// change role, reset password (staff + admin target, fresh vs. aged session), ban / unban (staff + admin target),
// sessions sheet, delete (type the email), and the self row has no destructive actions. Every step is verified against the database and the staff
// activity log (actor, action, status).
import { expect, test, type Page } from "@playwright/test"

import { db, nextIp, PASSWORD, RUN, seedUser, setPolicy } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(240_000)
// wide enough that the users DataTable renders as a table (< 768px container -> cards) even with the guide panel open
test.use({ viewport: { width: 1600, height: 900 } })

let admin: { id: string; email: string }
let staff: { id: string; email: string }
let otherAdmin: { id: string; email: string }

async function login(page: Page, email: string) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextIp() })
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
}

async function userRow(email: string) {
  const r = await db((c) =>
    c.query(`select id, role, banned, must_change_password, two_factor_enabled, created_by_id from "user" where email = $1`, [email])
  )
  return r.rows[0] as
    | { id: string; role: string; banned: boolean; must_change_password: boolean; two_factor_enabled: boolean; created_by_id: string | null }
    | undefined
}

async function lastLog(actorId: string, action: string) {
  const r = await db((c) =>
    c.query(`select status, target_label, metadata from activity_logs where actor_id = $1 and action = $2 order by created_at desc limit 1`, [actorId, action])
  )
  return r.rows[0] as { status: string; target_label: string | null; metadata: Record<string, unknown> } | undefined
}

async function openRowMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `Thao tác với ${name}` }).first().click()
}

test.beforeAll(async () => {
  await setPolicy({ admin: false, all: false })
  admin = await seedUser({ key: "uiadmin", role: "admin" })
  staff = await seedUser({ key: "uistaff", role: "staff" })
  otherAdmin = await seedUser({ key: "uiother", role: "admin" })
})

test.afterAll(async () => {
  await setPolicy({ admin: false, all: false })
})

test("admin tạo quản trị viên mới: sai mật khẩu xác nhận bị từ chối, đúng thì tạo + buộc đổi mật khẩu + ghi nhật ký", async ({ page }) => {
  await login(page, admin.email)
  await page.goto("/users")
  await expect(page.getByRole("heading", { name: "Người dùng", level: 1 })).toBeVisible()
  const email = `ui.newadmin.${RUN}@example.test`

  // the dev server may full-reload the page right after its first compile: retry until the dialog is really open
  await expect(async () => {
    await page.getByRole("button", { name: "Thêm người dùng" }).click()
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 90_000 })
  const dialog = page.getByRole("dialog")
  await dialog.locator("#new-user-name").fill("Admin mới UI")
  await dialog.locator("#new-user-email").fill(email)
  await dialog.locator("#new-user-role-admin").click()
  await dialog.locator("#new-user-password").fill("Tam-Admin-2026")
  // the re-auth block appears only for the admin role
  await dialog.locator("#new-user-reauth-password").fill("sai-mat-khau-1")
  await dialog.getByRole("button", { name: "Tạo người dùng" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect(await userRow(email)).toBeUndefined()

  await dialog.locator("#new-user-reauth-password").fill(PASSWORD)
  await dialog.getByRole("button", { name: "Tạo người dùng" }).click()
  await expect(dialog.getByRole("heading", { name: "Đã tạo người dùng" })).toBeVisible()
  await dialog.getByRole("button", { name: "Xong" }).click()

  const row = (await userRow(email))!
  expect(row).toMatchObject({ role: "admin", must_change_password: true, created_by_id: admin.id })
  expect((await lastLog(admin.id, "user.create"))?.status).toBe("success")
})

test("đổi vai trò nhân viên → quản trị viên → nhân viên cần mật khẩu của admin; không có thao tác nguy hiểm trên dòng của chính mình", async ({ page }) => {
  await login(page, admin.email)
  await page.goto("/users")
  await page.getByLabel("Tìm người dùng").fill(staff.email)

  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Đổi vai trò" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Mật khẩu của bạn").fill(PASSWORD)
  await dialog.getByRole("radio", { name: /Quản trị viên/ }).click()
  await dialog.getByRole("button", { name: "Đổi vai trò" }).click()
  await expect.poll(async () => (await userRow(staff.email))?.role).toBe("admin")
  expect((await lastLog(admin.id, "user.role.change"))?.metadata).toMatchObject({ before: { role: "staff" }, after: { role: "admin" } })

  // the list refreshes after the action: wait until the row shows the new role before the next dialog
  await expect(page.getByRole("row").filter({ hasText: staff.email })).toContainText("Quản trị viên")
  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Đổi vai trò" }).click()
  const d2 = page.getByRole("dialog")
  await d2.getByLabel("Mật khẩu của bạn").fill(PASSWORD)
  await d2.getByRole("radio", { name: /Nhân viên/ }).click()
  await d2.getByRole("button", { name: "Đổi vai trò" }).click()
  await expect.poll(async () => (await userRow(staff.email))?.role).toBe("staff")

  // own row: only a link to the account page
  await page.getByLabel("Tìm người dùng").fill(admin.email)
  await openRowMenu(page, "Ma trận uiadmin")
  await expect(page.getByRole("menuitem", { name: "Mở trang Tài khoản" })).toBeVisible()
  for (const name of ["Đổi vai trò", "Đặt lại mật khẩu", "Khoá tài khoản", "Xoá người dùng"]) {
    await expect(page.getByRole("menuitem", { name })).toHaveCount(0)
  }
})

test("đặt lại mật khẩu: nhân viên không cần xác nhận lại khi phiên còn mới (≤ 10 phút), admin khác thì luôn cần; mật khẩu tạm buộc đổi", async ({ page }) => {
  await login(page, admin.email)
  await page.goto("/users")

  await page.getByLabel("Tìm người dùng").fill(staff.email)
  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Đặt lại mật khẩu" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.locator("#reset-password").fill("Mat-Khau-Tam-77")
  await expect(dialog.locator("#reset-reauth-password")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Đặt lại mật khẩu" }).click()
  await expect(dialog.getByRole("heading", { name: "Đã đặt lại mật khẩu" })).toBeVisible()
  await dialog.getByRole("button", { name: "Xong" }).click()
  expect((await userRow(staff.email))?.must_change_password).toBe(true)

  await page.getByLabel("Tìm người dùng").fill(otherAdmin.email)
  await openRowMenu(page, "Ma trận uiother")
  await page.getByRole("menuitem", { name: "Đặt lại mật khẩu" }).click()
  const d2 = page.getByRole("dialog")
  await d2.locator("#reset-password").fill("Mat-Khau-Tam-88")
  await d2.locator("#reset-reauth-password").fill("sai-mat-khau-1")
  await d2.getByRole("button", { name: "Đặt lại mật khẩu" }).click()
  await expect(d2.getByRole("alert")).toBeVisible() // wrong confirmation: refused, nothing changed
  await d2.locator("#reset-reauth-password").fill(PASSWORD)
  await d2.getByRole("button", { name: "Đặt lại mật khẩu" }).click()
  await expect(d2.getByRole("heading", { name: "Đã đặt lại mật khẩu" })).toBeVisible()
  expect((await lastLog(admin.id, "user.password.reset"))?.status).toBe("success")
})

test("đặt lại mật khẩu nhân viên khi phiên đã cũ (> 10 phút): hộp xác nhận mật khẩu hiện ngay", async ({ page }) => {
  await login(page, admin.email)
  // age every session of the admin (signed in 11 minutes ago, no recent re-auth) and reload the list
  await db((c) => c.query(`update session set created_at = now() - interval '11 min' where user_id = $1`, [admin.id]))
  await page.goto("/users")
  await page.getByLabel("Tìm người dùng").fill(staff.email)
  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Đặt lại mật khẩu" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.locator("#reset-password").fill("Mat-Khau-Tam-79")
  await expect(dialog.locator("#reset-reauth-password")).toBeVisible()
  await dialog.locator("#reset-reauth-password").fill("sai-mat-khau-1")
  await dialog.getByRole("button", { name: "Đặt lại mật khẩu" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await dialog.locator("#reset-reauth-password").fill(PASSWORD)
  await dialog.getByRole("button", { name: "Đặt lại mật khẩu" }).click()
  await expect(dialog.getByRole("heading", { name: "Đã đặt lại mật khẩu" })).toBeVisible()
  await dialog.getByRole("button", { name: "Xong" }).click()
  expect((await lastLog(admin.id, "user.password.reset"))?.status).toBe("success")
})

test("khoá ADMIN khác cần nhập lại mật khẩu: sai bị từ chối, đúng thì khoá; mở khoá cũng cần", async ({ page }) => {
  await login(page, admin.email)
  await page.goto("/users")
  await page.getByLabel("Tìm người dùng").fill(otherAdmin.email)
  await openRowMenu(page, "Ma trận uiother")
  await page.getByRole("menuitem", { name: "Khoá tài khoản" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("#ban-password")).toBeVisible()
  await dialog.locator("#ban-password").fill("sai-mat-khau-1")
  await dialog.getByRole("button", { name: "Khoá tài khoản" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect((await userRow(otherAdmin.email))?.banned).toBe(false)
  expect((await lastLog(admin.id, "user.ban"))?.metadata).toMatchObject({ reauth: true })
  await dialog.locator("#ban-password").fill(PASSWORD)
  await dialog.getByRole("button", { name: "Khoá tài khoản" }).click()
  await expect.poll(async () => (await userRow(otherAdmin.email))?.banned).toBe(true)
  expect((await lastLog(admin.id, "user.ban"))?.status).toBe("success")

  await expect(page.getByRole("row").filter({ hasText: otherAdmin.email })).toContainText("Đã khoá")
  await openRowMenu(page, "Ma trận uiother")
  await page.getByRole("menuitem", { name: "Mở khoá" }).click()
  const d2 = page.getByRole("dialog")
  await d2.locator("#ban-password").fill(PASSWORD)
  await d2.getByRole("button", { name: "Mở khoá" }).click()
  await expect.poll(async () => (await userRow(otherAdmin.email))?.banned).toBe(false)
})

test("khoá rồi mở khoá tài khoản; người bị khoá không đăng nhập được", async ({ page, browser }) => {
  await login(page, admin.email)
  await page.goto("/users")
  await page.getByLabel("Tìm người dùng").fill(staff.email)
  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Khoá tài khoản" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Khoá tài khoản" }).click()
  await expect.poll(async () => (await userRow(staff.email))?.banned).toBe(true)

  // the banned user cannot sign in (own browser context, own IP)
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": nextIp() } })
  const p2 = await ctx.newPage()
  await p2.goto("/login")
  await p2.getByLabel("Email").fill(staff.email)
  await p2.getByLabel("Mật khẩu", { exact: true }).fill("Mat-Khau-Tam-79")
  await p2.getByRole("button", { name: "Đăng nhập" }).click()
  await expect(p2.getByRole("alert").filter({ hasText: "Tài khoản của bạn đã bị khoá" })).toBeVisible()
  await ctx.close()

  await page.getByLabel("Tìm người dùng").fill(staff.email)
  await openRowMenu(page, "Ma trận uistaff")
  await page.getByRole("menuitem", { name: "Mở khoá" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Mở khoá" }).click()
  await expect.poll(async () => (await userRow(staff.email))?.banned).toBe(false)
  expect((await lastLog(admin.id, "user.unban"))?.status).toBe("success")
})

test("xoá người dùng cần gõ lại email; người dùng còn kết nối thì không xoá được", async ({ page }) => {
  const gone = await seedUser({ key: "uidelete", role: "staff" })
  const owner = await seedUser({ key: "uiowner", role: "staff" })
  await db((c) =>
    c.query(
      `insert into connections(id, owner_id, platform, name, credentials_encrypted) values (gen_random_uuid(), $1, 'meta', 'Kết nối UI', 'v1.x.y.z')`,
      [owner.id]
    )
  )
  await login(page, admin.email)
  await page.goto("/users")

  await page.getByLabel("Tìm người dùng").fill(owner.email)
  await openRowMenu(page, "Ma trận uiowner")
  await page.getByRole("menuitem", { name: "Xoá người dùng" }).click()
  const blocked = page.getByRole("alertdialog")
  await blocked.locator("input").fill(owner.email)
  await blocked.getByRole("button", { name: "Xoá người dùng" }).click()
  await expect(page.getByText(/còn 1 kết nối/)).toBeVisible()
  expect(await userRow(owner.email)).toBeTruthy()
  await page.keyboard.press("Escape")

  await page.getByLabel("Tìm người dùng").fill(gone.email)
  await openRowMenu(page, "Ma trận uidelete")
  await page.getByRole("menuitem", { name: "Xoá người dùng" }).click()
  const dlg = page.getByRole("alertdialog")
  const confirm = dlg.getByRole("button", { name: "Xoá người dùng" })
  await expect(confirm).toBeDisabled() // not until the email is typed
  await dlg.locator("input").fill(gone.email)
  await confirm.click()
  await expect.poll(async () => await userRow(gone.email)).toBeUndefined()
  // Better Auth removes the user on its own connection; the success log commits a moment later with the guard tx
  await expect.poll(async () => (await lastLog(admin.id, "user.delete"))?.status).toBe("success")
})
