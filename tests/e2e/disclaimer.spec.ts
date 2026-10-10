// "Miễn trừ trách nhiệm" popups over real HTTP on the throw-away <db>_e2e database: the wizard behind is locked until
// the text was scrolled to the end AND 10 s passed AND the box is ticked; the acceptance is written to activity_logs;
// shown ONCE per user, kind and version (later visits of every page of that kind skip it; an acceptance of an older
// version does not count); Huỷ / Esc leave the page.
import { randomUUID } from "node:crypto"

import { expect, test } from "@playwright/test"

import {
  acceptDisclaimer,
  disclaimerDialog,
  expectNoDisclaimer,
} from "./disclaimer-helpers"
import { db, seedUser, setPolicy, signInApi } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(150_000)

let staff: { id: string; email: string }
/** accepted only an OLDER version of the connection text */
let staffOld: { id: string; email: string }

test.beforeAll(async () => {
  await setPolicy({ admin: false, all: false })
  staff = await seedUser({ key: "disclaimer-staff", role: "staff" })
  staffOld = await seedUser({ key: "disclaimer-old", role: "staff" })
  await db((c) =>
    c.query(
      `insert into activity_logs(actor_id, actor_email, actor_role, action, target_type, target_id, target_label, status, metadata)
       values ($1, $2, 'staff', 'legal.disclaimer_accept', 'disclaimer', 'connection', '2020-01-01', 'success',
               '{"kind":"connection","version":"2020-01-01"}'::jsonb)`,
      [staffOld.id, staffOld.email]
    )
  )
})

async function acceptances(
  userId: string
): Promise<{ kind: string; version: string }[]> {
  return db(async (c) => {
    const r = await c.query(
      `select target_id as kind, metadata->>'version' as version from activity_logs
        where actor_id = $1 and action = 'legal.disclaimer_accept' order by created_at`,
      [userId]
    )
    return r.rows as { kind: string; version: string }[]
  })
}

test("thêm kết nối: lần đầu khoá tới khi đọc hết + 10 giây + tick; ghi nhận; sau đó không hỏi lại ở mọi trang thêm kết nối", async ({
  page,
}) => {
  await signInApi(page.request, staff.email, false)
  await page.goto("/connections/new")
  const dialog = disclaimerDialog(page)
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByText(/Phiên bản \d{4}-\d{2}-\d{2} · áp dụng từ/)
  ).toBeVisible()
  // the wizard behind is out of the accessibility tree and not clickable
  await expect(
    page.getByRole("heading", { name: "Bạn muốn thêm loại kết nối nào?" })
  ).toHaveCount(0)

  const agree = dialog.getByRole("checkbox", {
    name: /Tôi đã đọc kỹ, hiểu và đồng ý/,
  })
  const confirm = dialog.getByRole("button", { name: "Tôi đồng ý và bắt đầu" })
  await expect(agree).toBeDisabled()
  await expect(confirm).toBeDisabled()
  await expect(
    dialog.getByText("Kéo xuống đọc hết nội dung để tiếp tục")
  ).toBeVisible()
  // clicking outside does not close it
  await page.mouse.click(5, 5)
  await expect(dialog).toBeVisible()

  // scrolled to the end, but the minimum reading time is not over yet
  const startedAt = Date.now()
  await dialog
    .getByRole("region", { name: "Nội dung miễn trừ trách nhiệm" })
    .evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(dialog.getByText(/Có thể xác nhận sau \d+ giây/)).toBeVisible()
  await expect(agree).toBeDisabled()
  await expect(agree).toBeEnabled({ timeout: 20_000 })
  // enabled no earlier than ~10 s after the page opened (the page opened before startedAt)
  expect(Date.now() - startedAt).toBeGreaterThan(3_000)
  await expect(dialog.getByText("Bạn đã đọc hết nội dung")).toBeVisible()
  await expect(confirm).toBeDisabled()
  await agree.click()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(dialog).toBeHidden()

  expect(await acceptances(staff.id)).toEqual([
    {
      kind: "connection",
      version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
  ])

  // same flow: the Google Drive card continues without a second popup
  await page.getByRole("link", { name: /Google Drive/ }).click()
  await expect(page).toHaveURL(/\/connections\/drive\/new$/)
  await expect(
    page.getByRole("heading", { level: 1, name: /Google Drive/ })
  ).toBeVisible()
  await expect(disclaimerDialog(page)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Tiếp tục" })).toBeVisible()

  // later visits (new page loads) of every "Thêm kết nối" page: never asked again for this version
  await page.goto("/connections/drive/new")
  await expectNoDisclaimer(page)
  await expect(page.getByRole("button", { name: "Tiếp tục" })).toBeVisible()
  await page.goto("/connections/new")
  await expectNoDisclaimer(page)
  await expect(
    page.getByRole("heading", { name: "Bạn muốn thêm loại kết nối nào?" })
  ).toBeVisible()
  await page.goto("/connections/telegram/new")
  await expectNoDisclaimer(page)
  // after signing in again (new session) too
  await page.context().clearCookies()
  await signInApi(page.request, staff.email, false)
  await page.goto("/connections/drive/new")
  await expectNoDisclaimer(page)
  expect(await acceptances(staff.id)).toHaveLength(1)
})

test("tạo MCP chưa có kết nối: không hỏi (chỉ hướng dẫn thêm kết nối)", async ({
  page,
}) => {
  await signInApi(page.request, staff.email, false)
  await page.goto("/mcp-servers/new")
  await expect(page.getByRole("link", { name: "Thêm kết nối" })).toBeVisible()
  await expect(disclaimerDialog(page)).toHaveCount(0)
})

test("tạo MCP: popup riêng (loại mcp, xác nhận kết nối không thay được); Esc rời trang; đồng ý xong mới vào wizard; lần sau không hỏi", async ({
  page,
}) => {
  // a connection with one enabled ad account (pages never decrypt here: an opaque value is enough)
  const connId = randomUUID()
  await db(async (c) => {
    await c.query(
      `insert into connections(id, owner_id, platform, name, credentials_encrypted, credential_hint, status)
       values ($1, $2, 'meta', 'E2E miễn trừ', 'v1.e2e.e2e.e2e', 'e2e1', 'active')`,
      [connId, staff.id]
    )
    await c.query(
      `insert into ad_accounts(connection_id, platform, external_id, name, currency, timezone, status, is_enabled)
       values ($1, 'meta', $2, 'TKQC E2E', 'VND', 'Asia/Ho_Chi_Minh', 'active', true)`,
      [connId, `act_e2e${connId.slice(0, 8)}`]
    )
  })
  try {
    await signInApi(page.request, staff.email, false)
    await page.goto("/mcp-servers/new")
    const dialog = disclaimerDialog(page)
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByRole("heading", { name: /trước khi tạo MCP/ })
    ).toBeVisible()
    await expect(dialog.getByText(/prompt injection/)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page).toHaveURL(/\/mcp-servers$/)

    await page.goto("/mcp-servers/new")
    await acceptDisclaimer(page)
    await expect(
      page.getByRole("button", { name: "Tiếp tục" }).first()
    ).toBeVisible()
    const rows = await acceptances(staff.id)
    expect(rows.map((r) => r.kind)).toEqual(["connection", "mcp"])
    // asked once: the next visit goes straight to the wizard
    await page.goto("/mcp-servers/new")
    await expectNoDisclaimer(page)
    await expect(
      page.getByRole("button", { name: "Tiếp tục" }).first()
    ).toBeVisible()
    expect(await acceptances(staff.id)).toHaveLength(2)
  } finally {
    await db((c) => c.query("delete from connections where id = $1", [connId]))
  }
})

test("đã xác nhận phiên bản cũ: hỏi lại phiên bản mới (Telegram mở trực tiếp); Huỷ về tab Telegram", async ({
  page,
}) => {
  await signInApi(page.request, staffOld.email, false)
  await page.goto("/connections/telegram/new")
  const dialog = disclaimerDialog(page)
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole("heading", { name: /trước khi kết nối/ })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Huỷ" }).click()
  await expect(page).toHaveURL(/\/connections\?tab=telegram$/)
  expect(await acceptances(staffOld.id)).toEqual([
    { kind: "connection", version: "2020-01-01" },
  ])
})
