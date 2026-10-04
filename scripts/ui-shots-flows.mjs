// DEV ONLY — drives the "Kết nối quảng cáo" + "MCP" screens with Playwright and saves screenshots
// (desktop 1440x900, tablet 820x1180, mobile 390x844 × light/dark), console errors and horizontal overflow.
//   node scripts/ui-shots-flows.mjs --out <dir> --cookies <cookies.json> [--base http://localhost:3112]
//        [--only name1,name2] [--vps desktop,mobile] [--themes light,dark] [--full 0|1]
// Cookies: JSON {"admin": "better-auth.session_token=…", "staff": "…"} written by scripts/dev-seed-logs.ts --out.
import fs from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = arg("out", "shots")
const BASE = arg("base", "http://localhost:3112")
const COOKIES = JSON.parse(fs.readFileSync(arg("cookies"), "utf8"))
const ONLY = arg("only", "")
  .split(",")
  .filter(Boolean)
const FULL = arg("full", "1") !== "0"
const STAFF_PASSWORD = process.env.DEV_SEED_PASSWORD ?? "dev-password-123456"

const VPS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
}
const vpNames = arg("vps", "desktop,tablet,mobile").split(",")
const themes = arg("themes", "light,dark").split(",")

fs.mkdirSync(OUT, { recursive: true })
const report = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function overflowInfo(page) {
  return page.evaluate(() => {
    const de = document.documentElement
    const vw = de.clientWidth
    const over = de.scrollWidth - vw
    const offenders = []
    if (over > 0) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
          const cs = getComputedStyle(el)
          if (cs.position === "fixed") continue
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}]`)
          if (offenders.length >= 6) break
        }
      }
    }
    return { over, offenders }
  })
}

/** interactive controls smaller than 36px (min side) — Radix switch/checkbox/radio get +24x16 hit area via ::after */
async function smallTargets(page) {
  return page.evaluate(() => {
    const out = []
    const sel = "button, [role=switch], [role=checkbox], [role=radio], [role=tab], select, input:not([type=hidden])"
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue
      if (el.closest("[data-nextjs-dev-tools-button], nextjs-portal")) continue
      let w = r.width
      let h = r.height
      if (el.matches("[role=switch], [role=checkbox], [role=radio]")) {
        w += 24
        h += 16
      }
      if (Math.min(w, h) < 36) {
        const name = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 30) || el.id || el.tagName
        out.push(`${el.tagName.toLowerCase()}[${name}] ${Math.round(w)}x${Math.round(h)}`)
      }
    }
    return out.slice(0, 8)
  })
}

async function makeContext(browser, vpName, theme, user) {
  const ctx = await browser.newContext({
    viewport: VPS[vpName],
    deviceScaleFactor: 1,
    hasTouch: vpName === "mobile",
    isMobile: vpName === "mobile",
    colorScheme: theme,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
  })
  const url = new URL(BASE)
  const [name, ...rest] = COOKIES[user].split("=")
  await ctx.addCookies([{ name, value: rest.join("="), domain: url.hostname, path: "/" }])
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t)
    } catch {}
  }, theme)
  return ctx
}

const T = {
  // helpers shared by scenarios
  async goto(page, p) {
    await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 120_000 })
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {})
    await sleep(500)
  },
  async hrefOf(page, listPath, text, selector = "a") {
    await T.goto(page, listPath)
    const loc = page.locator(`${selector}[href^="${listPath}/"]`, { hasText: text }).first()
    // the table (and its links) is display:none on phones (cards are shown instead) → only wait for "attached"
    await loc.waitFor({ state: "attached", timeout: 30_000 })
    return loc.getAttribute("href")
  },
}

// ---------------------------------------------------------------------------
// Scenarios: async ({ page, shot, user }) => void
// ---------------------------------------------------------------------------
const scenarios = {
  "conn-list": {
    user: "admin",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections")
      await shot("all")
      await page.getByRole("tab", { name: /Meta/ }).first().click()
      await sleep(300)
      await shot("tab-meta")
      await page.getByRole("tab", { name: /Tất cả/ }).first().click()
      const search = page.getByRole("searchbox").or(page.getByPlaceholder(/Tìm/)).first()
      await search.fill("zzzzz")
      await sleep(400)
      await shot("filtered-empty")
    },
  },
  "conn-list-staff": {
    user: "staff",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections")
      await shot("all")
    },
  },
  "conn-new": {
    user: "staff",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections/new")
      await shot("step0-platforms")
      await page.getByRole("button", { name: /Meta/ }).first().click()
      await sleep(400)
      await shot("step1-meta")
      await page.getByRole("button", { name: /Kiểm tra/ }).first().click()
      await sleep(500)
      await shot("step1-meta-errors")
      await page.fill("#connection-name", "Meta thử nghiệm")
      const secret = page.locator('input[type="password"]').first()
      await secret.fill("EAAINVALIDTOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")
      await page.getByRole("button", { name: /Kiểm tra/ }).first().click()
      await sleep(600)
      await shot("step2-loading")
      await page.getByText(/Không|không|lỗi|Lỗi/).first().waitFor({ timeout: 40_000 }).catch(() => {})
      await sleep(800)
      await shot("step2-error")
    },
  },
  // step 3 "Kiểm tra & chọn tài khoản" with a MOCKED server-action response (no real Meta token needed):
  // server-action POSTs on /connections/new are answered with a fake ConnectionPreview (the preview call) or with a
  // "recorded" failure (the create call, so the page stays and the submitted lists can be asserted).
  // The mixed set mirrors what the server sends: `defaultEnabled` false for closed / disabled / pending / manager.
  "conn-new-verified": {
    user: "staff",
    run: async ({ page, shot }) => {
      const acc = (externalId, name, over = {}) => ({
        externalId,
        name,
        currency: "VND",
        timezone: "Asia/Ho_Chi_Minh",
        status: "active",
        statusRaw: "1",
        isManager: false,
        parentExternalId: null,
        defaultEnabled: true,
        ...over,
      })
      const preview = {
        ok: true,
        data: {
          status: "expiring",
          statusMessage: "Token sẽ hết hạn sau 6 ngày (08/10/2026).",
          statusHint: 'Tạo token mới trong Graph API Explorer trước khi hết hạn, rồi bấm "Thay token" ở trang kết nối.',
          tokenExpiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          scopes: ["ads_management", "ads_read", "business_management", "pages_show_list"],
          warnings: ["Chưa nhập App ID + App Secret nên không tự đổi sang token dài hạn."],
          accounts: [
            acc("act_1001", "Shop Thời Trang Nữ Hà Nội"),
            acc("act_1002", "Mỹ Phẩm Hana Chính Hãng — Chiến dịch Black Friday & Tết Nguyên Đán 2027 (tên rất dài)"),
            acc("act_1003", "Noti Global (USD)", { currency: "USD", timezone: "America/Los_Angeles" }),
            acc("act_1004", "Noti Thailand", { currency: "THB", timezone: "Asia/Bangkok", status: "pending", statusRaw: "7", defaultEnabled: false }),
            acc("act_1005", "Tài khoản đã đóng", { status: "closed", statusRaw: "101", defaultEnabled: false }),
            acc("act_1006", "Tài khoản bị khoá thanh toán", { status: "disabled", statusRaw: "2", defaultEnabled: false }),
            acc("act_1007", "MCC Noti — tài khoản quản lý", { currency: "USD", isManager: true, defaultEnabled: false }),
            acc("act_1008", "Tài khoản chưa rõ trạng thái", { status: "unknown", statusRaw: "999" }),
          ],
        },
      }
      const created = []
      await page.route("**/connections/new*", async (route) => {
        const req = route.request()
        if (req.method() === "POST" && req.headers()["next-action"]) {
          let arg = null
          try {
            arg = JSON.parse(req.postData() ?? "[]")[0]
          } catch {}
          const isCreate = arg && typeof arg === "object" && "name" in arg && "credentials" in arg
          if (isCreate) created.push(arg)
          const payload = isCreate ? { ok: false, error: "Đã ghi nhận dữ liệu gửi lên (mock — không lưu thật)." } : preview
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/x-component" },
            body: `0:{"a":"$@1","f":"","b":"development"}\n1:${JSON.stringify(payload)}\n`,
          })
        }
        return route.continue()
      })
      await T.goto(page, "/connections/new?platform=meta")
      await page.fill("#connection-name", "Meta thử nghiệm")
      await page.locator('input[type="password"]').first().fill("EAAFAKETOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")
      await page.getByRole("button", { name: /Kiểm tra kết nối/ }).first().click()
      await page.getByText("Tài khoản quảng cáo tìm thấy").waitFor({ timeout: 30_000 })
      await sleep(500)
      const badge = async () => (await page.getByText(/Đang bật \d+\/\d+ tài khoản/).first().textContent())?.trim()
      const issues = []
      const expectBadge = async (label, want) => {
        const got = await badge()
        if (got !== want) issues.push(`${label}: badge "${got}" ≠ "${want}"`)
      }
      // 8 accounts: 4 default ON (1001, 1002, 1003, 1008), 4 default OFF (1004 pending, 1005 closed, 1006 disabled, 1007 MCC)
      await expectBadge("initial", "Đang bật 4/8 tài khoản")
      await shot("step3-verified")
      await page.getByText("Tài khoản quảng cáo tìm thấy").evaluate((el) => el.scrollIntoView({ block: "start" }))
      await page.evaluate(() => window.scrollBy(0, -90))
      await sleep(200)
      await shot.view("viewport-accounts-header")
      // switch ON one default-off account (closed 1005) and OFF one default-on (1002)
      await page.getByRole("switch", { name: /Tài khoản đã đóng/ }).first().click()
      await page.getByRole("switch", { name: /Mỹ Phẩm Hana/ }).first().click()
      await sleep(300)
      await expectBadge("after toggles", "Đang bật 4/8 tài khoản")
      await shot("step3-toggled")
      await page.getByRole("button", { name: "Lưu kết nối" }).click()
      await sleep(1200)
      const sent = created[0]
      if (!sent) issues.push("create action was not called")
      else {
        const dis = JSON.stringify([...(sent.disabledExternalIds ?? [])].sort())
        const ena = JSON.stringify([...(sent.enabledExternalIds ?? [])].sort())
        if (dis !== JSON.stringify(["act_1002"])) issues.push(`disabledExternalIds = ${dis}`)
        if (ena !== JSON.stringify(["act_1005"])) issues.push(`enabledExternalIds = ${ena}`)
        console.log(`  submitted: disabled=${dis} enabled=${ena}`)
      }
      // untouched defaults must send two empty lists
      await page.getByRole("button", { name: /Đặt lại về trạng thái/ }).click()
      await sleep(300)
      await expectBadge("after reset", "Đang bật 4/8 tài khoản")
      await page.getByRole("button", { name: "Lưu kết nối" }).click()
      await sleep(1200)
      const second = created[1]
      if (!second || (second.disabledExternalIds ?? []).length || (second.enabledExternalIds ?? []).length)
        issues.push(`defaults should send empty lists, got ${JSON.stringify(second)}`)
      await page.getByRole("button", { name: "Bật tất cả" }).click()
      await sleep(300)
      await expectBadge("all on", "Đang bật 8/8 tài khoản")
      await page.getByRole("button", { name: "Lưu kết nối" }).click()
      await sleep(1200)
      const third = created[2]
      if (!third || JSON.stringify([...(third.enabledExternalIds ?? [])].sort()) !== JSON.stringify(["act_1004", "act_1005", "act_1006", "act_1007"]))
        issues.push(`all on should enable the 4 default-off accounts, got ${JSON.stringify(third)}`)
      await page.getByRole("button", { name: "Tắt tất cả" }).click()
      await sleep(300)
      await expectBadge("all off", "Đang bật 0/8 tài khoản")
      await shot("step3-all-off")
      await page.getByRole("button", { name: "Lưu kết nối" }).click()
      await sleep(1200)
      const fourth = created[3]
      if (!fourth || JSON.stringify([...(fourth.disabledExternalIds ?? [])].sort()) !== JSON.stringify(["act_1001", "act_1002", "act_1003", "act_1008"]) || (fourth.enabledExternalIds ?? []).length)
        issues.push(`all off should disable the 4 default-on accounts only, got ${JSON.stringify(fourth)}`)
      for (const i of issues) throw new Error(i)
    },
  },
  // wizard error screen: the server sends ONE string "<what happened> <next step>" → message + hint line
  "conn-new-error-hint": {
    user: "staff",
    run: async ({ page, shot }) => {
      await page.route("**/connections/new*", async (route) => {
        const req = route.request()
        if (req.method() === "POST" && req.headers()["next-action"]) {
          const payload = { ok: false, error: "Token không hợp lệ hoặc đã bị thu hồi. Hãy tạo token mới rồi dán lại." }
          return route.fulfill({
            status: 200,
            headers: { "content-type": "text/x-component" },
            body: `0:{"a":"$@1","f":"","b":"development"}\n1:${JSON.stringify(payload)}\n`,
          })
        }
        return route.continue()
      })
      await T.goto(page, "/connections/new?platform=meta")
      await page.fill("#connection-name", "Meta thử nghiệm")
      await page.locator('input[type="password"]').first().fill("EAAFAKETOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")
      await page.getByRole("button", { name: /Kiểm tra kết nối/ }).first().click()
      await page.getByText("Không kiểm tra được kết nối").waitFor({ timeout: 30_000 })
      await sleep(400)
      await shot("step3-error-with-hint")
    },
  },
  "conn-new-others": {
    user: "staff",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections/new?platform=openai_ads")
      await shot("step1-openai_ads")
    },
  },
  "conn-detail": {
    user: "admin",
    run: async ({ page, shot }) => {
      for (const [label, text] of [
        ["meta-long", "BM chính — Công ty"],
        ["meta-expiring", "Meta Agency Client"],
        ["meta-invalid", "Meta cũ"],
        ["meta-multi-currency", "BM đa tiền tệ — Noti"],
        ["meta-disabled", "BM tạm tắt"],
      ]) {
        const href = await T.hrefOf(page, "/connections", text)
        await T.goto(page, href)
        await shot(label)
      }
    },
  },
  // statusMessage + statusHint: list (tooltip / phone card) and detail alert for every kind of unhealthy connection
  "conn-hints": {
    user: "admin",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections")
      await shot("list")
      for (const [label, text] of [
        ["invalid-meta", "Meta cũ"],
        ["expiring-meta", "Meta Agency Client"],
        ["invalid-meta-embedded", "token bị thu hồi"],
        ["invalid-openai-dedupe", "key bị từ chối"],
        ["transient-meta", "kiểm tra lỗi tạm thời"],
      ]) {
        const href = await T.hrefOf(page, "/connections", text)
        await T.goto(page, href)
        await shot(label)
      }
    },
  },
  "overview-alerts": {
    user: "admin",
    run: async ({ page, shot }) => {
      await T.goto(page, "/")
      await shot("overview")
    },
  },
  "conn-dialogs": {
    user: "admin",
    run: async ({ page, shot }) => {
      const href = await T.hrefOf(page, "/connections", "BM chính — Công ty")
      await T.goto(page, href)
      for (const [label, name] of [
        ["rename", /Đổi tên/],
        ["replace", /Thay token|Thay thế|Cập nhật token/],
        ["delete", /Xoá|Xóa/],
      ]) {
        // the actions live in the page header "Thêm" dropdown
        await page.getByRole("button", { name: "Thêm", exact: true }).first().click()
        await sleep(300)
        await page.getByRole("menuitem", { name }).first().click()
        await sleep(500)
        await shot(`dialog-${label}`)
        await page.keyboard.press("Escape")
        await sleep(300)
      }
    },
  },
  // a user with no connections and no MCP (cookie key "empty", see README note in the report)
  "empty-states": {
    user: "empty",
    run: async ({ page, shot }) => {
      await T.goto(page, "/connections")
      await shot("connections")
      await T.goto(page, "/mcp-servers")
      await shot("mcp-list")
      await T.goto(page, "/mcp-servers/new")
      await shot("mcp-new")
    },
  },
  "mcp-list": {
    user: "admin",
    run: async ({ page, shot }) => {
      await T.goto(page, "/mcp-servers")
      await shot("all")
    },
  },
  "mcp-list-staff": {
    user: "staff",
    run: async ({ page, shot }) => {
      await T.goto(page, "/mcp-servers")
      await shot("all")
    },
  },
  "mcp-new": {
    user: "staff",
    run: async ({ page, shot }) => {
      await T.goto(page, "/mcp-servers/new")
      await shot("step1-empty")
      await page.getByRole("button", { name: "Tiếp tục" }).click()
      await sleep(400)
      await shot("step1-error")
      await page.fill("#mcp-name", "Báo cáo ads hằng ngày")
      await page.getByRole("button", { name: "Tiếp tục" }).click()
      await sleep(500)
      await shot("step2-platforms")
      // enable every platform that has connections
      const switches = page.getByRole("switch")
      const n = await switches.count()
      for (let i = 0; i < n; i++) {
        const s = switches.nth(i)
        if ((await s.getAttribute("data-state")) !== "checked" && (await s.isEnabled())) await s.click().catch(() => {})
      }
      await sleep(500)
      await shot("step2-enabled")
      const boxes = page.locator('[id^="conn-"][role="checkbox"]')
      const bc = await boxes.count()
      for (let i = 0; i < bc; i++) {
        const b = boxes.nth(i)
        if ((await b.getAttribute("data-state")) !== "checked") await b.click().catch(() => {})
      }
      await sleep(500)
      await shot("step2-connections")
      await page.getByRole("button", { name: "Tiếp tục" }).click()
      await sleep(500)
      await shot("step3-permissions")
      await page.getByRole("button", { name: /Vận hành/ }).first().click().catch(() => {})
      await sleep(300)
      await shot("step3-operate")
      await page.getByRole("button", { name: "Tiếp tục" }).click()
      await sleep(500)
      await shot("step4-protection")
      await page.getByRole("button", { name: /Tạo MCP/ }).last().click().catch(() => {})
      await sleep(800)
      await shot("reauth-dialog")
      await page.locator('input[type="password"]').last().fill(STAFF_PASSWORD).catch(() => {})
      await page.keyboard.press("Enter")
      await sleep(2500)
      await shot("success")
    },
  },
  "mcp-dialogs": {
    user: "admin",
    run: async ({ page, shot }) => {
      const href = await T.hrefOf(page, "/mcp-servers", "Vận hành Meta")
      await T.goto(page, href + "?tab=security")
      await page.getByRole("button", { name: "Xem lại link" }).first().click()
      await sleep(600)
      await shot("reveal")
      await page.keyboard.press("Escape")
      await sleep(300)
      await page.getByRole("button", { name: "Xoay key" }).first().click()
      await sleep(600)
      await shot("rotate")
      await page.keyboard.press("Escape")
      await sleep(300)
      await page.getByRole("button", { name: "Tắt MCP" }).last().click()
      await sleep(600)
      await shot("disable")
      await page.keyboard.press("Escape")
      await sleep(300)
      await page.getByRole("button", { name: "Xoá MCP" }).last().click()
      await sleep(600)
      await shot("delete")
    },
  },
  // config tab: stored scopes pointing at deleted / switched-off connections and accounts → inline warning + save bar
  "mcp-config-issues": {
    user: "admin",
    run: async ({ page, shot }) => {
      const href = await T.hrefOf(page, "/mcp-servers", "Báo cáo cũ")
      await T.goto(page, href + "?tab=config")
      await page.getByText("Một số kết nối hoặc TKQC không còn dùng được").waitFor({ timeout: 30_000 })
      await sleep(400)
      await shot("config")
      await page.getByText("Một số kết nối hoặc TKQC không còn dùng được").scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollBy(0, -160))
      await sleep(200)
      await shot.view("alert-viewport")
      // the bar already offers to save the pruning
      await page.getByText(/Lưu để loại .* không còn dùng được khỏi MCP/).first().waitFor({ timeout: 5_000 })
      // an edit turns the bar message into "Có thay đổi chưa lưu — gồm loại …"
      await page.fill("#mcp-name", "Báo cáo cũ — đã sửa tên")
      await sleep(300)
      await page.getByText(/Có thay đổi chưa lưu — gồm loại/).first().waitFor({ timeout: 5_000 })
      await shot("config-edited")
      // "Huỷ" drops the edit and dismisses the bar; the warning stays
      await page.getByRole("button", { name: "Huỷ" }).first().click()
      await sleep(400)
      const barGone = (await page.getByText(/Có thay đổi chưa lưu|Lưu để loại/).count()) === 0
      if (!barGone) throw new Error("save bar should be dismissed after Huỷ")
      if ((await page.getByText("Một số kết nối hoặc TKQC không còn dùng được").count()) === 0) throw new Error("warning must stay")
      await shot("config-dismissed")
    },
  },
  // the platform's only connection is gone → the editor switches it off; the staff-owned MCP is read by the admin
  "mcp-config-platform-dropped": {
    user: "admin",
    run: async ({ page, shot }) => {
      const href = await T.hrefOf(page, "/mcp-servers", "OpenAI đã xoá")
      await T.goto(page, href + "?tab=config")
      await page.getByText("Một số kết nối hoặc TKQC không còn dùng được").waitFor({ timeout: 30_000 })
      await sleep(400)
      await shot("config")
      await page.getByText("Một số kết nối hoặc TKQC không còn dùng được").scrollIntoViewIfNeeded()
      await page.evaluate(() => window.scrollBy(0, -160))
      await sleep(200)
      await shot.view("alert-viewport")
    },
  },
  // overview tab: a platform with permissions but no usable account
  "mcp-overview-nousable": {
    user: "admin",
    run: async ({ page, shot }) => {
      for (const [label, text] of [
        ["all", "MCP chưa có TKQC dùng được"],
        ["some", "OpenAI chưa bật TKQC"],
        ["deleted-and-off", "Báo cáo cũ"],
        ["healthy", "Vận hành Meta"],
      ]) {
        const href = await T.hrefOf(page, "/mcp-servers", text)
        await T.goto(page, href)
        await sleep(300)
        await shot(label)
      }
    },
  },
  "mcp-detail": {
    user: "admin",
    run: async ({ page, shot }) => {
      const href = await T.hrefOf(page, "/mcp-servers", "Vận hành Meta")
      await T.goto(page, href)
      await shot("overview")
      for (const [label, re] of [
        ["config", /Cấu hình/],
        ["connect", /Kết nối AI/],
        ["logs", /Nhật ký/],
        ["security", /Bảo mật/],
      ]) {
        await page.getByRole("tab", { name: re }).first().click()
        await sleep(900)
        await shot(label)
      }
    },
  },
}

// ---------------------------------------------------------------------------
const browser = await chromium.launch()
for (const [name, sc] of Object.entries(scenarios)) {
  if (ONLY.length && !ONLY.includes(name)) continue
  for (const vp of vpNames) {
    for (const theme of themes) {
      const ctx = await makeContext(browser, vp, theme, sc.user)
      const page = await ctx.newPage()
      const issues = []
      page.on("console", (m) => {
        if (["error", "warning"].includes(m.type())) issues.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`)
      })
      page.on("pageerror", (e) => issues.push(`[pageerror] ${String(e).slice(0, 300)}`))
      const shot = async (label) => {
        const file = path.join(OUT, `${name}__${label}__${vp}-${theme}.png`)
        // full-page capture of a scrolled page misplaces fixed/sticky chrome (sidebar, top bar) → start from the top
        if (FULL) {
          await page.evaluate(() => window.scrollTo(0, 0))
          await sleep(150)
        }
        await page.screenshot({ path: file, fullPage: FULL })
        const o = await overflowInfo(page)
        if (o.over > 0) issues.push(`[overflow ${label}] +${o.over}px  ${o.offenders.join(" | ")}`)
        if (vp === "mobile" && theme === "light") {
          const small = await smallTargets(page)
          if (small.length) issues.push(`[small-target ${label}] ${small.join("; ")}`)
        }
      }
      // viewport-only capture at the CURRENT scroll position (sticky bars sit where a user sees them)
      shot.view = async (label) => {
        await page.screenshot({ path: path.join(OUT, `${name}__${label}__${vp}-${theme}.png`), fullPage: false })
      }
      try {
        await sc.run({ page, shot, user: sc.user })
      } catch (e) {
        issues.push(`[scenario-error] ${String(e).slice(0, 400)}`)
        try {
          await page.screenshot({ path: path.join(OUT, `${name}__ERROR__${vp}-${theme}.png`), fullPage: false })
        } catch {}
      }
      report.push({ scenario: name, vp, theme, issues: [...new Set(issues)] })
      console.log(`${name} ${vp}-${theme}: ${issues.length ? "\n  " + [...new Set(issues)].join("\n  ") : "ok"}`)
      await ctx.close()
    }
  }
}
await browser.close()
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2))
