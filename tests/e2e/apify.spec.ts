// Apify token screens (16-apify.md §8) over real HTTP on the throw-away <db>_e2e database: the Connections → Apify
// tab (admin sees every token with the creator column; staff see company tokens read-only + their own personal
// tokens), the token detail (another staff member's token = not found; a company token is read-only for staff), the
// "Thêm token Apify" page behind the connection disclaimer (staff: personal scope only) and the /connections/new card.
// No Apify call succeeds here (no real token): rows are seeded straight into the database with an opaque ciphertext
// (list / detail pages never decrypt) and nothing that needs Apify is asserted.
import { randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"

import { acceptDisclaimer, disclaimerDialog } from "./disclaimer-helpers"
import { db, seedUser, setPolicy, signInApi } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)
// wide enough for every column of the token table next to the sidebar and the guide panel (creator column: @5xl)
test.use({ viewport: { width: 1920, height: 1080 } })

let admin: { id: string; email: string }
let staffA: { id: string; email: string }
let staffB: { id: string; email: string }
let staffNew: { id: string; email: string }
const tok = {
  company: { id: randomUUID(), name: "E2E Apify công ty" },
  staffA: { id: randomUUID(), name: "E2E Apify của A" },
  staffB: { id: randomUUID(), name: "E2E Apify của B" },
}
const ALL_IDS = Object.values(tok).map((t) => t.id)

async function signIn(page: Page, email: string) {
  // page.request shares the browser context's cookie jar
  await signInApi(page.request, email, false)
}

async function insertTokens() {
  await db(async (c) => {
    const ins = (
      t: { id: string; name: string },
      scope: "company" | "personal",
      owner: string,
      extra: {
        status: string
        usage: number | null
        limit: number | null
        exhaustedDays?: number
      }
    ) =>
      c.query(
        `insert into apify_tokens(id, scope, owner_id, name, credentials_encrypted, credential_hint, apify_user_id,
           apify_username, plan_id, plan_tier, usage_usd, limit_usd, cycle_end_at, status, exhausted_until,
           last_checked_at)
         values ($1, $2, $3, $4, 'v1.e2e.e2e.e2e', 'Zz9q', $5, $6, 'STARTER', 'BRONZE', $7, $8,
           now() + interval '10 days', $9, $10, now())`,
        [
          t.id,
          scope,
          owner,
          t.name,
          `e2e-${t.id.slice(0, 8)}`,
          `e2e_user_${t.id.slice(0, 6)}`,
          extra.usage,
          extra.limit,
          extra.status,
          extra.exhaustedDays === undefined
            ? null
            : new Date(Date.now() + extra.exhaustedDays * 86_400_000),
        ]
      )
    await ins(tok.company, "company", admin.id, {
      status: "active",
      usage: 1.2,
      limit: 5,
    })
    await ins(tok.staffA, "personal", staffA.id, {
      status: "exhausted",
      usage: 5,
      limit: 5,
      exhaustedDays: 10,
    })
    await ins(tok.staffB, "personal", staffB.id, {
      status: "active",
      usage: null,
      limit: null,
    })
  })
}

/** removes what this spec inserted (no-op on the fresh e2e database; keeps a reused database clean) */
async function removeTokens() {
  await db((c) =>
    c.query(`delete from apify_tokens where id = any($1::uuid[])`, [ALL_IDS])
  )
}

test.afterAll(removeTokens)

test.beforeAll(async () => {
  await removeTokens()
  await setPolicy({ admin: false, all: false })
  admin = await seedUser({ key: "apify-admin", role: "admin" })
  staffA = await seedUser({ key: "apify-staff-a", role: "staff" })
  staffB = await seedUser({ key: "apify-staff-b", role: "staff" })
  staffNew = await seedUser({ key: "apify-staff-new", role: "staff" })
  await insertTokens()
})

test("admin: four tabs, the Apify tab lists every token with its creator and scope", async ({
  page,
}) => {
  await signIn(page, admin.email)
  await page.goto("/connections")
  const tabs = page.getByRole("tablist", { name: "Loại kết nối" })
  await expect(tabs.getByRole("tab")).toHaveCount(4)
  await expect(tabs.getByRole("tab", { name: /Apify/ })).toBeVisible()

  // /connections/apify (breadcrumb link) → the Apify tab
  await page.goto("/connections/apify")
  await expect(page).toHaveURL(/\/connections\?tab=apify$/)
  await expect(tabs.getByRole("tab", { name: /Apify/ })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(
    page.getByText(
      "Thêm API token Apify để AI lấy dữ liệu sàn TMĐT, mạng xã hội, Google Maps… qua MCP; hệ thống tự xoay vòng token."
    )
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Thêm token Apify" }).first()
  ).toHaveAttribute("href", "/connections/apify/new")

  const table = page.getByRole("table", { name: "Danh sách token Apify" })
  for (const t of Object.values(tok))
    await expect(table.getByText(t.name)).toBeVisible()
  await expect(
    table.getByRole("columnheader", { name: /Người thêm/ })
  ).toBeVisible()
  const companyRow = table
    .getByRole("row")
    .filter({ hasText: tok.company.name })
  await expect(companyRow.getByText("Công ty", { exact: true })).toBeVisible()
  await expect(
    companyRow.getByText(/1,20\s*US\$\s*\/\s*5,00\s*US\$/)
  ).toBeVisible()
  // exhausted with a future reset date: "Hết credit tới dd/MM"
  const exhaustedRow = table
    .getByRole("row")
    .filter({ hasText: tok.staffA.name })
  await expect(
    exhaustedRow.getByText(/Hết credit tới \d{2}\/\d{2}/)
  ).toBeVisible()

  // a staff member's personal token: admins manage it (the brand action re-checks it with Apify)
  await page.goto(`/connections/apify/${tok.staffB.id}`)
  await expect(
    page.getByRole("heading", { level: 1, name: tok.staffB.name })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Kiểm tra lại" })).toBeVisible()
  await expect(page.getByText(/apify_api_••••Zz9q/)).toBeVisible()
  // the token itself never reaches the page
  expect(await page.content()).not.toContain("v1.e2e.e2e.e2e")
})

test("staff: company tokens read-only + own personal tokens; another staff member's token is not found", async ({
  page,
}) => {
  await signIn(page, staffA.email)
  await page.goto("/connections?tab=apify")
  const table = page.getByRole("table", { name: "Danh sách token Apify" })
  await expect(table.getByText(tok.company.name)).toBeVisible()
  await expect(table.getByText(tok.staffA.name)).toBeVisible()
  await expect(table.getByText(tok.staffB.name)).toHaveCount(0)
  await expect(
    table.getByRole("columnheader", { name: /Người thêm/ })
  ).toHaveCount(0)
  const companyRow = table
    .getByRole("row")
    .filter({ hasText: tok.company.name })
  await expect(companyRow.getByText("Chỉ xem", { exact: true })).toBeVisible()

  // company token: read-only page (no manage action, no token hint)
  await page.goto(`/connections/apify/${tok.company.id}`)
  await expect(
    page.getByRole("heading", { level: 1, name: tok.company.name })
  ).toBeVisible()
  await expect(
    page.getByText("Token dùng chung công ty", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Kiểm tra lại" })).toHaveCount(
    0
  )
  await expect(page.getByText(/apify_api_••••/)).toHaveCount(0)

  // own token: managed by its owner
  const own = await page.goto(`/connections/apify/${tok.staffA.id}`)
  expect(own?.status()).toBe(200)
  await expect(
    page.getByRole("heading", { level: 1, name: tok.staffA.name })
  ).toBeVisible()
  await expect(
    page.getByText("Token đã hết credit", { exact: true })
  ).toBeVisible()

  // the not-found UI streams inside the segment's loading.tsx boundary (HTTP 200, like /connections/telegram/[id]):
  // assert the page content, not the status
  await page.goto(`/connections/apify/${tok.staffB.id}`)
  await expect(page.getByText("Không tìm thấy trang")).toBeVisible()
  await expect(page.getByText(tok.staffB.name)).toHaveCount(0)
  await page.goto("/connections/apify/not-a-uuid")
  await expect(page.getByText("Không tìm thấy trang")).toBeVisible()
})

test("add page: behind the connection disclaimer (Huỷ → Apify tab)", async ({
  page,
}) => {
  await signIn(page, staffNew.email)
  await page.goto("/connections/apify/new")
  const dialog = disclaimerDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Huỷ" }).click()
  await expect(page).toHaveURL(/\/connections\?tab=apify$/)
})

test("add page: staff add personal tokens only; the ToS note and the console link are shown", async ({
  page,
}) => {
  await signIn(page, staffA.email)
  await page.goto("/connections/apify/new")
  await acceptDisclaimer(page)
  await expect(
    page.getByRole("heading", { level: 1, name: "Thêm token Apify" })
  ).toBeVisible()
  await expect(
    page.getByRole("radio", { name: "Dùng chung công ty" })
  ).toHaveCount(0)
  await expect(page.getByText(/Token bạn thêm là token cá nhân/)).toBeVisible()
  await expect(page.getByText("Lưu ý điều khoản Apify")).toBeVisible()
  await expect(
    // the form's link (the guide panel has the same link)
    page.locator("#apify-new-token-help").getByRole("link", {
      name: /Mở Apify Console/,
    })
  ).toHaveAttribute("href", "https://console.apify.com/settings/integrations")
  // the zod format check runs before any call to Apify
  await page.getByLabel("API token", { exact: true }).fill("not-a-token")
  await page.getByRole("button", { name: "Kiểm tra", exact: true }).click()
  await expect(
    page.getByText(/Token Apify có dạng "apify_api_…"/)
  ).toBeVisible()
})

test("admin: scope choice on the add page; /connections/new offers Apify under Nguồn dữ liệu", async ({
  page,
}) => {
  await signIn(page, admin.email)
  await page.goto("/connections/new")
  await acceptDisclaimer(page)
  await expect(page.getByText("Nguồn dữ liệu", { exact: true })).toBeVisible()
  const card = page.getByRole("link", { name: /Apify/ })
  await expect(card).toHaveAttribute("href", "/connections/apify/new")
  await card.click()
  await expect(page).toHaveURL(/\/connections\/apify\/new$/)
  await expect(
    page.getByRole("radio", { name: "Dùng chung công ty" })
  ).toBeVisible()
  await expect(page.getByRole("radio", { name: "Cá nhân" })).toBeVisible()
})
