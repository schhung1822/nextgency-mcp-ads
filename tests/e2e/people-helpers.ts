// Shared helpers of the people / authorization e2e specs: seed users straight into the throw-away <db>_e2e
// database (scrypt hash via better-auth/crypto, TOTP secret encrypted with BETTER_AUTH_SECRET), flip policy
// settings, sign in over the Better Auth HTTP API, compute TOTP codes.
import { createHmac, randomBytes } from "node:crypto"
import { expect, type APIRequestContext } from "@playwright/test"
import { hashPassword, symmetricEncrypt } from "better-auth/crypto"
import pg from "pg"

export const BASE = `http://localhost:${process.env.E2E_PORT ?? 3101}`
export const PASSWORD = "Matrix-Pass-2026!"
/** Better Auth's TOTP key = the ASCII bytes of this string (the QR shows its base32 form). */
export const TOTP_SECRET_STRING = "matrixmatrixmatrixmatrix12345678"
export const RUN = randomBytes(3).toString("hex")

/** RFC 6238 (SHA-1, 30 s, 6 digits) for the seeded secret; ±1 step is accepted by the server. */
export function totp(at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac("sha1", Buffer.from(TOTP_SECRET_STRING)).update(counter).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 1_000_000).padStart(6, "0")
}

export async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

export interface Policy {
  admin: boolean
  all: boolean
}

export async function setPolicy(p: Policy): Promise<void> {
  await db(async (c) => {
    for (const [k, v] of [
      ["require_2fa_admin", p.admin],
      ["require_2fa_all", p.all],
    ] as const) {
      await c.query(
        "insert into app_settings(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value",
        [k, JSON.stringify(v)]
      )
    }
  })
}

let ipCounter = 0
/** A fresh client IP per sign-in: Better Auth allows 5 sign-ins / 60 s per IP and these suites sign in a lot. */
export function nextIp(): string {
  ipCounter++
  return `10.${(Number.parseInt(RUN, 16) % 200) + 20}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

export interface SeedSpec {
  key: string
  role: "admin" | "staff"
  mustChange?: boolean
  twoFactor?: boolean
}

export async function seedUser(a: SeedSpec): Promise<{ id: string; email: string }> {
  const id = randomBytes(16).toString("hex")
  const email = `${a.key}.${RUN}@example.test`
  const hash = await hashPassword(PASSWORD)
  await db(async (c) => {
    await c.query(
      `insert into "user"(id, name, email, email_verified, role, banned, two_factor_enabled, must_change_password, created_at, updated_at)
       values ($1, $2, $3, true, $4, false, $5, $6, now(), now())`,
      [id, `Ma trận ${a.key}`, email, a.role, !!a.twoFactor, !!a.mustChange]
    )
    await c.query(
      `insert into account(id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomBytes(16).toString("hex"), id, hash]
    )
    if (a.twoFactor) {
      const secret = process.env.BETTER_AUTH_SECRET!
      await c.query("insert into two_factor(id, secret, backup_codes, user_id, verified) values ($1, $2, $3, $4, true)", [
        randomBytes(16).toString("hex"),
        await symmetricEncrypt({ key: secret, data: TOTP_SECRET_STRING }),
        await symmetricEncrypt({ key: secret, data: JSON.stringify(["aaaaa-bbbbb"]) }),
        id,
      ])
    }
  })
  return { id, email }
}

/** Password sign-in (+ TOTP when the account has 2FA) over the Better Auth HTTP API; cookies stay in `ctx`. */
export async function signInApi(ctx: APIRequestContext, email: string, twoFactor: boolean): Promise<void> {
  const ip = nextIp()
  const res = await ctx.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD }, headers: { "x-forwarded-for": ip } })
  expect(res.status(), `sign-in ${email}`).toBe(200)
  if (twoFactor) {
    expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)
    const v = await ctx.post("/api/auth/two-factor/verify-totp", { data: { code: totp() }, headers: { "x-forwarded-for": ip } })
    expect(v.status(), `2FA ${email}`).toBe(200)
  }
}
