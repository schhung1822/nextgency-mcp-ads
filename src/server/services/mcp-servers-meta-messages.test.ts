// "Đọc tin nhắn Trang" switch of the MCP service (settings.metaPageMessages, 11-meta-pages.md §13; DB, skipped without
// DATABASE_URL):
// - admin-only: staff cannot turn it on (create or update), may keep it or turn it off;
// - an admin turning it on must re-authenticate;
// - while it stays on, a staff save may keep or narrow the Page scope, never widen it (new Page / "all Pages");
// - stored snake_case.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
})
vi.mock("server-only", () => ({}))

import { eq, inArray } from "drizzle-orm"
import { aad, encryptJson } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpServers, metaPages, user } from "@/server/db/schema"
import { createMcpServer, getMcpServer, MCP_ERRORS, updateMcpServer, type McpActor } from "./mcp-servers"

const hasDb = !!process.env.DATABASE_URL
const okVerify = async () => "ok" as const
const P = `tmcpmsg_${randomUUID().slice(0, 8)}`
const staff: McpActor = { id: `${P}_staff`, email: `${P}_staff@example.test`, role: "staff" }
const admin: McpActor = { id: `${P}_admin`, email: `${P}_admin@example.test`, role: "admin" }
const ids = { conn: randomUUID(), acc: randomUUID(), pageA: randomUUID(), pageB: randomUUID() }

function cfg(pageIds: string[] | null, settings: Record<string, unknown> = {}) {
  return {
    name: `${P} meta`,
    description: null,
    platforms: [
      {
        platform: "meta",
        connections: [{ connectionId: ids.conn, accountIds: [ids.acc], pageIds }],
        permissions: ["read"],
      },
    ],
    settings: {
      protectionMode: "basic",
      twoStepConfirm: true,
      budgetChangeMaxPct: 30,
      maxDailyBudget: {},
      rateLimitPerMin: 60,
      writeRateLimitPer10Min: 10,
      allowedIps: [],
      ...settings,
    },
    expiresAt: null,
  }
}

describe.skipIf(!hasDb)("MCP service: 'Đọc tin nhắn Trang' switch (admin-only, re-auth, no wider Page scope)", () => {
  let mcpId = ""
  const upd = (actor: McpActor, c: ReturnType<typeof cfg>, verify?: typeof okVerify) =>
    updateMcpServer(actor, { ...c, id: mcpId }, verify)

  beforeAll(async () => {
    await db.insert(user).values(
      [staff, admin].map((u) => ({
        id: u.id,
        name: u.id,
        email: u.email,
        emailVerified: true,
        role: u.role,
        twoFactorEnabled: u.role === "admin",
      }))
    )
    await db.insert(connections).values({
      id: ids.conn,
      ownerId: staff.id,
      platform: "meta",
      name: `${P} meta`,
      status: "active",
      credentialsEncrypted: encryptJson({ accessToken: "x" }, aad.connectionCredentials(ids.conn)),
      credentialHint: "xxxx",
    })
    await db.insert(adAccounts).values({
      id: ids.acc,
      connectionId: ids.conn,
      platform: "meta",
      externalId: `act_${P}`,
      name: `${P}1`,
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
      isEnabled: true,
    })
    await db.insert(metaPages).values([
      { id: ids.pageA, connectionId: ids.conn, externalId: "9001", name: "Trang A", tasks: ["MESSAGING"] },
      { id: ids.pageB, connectionId: ids.conn, externalId: "9002", name: "Trang B", tasks: ["MODERATE"] },
    ])
    mcpId = (await createMcpServer(staff, cfg([ids.pageA]), okVerify)).id
  })

  afterAll(async () => {
    if (!hasDb) return
    const owners = [staff.id, admin.id]
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
    await db.delete(connections).where(inArray(connections.ownerId, owners))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
    await db.delete(user).where(inArray(user.id, owners))
  })

  it("defaults off, stored snake_case", async () => {
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, mcpId))
    expect(row!.settings).toMatchObject({ meta_page_messages: false })
    expect((await getMcpServer(staff, mcpId))!.settings.metaPageMessages).toBe(false)
  })

  it("staff cannot turn it on (create or update) - field error, nothing saved", async () => {
    await expect(createMcpServer(staff, cfg([ids.pageA], { metaPageMessages: true }), okVerify)).rejects.toMatchObject({
      code: "invalid",
      fieldErrors: { "settings.metaPageMessages": MCP_ERRORS.metaMessagesAdminOnly },
    })
    await expect(upd(staff, cfg([ids.pageA], { metaPageMessages: true }))).rejects.toMatchObject({
      fieldErrors: { "settings.metaPageMessages": MCP_ERRORS.metaMessagesAdminOnly },
    })
    expect((await getMcpServer(staff, mcpId))!.settings.metaPageMessages).toBe(false)
  })

  it("an admin turning it on must re-authenticate; staff then keeps / narrows, never widens the Pages; may turn it off", async () => {
    await expect(upd(admin, cfg([ids.pageA], { metaPageMessages: true }))).rejects.toMatchObject({
      code: "reauth_required",
      fieldErrors: { _reauth: "required" },
    })
    expect((await getMcpServer(admin, mcpId))!.settings.metaPageMessages).toBe(false)
    expect((await upd(admin, cfg([ids.pageA], { metaPageMessages: true }), okVerify)).changed).toBe(true)
    expect((await getMcpServer(staff, mcpId))!.settings.metaPageMessages).toBe(true)

    // staff widening: a new Page, or "all Pages"
    for (const pages of [[ids.pageA, ids.pageB], null]) {
      await expect(upd(staff, cfg(pages, { metaPageMessages: true }))).rejects.toMatchObject({
        fieldErrors: { "settings.metaPageMessages": MCP_ERRORS.metaMessagesStaffWidening },
      })
    }
    // keeping the same Page while editing something else is fine
    expect((await upd(staff, { ...cfg([ids.pageA], { metaPageMessages: true }), name: `${P} meta 2` })).changed).toBe(true)
    // widening is fine once the switch is turned off in the same save
    expect((await upd(staff, cfg([ids.pageA, ids.pageB], { metaPageMessages: false }))).changed).toBe(true)
    expect((await getMcpServer(staff, mcpId))!.settings.metaPageMessages).toBe(false)

    // an admin may widen while it is on
    expect((await upd(admin, cfg(null, { metaPageMessages: true }), okVerify)).changed).toBe(true)
    // narrowing by staff ("all" → one Page) stays allowed
    expect((await upd(staff, cfg([ids.pageB], { metaPageMessages: true }))).changed).toBe(true)
  })
})
