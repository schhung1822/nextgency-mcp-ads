// Shared helpers for the "people" integration tests (users / roles / auth flows / staff isolation).
// They run the REAL Better Auth instance + Drizzle against the dev/test Postgres (DATABASE_URL) and only fake
// the Next request context: `next/headers` `headers()` returns `requestState.headers`, so server actions,
// `requireUser()` and the users service see a real signed-in session (cookie) - or none.
//
// A test file must register the mocks BEFORE importing app code:
//   vi.mock("server-only", () => ({}))
//   vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
//   vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())
//
// Not a test file itself (no `.test.ts` suffix) → never collected by vitest.
import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { and, eq, inArray, like, or } from "drizzle-orm"
import { vi } from "vitest"

import { getAuth } from "@/server/auth/auth"
import { runWithUserCreateContext } from "@/server/auth/user-create-context"
import { db } from "@/server/db/client"
import { activityLogs, appSettings, session as sessionTable, user, verification } from "@/server/db/schema"

// Creating a user / signing in hashes with scrypt: under the load of the whole parallel suite the default 10 s hook
// timeout is not enough for a `beforeAll` that creates a handful of users.
vi.setConfig({ hookTimeout: 90_000, testTimeout: 90_000 })

export const PASSWORD = "Correct-Horse-Battery-9"

export function baseUrl(): string {
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

/** A random private address so Better Auth's per-IP rate limit (stored in the DB) never interferes. */
export function randomIp(): string {
  const b = randomBytes(3)
  return `10.${b[0]}.${b[1]}.${1 + (b[2]! % 250)}`
}

// ---------------------------------------------------------------------------
// Fake Next request context
// ---------------------------------------------------------------------------

export const requestState: { headers: Headers } = { headers: new Headers() }

/** Per-call request context (concurrent "requests"): `runAs(session, fn)` wins over `requestState`. */
const requestScope = new AsyncLocalStorage<Headers>()
const currentHeaders = () => requestScope.getStore() ?? requestState.headers

/** Run `fn` as a separate request of `s` (null = anonymous) - safe to run several at once with Promise.all. */
export function runAs<T>(s: { headers: Headers } | null, fn: () => Promise<T>): Promise<T> {
  return requestScope.run(s ? s.headers : anonymousHeaders(), fn)
}

/** Factory for `vi.mock("next/headers", …)`. */
export function nextHeadersMock() {
  return {
    headers: async () => currentHeaders(),
    cookies: async () => ({
      get: (name: string) => {
        const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(currentHeaders().get("cookie") ?? "")
        return m ? { name, value: m[1] } : undefined
      },
      // Better Auth's nextCookies() plugin writes Set-Cookie through these; tests read them off the Response.
      set: () => undefined,
      delete: () => undefined,
    }),
  }
}

export function anonymousHeaders(ip = randomIp(), extra: Record<string, string> = {}): Headers {
  return new Headers({ origin: baseUrl(), "x-forwarded-for": ip, "user-agent": "vitest/people", ...extra })
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string
  email: string
  password: string
  role: "admin" | "staff"
  name: string
}

export interface CreateOpts {
  role: "admin" | "staff"
  mustChangePassword?: boolean
  twoFactorEnabled?: boolean
  banned?: boolean
  createdById?: string | null
  password?: string
}

/** Creates a user through Better Auth (real scrypt hash) using the trusted headerless dev-seed context. */
export async function createTestUser(prefix: string, label: string, opts: CreateOpts): Promise<TestUser> {
  const email = `${prefix}_${label}@example.test`.toLowerCase()
  const password = opts.password ?? PASSWORD
  const name = `${prefix} ${label}`
  const r = await runWithUserCreateContext(
    { kind: "dev-seed", mustChangePassword: !!opts.mustChangePassword, createdById: opts.createdById ?? null },
    () => getAuth().api.createUser({ body: { email, password, name, role: opts.role } })
  )
  const patch: Partial<typeof user.$inferInsert> = { emailVerified: true }
  if (opts.twoFactorEnabled) patch.twoFactorEnabled = true
  if (opts.banned) patch.banned = true
  await db.update(user).set(patch).where(eq(user.id, r.user.id))
  return { id: r.user.id, email, password, role: opts.role, name }
}

export interface Signed {
  user: TestUser
  cookie: string
  ip: string
  /** request headers carrying the session cookie (what Next's `headers()` would return) */
  headers: Headers
  sessionId: string
}

export function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ")
}

function authRequest(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string }) {
  return new Request(`${baseUrl()}/api/auth${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl(),
      "x-forwarded-for": init.ip ?? randomIp(),
      "user-agent": "vitest/people",
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

/** HTTP-level call into Better Auth (same path as the browser: sign-in, 2FA verify…). */
export function authHttp(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}): Promise<Response> {
  return getAuth().handler(authRequest(path, init))
}

async function latestSessionId(userId: string): Promise<string> {
  const rows = await db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.userId, userId))
  const last = rows[rows.length - 1]
  if (!last) throw new Error("no session row for user")
  return last.id
}

/** Password sign-in over the Better Auth HTTP handler. Throws unless it yields a session. */
export async function signIn(u: TestUser, ip = randomIp(), password = u.password): Promise<Signed> {
  const res = await authHttp("/sign-in/email", { body: { email: u.email, password }, ip })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`sign-in ${u.email} -> ${res.status} ${text}`)
  if ((JSON.parse(text) as { twoFactorRedirect?: boolean }).twoFactorRedirect) throw new Error("sign-in needs a 2FA code")
  const cookie = cookieOf(res)
  return {
    user: u,
    cookie,
    ip,
    headers: anonymousHeaders(ip, { cookie }),
    sessionId: await latestSessionId(u.id),
  }
}

/** Point `headers()` / `getSession()` at this session (null → anonymous). */
export function actAs(s: Signed | null, ip = randomIp()): void {
  requestState.headers = s ? s.headers : anonymousHeaders(ip)
}

/** Cookie header for an already-signed session with another IP/user agent (a second device). */
export async function signInAgain(u: TestUser): Promise<Signed> {
  return signIn(u)
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s - the Better Auth twoFactor configuration)
// ---------------------------------------------------------------------------

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

export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 1_000_000).padStart(6, "0")
}

/** Codes of the previous/current/next time step: used once each by tests to avoid waiting 30 s. */
export function totpWindow(secret: string, now = Date.now()): string[] {
  return [totp(secret, now), totp(secret, now + 30_000), totp(secret, now - 30_000)]
}

/**
 * Turn real TOTP 2FA on for a signed-in user (password → secret → first code). Better Auth ROTATES the session
 * when 2FA gets enabled (old cookie dies), so the fresh session is returned as `signed`.
 */
export async function enableTotp(s: Signed): Promise<{ secret: string; backupCodes: string[]; usedCode: string; signed: Signed }> {
  const r = await getAuth().api.enableTwoFactor({ body: { password: s.user.password }, headers: s.headers })
  if (!("totpURI" in r)) throw new Error("two-factor enable did not return a TOTP secret")
  const secret = new URL(r.totpURI).searchParams.get("secret")!
  const usedCode = totp(secret)
  const res = await getAuth().api.verifyTOTP({ body: { code: usedCode }, headers: s.headers, asResponse: true })
  if (res.status !== 200) throw new Error(`verify-totp (enrol) -> ${res.status}`)
  const cookie = cookieOf(res)
  const signed: Signed = {
    ...s,
    cookie,
    headers: anonymousHeaders(s.ip, { cookie }),
    sessionId: await latestSessionId(s.user.id),
  }
  return { secret, backupCodes: r.backupCodes ?? [], usedCode, signed }
}

/** Sign-in for an account with TOTP 2FA: password step, then the code. */
export async function signInWithTotp(u: TestUser, secret: string, offsetMs = 0, ip = randomIp()): Promise<Signed> {
  const first = await authHttp("/sign-in/email", { body: { email: u.email, password: u.password }, ip })
  const body = (await first.json()) as { twoFactorRedirect?: boolean }
  if (!body.twoFactorRedirect) throw new Error("expected a 2FA challenge")
  const challenge = cookieOf(first)
  const v = await authHttp("/two-factor/verify-totp", { body: { code: totp(secret, Date.now() + offsetMs) }, headers: { cookie: challenge }, ip })
  if (v.status !== 200) throw new Error(`verify-totp -> ${v.status}`)
  const cookie = cookieOf(v)
  return { user: u, cookie, ip, headers: anonymousHeaders(ip, { cookie }), sessionId: await latestSessionId(u.id) }
}

// ---------------------------------------------------------------------------
// Settings + cleanup
// ---------------------------------------------------------------------------

const SETTING_KEYS = ["log_retention_months_mcp", "log_retention_months_staff", "require_2fa_admin", "require_2fa_all", "session_max_hours"]

/** Snapshot of the policy settings; `restore()` puts the original rows back. */
export async function snapshotSettings(): Promise<{ restore: () => Promise<void> }> {
  const original = await db.select().from(appSettings).where(inArray(appSettings.key, SETTING_KEYS))
  return {
    restore: async () => {
      await db.delete(appSettings).where(inArray(appSettings.key, SETTING_KEYS))
      if (original.length) await db.insert(appSettings).values(original)
    },
  }
}

export async function setSettingRaw(key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } })
}

/** Remove every row a test created: users (cascades sessions/accounts/2FA), logs, lockout / quota counters. */
export async function cleanup(prefix: string): Promise<void> {
  const ids = (await db.select({ id: user.id }).from(user).where(like(user.email, `${prefix}%`))).map((r) => r.id)
  await db.delete(activityLogs).where(
    or(
      like(activityLogs.actorEmail, `${prefix}%`),
      like(activityLogs.targetLabel, `${prefix}%`),
      ids.length ? inArray(activityLogs.actorId, ids) : undefined,
      ids.length ? inArray(activityLogs.targetId, ids) : undefined
    )
  )
  if (ids.length) {
    await db
      .delete(verification)
      .where(and(like(verification.identifier, "trust-device-%"), inArray(verification.value, ids)))
    await db.delete(user).where(inArray(user.id, ids))
  }
}

export async function closeDb(): Promise<void> {
  const { pool } = await import("@/server/db/client")
  await pool().end()
  ;(globalThis as Record<string, unknown>).__adsMcpPool = undefined
  ;(globalThis as Record<string, unknown>).__adsMcpDb = undefined
}

export const uid = () => randomUUID().slice(0, 8)
