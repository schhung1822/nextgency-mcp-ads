// DEV ONLY — screenshots + sanity report for the "people" screens: auth pages, /users, /account.
//   node scripts/ui-shots-people.mjs --phase <setup|login|twofa|forced|dash|all> --out <dir> [--base http://localhost:3113]
// Needs a running dev server + a dev database (see CLAUDE.md). Phases run in this order on a fresh DB:
//   setup  → /setup shots, then creates the first admin through the real form
//   login  → /login shots (+ error + pending + keyboard-open viewport)
//   twofa  → admin enrols 2FA through the real flow (QR, backup codes), then /login/2fa shots
//   forced → admin creates a staff user through the dialog, staff signs in → forced change-password page
//   dash   → /users (+dialogs) and /account for admin and staff at every viewport/theme
// Each shot is saved as <out>/<phase>/<viewport>-<theme>/<name>.png; report.json collects console errors,
// horizontal overflow and small touch targets.
import { createHmac } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { chromium } from "@playwright/test"

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d)
const BASE = arg("base", "http://localhost:3113")
const OUT = path.resolve(arg("out", "shots-people"))
const PHASE = arg("phase", "all")
const ONLY_VP = arg("vp", "")
const ONLY_THEME = arg("theme", "")

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
].filter((v) => !ONLY_VP || v.name === ONLY_VP)
const THEMES = ["light", "dark"].filter((t) => !ONLY_THEME || t === ONLY_THEME)

const ADMIN = { name: "Quản trị Demo", email: "admin.demo@example.test", password: "Admin-Pass-2026!" }
const STAFF = { name: "Lan Nguyễn", email: "lan.nguyen@example.test" }
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "ui-people-setup-token"

fs.mkdirSync(OUT, { recursive: true })
const statePath = path.join(OUT, "state.json")
const reportPath = path.join(OUT, "report.json")
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {}
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { issues: [] }
const save = () => {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
}

// ---- TOTP (RFC 6238, SHA-1, 30 s) -------------------------------------------------------------
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const out = []
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
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, "0")
}
let lastCode = state.lastCode ?? ""
async function freshTotp(secret) {
  for (;;) {
    const remaining = 30 - (Math.floor(Date.now() / 1000) % 30)
    if (remaining < 4 || totp(secret) === lastCode) {
      await new Promise((r) => setTimeout(r, remaining * 1000 + 600))
      continue
    }
    lastCode = totp(secret)
    state.lastCode = lastCode
    return lastCode
  }
}

// DEV DATABASE ONLY (DATABASE_URL from the launcher): switch 2FA off so the enrolment walk can repeat.
async function resetTwoFactor(email) {
  const { default: pg } = await import("pg")
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    await c.query('delete from two_factor where user_id = (select id from "user" where email = $1)', [email])
    await c.query('update "user" set two_factor_enabled = false where email = $1', [email])
  } finally {
    await c.end()
  }
}

// ---- helpers ----------------------------------------------------------------------------------
const browser = await chromium.launch()
let lastPage = null

let ipCounter = Math.floor(Math.random() * 200) + 10

async function newPage(vp, theme, opts = {}) {
  // Better Auth rate-limits per client IP (x-forwarded-for) → give every context its own fake IP
  ipCounter += 1
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": `10.${ipCounter % 250}.${(ipCounter * 7) % 250}.${(ipCounter * 13) % 250}` },
    viewport: { width: vp.width, height: vp.height },
    colorScheme: theme,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    deviceScaleFactor: 1,
    hasTouch: vp.name === "mobile",
    ...opts,
  })
  const page = await ctx.newPage()
  lastPage = page
  const key = `${vp.name}-${theme}`
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) {
      const text = m.text()
      if (/Download the React DevTools|favicon|\[HMR\]|\[Fast Refresh\]/.test(text)) return
      report.issues.push({ kind: `console-${m.type()}`, key, url: page.url(), text: text.slice(0, 400) })
    }
  })
  page.on("pageerror", (e) => report.issues.push({ kind: "pageerror", key, url: page.url(), text: String(e).slice(0, 400) }))
  return { ctx, page, key }
}

async function checks(page, key, name) {
  const res = await page.evaluate(() => {
    const de = document.documentElement
    const overflow = de.scrollWidth - de.clientWidth
    const small = []
    for (const el of document.querySelectorAll("button, a[href], [role=button], input, select, [role=checkbox], [role=combobox]")) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue
      if (el.closest("[aria-hidden=true], [hidden]") || el.className?.toString().includes("sr-only")) continue
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.className.includes("sr-only")) continue
      if (r.height < 36 || r.width < 36) {
        small.push({ tag: el.tagName.toLowerCase(), text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
    // text clipped by overflow inside cards (very rough): elements whose scrollWidth > clientWidth with overflow visible
    return { overflow, small: small.slice(0, 12), title: document.title }
  })
  if (res.overflow > 1) report.issues.push({ kind: "h-overflow", key, name, px: res.overflow })
  if (key.startsWith("mobile") && res.small.length) report.issues.push({ kind: "small-targets", key, name, items: res.small })
  return res
}

async function shot(page, key, phase, name, { full = false } = {}) {
  const dir = path.join(OUT, phase, key)
  fs.mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(250)
  await checks(page, key, `${phase}/${name}`)
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: full })
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {})
  await page.waitForTimeout(300)
}

async function realLogin(page, email, password) {
  await page.goto(`${BASE}/login`)
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password)
  await page.getByRole("button", { name: "Đăng nhập" }).click()
}

async function otpFill(page, secret) {
  const code = await freshTotp(secret)
  await page.locator("input[autocomplete=one-time-code]").first().fill(code)
}

async function eachCombo(fn) {
  for (const vp of VIEWPORTS) for (const theme of THEMES) await fn(vp, theme)
}

// ---- phases -----------------------------------------------------------------------------------
async function phaseSetup() {
  console.log("[setup]")
  await eachCombo(async (vp, theme) => {
    const { ctx, page, key } = await newPage(vp, theme)
    await page.goto(`${BASE}/setup`)
    await settle(page)
    await shot(page, key, "setup", "01-empty", { full: true })
    if (vp.name === "desktop" || vp.name === "mobile") {
      await page.getByRole("button", { name: /Tạo quản trị viên/ }).click()
      await page.waitForTimeout(400)
      await shot(page, key, "setup", "02-validation", { full: true })
    }
    await ctx.close()
  })
  // keyboard-open mobile viewport
  for (const theme of THEMES) {
    const { ctx, page, key } = await newPage({ name: "mobile", width: 390, height: 500 }, theme)
    await page.goto(`${BASE}/setup`)
    await settle(page)
    await shot(page, `kb-${key}`, "setup", "03-keyboard")
    await ctx.close()
  }
  // wrong token → server error
  {
    const { ctx, page, key } = await newPage(VIEWPORTS[0], "light")
    await page.goto(`${BASE}/setup`)
    await page.getByLabel("Họ tên").fill(ADMIN.name)
    await page.getByLabel("Email").fill(ADMIN.email)
    await page.getByLabel("Mật khẩu", { exact: true }).fill(ADMIN.password)
    await page.getByLabel("Nhập lại mật khẩu").fill(ADMIN.password)
    await page.getByLabel(/Mã thiết lập/).fill("sai-ma")
    await page.getByRole("button", { name: /Tạo quản trị viên/ }).click()
    await page.locator('[data-slot="alert"]').first().waitFor()
    await shot(page, key, "setup", "04-wrong-token", { full: true })
    // now the real thing
    await page.getByLabel(/Mã thiết lập/).fill(SETUP_TOKEN)
    await page.getByRole("button", { name: /Tạo quản trị viên/ }).click()
    await page.waitForURL((u) => !u.pathname.startsWith("/setup"), { timeout: 30000 })
    await settle(page)
    state.afterSetupUrl = new URL(page.url()).pathname
    await shot(page, key, "setup", "05-after-setup", { full: true })
    await ctx.close()
  }
  save()
}

async function phaseLogin() {
  console.log("[login]")
  await eachCombo(async (vp, theme) => {
    const { ctx, page, key } = await newPage(vp, theme)
    await page.goto(`${BASE}/login`)
    await settle(page)
    await shot(page, key, "login", "01-empty", { full: true })
    if (vp.name !== "tablet") {
      await page.getByRole("button", { name: "Đăng nhập" }).click()
      await page.waitForTimeout(400)
      await shot(page, key, "login", "02-validation", { full: true })
      await page.getByLabel("Email").fill(ADMIN.email)
      await page.getByLabel("Mật khẩu", { exact: true }).fill("sai-mat-khau-123")
      await page.getByRole("button", { name: "Đăng nhập" }).click()
      await page.locator('[data-slot="alert"]').first().waitFor({ timeout: 45000 }).catch(() => {})
      await shot(page, key, "login", "03-wrong-password", { full: true })
    }
    await ctx.close()
  })
  for (const theme of THEMES) {
    const { ctx, page, key } = await newPage({ name: "mobile", width: 390, height: 500 }, theme)
    await page.goto(`${BASE}/login`)
    await settle(page)
    await page.getByLabel("Email").focus()
    await shot(page, `kb-${key}`, "login", "04-keyboard")
    await ctx.close()
  }
  // pending state (slow auth endpoint)
  {
    const { ctx, page, key } = await newPage(VIEWPORTS[0], "light")
    await page.route("**/api/auth/sign-in/email", async (route) => {
      await new Promise((r) => setTimeout(r, 4000))
      await route.continue()
    })
    await page.goto(`${BASE}/login`)
    await page.getByLabel("Email").fill(ADMIN.email)
    await page.getByLabel("Mật khẩu", { exact: true }).fill("sai-mat-khau-123")
    await page.getByRole("button", { name: "Đăng nhập" }).click()
    await page.waitForTimeout(700)
    await shot(page, key, "login", "05-pending")
    await ctx.close()
  }
  save()
}

async function phaseTwoFactor() {
  console.log("[twofa]")
  // Enrol through the real flow. Each combo repeats the walk (2FA is disabled again through the account card
  // when already on), so every viewport/theme gets real QR + backup-code screens.
  const vpBy = (n) => VIEWPORTS.find((v) => v.name === n) ?? VIEWPORTS[0]
  const combos = [
    [vpBy("desktop"), "light"],
    [vpBy("mobile"), "dark"],
    [vpBy("mobile"), "light"],
    [vpBy("desktop"), "dark"],
    [vpBy("tablet"), "light"],
  ].filter(([, t]) => THEMES.includes(t))
  for (const [vp, theme] of combos) {
    const { ctx, page, key } = await newPage(vp, theme)
    await realLogin(page, ADMIN.email, ADMIN.password)
    await page.waitForURL((u) => u.pathname !== "/login", { timeout: 30000 })
    if (new URL(page.url()).pathname === "/login/2fa") {
      await otpFill(page, state.totpSecret)
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 })
    }
    await page.goto(`${BASE}/security/enable-2fa`)
    await settle(page)
    if (new URL(page.url()).pathname !== "/security/enable-2fa") {
      // admins cannot switch 2FA off through the UI/server action → reset it directly in the dev DB
      await resetTwoFactor(ADMIN.email)
      await page.goto(`${BASE}/security/enable-2fa`)
      await settle(page)
    }
    await shot(page, key, "twofa", "01-enable-password", { full: true })
    await page.getByLabel(/Mật khẩu hiện tại/).fill(ADMIN.password)
    await page.getByRole("button", { name: /Tiếp tục/ }).click()
    await page.getByTestId("totp-qr").waitFor({ timeout: 20000 })
    await settle(page)
    // <input> (old) or <code> (grouped in blocks of 4)
    state.totpSecret = (await page.locator("#totp-secret").evaluate((el) => el.value ?? el.textContent)).replace(/\s+/g, "")
    await shot(page, key, "twofa", "02-scan", { full: true })
    await page.locator("input[autocomplete=one-time-code]").first().fill(await freshTotp(state.totpSecret))
    await page.getByTestId("backup-codes").waitFor({ timeout: 20000 })
    await settle(page)
    await shot(page, key, "twofa", "03-backup-codes", { full: true })
    state.backupCodes = (await page.getByTestId("backup-codes").innerText()).split(/\s+/).filter(Boolean)
    await ctx.close()
    save()
  }
  // keyboard-open on the scan step is hard to reach; shoot the password step instead
  // /login/2fa
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const { ctx, page, key } = await newPage(vp, theme)
      await realLogin(page, ADMIN.email, ADMIN.password)
      await page.waitForURL("**/login/2fa**", { timeout: 30000 })
      await settle(page)
      await shot(page, key, "twofa", "04-login-2fa", { full: true })
      if (vp.name !== "tablet") {
        await page.locator("input[autocomplete=one-time-code]").first().fill("000000")
        await page.locator('[data-slot="alert"]').first().waitFor({ timeout: 45000 }).catch(() => {})
        await shot(page, key, "twofa", "05-login-2fa-wrong", { full: true })
        await page.getByRole("button", { name: /Dùng mã dự phòng/ }).click()
        await page.waitForTimeout(300)
        await shot(page, key, "twofa", "06-login-2fa-backup", { full: true })
      }
      await ctx.close()
    }
  }
  for (const theme of THEMES) {
    const { ctx, page, key } = await newPage({ name: "mobile", width: 360, height: 640 }, theme)
    await realLogin(page, ADMIN.email, ADMIN.password)
    await page.waitForURL("**/login/2fa**", { timeout: 30000 })
    await settle(page)
    await shot(page, `w360-${key}`, "twofa", "07-login-2fa-360")
    await ctx.close()
  }
  // sign in for real and store the session for the dashboard phases
  {
    const { ctx, page } = await newPage(VIEWPORTS[0], "light")
    await realLogin(page, ADMIN.email, ADMIN.password)
    await page.waitForURL("**/login/2fa**", { timeout: 30000 })
    await otpFill(page, state.totpSecret)
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 })
    await ctx.storageState({ path: path.join(OUT, "admin-state.json") })
    await ctx.close()
  }
  save()
}

async function adminCtx(vp, theme) {
  return newPage(vp, theme, { storageState: path.join(OUT, "admin-state.json") })
}

async function phaseForced() {
  console.log("[forced]")
  const { ctx, page } = await adminCtx(VIEWPORTS[0], "light")
  await page.goto(`${BASE}/users`)
  await settle(page)
  // create the staff user through the dialog (real flow) and read the temp password back
  await page.getByRole("button", { name: /Thêm người dùng/ }).click()
  await page.locator("#new-user-name").fill(STAFF.name)
  await page.locator("#new-user-email").fill(STAFF.email)
  await page.getByRole("button", { name: "Tạo người dùng" }).click()
  await page.getByText("Đã tạo người dùng").first().waitFor({ timeout: 20000 })
  state.staffTemp = await page.locator("#created-password").inputValue()
  await ctx.close()
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const c = await newPage(vp, theme)
      await realLogin(c.page, STAFF.email, state.staffTemp)
      await c.page.waitForURL("**/security/change-password**", { timeout: 30000 })
      await settle(c.page)
      await shot(c.page, c.key, "forced", "01-change-password", { full: true })
      if (vp.name === "desktop") {
        await c.page.getByRole("button", { name: "Đổi mật khẩu" }).click()
        await c.page.waitForTimeout(400)
        await shot(c.page, c.key, "forced", "02-validation", { full: true })
      }
      await c.ctx.close()
    }
  }
  // finish the forced change once to obtain the staff session
  state.staffPassword = "Staff-New-Pass-2026!"
  {
    const c = await newPage(VIEWPORTS[0], "light")
    await realLogin(c.page, STAFF.email, state.staffTemp)
    await c.page.waitForURL("**/security/change-password**", { timeout: 30000 })
    await c.page.getByLabel("Mật khẩu hiện tại").fill(state.staffTemp)
    await c.page.getByLabel("Mật khẩu mới", { exact: true }).fill(state.staffPassword)
    await c.page.getByLabel("Nhập lại mật khẩu mới").fill(state.staffPassword)
    await c.page.getByRole("button", { name: "Đổi mật khẩu" }).click()
    await c.page.waitForURL((u) => !u.pathname.startsWith("/security"), { timeout: 30000 })
    await c.ctx.storageState({ path: path.join(OUT, "staff-state.json") })
    await c.ctx.close()
  }
  save()
}

async function openRowMenu(page, name) {
  await page.getByRole("button", { name: `Thao tác với ${name}` }).first().click()
  await page.waitForTimeout(300)
}

async function phaseDash() {
  console.log("[dash]")
  const target = "Bùi Ngọc Ánh"
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const { ctx, page, key } = await adminCtx(vp, theme)
      // /users
      await page.goto(`${BASE}/users`)
      await settle(page)
      await shot(page, key, "dash", "users-01-list", { full: true })
      await page.getByRole("button", { name: /Thêm người dùng/ }).click()
      await page.waitForTimeout(500)
      await shot(page, key, "dash", "users-02-create-staff")
      // role → admin (radio cards; old UI: Select)
      if (await page.locator("#new-user-role-admin").count()) {
        await page.locator("#new-user-role-admin").click()
      } else {
        await page.locator("#new-user-role").click().catch(() => {})
        await page.getByRole("option", { name: "Quản trị viên" }).click().catch(() => {})
      }
      await page.waitForTimeout(400)
      await shot(page, key, "dash", "users-03-create-admin")
      // validation state
      await page.getByRole("button", { name: "Tạo người dùng" }).click()
      await page.waitForTimeout(500)
      await shot(page, key, "dash", "users-03b-create-validation")
      await page.keyboard.press("Escape")
      await page.waitForTimeout(400)
      // row menu + row dialogs for one user
      await openRowMenu(page, target)
      await shot(page, key, "dash", "users-04-row-menu")
      await page.keyboard.press("Escape")
      for (const [i, label] of [
        ["05-role", "Đổi vai trò"],
        ["06-reset-password", "Đặt lại mật khẩu"],
        ["07-sessions", "Xem phiên đăng nhập"],
        ["08-delete", "Xoá người dùng"],
        ["09-ban", "Khoá tài khoản"],
      ]) {
        await openRowMenu(page, target)
        await page.getByRole("menuitem", { name: label }).first().click()
        await page.waitForTimeout(700)
        await shot(page, key, "dash", `users-${i}`)
        await page.keyboard.press("Escape")
        await page.waitForTimeout(450)
      }
      // self menu
      await openRowMenu(page, "Quản trị Demo")
      await shot(page, key, "dash", "users-10-self-menu")
      await page.keyboard.press("Escape")
      // filters: search + banned tab
      const search = page.getByRole("searchbox").or(page.locator("input[name=q]")).first()
      if (await search.count()) {
        await search.fill("huong")
        await page.waitForTimeout(800)
        await shot(page, key, "dash", "users-11-search")
        await search.fill("zzzz-khong-co")
        await page.waitForTimeout(800)
        await shot(page, key, "dash", "users-12-search-empty")
      }
      // /account
      await page.goto(`${BASE}/account`)
      await settle(page)
      await shot(page, key, "dash", "account-01", { full: true })
      await shot(page, key, "dash", "account-01b-fold")
      await ctx.close()
      // staff account
      if (fs.existsSync(path.join(OUT, "staff-state.json"))) {
        const s = await newPage(vp, theme, { storageState: path.join(OUT, "staff-state.json") })
        await s.page.goto(`${BASE}/account`)
        await settle(s.page)
        await shot(s.page, s.key, "dash", "account-02-staff", { full: true })
        await s.ctx.close()
      }
    }
  }
  save()
}

const phases = {
  setup: phaseSetup,
  login: phaseLogin,
  twofa: phaseTwoFactor,
  forced: phaseForced,
  dash: phaseDash,
}
const run = PHASE === "all" ? Object.keys(phases) : PHASE.split(",")
try {
  for (const p of run) await phases[p]()
} catch (e) {
  if (lastPage) {
    await lastPage.screenshot({ path: path.join(OUT, "debug-fail.png") }).catch(() => {})
    console.error("FAILED at", lastPage.url(), "alerts:", await lastPage.locator('[data-slot="alert"]').allInnerTexts().catch(() => []))
  }
  throw e
} finally {
  save()
  await browser.close()
}
const byKind = {}
for (const i of report.issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1
console.log("issues:", JSON.stringify(byKind))
console.log("screenshots →", OUT)
