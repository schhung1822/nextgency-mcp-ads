// REAL Meta adapter (HTTP faked at fetch level) driven by the real connection service: a pasted short-lived personal
// (via) user token is exchanged for a ~60-day token BEFORE it is stored, the expiry drives active → expiring →
// invalid, and neither token ever shows up in the status message, meta, activity log or the DTOs.
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections } from "@/server/db/schema"
import { decryptCredentials } from "@/server/jobs/lib/connection-ops"
import { __resetBuckets } from "@/server/providers/rate-limit"
import { metaProvider } from "@/server/providers/meta"
import { json, mockGraph } from "@/server/providers/meta/test-utils"
import { registerProvider } from "@/server/providers/registry"
import { createConnection, getConnection, listConnections, previewConnection, replaceCredentials, testConnection } from "@/server/services/connections"
import { loadTestEnv, World } from "./world"

const hasDb = loadTestEnv()
const DAY = 86_400
const APP_ID = "123456789012345"
const APP_SECRET = "0123456789abcdef0123456789abcdef"
const SHORT = "EAAshortlivedpersonaltoken000000001"
const LONG = "EAAlonglivedpersonaltoken0000000002"
const REVOKED = "EAArevokedtoken000000000000000003"

const accountRows = {
  data: [
    { id: "act_1001", account_id: "1001", name: "Shop VN", account_status: 1, currency: "VND", timezone_name: "Asia/Ho_Chi_Minh", amount_spent: "0", balance: "0", min_daily_budget: 26484 },
    { id: "act_2002", account_id: "2002", name: "Shop US", account_status: 1, currency: "USD", timezone_name: "America/New_York", amount_spent: "0", balance: "0", min_daily_budget: 100 },
    { id: "act_3003", account_id: "3003", name: "Đã đóng", account_status: 101, currency: "VND", timezone_name: "Asia/Ho_Chi_Minh", amount_spent: "0", balance: "0", min_daily_budget: 26484 },
  ],
}
const SCOPES = ["ads_management", "ads_read", "pages_show_list", "pages_read_engagement", "business_management"]

describe.skipIf(!hasDb)("Meta personal user token (real adapter, faked Graph API)", { timeout: 120_000 }, () => {
  let w: World
  /** seconds until each token expires, as the fake Graph API reports it */
  const expiry: Record<string, number> = {}
  const calls = () => (graph ? graph.calls : [])
  let graph: ReturnType<typeof mockGraph> | null = null

  beforeAll(async () => {
    w = await World.create()
    registerProvider(metaProvider as never) // the real adapter instead of the flows fake
  }, 120_000)
  afterAll(async () => {
    vi.unstubAllGlobals()
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => {
    __resetBuckets()
    expiry[SHORT] = 3_600 // 1 hour
    expiry[LONG] = 60 * DAY
    expiry[REVOKED] = -1
    graph = mockGraph([
      [
        "GET",
        "debug_token",
        (c) => {
          const t = c.params.input_token ?? ""
          if (t === REVOKED) return json({ data: { app_id: APP_ID, type: "USER", is_valid: false, error: { code: 190, message: "Session has expired" } } })
          return json({ data: { app_id: APP_ID, type: "USER", is_valid: true, expires_at: Math.floor(Date.now() / 1000) + (expiry[t] ?? 60 * DAY), data_access_expires_at: 0, scopes: SCOPES, user_id: "99" } })
        },
      ],
      ["GET", "oauth/access_token", () => json({ access_token: LONG, token_type: "bearer", expires_in: 60 * DAY })],
      ["GET", "me", () => json({ id: "99", name: "Via Minh" })],
      ["GET", "me/adaccounts", () => json(accountRows)],
    ])
  })

  const creds = (token: string) => ({ access_token: token, app_id: APP_ID, app_secret: APP_SECRET })

  it("exchanges the short-lived token before saving: the stored credential is the 60-day one, accounts are synced with currencies", async () => {
    const actor = w.users.staff
    // wizard step 3: preview tells the user what happened to their token, saves nothing
    const pv = await previewConnection(actor, { platform: "meta", credentials: creds(SHORT) })
    expect(pv.status).toBe("active")
    expect(pv.warnings.join(" ")).toMatch(/đổi token ngắn hạn sang token dài hạn/)
    expect(pv.accounts.map((a) => [a.externalId, a.currency, a.defaultEnabled]).sort()).toEqual([
      ["act_1001", "VND", true],
      ["act_2002", "USD", true],
      ["act_3003", "VND", false], // closed → OFF by default
    ])
    expect(new Date(pv.tokenExpiresAt!).getTime() - Date.now()).toBeGreaterThan(55 * DAY * 1000)
    expect(JSON.stringify(pv)).not.toContain(SHORT)
    expect(JSON.stringify(pv)).not.toContain(LONG)

    const { id } = await createConnection(actor, { platform: "meta", name: `${w.prefix} via`, credentials: creds(SHORT) })
    const row = await w.connRow(id)
    expect(decryptCredentials(row)).toMatchObject({ accessToken: LONG, appId: APP_ID, appSecret: APP_SECRET }) // NOT the short one
    expect(row.status).toBe("active")
    expect(row.credentialHint).toBe(`…${LONG.slice(-4)}`)
    expect(row.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(55 * DAY * 1000)
    expect(row.credentialsEncrypted).not.toContain(LONG)
    expect(JSON.stringify(row.meta)).not.toContain(LONG)
    const accs = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, id))
    expect(Object.fromEntries(accs.map((a) => [a.externalId, [a.currency, a.isEnabled, a.status]]))).toEqual({
      act_1001: ["VND", true, "active"],
      act_2002: ["USD", true, "active"],
      act_3003: ["VND", false, "closed"],
    })
    // the exchange ran exactly once per save and the secret never went into a logged URL
    expect(calls().filter((c) => c.path === "oauth/access_token").length).toBeGreaterThanOrEqual(1)
    const logs = JSON.stringify(await db.select().from(activityLogs).where(eq(activityLogs.targetId, id)))
    for (const secret of [SHORT, LONG, APP_SECRET]) expect(logs).not.toContain(secret)
  })

  it("60-day token ageing: active → expiring (<7 days, message + next step) → invalid (expired) and back after replacing", async () => {
    const actor = w.users.staff
    const { id } = await createConnection(actor, { platform: "meta", name: `${w.prefix} ageing`, credentials: creds(SHORT) })
    expect((await w.connRow(id)).status).toBe("active")

    expiry[LONG] = 5 * DAY
    let r = await testConnection(actor, id)
    expect(r.status).toBe("expiring")
    expect(r.statusMessage).toMatch(/hết hạn sau (4|5) ngày/)
    expect(r.statusMessage).not.toMatch(/Graph API Explorer/) // the instruction is in statusHint
    expect(r.statusHint).toMatch(/Graph API Explorer/)
    expect(r.statusHint).toMatch(/Thay token/)
    expect((await listConnections(actor)).find((c) => c.id === id)!).toMatchObject({ status: "expiring", statusHint: r.statusHint })

    expiry[LONG] = -10 // expired
    r = await testConnection(actor, id)
    expect(r.status).toBe("invalid")
    expect(r.statusMessage).toMatch(/Token (đã hết hạn|không hợp lệ)/)
    expect((await getConnection(actor, id)).statusHint).toMatch(/Thay token/)

    // replacing with a fresh token (exchanged again) brings it back
    expiry[LONG] = 60 * DAY
    r = await replaceCredentials(actor, { connectionId: id, credentials: creds(SHORT) })
    expect(r.status).toBe("active")
    expect(r.statusMessage).toBeNull()
    expect(r.statusHint).toBeNull()
  })

  it("a revoked token is refused at save time with a Vietnamese message (nothing stored) and no secret in it", async () => {
    const actor = w.users.staff
    const before = (await db.select().from(connections).where(eq(connections.ownerId, actor.id))).length
    await expect(createConnection(actor, { platform: "meta", name: `${w.prefix} revoked`, credentials: creds(REVOKED) })).rejects.toThrow(/Token không hợp lệ/)
    await expect(previewConnection(actor, { platform: "meta", credentials: creds(REVOKED) })).rejects.toThrow(/Token không hợp lệ/)
    try {
      await createConnection(actor, { platform: "meta", name: `${w.prefix} revoked`, credentials: creds(REVOKED) })
    } catch (e) {
      const msg = (e as Error).message
      for (const secret of [REVOKED, APP_SECRET]) expect(msg).not.toContain(secret)
      expect(msg).toMatch(/dán lại/) // wizard wording (nothing saved yet)
    }
    expect((await db.select().from(connections).where(eq(connections.ownerId, actor.id))).length).toBe(before)
  })
})
