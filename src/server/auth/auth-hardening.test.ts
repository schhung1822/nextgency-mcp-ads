// Integration tests of the real Better Auth instance (hooks + config) against the dev Postgres
// (skipped when DATABASE_URL is absent): admin endpoints over HTTP, headerless createUser, user-create flags,
// password-step lockout for 2FA vs password-only accounts.
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
})
vi.mock("server-only", () => ({}))

import { eq, inArray, like } from "drizzle-orm"

import { db } from "@/server/db/client"
import { activityLogs, user, verification } from "@/server/db/schema"

import { getAuth } from "./auth"
import { ADMIN_ENDPOINT_PATHS } from "./guards"
import { clearLoginFailures, LOCKOUT_EMAIL_MAX_FAILURES, LOCKOUT_MAX_FAILURES, lockoutKey, recordLoginFailure } from "./lockout"
import { runWithUserCreateContext } from "./user-create-context"

const hasDb = !!process.env.DATABASE_URL
const P = `tauth_${randomUUID().slice(0, 8)}`
const PASSWORD = "Correct-Horse-Battery-9"
const created: string[] = []
const emails = {
  plain: `${P}_plain@example.test`,
  twofa: `${P}_2fa@example.test`,
  flags: `${P}_flags@example.test`,
  untrusted: `${P}_untrusted@example.test`,
}

function base(): string {
  return (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

/** Random TEST-NET-3 address so Better Auth's per-IP rate limit (stored in DB) never interferes. */
function randomIp(): string {
  return `203.0.113.${1 + (randomBytes(1)[0]! % 250)}`
}

async function signIn(email: string, password: string, ip: string): Promise<Response> {
  return getAuth().handler(
    new Request(`${base()}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base(), "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    })
  )
}

async function createTrusted(email: string, ctx: Parameters<typeof runWithUserCreateContext>[0]) {
  const r = await runWithUserCreateContext(ctx, () =>
    getAuth().api.createUser({ body: { email, password: PASSWORD, name: P, role: "staff" } })
  )
  created.push(r.user.id)
  return r.user.id
}

describe.skipIf(!hasDb)("Better Auth hardening (DB)", () => {
  beforeAll(async () => {
    // make sure the user table is not empty (a headerless createUser is allowed on an empty DB)
    await createTrusted(emails.plain, { kind: "dev-seed", mustChangePassword: false })
    const id2 = await createTrusted(emails.twofa, { kind: "dev-seed", mustChangePassword: false })
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, id2))
  })

  afterAll(async () => {
    if (!hasDb) return
    for (const e of Object.values(emails)) await clearLoginFailures(e).catch(() => {})
    if (created.length) {
      await db.delete(activityLogs).where(inArray(activityLogs.actorId, created))
      await db.delete(user).where(inArray(user.id, created))
    }
    await db.delete(activityLogs).where(like(activityLogs.targetLabel, `${P}%`))
  })

  it("every /api/auth/admin/* endpoint answers 404 over HTTP", async () => {
    for (const path of ADMIN_ENDPOINT_PATHS) {
      for (const method of ["GET", "POST"] as const) {
        const res = await getAuth().handler(
          new Request(`${base()}/api/auth${path}`, {
            method,
            headers: { "content-type": "application/json", origin: base(), "x-forwarded-for": randomIp() },
            ...(method === "POST" ? { body: JSON.stringify({ userId: "x", role: "admin" }) } : {}),
          })
        )
        expect(res.status, `${method} ${path}`).toBe(404)
      }
    }
  })

  it("the before-hook also rejects an admin endpoint invoked with a Request (second layer)", async () => {
    await expect(
      getAuth().api.listUsers({
        query: {},
        request: new Request(`${base()}/api/auth/admin/list-users`, { headers: { origin: base() } }),
      })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it("headerless createUser is refused unless server code marks it trusted", async () => {
    await expect(
      getAuth().api.createUser({ body: { email: emails.untrusted, password: PASSWORD, name: P, role: "admin" } })
    ).rejects.toMatchObject({ body: { code: "UNAUTHORIZED" } })
    expect(await db.select().from(user).where(eq(user.email, emails.untrusted))).toHaveLength(0)
    // kind "admin" is not a headerless kind (admins call with their request headers)
    await expect(
      runWithUserCreateContext({ kind: "admin", createdById: "x", mustChangePassword: true }, () =>
        getAuth().api.createUser({ body: { email: emails.untrusted, password: PASSWORD, name: P, role: "staff" } })
      )
    ).rejects.toMatchObject({ body: { code: "UNAUTHORIZED" } })
  })

  it("mustChangePassword / createdById are written by the INSERT itself (no unflagged window)", async () => {
    const creator = created[0]!
    const id = await createTrusted(emails.flags, { kind: "dev-seed", createdById: creator, mustChangePassword: true })
    const [row] = await db.select().from(user).where(eq(user.id, id))
    expect(row!.mustChangePassword).toBe(true)
    expect(row!.createdById).toBe(creator)
  })

  it("password-only account: ONE attacker IP cannot lock the owner out (owner = unknown IP still signs in)", async () => {
    const attackerIp = randomIp()
    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await recordLoginFailure(emails.plain, attackerIp)
    // the attacker's IP is locked out of this email…
    expect((await signIn(emails.plain, PASSWORD, attackerIp)).status).toBe(429)
    // …but the owner (another IP) is not: 10 failures from one IP stay far below the account-wide threshold
    let ownerIp = randomIp()
    while (ownerIp === attackerIp) ownerIp = randomIp()
    expect((await signIn(emails.plain, PASSWORD, ownerIp)).status).toBe(200)
    await clearLoginFailures(emails.plain)
  })

  it("password-only account: distributed guessing triggers the account-wide lock, except for an IP that signed in recently", async () => {
    const knownIp = randomIp()
    const ok = await signIn(emails.plain, PASSWORD, knownIp) // success is logged with this IP (known IP)
    expect(ok.status).toBe(200)
    // many different IPs fail → account-wide counter reaches its threshold
    for (let i = 0; i < LOCKOUT_EMAIL_MAX_FAILURES; i++) await recordLoginFailure(emails.plain, `198.51.100.${(i % 200) + 1}`)
    // a brand-new IP is refused (distributed attack suspected)…
    const stranger = await signIn(emails.plain, PASSWORD, randomIp())
    expect(stranger.status).toBe(429)
    expect(((await stranger.json()) as { code?: string }).code).toBe("ACCOUNT_LOCKED")
    // …but the owner's usual IP always gets through
    expect((await signIn(emails.plain, PASSWORD, knownIp)).status).toBe(200)
    await clearLoginFailures(emails.plain)
  })

  it("2FA account: an attacker cannot lock the owner out; the attacker's IP stays locked", async () => {
    const attackerIp = randomIp()
    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await recordLoginFailure(emails.twofa, attackerIp)
    // attacker (same IP) - even with the right password - is refused
    const blocked = await signIn(emails.twofa, PASSWORD, attackerIp)
    expect(blocked.status).toBe(429)
    // owner from another IP: password accepted → 2FA challenge (not a session)
    let ownerIp = randomIp()
    while (ownerIp === attackerIp) ownerIp = randomIp()
    const ok = await signIn(emails.twofa, PASSWORD, ownerIp)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)
    // a correct password clears the counters (all IPs)
    expect(
      await db.select().from(verification).where(like(verification.id, `${lockoutKey(emails.twofa)}%`))
    ).toHaveLength(0)
  })

  it("clearLoginFailures (CLI unlock) removes the email and every per-IP counter", async () => {
    await recordLoginFailure(emails.plain, randomIp())
    await recordLoginFailure(emails.plain, randomIp())
    expect(await clearLoginFailures(emails.plain)).toBeGreaterThanOrEqual(3)
    expect(
      await db.select().from(verification).where(like(verification.id, `${lockoutKey(emails.plain)}%`))
    ).toHaveLength(0)
  })
})
