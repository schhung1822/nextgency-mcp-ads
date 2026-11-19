// Version + update system through the real UI (seeded admin / staff, throw-away <db>_e2e database):
//   admin  - "Phiên bản" in the user menu (desktop dropdown + phone Menu sheet), update dot + "Có bản mới" link,
//            Overview alert, /settings/updates (notes rendered as escaped text, re-auth dialog, progress that follows
//            the updater's rows through polling, reload after success), updater offline -> manual instructions
//   staff  - sees the version number only; /settings/updates and /api/updates/status answer 404
// Set E2E_SHOTS_DIR to also save screenshots (light/dark, 1440 and 390 px) of each state.
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { db, nextIp, PASSWORD, seedUser, setPolicy } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(240_000)

const SHOTS = process.env.E2E_SHOTS_DIR
const NOTES = "Bản 0.2.0\n- <b>không phải HTML</b> <img src=x onerror=alert(1)>\n- Cập nhật tự động"

let admin: { id: string; email: string }
let staff: { id: string; email: string }

async function login(page: Page, email: string) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextIp() })
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/login"))
}

/** fullPage resizes the viewport, which closes open menus / dialogs: pass full = false for those. */
async function shot(page: Page, name: string, full = true) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full })
}

async function setKey(key: string, value: unknown) {
  await db((c) =>
    c.query("insert into app_settings(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(value)])
  )
}

const heartbeat = (secondsAgo = 5) =>
  setKey("updater_heartbeat", { at: new Date(Date.now() - secondsAgo * 1000).toISOString(), version: "0.1.0", composeProject: "ads-mcp" })

async function currentVersion(page: Page): Promise<string> {
  const res = await page.request.get("/api/updates/status")
  return ((await res.json()) as { current: string }).current
}

test.beforeAll(async () => {
  await setPolicy({ admin: false, all: false })
  admin = await seedUser({ key: "updadmin", role: "admin" })
  staff = await seedUser({ key: "updstaff", role: "staff" })
  await db((c) => c.query("delete from system_update_requests"))
  await setKey("update_latest", {
    version: "99.0.0",
    tag: "v99.0.0",
    publishedAt: "2026-10-01T08:00:00.000Z",
    notes: NOTES,
    url: "https://github.com/schhung1822/nextgency-mcp-ads/releases/tag/v99.0.0",
    checkedAt: new Date().toISOString(),
  })
  await heartbeat()
})

test.afterAll(async () => {
  await db(async (c) => {
    await c.query("delete from system_update_requests")
    await c.query("delete from app_settings where key in ('update_latest','update_check_error','updater_heartbeat')")
  })
  await setPolicy({ admin: false, all: false })
})

test("nhân viên: chỉ thấy số phiên bản; trang, API cập nhật trả 404; Tổng quan không có cảnh báo cập nhật", async ({ page }) => {
  await login(page, staff.email)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tổng quan", level: 1 })).toBeVisible()
  await expect(page.getByText("Có bản mới")).toHaveCount(0)
  await expect(page.locator("[data-slot=update-dot]")).toHaveCount(0)

  await page.getByRole("button", { name: "Menu tài khoản" }).first().click()
  await expect(page.locator("[data-slot=app-version]").first()).toHaveText(/Phiên bản /)
  await expect(page.locator("[data-update-link]")).toHaveCount(0)
  await page.keyboard.press("Escape")

  const res = await page.goto("/settings/updates")
  expect(res?.status()).toBe(404)
  expect((await page.request.get("/api/updates/status")).status()).toBe(404)
})

test("admin trên máy tính: phiên bản + chấm cảnh báo + mục 'Có bản mới' trong menu, cảnh báo ở Tổng quan", async ({ page }) => {
  await heartbeat()
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page, admin.email)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tổng quan", level: 1 })).toBeVisible()
  await expect(page.locator("[data-slot=update-dot]").first()).toBeAttached()
  // Overview "Cảnh báo": one entry for the update
  await expect(page.getByRole("link", { name: /Có bản mới v99\.0\.0/ }).first()).toBeVisible()
  await shot(page, "overview-admin-light-1440")

  await page.getByRole("button", { name: "Menu tài khoản" }).first().click()
  await expect(page.locator("[data-slot=app-version]").first()).toHaveText(/Phiên bản v?\d/)
  await expect(page.locator("[data-update-link]").first()).toHaveText(/Có bản mới v99\.0\.0/)
  await shot(page, "user-menu-admin-light-1440", false)
  await page.locator("[data-update-link]").first().click()
  await page.waitForURL("**/settings/updates")
  await expect(page.getByRole("heading", { name: "Cập nhật hệ thống", level: 1 })).toBeVisible()
})

test("/settings/updates: ghi chú hiển thị dạng text, nút Cập nhật duy nhất (brand), nhập mật khẩu sai bị từ chối", async ({ page }) => {
  await heartbeat()
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page, admin.email)
  await page.goto("/settings/updates")
  await expect(page.getByRole("heading", { name: "Cập nhật hệ thống", level: 1 })).toBeVisible()

  // notes are an escaped text node: the markup is visible as text and nothing was injected
  const notes = page.locator("pre", { hasText: "Bản 0.2.0" })
  await expect(notes).toContainText("<b>không phải HTML</b>")
  await expect(page.locator("pre b, pre img")).toHaveCount(0)

  const brand = page.locator("[data-slot=page-header] [data-variant=brand]")
  await expect(brand).toHaveCount(1)
  await expect(brand).toHaveText("Cập nhật lên v99.0.0")
  await expect(brand).toBeEnabled()
  await shot(page, "updates-admin-light-1440")
  await page.emulateMedia({ colorScheme: "dark" })
  await shot(page, "updates-admin-dark-1440")
  await page.emulateMedia({ colorScheme: "light" })

  await brand.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText(/gián đoạn khoảng 1-2 phút/)).toBeVisible()
  await expect(dialog.getByText(/tự sao lưu/)).toBeVisible()
  await shot(page, "updates-confirm-light-1440", false)
  await dialog.getByLabel("Mật khẩu").fill("sai-mat-khau-1")
  await dialog.getByRole("button", { name: "Cập nhật", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect((await db((c) => c.query("select count(*)::int as n from system_update_requests"))).rows[0].n).toBe(0)
  await dialog.getByRole("button", { name: "Huỷ" }).click()
})

test("cập nhật: gửi yêu cầu, tiến trình theo dõi các dòng của updater, thành công thì tự tải lại", async ({ page }) => {
  await heartbeat()
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page, admin.email)
  await page.goto("/settings/updates")
  const from = await currentVersion(page)

  await page.locator("[data-slot=page-header] [data-variant=brand]").click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Mật khẩu").fill(PASSWORD)
  await dialog.getByRole("button", { name: "Cập nhật", exact: true }).click()
  await expect(page.locator("[data-slot=update-progress]").getByText("Đang chờ dịch vụ cập nhật nhận việc")).toBeVisible()

  // the web wrote the pending row (contract) + an activity log in the same transaction
  const row = (await db((c) => c.query("select id, from_version, target_version, status, requested_by from system_update_requests"))).rows
  expect(row).toHaveLength(1)
  expect(row[0]).toMatchObject({ from_version: from, target_version: "99.0.0", status: "pending", requested_by: admin.id })
  const logged = await db((c) => c.query("select status from activity_logs where actor_id = $1 and action = 'system.update_requested' and status = 'success'", [admin.id]))
  expect(logged.rows).toEqual([{ status: "success" }])
  // the button is locked while a request is open
  await expect(page.locator("[data-slot=page-header] [data-variant=brand]")).toBeDisabled()
  await shot(page, "updates-pending-light-1440")

  // the updater picks it up and reports a step (polling shows it without a reload)
  await db((c) => c.query("update system_update_requests set status = 'running', step = 'migrate', started_at = now() where id = $1", [row[0].id]))
  const current = page.locator("[data-slot=update-progress] li[aria-current=step]")
  await expect(current).toContainText("Cập nhật cơ sở dữ liệu", { timeout: 20_000 })
  await shot(page, "updates-running-light-1440")

  // the web is restarting: failing polls must not show an error page
  await page.route("**/api/updates/status", (route) => route.abort())
  await expect(page.getByText(/đang khởi động lại/)).toBeVisible({ timeout: 20_000 })
  await shot(page, "updates-restarting-light-1440")
  await page.unroute("**/api/updates/status")

  // finished: success message, then the page reloads itself (a marker on window disappears)
  await page.evaluate(() => ((window as unknown as { __marker?: number }).__marker = 1))
  await db((c) => c.query("update system_update_requests set status = 'succeeded', step = 'healthcheck', finished_at = now() where id = $1", [row[0].id]))
  await expect(page.getByText(/Đã cập nhật lên v99\.0\.0/)).toBeVisible({ timeout: 20_000 })
  await shot(page, "updates-succeeded-light-1440")
  await expect.poll(() => page.evaluate(() => (window as unknown as { __marker?: number }).__marker), { timeout: 20_000 }).toBeUndefined()
  await expect(page.getByRole("heading", { name: "Lịch sử cập nhật" })).toBeVisible()
  // exact: the page also auto-checks GitHub on open (a repo that does not exist in e2e -> "...không thành công" alert)
  await expect(page.getByText("Thành công", { exact: true })).toBeVisible()
})

test("cập nhật thất bại / quay về bản cũ: hiện lý do; updater offline: khoá nút và hướng dẫn chạy tay", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await db((c) => c.query("delete from system_update_requests"))
  await login(page, admin.email)
  await db((c) =>
    c.query(
      `insert into system_update_requests(from_version, target_version, status, step, message, requested_by, finished_at)
       values ('0.1.0', '99.0.0', 'rolled_back', 'rollback', 'Healthcheck lỗi, đã quay về bản 0.1.0.', $1, now())`,
      [admin.id]
    )
  )
  await page.goto("/settings/updates")
  await expect(page.getByText("Đã quay về bản cũ")).toBeVisible()
  await expect(page.getByText("Healthcheck lỗi, đã quay về bản 0.1.0.")).toBeVisible()

  // heartbeat stale -> offline: brand button disabled + manual instructions
  await heartbeat(300)
  await page.reload()
  await expect(page.locator("[data-slot=page-header] [data-variant=brand]")).toBeDisabled()
  await expect(page.getByText(/docker compose pull && docker compose up -d --no-build/)).toBeVisible()
  await expect(page.getByText("Chưa bật", { exact: true })).toBeVisible()
  await shot(page, "updates-offline-light-1440")
  await page.emulateMedia({ colorScheme: "dark" })
  await shot(page, "updates-offline-dark-1440")
  await page.emulateMedia({ colorScheme: "light" })
  await heartbeat()
})

test("điện thoại 390px: nút Menu có chấm cảnh báo; sheet có 'Có bản mới' và số phiên bản; trang cập nhật dùng được", async ({ page }) => {
  await heartbeat()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, admin.email)
  await page.goto("/")
  await expect(page.locator("nav[data-slot=bottom-nav] [data-slot=update-dot]")).toBeAttached()
  await shot(page, "overview-admin-light-390")
  await page.locator("nav[data-slot=bottom-nav]").getByRole("button", { name: "Menu" }).click()
  const sheet = page.locator("[data-slot=bottom-menu]")
  await expect(sheet.locator("[data-update-link]")).toHaveText(/Có bản mới v99\.0\.0/)
  await expect(sheet.locator("[data-slot=app-version]")).toHaveText(/Phiên bản /)
  await shot(page, "menu-sheet-admin-light-390", false)
  await sheet.locator("[data-update-link]").click()
  await page.waitForURL("**/settings/updates")
  await expect(page.locator("[data-slot=page-header] [data-variant=brand]")).toBeVisible()
  await shot(page, "updates-admin-light-390")
  await page.emulateMedia({ colorScheme: "dark" })
  await shot(page, "updates-admin-dark-390")
  // no horizontal page scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  // staff on a phone: version line, no update entry
  await page.context().clearCookies()
  await login(page, staff.email)
  await page.goto("/")
  await page.locator("nav[data-slot=bottom-nav]").getByRole("button", { name: "Menu" }).click()
  await expect(page.locator("[data-slot=bottom-menu] [data-slot=app-version]")).toHaveText(/Phiên bản /)
  await expect(page.locator("[data-slot=bottom-menu] [data-update-link]")).toHaveCount(0)
})
