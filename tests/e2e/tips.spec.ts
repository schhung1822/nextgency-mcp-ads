// "Mẹo sử dụng" (/tips/*): the old /automation-tips link and /tips redirect to /tips/automation, the three tips render
// for a staff member with the sub-menu (aria-current on the open tip) and the sidebar item stays active on each tip.
import { expect, test } from "@playwright/test"

import { BASE, seedUser, setPolicy, signInApi } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(120_000)

test("redirects keep old links working (signed out → login with next)", async ({
  request,
}) => {
  for (const path of ["/automation-tips", "/tips"]) {
    const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 })
    expect([307, 308]).toContain(res.status())
    expect(res.headers()["location"]).toMatch(/\/tips\/automation$/)
  }
  const old = await request.get(`${BASE}/automation-tips`, { maxRedirects: 0 })
  expect(old.status()).toBe(308)
})

test("staff sees the three tips with the sub-menu", async ({ page }) => {
  await setPolicy({ admin: false, all: false })
  const staff = await seedUser({ key: "tips-staff", role: "staff" })
  await signInApi(page.request, staff.email, false)

  await page.goto(`${BASE}/automation-tips`)
  await expect(page).toHaveURL(/\/tips\/automation$/)
  await expect(
    page.getByRole("heading", { level: 1, name: "Mẹo sử dụng" })
  ).toBeVisible()
  const nav = page.getByRole("navigation", { name: "Chọn mẹo" })
  await expect(nav.locator("[aria-current=page]")).toContainText("Chạy tự động")

  await nav
    .getByRole("link", { name: /Tạo quảng cáo số lượng lớn|QC hàng loạt/ })
    .click()
  await expect(page).toHaveURL(/\/tips\/bulk-ads$/)
  await expect(page).toHaveTitle(/Tạo quảng cáo số lượng lớn · Mẹo sử dụng/)
  await expect(
    page.getByRole("button", { name: "Sao chép dòng tiêu đề" })
  ).toBeVisible()
  await expect(nav.locator("[aria-current=page]")).toContainText(
    /Tạo quảng cáo số lượng lớn|QC hàng loạt/
  )

  await page.goto(`${BASE}/tips/ad-check`)
  await expect(page).toHaveTitle(/Tự động kiểm tra quảng cáo · Mẹo sử dụng/)
  await expect(page.getByText("Vì sao nên đặt lịch trên web")).toBeVisible()
  // the sidebar item (href /tips/automation) stays active on every tip
  await expect(
    page.locator('a[href="/tips/automation"][data-active="true"]').first()
  ).toBeVisible()
})
