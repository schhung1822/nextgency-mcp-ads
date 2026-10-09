// Google Drive screens (15-google-drive-media.md §11) over real HTTP on the throw-away <db>_e2e database:
// "not configured" states, the Settings card, the Connections → Google Drive tab (admin sees everything with the
// creator column; staff see company + own only), the source detail (another staff member's source = 404), the
// wizard scope rule (staff: personal only) and the session thumbnail route (never 200 for a foreign source).
// No Google call succeeds here (no real credentials): rows are seeded straight into the database and only screens
// that do not need Google are asserted; the folder grid's error state is asserted instead of files.
import { randomUUID } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"

import { BASE, db, seedUser, setPolicy, signInApi } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)

const SYSTEM_EMAIL = "ads-mcp-e2e@e2e-project.iam.gserviceaccount.com"

let admin: { id: string; email: string }
let staffA: { id: string; email: string }
let staffB: { id: string; email: string }
const src = {
  company: { id: randomUUID(), name: "E2E Creative công ty" },
  staffA: { id: randomUUID(), name: "E2E Thư mục của A" },
  staffB: { id: randomUUID(), name: "E2E Sheet của B" },
}
const credId = randomUUID()

async function signIn(page: Page, email: string) {
  // page.request shares the browser context's cookie jar
  await signInApi(page.request, email, false)
}

async function insertDriveData() {
  await db(async (c) => {
    // list / settings pages never decrypt: an opaque value is enough (a Google call would fail → error states)
    await c.query(
      `insert into drive_credentials(id, kind, owner_id, name, credentials_encrypted, api_key_encrypted, api_key_hint,
         client_email, credential_hint, status)
       values ($1, 'system', null, '', 'v1.e2e.e2e.e2e', 'v1.e2e.e2e.e2e', 'Ab9Z', $2, 'k3y9', 'active')`,
      [credId, SYSTEM_EMAIL]
    )
    const ins = (
      id: string,
      kind: "folder" | "sheet",
      scope: "company" | "personal",
      owner: string,
      name: string
    ) =>
      c.query(
        `insert into drive_sources(id, kind, scope, owner_id, credential_id, google_id, sheet_gid, name, google_name,
           config, status, last_checked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9::jsonb, 'active', now())`,
        [
          id,
          kind,
          scope,
          owner,
          credId,
          `1e2e${id.replace(/-/g, "").slice(0, 24)}`,
          kind === "sheet" ? 0 : null,
          name,
          JSON.stringify(
            kind === "folder"
              ? { recursiveDepth: 1 }
              : {
                  headerRow: 1,
                  columns: { link: "Link Drive", status: "Trạng thái" },
                  writeback: false,
                }
          ),
        ]
      )
    await ins(src.company.id, "folder", "company", admin.id, src.company.name)
    await ins(src.staffA.id, "folder", "personal", staffA.id, src.staffA.name)
    await ins(src.staffB.id, "sheet", "personal", staffB.id, src.staffB.name)
  })
}

/** removes what this spec inserted (no-op on the fresh e2e database; keeps a reused database clean) */
async function removeDriveData() {
  await db(async (c) => {
    await c.query(
      `delete from drive_sources where credential_id in (select id from drive_credentials where client_email = $1)`,
      [SYSTEM_EMAIL]
    )
    await c.query(`delete from drive_credentials where client_email = $1`, [
      SYSTEM_EMAIL,
    ])
  })
}

test.afterAll(removeDriveData)

test.beforeAll(async () => {
  await removeDriveData()
  await setPolicy({ admin: false, all: false })
  admin = await seedUser({ key: "drive-admin", role: "admin" })
  staffA = await seedUser({ key: "drive-staff-a", role: "staff" })
  staffB = await seedUser({ key: "drive-staff-b", role: "staff" })
})

test("not configured: admin is sent to Settings, staff to the administrator", async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const pa = await ctxA.newPage()
  await signIn(pa, admin.email)
  await pa.goto("/connections?tab=drive")
  await expect(pa.getByRole("tab", { name: /Google Drive/ })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(pa.getByText("Chưa cấu hình Google Drive")).toBeVisible()
  await expect(pa.getByRole("link", { name: "Mở Cài đặt" })).toHaveAttribute(
    "href",
    "/settings#google-drive"
  )
  await pa.goto("/settings")
  const card = pa.locator("#google-drive")
  await expect(
    card.getByText("Google Drive hệ thống", { exact: true })
  ).toBeVisible()
  await expect(card.getByText("Chưa cấu hình", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Kiểm tra" })).toHaveCount(0)
  await ctxA.close()

  const ctxS = await browser.newContext()
  const ps = await ctxS.newPage()
  await signIn(ps, staffA.email)
  await ps.goto("/connections?tab=drive")
  await expect(
    ps.getByText(/Liên hệ quản trị viên để cấu hình Google Drive/)
  ).toBeVisible()
  await expect(ps.getByRole("link", { name: "Mở Cài đặt" })).toHaveCount(0)
  await ctxS.close()
})

test("admin: settings card shows hints only, the tab lists every source with its creator", async ({
  page,
}) => {
  await insertDriveData()
  await signIn(page, admin.email)
  await page.goto("/settings")
  const card = page.locator("#google-drive")
  await expect(
    card.getByRole("textbox", { name: /Email service account/ })
  ).toHaveValue(SYSTEM_EMAIL)
  await expect(card.getByText("…k3y9", { exact: true })).toBeVisible()
  await expect(card.getByText("…Ab9Z", { exact: true })).toBeVisible()
  // write-only fields start empty
  await expect(card.locator("#drive-system-json")).toHaveValue("")
  await expect(card.locator("#drive-system-apikey")).toHaveValue("")

  await page.goto("/connections?tab=drive")
  await expect(
    page.getByRole("textbox", { name: "Email hệ thống Google Drive" })
  ).toHaveValue(SYSTEM_EMAIL)
  const table = page.getByRole("table", {
    name: "Danh sách thư mục / sheet Google Drive",
  })
  for (const s of Object.values(src))
    await expect(table.getByText(s.name)).toBeVisible()
  await expect(
    table.getByRole("columnheader", { name: /Người tạo/ })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Thêm thư mục / sheet" })
  ).toHaveAttribute("href", "/connections/drive/new")

  // detail of a staff member's source (G4: admins see everything); no Google → the preview shows its error state
  await page.goto(`/connections/drive/${src.staffB.id}`)
  await expect(
    page.getByRole("heading", { level: 1, name: src.staffB.name })
  ).toBeVisible()
  await expect(page.getByText("Không đọc được sheet")).toBeVisible()
  // one action in the header and the same one in the listing error (manager): re-check the source
  await expect(
    page.getByRole("button", { name: "Kiểm tra lại" }).first()
  ).toBeVisible()
  await expect(
    page.getByText(/Trạng thái ở đầu trang là kết quả của lần kiểm tra trước/)
  ).toBeVisible()
})

test("connections: three top tabs, the platform is a filter; /connections/new offers Google Drive", async ({
  page,
}) => {
  await signIn(page, admin.email)
  await page.goto("/connections")
  const tabs = page.getByRole("tablist", { name: "Loại kết nối" })
  await expect(tabs.getByRole("tab")).toHaveCount(3)
  await expect(tabs.getByRole("tab", { name: /Quảng cáo/ })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(tabs.getByRole("tab", { name: /Telegram/ })).toBeVisible()
  await expect(tabs.getByRole("tab", { name: /Google Drive/ })).toBeVisible()
  // old platform-tab links open the "Quảng cáo" tab and preselect the "Nền tảng" filter pill (the filter bar is only
  // rendered when there is at least one ad connection - this e2e database may have none → empty state instead)
  await page.goto("/connections?platform=tiktok")
  await expect(
    page.getByRole("tablist", { name: "Loại kết nối" }).getByRole("tab", { name: /Quảng cáo/ })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page
      .getByRole("button", { name: /Nền tảng.*TikTok/ })
      .or(page.getByText("Chưa có kết nối quảng cáo"))
      .first()
  ).toBeVisible()

  await page.goto("/connections?tab=drive")
  await expect(
    page.getByText(
      "Khai báo thư mục ảnh, video hoặc Google Sheet kế hoạch để AI lấy file lên quảng cáo."
    )
  ).toBeVisible()

  await page.goto("/connections/new")
  await expect(page.getByText("Kho creative")).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Google Drive/ })
  ).toHaveAttribute("href", "/connections/drive/new")
})

test("staff: company + own sources only; another staff member's source is not found", async ({
  page,
}) => {
  await signIn(page, staffA.email)
  await page.goto("/connections?tab=drive")
  const table = page.getByRole("table", {
    name: "Danh sách thư mục / sheet Google Drive",
  })
  await expect(table.getByText(src.company.name)).toBeVisible()
  await expect(table.getByText(src.staffA.name)).toBeVisible()
  await expect(table.getByText(src.staffB.name)).toHaveCount(0)
  await expect(
    table.getByRole("columnheader", { name: /Người tạo/ })
  ).toHaveCount(0)

  const own = await page.goto(`/connections/drive/${src.staffA.id}`)
  expect(own?.status()).toBe(200)
  await expect(
    page.getByRole("heading", { level: 1, name: src.staffA.name })
  ).toBeVisible()

  // company source: read-only for staff (no manage actions)
  await page.goto(`/connections/drive/${src.company.id}`)
  await expect(
    page.getByRole("heading", { level: 1, name: src.company.name })
  ).toBeVisible()
  await expect(page.getByText(/chỉ quản trị viên sửa hoặc xoá/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Kiểm tra lại" })).toHaveCount(
    0
  )
  // the listing error offers a reload (no re-check), and no admin-only fix hint for a system-email source
  await expect(page.getByRole("button", { name: "Tải lại" })).toBeVisible()
  await expect(page.getByText(/Tạo khoá JSON mới/)).toHaveCount(0)

  // the not-found UI streams inside the segment's loading.tsx boundary (HTTP 200, like /connections/telegram/[id]):
  // assert the page content, not the status
  await page.goto(`/connections/drive/${src.staffB.id}`)
  await expect(page.getByText("Không tìm thấy trang")).toBeVisible()
  await expect(page.getByText(src.staffB.name)).toHaveCount(0)

  // settings stays admin-only
  const settings = await page.goto("/settings")
  expect(settings?.status()).toBe(404)
})

test("staff wizard: personal scope only; the system email is offered for sharing", async ({
  page,
}) => {
  await signIn(page, staffA.email)
  await page.goto("/connections/drive/new")
  await expect(page.getByRole("radio", { name: "Công ty" })).toHaveCount(0)
  await expect(
    page.getByText(/Bạn khai báo thư mục \/ sheet riêng/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Tiếp tục" }).click()
  await expect(
    page.getByRole("textbox", { name: "Email để chia sẻ" })
  ).toHaveValue(SYSTEM_EMAIL)
  // "Tiếp tục" waits for a successful "Kiểm tra"
  await expect(page.getByRole("button", { name: "Tiếp tục" })).toBeDisabled()
})

test("thumbnail route: 404 for a foreign source, a bad id and without a session", async ({
  page,
  playwright,
}) => {
  await signIn(page, staffA.email)
  const foreign = await page.request.get(
    `/api/drive/thumb/${src.staffB.id}/1AbCdEfGhIjKlMnOp`
  )
  expect(foreign.status()).toBe(404)
  const bad = await page.request.get(
    `/api/drive/thumb/not-a-uuid/1AbCdEfGhIjKlMnOp`
  )
  expect(bad.status()).toBe(404)
  // own source but no Google access here → still a plain 404, never an error page with details
  const own = await page.request.get(
    `/api/drive/thumb/${src.staffA.id}/1AbCdEfGhIjKlMnOp`
  )
  expect(own.status()).toBe(404)
  expect(await own.text()).toBe("Not found")

  const anon = await playwright.request.newContext({
    baseURL: BASE,
  })
  const res = await anon.get(
    `/api/drive/thumb/${src.company.id}/1AbCdEfGhIjKlMnOp`,
    { maxRedirects: 0 }
  )
  expect(res.status()).not.toBe(200)
  await anon.dispose()
})
