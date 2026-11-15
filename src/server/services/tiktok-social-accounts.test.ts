// TikTok Social connect service (17-tiktok-social.md §3-§5; DB, skipped without DATABASE_URL): OAuth state checks,
// one live row per TikTok username (TSD1: same owner / admin → tokens replaced; another staff → refused), reconnect of
// the wrong account, visibility, delete (secret erased, token revoked). TikTok faked at fetch level.
import { randomUUID } from "node:crypto"

import { and, eq, inArray, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) */
  }
})
vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { activityLogs, tiktokSocialAccounts, tiktokSocialClients, user } from "@/server/db/schema"
import { __setTiktokSocialFetch } from "@/server/tiktok-social/api"
import { decryptTiktokSocialTokens } from "@/server/tiktok-social/store"

import {
  beginTiktokSocialConnect,
  completeTiktokSocialConnect,
  deleteTiktokSocialAccount,
  listTiktokSocialAccounts,
  type TtsActor,
} from "./tiktok-social-accounts"

const hasDb = !!process.env.DATABASE_URL
const P = `ttsx${randomUUID().slice(0, 6)}`
const staff: TtsActor = { id: `${P}_staff`, email: `${P}_staff@example.test`, role: "staff" }
const staff2: TtsActor = { id: `${P}_staff2`, email: `${P}_staff2@example.test`, role: "staff" }
const admin: TtsActor = { id: `${P}_admin`, email: `${P}_admin@example.test`, role: "admin" }

/** the TikTok account the next sign-in "is" */
let signedInAs = `${P}one`
let issued = 0
const revoked: string[] = []

describe.skipIf(!hasDb)("TikTok Social connect service", () => {
  beforeAll(async () => {
    await db.insert(user).values([staff, staff2, admin].map((u) => ({ id: u.id, name: u.id, email: u.email, emailVerified: true, role: u.role })))
    __setTiktokSocialFetch(async (url, init) => {
      const ok = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } })
      if (url.endsWith("/register")) return ok({ client_id: `client_${P}_abcdefgh` })
      if (url.endsWith("/token")) {
        issued++
        return ok({ access_token: `AT${issued}`, refresh_token: `RT${issued}`, expires_in: 86400, refresh_token_expires_in: 31536000, scope: "user.info.basic video.list" })
      }
      if (url.endsWith("/revoke")) {
        revoked.push(new URLSearchParams(String(init.body)).get("token") ?? "")
        return ok({})
      }
      const api = { code: 0, data: { username: signedInAs, display_name: "Shop Test", is_business_account: true } }
      return ok({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(api) }] } })
    })
  })

  afterEach(() => {
    signedInAs = `${P}one`
  })

  afterAll(async () => {
    __setTiktokSocialFetch(null)
    if (!hasDb) return
    const owners = [staff.id, staff2.id, admin.id]
    await db.delete(tiktokSocialAccounts).where(inArray(tiktokSocialAccounts.ownerId, owners))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
    await db.delete(user).where(inArray(user.id, owners))
  })

  /** begin + complete like the browser would (state from the URL, blob from the cookie) */
  async function connect(actor: TtsActor, o: { reconnectId?: string; state?: string; error?: string } = {}) {
    const b = await beginTiktokSocialConnect(actor, { reconnectId: o.reconnectId })
    const state = new URL(b.url).searchParams.get("state")!
    return completeTiktokSocialConnect(actor, { code: "CODE", state: o.state ?? state, error: o.error, stateBlob: b.stateBlob })
  }

  it("registers the client once per redirect URI and builds a PKCE authorize URL", async () => {
    const b = await beginTiktokSocialConnect(staff, {})
    const u = new URL(b.url)
    // the client of this redirect URI may come from an earlier run (rows are kept): the URL uses the stored one
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/api\/tiktok-social\/callback$/)
    expect(b.stateBlob).not.toContain(u.searchParams.get("state")!)
    const rows = await db.select().from(tiktokSocialClients).where(eq(tiktokSocialClients.redirectUri, u.searchParams.get("redirect_uri")!))
    expect(rows).toHaveLength(1)
    expect(u.searchParams.get("client_id")).toBe(rows[0]!.clientId)
  })

  it("refuses a wrong state, another user's blob, a denied consent", async () => {
    await expect(connect(staff, { state: "forged" })).rejects.toMatchObject({ reason: "state" })
    const b = await beginTiktokSocialConnect(staff, {})
    const state = new URL(b.url).searchParams.get("state")!
    await expect(completeTiktokSocialConnect(staff2, { code: "C", state, stateBlob: b.stateBlob })).rejects.toMatchObject({ reason: "state" })
    await expect(connect(staff, { error: "access_denied" })).rejects.toMatchObject({ reason: "denied" })
  })

  it("connects, then the same account again replaces the tokens (one row); another staff is refused", async () => {
    const first = await connect(staff)
    expect(first).toMatchObject({ username: `${P}one`, reconnected: false })
    const second = await connect(staff)
    expect(second).toEqual({ id: first.id, username: `${P}one`, reconnected: true })
    const rows = await db
      .select()
      .from(tiktokSocialAccounts)
      .where(and(eq(tiktokSocialAccounts.username, `${P}one`), isNull(tiktokSocialAccounts.deletedAt)))
    expect(rows).toHaveLength(1)
    expect(decryptTiktokSocialTokens(rows[0]!).accessToken).toBe(`AT${issued}`)
    expect(rows[0]).toMatchObject({ ownerId: staff.id, isBusinessAccount: true, displayName: "Shop Test", status: "active" })
    await expect(connect(staff2)).rejects.toMatchObject({ reason: "duplicate" })
    // an admin may sign the same account in again (tokens of the existing row)
    await expect(connect(admin)).resolves.toMatchObject({ id: first.id, reconnected: true })
    // visibility: staff2 does not see it, admin does (with the owner e-mail)
    expect((await listTiktokSocialAccounts(staff2)).some((a) => a.id === first.id)).toBe(false)
    expect((await listTiktokSocialAccounts(admin)).find((a) => a.id === first.id)).toMatchObject({ ownerEmail: staff.email })
  })

  it("reconnect with another TikTok account is refused (names both handles)", async () => {
    signedInAs = `${P}two`
    const two = await connect(staff)
    signedInAs = `${P}three`
    await expect(connect(staff, { reconnectId: two.id })).rejects.toMatchObject({ reason: "wrong", fieldErrors: { expected: `${P}two`, got: `${P}three` } })
  })

  it("delete: secret erased, refresh token revoked at TikTok, the username can be connected again", async () => {
    signedInAs = `${P}four`
    const four = await connect(staff)
    const [row] = await db.select().from(tiktokSocialAccounts).where(eq(tiktokSocialAccounts.id, four.id))
    const rt = decryptTiktokSocialTokens(row!).refreshToken
    await expect(deleteTiktokSocialAccount(staff, { id: four.id, confirmName: "nope" })).rejects.toMatchObject({ fieldErrors: { confirmName: expect.any(String) } })
    await deleteTiktokSocialAccount(staff, { id: four.id, confirmName: row!.name })
    const [gone] = await db.select().from(tiktokSocialAccounts).where(eq(tiktokSocialAccounts.id, four.id))
    expect(gone!.deletedAt).not.toBeNull()
    expect(() => decryptTiktokSocialTokens(gone!)).toThrow()
    expect(revoked).toContain(rt)
    await expect(connect(staff)).resolves.toMatchObject({ reconnected: false })
  })
})
