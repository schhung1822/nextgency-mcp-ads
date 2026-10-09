// Authorization matrix over real HTTP (dev server + throw-away <db>_e2e database from playwright.config.ts):
// every page route, the API routes (/api/health, /api/auth/*, /api/logs/export, /mcp/*) against every kind of
// caller — anonymous, staff, admin (with / without 2FA), forced password change, banned, expired session —
// under the three 2FA policies (off / require_2fa_admin / require_2fa_all).
//
// Users are seeded straight into the database (scrypt hash via better-auth/crypto, TOTP secret encrypted with
// BETTER_AUTH_SECRET) and signed in over the Better Auth HTTP API, so no UI is involved and nothing depends on
// auth.spec.ts. Redirects are NOT followed: the exact status + Location is the assertion.
import { randomBytes } from "node:crypto"
import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test"

import { BASE, db, nextIp, PASSWORD, RUN, seedUser, setPolicy, signInApi, type Policy } from "./people-helpers"

test.describe.configure({ mode: "serial" })
test.setTimeout(300_000)

interface Actor {
  key: string
  email: string
  role?: "admin" | "staff"
  anonymous?: boolean
  mustChange?: boolean
  twoFactor?: boolean
  state?: "ok" | "banned" | "expired"
  ctx: APIRequestContext
  userId?: string
}

const actors: Actor[] = []

async function makeActor(a: Omit<Actor, "ctx" | "email" | "userId">): Promise<Actor> {
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } })
  if (a.anonymous) {
    const actor: Actor = { ...a, email: "", ctx }
    actors.push(actor)
    return actor
  }
  const { id, email } = await seedUser({ key: a.key, role: a.role ?? "staff", mustChange: a.mustChange, twoFactor: a.twoFactor })
  await signInApi(ctx, email, !!a.twoFactor)
  if (a.state === "banned") await db((c) => c.query(`update "user" set banned = true where id = $1`, [id]))
  if (a.state === "expired")
    await db((c) => c.query(`update session set expires_at = now() - interval '1 minute' where user_id = $1`, [id]))
  const actor: Actor = { ...a, email, ctx, userId: id }
  actors.push(actor)
  return actor
}

// ---------------------------------------------------------------------------------------------------------------
// expectation model
// ---------------------------------------------------------------------------------------------------------------
type Gate = "login-next" | "login" | "change-password" | "enable-2fa" | "ok"

function gateOf(a: Actor, policy: Policy): Gate {
  if (a.anonymous) return "login-next" // proxy: no session cookie → /login?next=…
  if (a.state === "banned" || a.state === "expired") return "login" // cookie present, session invalid → page redirect
  if (a.mustChange) return "change-password"
  const required = a.role === "admin" ? policy.admin || policy.all : policy.all
  if (!a.twoFactor && required) return "enable-2fa"
  return "ok"
}

interface Outcome {
  status: number
  /** pathname of the Location header for redirects */
  to?: string
}

const GATE_REDIRECT: Record<Exclude<Gate, "ok">, string> = {
  "login-next": "/login",
  login: "/login",
  "change-password": "/security/change-password",
  "enable-2fa": "/security/enable-2fa",
}

function expectedPage(a: Actor, policy: Policy, kind: "app" | "admin" | "notfound-when-ok"): Outcome {
  const g = gateOf(a, policy)
  if (g !== "ok") return { status: 307, to: GATE_REDIRECT[g] }
  if (kind === "notfound-when-ok") return { status: 404 }
  if (kind === "admin" && a.role !== "admin") return { status: 404 }
  return { status: 200 }
}

async function visit(a: Actor, path: string): Promise<Outcome & { res: APIResponse }> {
  const res = await a.ctx.get(path, { maxRedirects: 0 })
  const loc = res.headers().location
  return { status: res.status(), to: loc ? new URL(loc, BASE).pathname : undefined, res }
}

const NIL = "00000000-0000-4000-8000-000000000000"
const APP_PAGES = ["/", "/account", "/connections", "/connections/new", "/connections/drive/new", "/mcp-servers", "/mcp-servers/new", "/logs"]
const MISSING_PAGES = [`/connections/${NIL}`, `/connections/drive/${NIL}`, `/mcp-servers/${NIL}`]
const ADMIN_PAGES = ["/users", "/settings", "/settings/updates"]
const POLICIES: { name: string; policy: Policy }[] = [
  { name: "2FA tuỳ chọn (mặc định)", policy: { admin: false, all: false } },
  { name: "bắt buộc 2FA cho quản trị viên", policy: { admin: true, all: false } },
  { name: "bắt buộc 2FA cho mọi người", policy: { admin: true, all: true } },
]

let anon: Actor
let staff: Actor
let staff2fa: Actor
let admin: Actor
let admin2fa: Actor
let staffMustChange: Actor
let adminMustChange: Actor
let banned: Actor
let expired: Actor

test.beforeAll(async () => {
  // a user must exist, otherwise /login redirects to /setup
  await setPolicy({ admin: false, all: false })
  anon = await makeActor({ key: "anon", anonymous: true })
  staff = await makeActor({ key: "staff", role: "staff" })
  staff2fa = await makeActor({ key: "staff2fa", role: "staff", twoFactor: true })
  admin = await makeActor({ key: "admin", role: "admin" })
  admin2fa = await makeActor({ key: "admin2fa", role: "admin", twoFactor: true })
  staffMustChange = await makeActor({ key: "staffmc", role: "staff", mustChange: true })
  adminMustChange = await makeActor({ key: "adminmc", role: "admin", mustChange: true })
  banned = await makeActor({ key: "banned", role: "staff", state: "banned" })
  expired = await makeActor({ key: "expired", role: "staff", state: "expired" })
})

test.afterAll(async () => {
  await setPolicy({ admin: false, all: false })
  await Promise.all(actors.map((a) => a.ctx.dispose()))
})

// ---------------------------------------------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------------------------------------------
for (const { name, policy } of POLICIES) {
  test(`trang ứng dụng + trang quản trị — ${name}`, async () => {
    await setPolicy(policy)
    const all = [anon, staff, staff2fa, admin, admin2fa, staffMustChange, adminMustChange, banned, expired]
    const problems: string[] = []
    for (const a of all) {
      for (const [paths, kind] of [
        [APP_PAGES, "app"],
        [MISSING_PAGES, "notfound-when-ok"],
        [ADMIN_PAGES, "admin"],
      ] as const) {
        for (const path of paths) {
          const want = expectedPage(a, policy, kind)
          const got = await visit(a, path)
          if (kind === "notfound-when-ok" && want.status === 404) {
            // a missing / not-yours id: the not-found UI is streamed inside the page's loading boundary
            // (HTTP 200) — same answer for "does not exist" and "belongs to someone else", no data in it.
            const html = got.status === 404 || got.status === 200 ? await got.res.text() : ""
            if (![200, 404].includes(got.status) || !html.includes("Không tìm thấy"))
              problems.push(`${a.key} ${path}: expected the not-found page, got ${got.status}`)
            continue
          }
          if (got.status !== want.status || (want.to && got.to !== want.to))
            problems.push(`${a.key} ${path}: expected ${want.status}${want.to ? ` → ${want.to}` : ""}, got ${got.status}${got.to ? ` → ${got.to}` : ""}`)
        }
      }
    }
    expect(problems).toEqual([])
  })
}

test("trang đăng nhập/2FA/đổi mật khẩu/bật 2FA/setup theo từng người dùng", async () => {
  await setPolicy({ admin: false, all: false })
  const problems: string[] = []
  const check = (label: string, got: Outcome, want: Outcome) => {
    if (got.status !== want.status || (want.to !== undefined && got.to !== want.to))
      problems.push(`${label}: expected ${want.status}${want.to ? ` → ${want.to}` : ""}, got ${got.status}${got.to ? ` → ${got.to}` : ""}`)
  }
  // /login: public; a valid session is sent to the dashboard; a dead session (banned/expired) just sees the form
  check("anon /login", await visit(anon, "/login"), { status: 200 })
  for (const a of [staff, admin, admin2fa, staffMustChange]) check(`${a.key} /login`, await visit(a, "/login"), { status: 307, to: "/" })
  for (const a of [banned, expired]) check(`${a.key} /login`, await visit(a, "/login"), { status: 200 })
  // public legal pages (pasted into Meta/OpenAI developer apps): 200 for everyone, never a redirect to /login
  for (const path of ["/privacy", "/terms", "/data-deletion"])
    for (const a of [anon, staff, admin, banned, expired, staffMustChange]) check(`${a.key} ${path}`, await visit(a, path), { status: 200 })
  // /login/2fa: without a pending challenge → back to /login (valid session → dashboard)
  check("anon /login/2fa", await visit(anon, "/login/2fa"), { status: 307, to: "/login" })
  check("staff /login/2fa", await visit(staff, "/login/2fa"), { status: 307, to: "/" })
  check("banned /login/2fa", await visit(banned, "/login/2fa"), { status: 307, to: "/login" })
  // forced steps
  check("anon /security/change-password", await visit(anon, "/security/change-password"), { status: 307, to: "/login" })
  check("staff /security/change-password", await visit(staff, "/security/change-password"), { status: 307, to: "/account" })
  check("staffmc /security/change-password", await visit(staffMustChange, "/security/change-password"), { status: 200 })
  check("adminmc /security/change-password", await visit(adminMustChange, "/security/change-password"), { status: 200 })
  check("banned /security/change-password", await visit(banned, "/security/change-password"), { status: 307, to: "/login" })
  check("anon /security/enable-2fa", await visit(anon, "/security/enable-2fa"), { status: 307, to: "/login" })
  check("staff /security/enable-2fa", await visit(staff, "/security/enable-2fa"), { status: 200 }) // voluntary enrolment
  check("admin /security/enable-2fa", await visit(admin, "/security/enable-2fa"), { status: 200 })
  check("admin2fa /security/enable-2fa", await visit(admin2fa, "/security/enable-2fa"), { status: 307, to: "/account" })
  check("staffmc /security/enable-2fa", await visit(staffMustChange, "/security/enable-2fa"), { status: 307, to: "/security/change-password" })
  check("expired /security/enable-2fa", await visit(expired, "/security/enable-2fa"), { status: 307, to: "/login" })
  // /setup is closed once a user exists — for everyone, and its tab title must not give it away
  for (const a of [anon, staff, admin]) {
    const r = await visit(a, "/setup")
    check(`${a.key} /setup`, r, { status: 404 })
    expect(await r.res.text(), `${a.key} /setup title`).not.toMatch(/<title>[^<]*Thiết lập/)
  }
  expect(problems).toEqual([])
})

test("trang quản trị trả 404 thật (không phải 200 với giao diện 404) cho nhân viên", async () => {
  await setPolicy({ admin: false, all: false })
  for (const path of ADMIN_PAGES) {
    const r = await visit(staff, path)
    expect(r.status, `staff ${path}`).toBe(404)
    // nothing of the admin page leaked into the 404
    const html = await r.res.text()
    expect(html).not.toMatch(/Danh sách người dùng|Thêm người dùng|Giữ nhật ký|Bắt buộc 2FA/)
  }
})

test("/logs?tab=staff: nhân viên chỉ nhận tab MCP (không có dữ liệu nhật ký nhân sự)", async () => {
  await setPolicy({ admin: false, all: false })
  const asStaff = await visit(staff, "/logs?tab=staff")
  expect(asStaff.status).toBe(200)
  const html = await asStaff.res.text()
  expect(html).not.toMatch(/Nhật ký nhân sự/)
  const asAdmin = await visit(admin, "/logs?tab=staff")
  expect(asAdmin.status).toBe(200)
  expect(await asAdmin.res.text()).toMatch(/Nhật ký nhân sự/)
})

// ---------------------------------------------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------------------------------------------
test("/api/health: công khai, chỉ {ok:true}, không lộ phiên bản", async () => {
  for (const a of [anon, staff, banned]) {
    const r = await a.ctx.get("/api/health")
    expect(r.status()).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(r.headers()["cache-control"]).toContain("no-store")
    expect(r.headers()["x-powered-by"]).toBeUndefined()
  }
})

test("/mcp/<key>: key sai → 404 (không bao giờ 401), mọi phương thức, kể cả có cookie quản trị", async () => {
  const key = `amcp_${randomBytes(32).toString("base64url")}`
  for (const a of [anon, admin2fa]) {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const r = await a.ctx.fetch(`/mcp/${key}`, {
        method,
        data: method === "POST" ? { jsonrpc: "2.0", id: 1, method: "tools/list" } : undefined,
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      })
      expect(r.status(), `${a.key} ${method}`).toBe(404)
    }
  }
  const r = await anon.ctx.get(`/mcp/${key}`)
  expect(r.headers()["referrer-policy"]).toBe("no-referrer")
})

test("/api/auth/*: chỉ sign-in, 2FA verify, sign-out, get-session, ok; mọi endpoint khác (kể cả admin/*) trả 404", async () => {
  const blocked: [string, string][] = [
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/revoke-other-sessions"],
    ["GET", "/api/auth/list-sessions"],
    ["GET", "/api/auth/list-accounts"],
    ["POST", "/api/auth/two-factor/enable"],
    ["POST", "/api/auth/two-factor/disable"],
    ["POST", "/api/auth/two-factor/generate-backup-codes"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/admin/list-users"],
    ["POST", "/api/auth/admin/set-role"],
    ["POST", "/api/auth/admin/impersonate-user"],
    ["POST", "/api/auth/admin/create-user"],
  ]
  for (const a of [anon, staff, admin2fa]) {
    for (const [method, path] of blocked) {
      const r = await a.ctx.fetch(path, { method, data: method === "POST" ? {} : undefined })
      expect(r.status(), `${a.key} ${method} ${path}`).toBe(404)
    }
  }
  // what the browser needs keeps working
  expect((await anon.ctx.get("/api/auth/ok")).status()).toBe(200)
  expect((await staff.ctx.get("/api/auth/get-session")).status()).toBe(200)
  const anonSession = await anon.ctx.get("/api/auth/get-session")
  expect(anonSession.status()).toBe(200)
  expect(await anonSession.json()).toBeNull()
})

test("đăng nhập: cookie HttpOnly + SameSite=Lax, header bảo mật, không phân biệt email lạ với mật khẩu sai", async () => {
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } })
  const ok = await ctx.post("/api/auth/sign-in/email", { data: { email: staff.email, password: PASSWORD }, headers: { "x-forwarded-for": nextIp() } })
  expect(ok.status()).toBe(200)
  const cookie = ok.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).find((v) => /session_token/.test(v))!
  expect(cookie).toMatch(/HttpOnly/i)
  expect(cookie).toMatch(/SameSite=Lax/i)
  expect(cookie).toMatch(/Path=\//)
  expect(cookie).toMatch(/Max-Age=\d+/)

  const wrong = await ctx.post("/api/auth/sign-in/email", { data: { email: staff.email, password: "sai-sai-sai-1" }, headers: { "x-forwarded-for": nextIp() } })
  const unknown = await ctx.post("/api/auth/sign-in/email", { data: { email: `nobody.${RUN}@example.test`, password: "sai-sai-sai-1" }, headers: { "x-forwarded-for": nextIp() } })
  expect(wrong.status()).toBe(401)
  expect(unknown.status()).toBe(401)
  expect(await unknown.json()).toEqual(await wrong.json())

  const page = await staff.ctx.get("/account")
  const h = page.headers()
  expect(h["x-frame-options"]).toBe("DENY")
  expect(h["x-content-type-options"]).toBe("nosniff")
  expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/)
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin")
  expect(h["x-powered-by"]).toBeUndefined()
  await ctx.dispose()
})

test("CSRF: đăng xuất từ Origin lạ bị từ chối khi có cookie phiên; Origin đúng thì được", async () => {
  const ctx = await pwRequest.newContext({ baseURL: BASE })
  const ip = nextIp()
  const login = await ctx.post("/api/auth/sign-in/email", { data: { email: staff.email, password: PASSWORD }, headers: { origin: BASE, "x-forwarded-for": ip } })
  expect(login.status()).toBe(200)
  const evil = await ctx.post("/api/auth/sign-out", { data: {}, headers: { origin: "https://evil.example", "x-forwarded-for": ip } })
  expect(evil.status()).toBe(403)
  const noOrigin = await ctx.post("/api/auth/sign-out", { data: {}, headers: { "x-forwarded-for": ip } })
  expect(noOrigin.status()).toBe(403)
  expect((await ctx.get("/api/auth/get-session")).status()).toBe(200) // still signed in
  const fine = await ctx.post("/api/auth/sign-out", { data: {}, headers: { origin: BASE, "x-forwarded-for": ip } })
  expect(fine.status()).toBe(200)
  await ctx.dispose()
})

test("Server Action từ Origin lạ bị Next từ chối", async () => {
  const r = await staff.ctx.post("/account", {
    headers: { "next-action": "0".repeat(40), origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" },
    data: "[]",
  })
  expect(r.status()).toBeGreaterThanOrEqual(400)
})

// ---------------------------------------------------------------------------------------------------------------
// /api/logs/export
// ---------------------------------------------------------------------------------------------------------------
test("/api/logs/export: ẩn danh/khoá/hết hạn bị chặn, Origin lạ 403, GET 405, tab nhân sự chỉ admin, nhân viên chỉ xuất MCP của mình", async () => {
  await setPolicy({ admin: false, all: false })
  const post = (a: Actor, search: string, headers: Record<string, string> = {}) =>
    a.ctx.post("/api/logs/export", { data: { search }, headers: { origin: BASE, ...headers }, maxRedirects: 0 })

  // anonymous: the proxy sends it to /login before the route even runs
  expect((await post(anon, "")).status()).toBe(307)
  for (const a of [banned, expired]) expect((await post(a, "")).status(), a.key).toBe(401)
  expect((await post(staffMustChange, "")).status()).toBe(401)
  expect((await staff.ctx.get("/api/logs/export")).status()).toBe(405)

  expect((await post(staff, "", { origin: "https://evil.example" })).status()).toBe(403)
  expect((await post(staff, "", { "sec-fetch-site": "cross-site" })).status()).toBe(403)

  expect((await post(staff, "tab=staff")).status()).toBe(403)
  const own = await post(staff, "")
  expect(own.status()).toBe(200)
  expect(own.headers()["content-type"]).toContain("text/csv")
  expect(own.headers()["content-disposition"]).toContain("attachment")
  const adminStaffTab = await post(admin2fa, "tab=staff")
  expect(adminStaffTab.status()).toBe(200)
  // the export is a log of actions: it never carries a password or a credential (action CODES such as
  // auth.password.change are fine, so look for values, not words)
  const csv = await adminStaffTab.text()
  expect(csv).not.toContain(PASSWORD)
  expect(csv).not.toMatch(/Bearer\s|EAA[A-Za-z0-9]{20,}|amcp_[A-Za-z0-9_-]{20,}|-----BEGIN/)
})
