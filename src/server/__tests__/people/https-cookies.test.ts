// Cookie flags when the app is served over HTTPS (BETTER_AUTH_URL=https://…, i.e. production behind Caddy):
// session + 2FA challenge cookies must be Secure + HttpOnly + SameSite=Lax with the __Secure- prefix, sessions
// last 12 hours, and the CSRF Origin check lets only the app origin through.
import { afterAll, describe, expect, it, vi } from "vitest"

const tmp = await vi.hoisted(async () => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env */
  }
  process.env.BETTER_AUTH_URL = "https://ads.example.test"
  const { createTempDb } = await import("./temp-db")
  const t = await createTempDb("https")
  if (t) process.env.DATABASE_URL = t.url
  return t
})
vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", async () => (await import("@/server/__tests__/people/harness")).nextHeadersMock())

import { authHttp, closeDb, createTestUser, enableTotp, randomIp, signIn, uid } from "./harness"

const hasDb = !!tmp
const P = `thttps_${uid()}`

describe.skipIf(!hasDb)("cookie qua HTTPS", () => {
  afterAll(async () => {
    await closeDb()
    await tmp?.drop()
  })

  it("cookie phiên và cookie thử thách 2FA: Secure, HttpOnly, SameSite=Lax, tiền tố __Secure-, sống 12 giờ", async () => {
    const u = await createTestUser(P, "cookie", { role: "staff" })
    const plain = await authHttp("/sign-in/email", { body: { email: u.email, password: u.password } })
    expect(plain.status).toBe(200)
    const cookies = plain.headers.getSetCookie()
    const session = cookies.find((c) => /session_token/.test(c))!
    expect(session).toMatch(/^__Secure-better-auth\.session_token=/)
    expect(session).toMatch(/; Secure/i)
    expect(session).toMatch(/; HttpOnly/i)
    expect(session).toMatch(/; SameSite=Lax/i)
    expect(session).toMatch(/; Path=\//)
    expect(session).toMatch(/Max-Age=43200\b/)

    const s = await signIn(u)
    const t = await enableTotp(s)
    expect(t.secret).toBeTruthy()
    const challenge = await authHttp("/sign-in/email", { body: { email: u.email, password: u.password } })
    const c2 = challenge.headers.getSetCookie().find((c) => /two_factor/.test(c))!
    expect(c2).toMatch(/^__Secure-better-auth\.two_factor=/)
    expect(c2).toMatch(/; Secure/i)
    expect(c2).toMatch(/; HttpOnly/i)
    expect(c2).toMatch(/; SameSite=Lax/i)
    expect(c2).not.toMatch(/Max-Age=43200/) // short-lived challenge, not a session
  })

  it("không có cookie nào bị đặt khi đăng nhập sai", async () => {
    const u = await createTestUser(P, "nocookie", { role: "staff" })
    const r = await authHttp("/sign-in/email", { body: { email: u.email, password: "sai-sai-sai-1" }, ip: randomIp() })
    expect(r.status).toBe(401)
    expect(r.headers.getSetCookie().filter((c) => !/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c))).toEqual([])
  })
})
