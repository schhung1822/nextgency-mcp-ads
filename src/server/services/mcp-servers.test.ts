// Integration tests for the MCP admin service against the dev Postgres (skipped when DATABASE_URL is absent).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => {
  try {
    process.loadEnvFile(".env")
  } catch {
    /* no .env (CI) → DB tests are skipped */
  }
  return { failLog: false }
})

vi.mock("server-only", () => ({}))
vi.mock("@/server/audit/activity-log", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/audit/activity-log")>()
  return {
    ...actual,
    logActivity: async (...args: Parameters<typeof actual.logActivity>) => {
      if (hoisted.failLog) throw new Error("simulated activity log failure")
      return actual.logActivity(...args)
    },
  }
})

import { and, eq, inArray } from "drizzle-orm"

import { hashMcpKey } from "@/server/crypto/mcp-key"
import { aad, decryptSecret, encryptJson } from "@/server/crypto/secret-box"
import { db } from "@/server/db/client"
import {
  activityLogs,
  adAccounts,
  connections,
  mcpPlatformPermissions,
  mcpServers,
  user,
} from "@/server/db/schema"

import {
  computeMcpStatus,
  createMcpServer as createMcpServerWithReauth,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  listSelectableConnections,
  McpServiceError,
  REVEAL_MAX_FAILURES,
  revealMcpUrl,
  rotateMcpKey,
  setMcpEnabled,
  updateMcpServer,
  type McpActor,
} from "./mcp-servers"

const hasDb = !!process.env.DATABASE_URL
const okVerify = async () => "ok" as const
/** Most tests are not about re-auth: create with a verifier that always succeeds. */
const createMcpServer = (a: McpActor, i: unknown) => createMcpServerWithReauth(a, i, okVerify)
const P = `tmcpadm_${randomUUID().slice(0, 8)}`

const staffA: McpActor = {
  id: `${P}_staff_a`,
  email: `${P}_staff_a@example.test`,
  role: "staff",
}
const staffB: McpActor = {
  id: `${P}_staff_b`,
  email: `${P}_staff_b@example.test`,
  role: "staff",
}
const admin: McpActor = {
  id: `${P}_admin`,
  email: `${P}_admin@example.test`,
  role: "admin",
}

const ids = {
  connA: randomUUID(), // staff A, meta
  connA2: randomUUID(), // staff A, openai_ads
  connB: randomUUID(), // staff B, meta
  connAdmin: randomUUID(), // admin, openai_ads
  connDisabled: randomUUID(), // staff A, meta, status disabled
  accA1: randomUUID(),
  accA2: randomUUID(),
  accADisabled: randomUUID(),
  accA2t: randomUUID(),
  accB1: randomUUID(),
  accAdm: randomUUID(),
}

const settings = {
  twoStepConfirm: true,
  budgetChangeMaxPct: 50,
  // mandatory for MCPs with write permissions (meta accounts are VND, openai_ads USD)
  maxDailyBudget: { VND: 100_000_000, USD: 10_000 },
  rateLimitPerMin: 60,
  allowedIps: [],
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: `${P} MCP`,
    description: "test",
    platforms: [
      {
        platform: "meta",
        connections: [{ connectionId: ids.connA, accountIds: null }],
        permissions: ["status"],
      },
    ],
    settings,
    expiresAt: null,
    ...overrides,
  }
}

function keyOf(url: string) {
  return url.slice(url.lastIndexOf("/mcp/") + 5)
}

async function logsFor(mcpId: string) {
  return db
    .select()
    .from(activityLogs)
    .where(
      and(eq(activityLogs.targetType, "mcp"), eq(activityLogs.targetId, mcpId))
    )
}

describe.skipIf(!hasDb)("mcp-servers service (DB)", () => {
  beforeAll(async () => {
    await db.insert(user).values(
      [staffA, staffB, admin].map((u) => ({
        id: u.id,
        name: u.id,
        email: u.email,
        emailVerified: true,
        role: u.role,
        twoFactorEnabled: u.role === "admin",
      }))
    )
    const conn = (
      id: string,
      ownerId: string,
      platform: "meta" | "openai_ads",
      name: string,
      status = "active"
    ) => ({
      id,
      ownerId,
      platform,
      name,
      status,
      credentialsEncrypted: encryptJson(
        { accessToken: "x" },
        aad.connectionCredentials(id)
      ),
      credentialHint: "xxxx",
    })
    await db
      .insert(connections)
      .values([
        conn(ids.connA, staffA.id, "meta", `${P} A meta`),
        conn(ids.connA2, staffA.id, "openai_ads", `${P} A openai`),
        conn(ids.connB, staffB.id, "meta", `${P} B meta`),
        conn(ids.connAdmin, admin.id, "openai_ads", `${P} admin openai`),
        conn(
          ids.connDisabled,
          staffA.id,
          "meta",
          `${P} A disabled`,
          "disabled"
        ),
      ])
    const acc = (
      id: string,
      connectionId: string,
      platform: "meta" | "openai_ads",
      ext: string,
      enabled = true
    ) => ({
      id,
      connectionId,
      platform,
      externalId: ext,
      name: ext,
      currency: platform === "openai_ads" ? "USD" : "VND",
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
      isEnabled: enabled,
    })
    await db
      .insert(adAccounts)
      .values([
        acc(ids.accA1, ids.connA, "meta", "act_1"),
        acc(ids.accA2, ids.connA, "meta", "act_2"),
        acc(ids.accADisabled, ids.connA, "meta", "act_3", false),
        acc(ids.accA2t, ids.connA2, "openai_ads", "adacct_700001"),
        acc(ids.accB1, ids.connB, "meta", "act_9"),
        acc(ids.accAdm, ids.connAdmin, "openai_ads", "adacct_1234567890"),
      ])
  })

  afterAll(async () => {
    if (!hasDb) return
    const owners = [staffA.id, staffB.id, admin.id]
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
    await db.delete(connections).where(inArray(connections.ownerId, owners))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
    await db.delete(user).where(inArray(user.id, owners))
  })

  it("create requires re-auth: failure is logged, nothing is created", async () => {
    const name = `${P} create reauth`
    // admin: staff A keeps its whole failure budget for the reveal test
    await expect(
      createMcpServerWithReauth(admin, input({ name }), async () => "bad_password")
    ).rejects.toMatchObject({ code: "reauth_failed" })
    await expect(
      createMcpServerWithReauth(admin, input({ name }), async () => "code_required")
    ).rejects.toMatchObject({ code: "reauth_code_required" })
    expect(await db.select().from(mcpServers).where(eq(mcpServers.name, name))).toHaveLength(0)
    const failures = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.actorId, admin.id), eq(activityLogs.action, "mcp.create")))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.status).toBe("failure")
    expect(failures[0]!.metadata).toMatchObject({ reauth: true, reason: "bad_password" })
  })

  it("creates an MCP: key stored only as hash + prefix + ciphertext, URL returned once, read always granted", async () => {
    const r = await createMcpServer(staffA, input())
    const key = keyOf(r.url)
    expect(key).toMatch(/^amcp_[A-Za-z0-9_-]{43}$/)
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, r.id))
    expect(row!.keyHash).toBe(hashMcpKey(key))
    expect(row!.keyPrefix).toBe(key.slice(0, 12))
    expect(row!.keyEncrypted).not.toContain(key.slice(5))
    expect(decryptSecret(row!.keyEncrypted, aad.mcpKey(r.id))).toBe(key)
    expect(row!.settings).toMatchObject({
      two_step_confirm: true,
      budget_change_max_pct: 50,
      rate_limit_per_min: 60,
    })

    const perms = await db
      .select()
      .from(mcpPlatformPermissions)
      .where(eq(mcpPlatformPermissions.mcpId, r.id))
    expect(perms[0]!.permissions).toEqual(["read", "status"])

    const detail = await getMcpServer(staffA, r.id)
    expect(JSON.stringify(detail)).not.toContain(key)
    expect(detail!.maskedUrl).toContain(row!.keyPrefix)
    expect(detail!.status).toBe("active")

    const logs = await logsFor(r.id)
    expect(logs.map((l) => l.action)).toEqual(["mcp.create"])
    expect(JSON.stringify(logs[0]!.metadata)).not.toContain(key)
  })

  it("staff cannot attach another user's connection; admin can (D4)", async () => {
    const bad = input({
      name: `${P} steal`,
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connB, accountIds: null }],
          permissions: [],
        },
      ],
    })
    await expect(createMcpServer(staffA, bad)).rejects.toMatchObject({
      code: "invalid",
    })
    expect(
      await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.name, `${P} steal`))
    ).toHaveLength(0)

    const r = await createMcpServer(admin, {
      ...bad,
      name: `${P} admin uses B`,
    })
    expect(r.id).toBeTruthy()
  })

  it("rejects platform mismatch, foreign accounts and disabled accounts", async () => {
    const mismatch = input({
      platforms: [
        {
          platform: "openai_ads",
          connections: [{ connectionId: ids.connA, accountIds: null }],
          permissions: [],
        },
      ],
    })
    await expect(createMcpServer(staffA, mismatch)).rejects.toBeInstanceOf(
      McpServiceError
    )
    const foreignAcc = input({
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connA, accountIds: [ids.accB1] }],
          permissions: [],
        },
      ],
    })
    await expect(createMcpServer(staffA, foreignAcc)).rejects.toMatchObject({
      code: "invalid",
    })
    const disabledAcc = input({
      platforms: [
        {
          platform: "meta",
          connections: [
            { connectionId: ids.connA, accountIds: [ids.accADisabled] },
          ],
          permissions: [],
        },
      ],
    })
    await expect(createMcpServer(staffA, disabledAcc)).rejects.toMatchObject({
      code: "invalid",
    })
    const disabledConn = input({
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connDisabled, accountIds: null }],
          permissions: [],
        },
      ],
    })
    await expect(createMcpServer(staffA, disabledConn)).rejects.toMatchObject({
      code: "invalid",
    })
  })

  it("validates settings bounds", async () => {
    const bad = [
      { ...settings, budgetChangeMaxPct: 0 },
      { ...settings, budgetChangeMaxPct: 501 },
      { ...settings, rateLimitPerMin: 0 },
      { ...settings, rateLimitPerMin: 601 },
      { ...settings, allowedIps: ["not-an-ip"] },
      { ...settings, allowedIps: ["10.0.0.0/33"] },
      { ...settings, maxDailyBudget: { vnd: 100 } },
      { ...settings, maxDailyBudget: { VND: -1 } },
      { ...settings, maxLifetimeBudget: { VND: 0 } },
      { ...settings, maxBid: { usd: 1 } },
      { ...settings, writeRateLimitPer10Min: 0 },
      { ...settings, writeRateLimitPer10Min: 1001 },
    ]
    for (const s of bad) {
      await expect(
        createMcpServer(staffA, input({ settings: s }))
      ).rejects.toMatchObject({ code: "invalid" })
    }
    await expect(
      createMcpServer(
        staffA,
        input({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      )
    ).rejects.toMatchObject({ code: "invalid" })
    const ok = await createMcpServer(
      staffA,
      input({
        name: `${P} bounds ok`,
        settings: {
          ...settings,
          allowedIps: ["203.0.113.10", "160.79.104.0/21", "2001:db8::/32"],
          maxDailyBudget: { VND: 5_000_000 },
          maxLifetimeBudget: { VND: 100_000_000 },
          maxBid: { VND: 30_000 },
          writeRateLimitPer10Min: 8,
        },
      })
    )
    const d = await getMcpServer(staffA, ok.id)
    expect(d!.settings.allowedIps).toHaveLength(3)
    expect(d!.settings.maxDailyBudget).toEqual({ VND: 5_000_000 })
    expect(d!.settings.maxLifetimeBudget).toEqual({ VND: 100_000_000 })
    expect(d!.settings.maxBid).toEqual({ VND: 30_000 })
    expect(d!.settings.writeRateLimitPer10Min).toBe(8)
    const [stored] = await db
      .select({ settings: mcpServers.settings })
      .from(mcpServers)
      .where(eq(mcpServers.id, ok.id))
    expect(stored!.settings).toMatchObject({
      max_lifetime_budget: { VND: 100_000_000 },
      max_bid: { VND: 30_000 },
      write_rate_limit_per_10min: 8,
    })
  })

  it("update: new guardrail fields are saved, diffed only when changed, and survive a legacy row", async () => {
    const r = await createMcpServer(staffA, input({ name: `${P} guard` }))
    // a row written before the new fields existed (no lifetime/bid/write-rate keys)
    await db
      .update(mcpServers)
      .set({
        settings: {
          two_step_confirm: true,
          budget_change_max_pct: 50,
          max_daily_budget: { VND: 100_000_000, USD: 10_000 },
          rate_limit_per_min: 60,
          allowed_ips: [],
        },
      })
      .where(eq(mcpServers.id, r.id))
    // same values (new fields at their defaults): the only change is the upgrade of the legacy row to
    // "caps required" - a runtime change (writes without a daily cap are refused from now on) → saved + logged
    const same = {
      ...input({ name: `${P} guard` }),
      id: r.id,
      settings: { ...settings, writeRateLimitPer10Min: 20 },
    }
    expect((await updateMcpServer(staffA, same)).changed).toBe(true)
    const [upgraded] = await db
      .select({ settings: mcpServers.settings })
      .from(mcpServers)
      .where(eq(mcpServers.id, r.id))
    expect(upgraded!.settings).toMatchObject({ money_caps_required: true })
    const upgradeLogs = (await logsFor(r.id)).filter((l) => l.action === "mcp.update")
    expect(upgradeLogs).toHaveLength(1)
    expect(upgradeLogs[0]!.metadata).toEqual({
      before: { moneyCapsRequired: false },
      after: { moneyCapsRequired: true },
      reason: "caps_required_upgrade",
    })
    // saving the same values again: nothing changes, nothing is logged
    expect((await updateMcpServer(staffA, same)).changed).toBe(false)
    expect((await logsFor(r.id)).filter((l) => l.action === "mcp.update")).toHaveLength(1)

    const guarded = {
      ...settings,
      maxLifetimeBudget: { VND: 90_000_000, USD: 3000 },
      maxBid: { USD: 4.5 },
      writeRateLimitPer10Min: 10,
    }
    const res = await updateMcpServer(staffA, {
      ...input({ name: `${P} guard` }),
      id: r.id,
      settings: guarded,
    })
    expect(res.changed).toBe(true)
    const logs = await logsFor(r.id)
    const upd = logs.filter(
      (l) =>
        l.action === "mcp.update" &&
        (l.metadata as { reason?: string }).reason !== "caps_required_upgrade"
    )
    expect(upd).toHaveLength(1)
    const meta = upd[0]!.metadata as {
      before: Record<string, unknown>
      after: { settings: Record<string, unknown> }
    }
    expect(Object.keys(meta.after)).toEqual(["settings"])
    expect(meta.after.settings).toMatchObject({
      maxLifetimeBudget: { USD: 3000, VND: 90_000_000 },
      maxBid: { USD: 4.5 },
      writeRateLimitPer10Min: 10,
    })
    // same caps in a different key order → no spurious change
    expect(
      (
        await updateMcpServer(staffA, {
          ...input({ name: `${P} guard` }),
          id: r.id,
          settings: {
            ...guarded,
            maxLifetimeBudget: { USD: 3000, VND: 90_000_000 },
          },
        })
      ).changed
    ).toBe(false)
    const d = await getMcpServer(staffA, r.id)
    expect(d!.settings.maxLifetimeBudget).toEqual({
      USD: 3000,
      VND: 90_000_000,
    })
    expect(d!.settings.writeRateLimitPer10Min).toBe(10)
  })

  it("isolates staff: list/get/update/rotate/delete of another user's MCP", async () => {
    const r = await createMcpServer(staffB, {
      ...input({ name: `${P} B private` }),
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connB, accountIds: [ids.accB1] }],
          permissions: [],
        },
      ],
    })
    expect((await listMcpServers(staffA)).some((m) => m.id === r.id)).toBe(
      false
    )
    expect(await getMcpServer(staffA, r.id)).toBeNull()
    await expect(
      updateMcpServer(staffA, { ...input(), id: r.id })
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      rotateMcpKey(staffA, r.id, async () => "ok")
    ).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(setMcpEnabled(staffA, r.id, false)).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(
      deleteMcpServer(staffA, r.id, `${P} B private`)
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      revealMcpUrl(staffA, r.id, async () => "ok")
    ).rejects.toMatchObject({ code: "not_found" })

    const adminList = await listMcpServers(admin)
    const row = adminList.find((m) => m.id === r.id)
    expect(row?.ownerEmail).toBe(staffB.email)
    expect(await getMcpServer(admin, r.id)).not.toBeNull()

    // selectable connections follow the owner rule
    const sel = await listSelectableConnections(staffA)
    expect(sel.map((c) => c.id).sort()).toEqual([ids.connA, ids.connA2].sort())
    expect(
      sel.find((c) => c.id === ids.connA)!.accounts.map((a) => a.id)
    ).not.toContain(ids.accADisabled)
    const adminSel = await listSelectableConnections(admin)
    expect(adminSel.map((c) => c.id)).toEqual(
      expect.arrayContaining([ids.connA, ids.connB, ids.connAdmin])
    )
    const forStaffOwner = await listSelectableConnections(admin, {
      id: staffB.id,
      role: "staff",
    })
    expect(forStaffOwner.map((c) => c.id)).toEqual([ids.connB])
    expect(
      await listSelectableConnections(staffA, { id: staffB.id, role: "staff" })
    ).toEqual([])
  })

  it("update: owner rule applies to the MCP owner even when an admin edits; diff logged", async () => {
    const r = await createMcpServer(staffA, input({ name: `${P} upd` }))
    // admin editing a staff MCP cannot attach admin's own connection
    await expect(
      updateMcpServer(admin, {
        ...input({ name: `${P} upd` }),
        id: r.id,
        platforms: [
          {
            platform: "openai_ads",
            connections: [{ connectionId: ids.connAdmin, accountIds: null }],
            permissions: [],
          },
        ],
      })
    ).rejects.toMatchObject({ code: "invalid" })

    const res = await updateMcpServer(staffA, {
      ...input({ name: `${P} upd 2` }),
      id: r.id,
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connA, accountIds: [ids.accA1] }],
          permissions: ["update"],
        },
        {
          platform: "openai_ads",
          connections: [{ connectionId: ids.connA2, accountIds: null }],
          permissions: [],
        },
      ],
    })
    expect(res.changed).toBe(true)
    const d = await getMcpServer(staffA, r.id)
    expect(d!.name).toBe(`${P} upd 2`)
    expect(d!.permissions).toEqual({
      meta: ["read", "update"],
      openai_ads: ["read"],
    })
    expect(
      d!.config.find((p) => p.platform === "meta")!.connections[0]!.accountIds
    ).toEqual([ids.accA1])
    const logs = await logsFor(r.id)
    const upd = logs.find((l) => l.action === "mcp.update")!
    expect(
      Object.keys((upd.metadata as { after: object }).after).sort()
    ).toEqual(["name", "platforms"])

    const again = await updateMcpServer(staffA, {
      ...input({ name: `${P} upd 2` }),
      id: r.id,
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connA, accountIds: [ids.accA1] }],
          permissions: ["update"],
        },
        {
          platform: "openai_ads",
          connections: [{ connectionId: ids.connA2, accountIds: null }],
          permissions: [],
        },
      ],
    })
    expect(again.changed).toBe(false)
  })

  it("GMV Max write switch: only an admin may turn it on; staff may keep or turn it off; diff logged", async () => {
    const on = { ...settings, tiktokGmvMaxWrite: true }
    const before = (await db.select().from(mcpServers).where(eq(mcpServers.ownerId, staffA.id))).length
    // staff cannot create an MCP with the switch on (nothing created, field error on the switch)
    const err = await createMcpServer(staffA, input({ name: `${P} gmv staff`, settings: on })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpServiceError)
    expect(err).toMatchObject({
      code: "invalid",
      message: "Chỉ quản trị viên được bật quyền thay đổi GMV Max.",
      fieldErrors: { "settings.tiktokGmvMaxWrite": "Chỉ quản trị viên được bật quyền thay đổi GMV Max." },
    })
    expect((await db.select().from(mcpServers).where(eq(mcpServers.ownerId, staffA.id))).length).toBe(before)

    // an admin may create one with the switch on (own connection)
    const adm = await createMcpServer(admin, {
      ...input({ name: `${P} gmv admin`, settings: on }),
      platforms: [{ platform: "openai_ads", connections: [{ connectionId: ids.connAdmin, accountIds: null }], permissions: ["status"] }],
    })
    expect((await getMcpServer(admin, adm.id))!.settings.tiktokGmvMaxWrite).toBe(true)

    // staff MCP: off by default; staff cannot turn it on (stored value unchanged)
    const r = await createMcpServer(staffA, input({ name: `${P} gmv` }))
    const [created] = await db.select({ settings: mcpServers.settings }).from(mcpServers).where(eq(mcpServers.id, r.id))
    expect(created!.settings).toMatchObject({ tiktok_gmv_max_write: false })
    await expect(
      updateMcpServer(staffA, { ...input({ name: `${P} gmv` }), id: r.id, settings: on })
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { "settings.tiktokGmvMaxWrite": expect.any(String) } })
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(false)

    // an admin edits the staff MCP and turns it on → re-auth required first (S4), then saved + logged before → after
    await expect(
      updateMcpServer(admin, { ...input({ name: `${P} gmv` }), id: r.id, settings: on })
    ).rejects.toMatchObject({ code: "reauth_required" })
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(false)
    expect(
      (await updateMcpServer(admin, { ...input({ name: `${P} gmv` }), id: r.id, settings: on }, okVerify)).changed
    ).toBe(true)
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(true)
    const upd = (await logsFor(r.id)).filter((l) => l.action === "mcp.update")
    expect(upd).toHaveLength(1)
    const meta = upd[0]!.metadata as {
      before: { settings: Record<string, unknown> }
      after: { settings: Record<string, unknown> }
      ownerId?: string
    }
    expect(meta.before.settings.tiktokGmvMaxWrite).toBe(false)
    expect(meta.after.settings.tiktokGmvMaxWrite).toBe(true)
    expect(meta.ownerId).toBe(staffA.id)

    // the staff owner may keep it (other edits) …
    expect((await updateMcpServer(staffA, { ...input({ name: `${P} gmv 2` }), id: r.id, settings: on })).changed).toBe(true)
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(true)
    // … or turn it off, but not back on
    expect((await updateMcpServer(staffA, { ...input({ name: `${P} gmv 2` }), id: r.id })).changed).toBe(true)
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(false)
    await expect(
      updateMcpServer(staffA, { ...input({ name: `${P} gmv 2` }), id: r.id, settings: on })
    ).rejects.toMatchObject({ code: "invalid" })
    expect((await getMcpServer(staffA, r.id))!.settings.tiktokGmvMaxWrite).toBe(false)
  })

  it("rotate requires re-auth, invalidates the old key hash and returns a new URL once", async () => {
    const r = await createMcpServer(staffA, input({ name: `${P} rot` }))
    const oldKey = keyOf(r.url)
    await expect(
      // admin (owner check passes) so staff A keeps its whole failure budget for the reveal test
      rotateMcpKey(admin, r.id, async () => "bad_password")
    ).rejects.toMatchObject({ code: "reauth_failed" })
    const [unchanged] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, r.id))
    expect(unchanged!.keyHash).toBe(hashMcpKey(oldKey))
    expect(
      (await logsFor(r.id)).find(
        (l) => l.action === "mcp.key.rotate" && l.status === "failure"
      )
    ).toBeTruthy()

    const { url } = await rotateMcpKey(staffA, r.id, async () => "ok")
    const newKey = keyOf(url)
    expect(newKey).not.toBe(oldKey)
    expect(
      await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.keyHash, hashMcpKey(oldKey)))
    ).toHaveLength(0)
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.keyHash, hashMcpKey(newKey)))
    expect(row!.id).toBe(r.id)
    expect(row!.keyRotatedAt).not.toBeNull()
    expect((await logsFor(r.id)).map((l) => l.action)).toContain(
      "mcp.key.rotate"
    )
  })

  it("reveal requires re-auth on every call, logs success/failure and throttles failures", async () => {
    const r = await createMcpServer(staffA, input({ name: `${P} reveal` }))
    const verify = vi.fn(async () => "bad_password" as const)
    await expect(revealMcpUrl(staffA, r.id, verify)).rejects.toMatchObject({
      code: "reauth_failed",
    })
    expect(verify).toHaveBeenCalledTimes(1)

    await expect(
      revealMcpUrl(staffA, r.id, async () => "code_required")
    ).rejects.toMatchObject({
      code: "reauth_code_required",
    })

    const ok = await revealMcpUrl(staffA, r.id, async () => "ok")
    expect(ok.url).toBe(r.url)

    const logs = (await logsFor(r.id)).filter(
      (l) => l.action === "mcp.key.reveal"
    )
    expect(logs.map((l) => l.status).sort()).toEqual(["failure", "success"])
    expect(JSON.stringify(logs.map((l) => l.metadata))).not.toContain(
      keyOf(r.url)
    )

    for (let i = 1; i < REVEAL_MAX_FAILURES; i++) {
      await expect(
        revealMcpUrl(staffA, r.id, async () => "bad_code")
      ).rejects.toMatchObject({ code: "reauth_failed" })
    }
    const never = vi.fn(async () => "ok" as const)
    await expect(revealMcpUrl(staffA, r.id, never)).rejects.toMatchObject({
      code: "reauth_locked",
    })
    expect(never).not.toHaveBeenCalled()
    // the budget is shared by every re-auth: create is locked too
    await expect(
      createMcpServerWithReauth(staffA, input({ name: `${P} locked` }), never)
    ).rejects.toMatchObject({ code: "reauth_locked" })
    // simulate the 15-minute window passing so the following tests can create MCPs as staff A
    await db
      .delete(activityLogs)
      .where(and(eq(activityLogs.actorId, staffA.id), eq(activityLogs.status, "failure")))
  })

  it("writes the activity log in the same transaction (log failure rolls back the change)", async () => {
    hoisted.failLog = true
    try {
      await expect(
        createMcpServer(staffA, input({ name: `${P} tx` }))
      ).rejects.toThrow("simulated")
    } finally {
      hoisted.failLog = false
    }
    expect(
      await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.name, `${P} tx`))
    ).toHaveLength(0)

    const r = await createMcpServer(staffA, input({ name: `${P} tx2` }))
    hoisted.failLog = true
    try {
      await expect(setMcpEnabled(staffA, r.id, false)).rejects.toThrow(
        "simulated"
      )
      // admin: staff A has used up its re-auth failure budget in the previous test
      await expect(rotateMcpKey(admin, r.id, async () => "ok")).rejects.toThrow(
        "simulated"
      )
    } finally {
      hoisted.failLog = false
    }
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, r.id))
    expect(row!.status).toBe("active")
    expect(row!.keyHash).toBe(hashMcpKey(keyOf(r.url)))
  })

  it("enable/disable and soft delete (name must match; key scrubbed)", async () => {
    const r = await createMcpServer(staffA, input({ name: `${P} del` }))
    expect(await setMcpEnabled(staffA, r.id, false)).toEqual({ changed: true })
    expect(await setMcpEnabled(staffA, r.id, false)).toEqual({ changed: false })
    expect((await getMcpServer(staffA, r.id))!.status).toBe("disabled")
    await setMcpEnabled(staffA, r.id, true)

    await expect(deleteMcpServer(staffA, r.id, "wrong")).rejects.toMatchObject({
      code: "invalid",
    })
    await deleteMcpServer(staffA, r.id, `${P} del`)
    expect(await getMcpServer(staffA, r.id)).toBeNull()
    expect((await listMcpServers(staffA)).some((m) => m.id === r.id)).toBe(
      false
    )
    expect(
      await db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.keyHash, hashMcpKey(keyOf(r.url))))
    ).toHaveLength(0)
    const actions = (await logsFor(r.id)).map((l) => l.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        "mcp.create",
        "mcp.disable",
        "mcp.enable",
        "mcp.delete",
      ])
    )
  })

  it("parallel wrong attempts cannot exceed the failure budget", async () => {
    const r = await createMcpServer(staffB, {
      ...input({ name: `${P} B throttle` }),
      platforms: [
        {
          platform: "meta",
          connections: [{ connectionId: ids.connB, accountIds: null }],
          permissions: [],
        },
      ],
    })
    const verify = vi.fn(async () => {
      await new Promise((res) => setTimeout(res, 20))
      return "bad_password" as const
    })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => revealMcpUrl(staffB, r.id, verify))
    )
    const codes = results.map((x) =>
      x.status === "rejected" ? (x.reason as { code: string }).code : "ok"
    )
    expect(codes.filter((c) => c === "reauth_failed")).toHaveLength(
      REVEAL_MAX_FAILURES
    )
    expect(codes.filter((c) => c === "reauth_locked")).toHaveLength(
      10 - REVEAL_MAX_FAILURES
    )
    expect(verify).toHaveBeenCalledTimes(REVEAL_MAX_FAILURES)
  })
})

describe.skipIf(!hasDb)("mcp-servers service: mandatory daily caps + scope privacy (DB)", () => {
  const Q = `tmcpcap_${randomUUID().slice(0, 8)}`
  const sa: McpActor = { id: `${Q}_staff_a`, email: `${Q}_staff_a@example.test`, role: "staff" }
  const sb: McpActor = { id: `${Q}_staff_b`, email: `${Q}_staff_b@example.test`, role: "staff" }
  const ad: McpActor = { id: `${Q}_admin`, email: `${Q}_admin@example.test`, role: "admin" }
  const c = { a: randomUUID(), aOpenai: randomUUID(), b: randomUUID() }
  const acc = { vnd: randomUUID(), usd: randomUUID(), openai: randomUUID(), b: randomUUID() }
  const scope = (permissions: string[], extra: Record<string, unknown> = {}) => ({
    name: `${Q} caps`,
    description: null,
    platforms: [{ platform: "meta", connections: [{ connectionId: c.a, accountIds: null }], permissions }],
    settings: { ...settings, maxDailyBudget: {} },
    expiresAt: null,
    ...extra,
  })

  beforeAll(async () => {
    await db.insert(user).values(
      [sa, sb, ad].map((u) => ({ id: u.id, name: u.id, email: u.email, emailVerified: true, role: u.role }))
    )
    const conn = (id: string, ownerId: string, platform: "meta" | "openai_ads", name: string) => ({
      id,
      ownerId,
      platform,
      name,
      status: "active",
      credentialsEncrypted: encryptJson({ accessToken: "x" }, aad.connectionCredentials(id)),
      credentialHint: "xxxx",
    })
    await db.insert(connections).values([
      conn(c.a, sa.id, "meta", `${Q} A meta`),
      conn(c.aOpenai, sa.id, "openai_ads", `${Q} A openai`),
      conn(c.b, sb.id, "meta", `${Q} B meta (secret name)`),
    ])
    const account = (id: string, connectionId: string, platform: "meta" | "openai_ads", ext: string, currency: string) => ({
      id,
      connectionId,
      platform,
      externalId: ext,
      name: ext,
      currency,
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
      isEnabled: true,
    })
    await db.insert(adAccounts).values([
      account(acc.vnd, c.a, "meta", "act_11", "VND"),
      account(acc.usd, c.a, "meta", "act_12", "USD"),
      account(acc.openai, c.aOpenai, "openai_ads", "adacct_711", "USD"),
      account(acc.b, c.b, "meta", "act_19", "VND"),
    ])
  })

  afterAll(async () => {
    if (!hasDb) return
    const owners = [sa.id, sb.id, ad.id]
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, owners))
    await db.delete(connections).where(inArray(connections.ownerId, owners))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, owners))
    await db.delete(user).where(inArray(user.id, owners))
  })

  it("an MCP with a money-write permission needs a daily cap for every currency in that scope", async () => {
    for (const perm of ["status", "update", "copy", "create"]) {
      const err = await createMcpServer(sa, scope([perm])).catch((e: unknown) => e)
      expect(err, perm).toBeInstanceOf(McpServiceError)
      expect(err).toMatchObject({ code: "invalid" })
      expect((err as McpServiceError).message).toMatch(/USD, VND/)
      expect(Object.keys((err as McpServiceError).fieldErrors ?? {}).sort()).toEqual([
        "settings.maxDailyBudget.USD",
        "settings.maxDailyBudget.VND",
      ])
    }
    // one currency is not enough
    await expect(
      createMcpServer(sa, scope(["status"], { settings: { ...settings, maxDailyBudget: { VND: 1_000_000 } } }))
    ).rejects.toMatchObject({ fieldErrors: { "settings.maxDailyBudget.USD": expect.stringMatching(/USD/) } })
    // picked accounts: only their currencies are required
    const picked = await createMcpServer(sa, {
      ...scope(["status"], { settings: { ...settings, maxDailyBudget: { VND: 1_000_000 } } }),
      platforms: [{ platform: "meta", connections: [{ connectionId: c.a, accountIds: [acc.vnd] }], permissions: ["status"] }],
    })
    expect((await getMcpServer(sa, picked.id))!.capsMissing).toEqual([])
    // nothing created by the refused attempts
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.ownerId, sa.id))
    expect(rows).toHaveLength(1)
  })

  it("read-only and delete-only scopes need no cap; the permission of each platform counts on its own", async () => {
    const ro = await createMcpServer(sa, scope(["read"], { name: `${Q} ro` }))
    expect((await getMcpServer(sa, ro.id))!.capsMissing).toEqual([])
    await createMcpServer(sa, scope(["delete"], { name: `${Q} del` }))
    // meta read-only + openai write: only USD (openai) is required
    const mixed = await createMcpServer(sa, {
      ...scope([], { name: `${Q} mixed`, settings: { ...settings, maxDailyBudget: { USD: 50 } } }),
      platforms: [
        { platform: "meta", connections: [{ connectionId: c.a, accountIds: null }], permissions: ["read"] },
        { platform: "openai_ads", connections: [{ connectionId: c.aOpenai, accountIds: null }], permissions: ["update"] },
      ],
    })
    const [stored] = await db.select({ settings: mcpServers.settings }).from(mcpServers).where(eq(mcpServers.id, mixed.id))
    expect(stored!.settings).toMatchObject({ money_caps_required: true, max_daily_budget: { USD: 50 } })
  })

  it("a legacy MCP keeps working, is flagged in list/detail, and cannot be saved again until its caps are set", async () => {
    const r = await createMcpServer(sa, scope(["read", "status"], { name: `${Q} legacy`, settings }))
    // written by v1.0.1: no money_caps_required, no caps
    await db
      .update(mcpServers)
      .set({ settings: { two_step_confirm: true, budget_change_max_pct: 50, max_daily_budget: { VND: 5 }, rate_limit_per_min: 60, allowed_ips: [] } })
      .where(eq(mcpServers.id, r.id))
    const detail = await getMcpServer(sa, r.id)
    expect(detail!.settings.moneyCapsRequired).toBe(false)
    expect(detail!.capsMissing).toEqual(["USD"])
    expect((await listMcpServers(sa)).find((m) => m.id === r.id)!.capsMissing).toEqual(["USD"])

    const edit = { ...scope(["read", "status"], { name: `${Q} legacy renamed`, settings: { ...settings, maxDailyBudget: { VND: 5 } } }), id: r.id }
    await expect(updateMcpServer(sa, edit)).rejects.toMatchObject({
      code: "invalid",
      fieldErrors: { "settings.maxDailyBudget.USD": expect.any(String) },
    })
    const [unchanged] = await db.select().from(mcpServers).where(eq(mcpServers.id, r.id))
    expect(unchanged!.name).toBe(`${Q} legacy`)
    expect(unchanged!.settings).not.toHaveProperty("money_caps_required")

    const fixed = await updateMcpServer(sa, { ...edit, settings: { ...settings, maxDailyBudget: { VND: 5, USD: 3 } } })
    expect(fixed.changed).toBe(true)
    const after = await getMcpServer(sa, r.id)
    expect(after!.settings.moneyCapsRequired).toBe(true)
    expect(after!.capsMissing).toEqual([])
    // the internal marker never shows up in the activity diff
    const logs = await logsFor(r.id)
    const upd = logs.find((l) => l.action === "mcp.update")!
    expect(JSON.stringify(upd.metadata)).not.toMatch(/moneyCapsRequired|money_caps_required/)
  })

  it("the stored scope of an MCP never reveals the name of a connection the viewer may not access", async () => {
    // created by an admin with staff B's connection (D4), the admin is later demoted to staff
    const r = await createMcpServer(ad, {
      ...scope(["read"], { name: `${Q} cross` }),
      platforms: [{ platform: "meta", connections: [{ connectionId: c.b, accountIds: null }], permissions: ["read"] }],
    })
    const asAdmin = await getMcpServer(ad, r.id)
    expect(asAdmin!.config[0]!.connections[0]!.connectionName).toBe(`${Q} B meta (secret name)`)
    const demoted: McpActor = { ...ad, role: "staff" }
    const asDemoted = await getMcpServer(demoted, r.id)
    expect(asDemoted).not.toBeNull()
    expect(asDemoted!.config[0]!.connections[0]!.connectionName).toBe("Kết nối của người dùng khác")
    expect(JSON.stringify(asDemoted)).not.toContain("secret name")
  })
})

describe("computeMcpStatus", () => {
  it("derives expired from expires_at", () => {
    const now = new Date("2026-10-02T00:00:00Z")
    expect(computeMcpStatus({ status: "active", expiresAt: null }, now)).toBe(
      "active"
    )
    expect(
      computeMcpStatus(
        { status: "active", expiresAt: new Date("2026-10-01T00:00:00Z") },
        now
      )
    ).toBe("expired")
    expect(
      computeMcpStatus(
        { status: "disabled", expiresAt: new Date("2026-10-01T00:00:00Z") },
        now
      )
    ).toBe("disabled")
  })
})
