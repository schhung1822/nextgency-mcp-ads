// PERMISSION MATRIX, table driven, through the real services + the real endpoint.
// The expectations below are written from the product spec (01-product-spec.md §4, 04-mcp-design.md §4), NOT
// derived from the code under test:
//   - a common tool exists iff some platform of the MCP grants its permission;
//   - a platform tool (`<platform>_…`) exists iff THAT platform grants its permission;
//   - a call is served iff the platform grants the permission AND the account is in the MCP's scope;
//   - everything else is refused and nothing reaches the platform adapter.
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { adAccounts, connections, mcpAccountScopes, mcpServers } from "@/server/db/schema"
import { PLATFORMS, type Platform } from "@/server/providers/types"
import type { Permission } from "@/server/mcp/types"
import { demoAccounts, loadTestEnv, World, type ConnInfo, type McpCfg } from "./world"

const hasDb = loadTestEnv()

const ALL_PERMS: Permission[] = ["read", "status", "update", "copy", "create", "delete"]

/** common tool → permission needed (spec table) */
const COMMON_TOOLS: Record<string, Permission> = {
  ads_list_accounts: "read",
  ads_get_report: "read",
  ads_list_objects: "read",
  ads_get_object: "read",
  ads_lookup: "read",
  ads_set_status: "status",
  ads_update_budget: "update",
  ads_update_object: "update",
  ads_copy_object: "copy",
  ads_upload_media: "create",
  ads_delete_object: "delete",
}
/** platform tools of the fake adapter → permission */
const platformTools = (p: Platform): Record<string, Permission> => ({
  [`${p}_fake_insight`]: "read",
  [`${p}_fake_create_campaign`]: "create",
  [`${p}_fake_create_adgroup`]: "create",
  [`${p}_fake_undeclared_money`]: "create",
})

const normalize = (perms: Permission[]): Permission[] => ALL_PERMS.filter((p) => p === "read" || perms.includes(p))

function expectedTools(grant: Partial<Record<Platform, Permission[]>>): string[] {
  const out: string[] = []
  const entries = Object.entries(grant) as [Platform, Permission[]][]
  for (const [tool, perm] of Object.entries(COMMON_TOOLS)) {
    if (entries.some(([, perms]) => perms.includes(perm))) out.push(tool)
  }
  for (const [p, perms] of entries) {
    for (const [tool, perm] of Object.entries(platformTools(p))) if (perms.includes(perm)) out.push(tool)
  }
  return out.sort()
}

/** a tool call that would be valid on `platform`/`account` */
function invocation(tool: string, platform: Platform, account: string): Record<string, unknown> {
  const base = { platform, account_id: account }
  switch (tool) {
    case "ads_list_accounts":
      return { platform }
    case "ads_get_report":
      return { platforms: [platform], account_ids: [account], level: "account", preset: "yesterday" }
    case "ads_list_objects":
      return { ...base, level: "campaign" }
    case "ads_get_object":
      return { ...base, level: "campaign", id: "c1" }
    case "ads_lookup":
      return { ...base, kind: "pages" }
    case "ads_set_status":
      return { ...base, level: "campaign", ids: ["c1"], status: "paused" }
    case "ads_update_budget":
      return { ...base, level: "ad_group", id: "g1", budget_type: "daily", amount: 110 }
    case "ads_update_object":
      return { ...base, level: "campaign", id: "c1", name: "Renamed" }
    case "ads_copy_object":
      return { ...base, level: "campaign", id: "c1" }
    case "ads_upload_media":
      return { ...base, type: "image", url: "http://127.0.0.1/a.png" } // reaches the SSRF guard ⇒ permission passed
    case "ads_delete_object":
      return { ...base, level: "campaign", id: "c2" }
    default:
      if (tool.endsWith("_fake_insight")) return { account_id: account, topic: "x" }
      return { account_id: account, name: "n" }
  }
}

const PERMISSION_ERRORS = new Set(["permission_denied", "account_not_in_scope"])

describe.skipIf(!hasDb)("permission matrix (services → endpoint)", { timeout: 300_000 }, () => {
  let w: World
  const conns = {} as Record<Platform, ConnInfo>
  const accountsOf = (p: Platform) => conns[p].accounts.map((a) => a.externalId)

  beforeAll(async () => {
    w = await World.create()
    for (const p of PLATFORMS) {
      conns[p] = await w.connect(w.users.staff, p, demoAccounts(w.prefix, p))
      for (const a of conns[p].accounts) {
        w.seedObjects(a.externalId, [
          { id: "c1", level: "campaign", name: "C1", status: "active", parentId: null, budget: null },
          { id: "c2", level: "campaign", name: "C2", status: "paused", parentId: null, budget: null },
          { id: "g1", level: "ad_group", name: "G1", status: "active", parentId: "c1", budget: { type: "daily", amount: 100, level: "ad_group" } },
          { id: "a1", level: "ad", name: "A1", status: "active", parentId: "g1" },
        ])
      }
    }
  }, 120_000)
  afterAll(async () => {
    if (w) await w.cleanup()
  }, 60_000)
  beforeEach(() => w.reset())

  /** served = the platform grants the permission and the account is in scope; refused otherwise. */
  async function assertCall(
    key: string,
    tool: string,
    platform: Platform,
    account: string,
    expectServed: boolean,
    label: string
  ) {
    const before = w.state.executions.length
    const r = await w.call(key, tool, invocation(tool, platform, account))
    const code = r.sc?.code as string | undefined
    const refused = Boolean(r.rpcError) || (r.isError && (code === undefined || PERMISSION_ERRORS.has(code)))
    if (expectServed) {
      expect(refused, `${label}: ${tool} ${platform} ${account} should be served but got ${r.rpcError?.message ?? r.text}`).toBe(false)
    } else {
      expect(refused, `${label}: ${tool} ${platform} ${account} must be refused but got ${JSON.stringify(r.sc).slice(0, 200)}`).toBe(true)
      expect(w.state.executions.length, `${label}: ${tool} must not reach the adapter`).toBe(before)
    }
  }

  // ---------------------------------------------------------------------------------------------
  const PERM_SETS: Permission[][] = [
    ["read"],
    ["read", "status"],
    ["read", "update"],
    ["read", "copy"],
    ["read", "create"],
    ["read", "delete"],
    ["status", "delete"], // no "read" given → read is always added
    ALL_PERMS,
  ]

  describe.each(PLATFORMS)("single platform MCP: %s", (platform) => {
    it.each(PERM_SETS.map((s) => [s.join("+")] as const))("permissions %s", async (label) => {
      const perms = PERM_SETS.find((s) => s.join("+") === label)!
      const effective = normalize(perms)
      const mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: { [platform]: { permissions: perms, connections: [{ conn: conns[platform] }] } },
      })
      const expected = expectedTools({ [platform]: effective })
      // both protocol eras serve exactly the same catalogue
      for (const modern of [true, false]) {
        const t = await w.tools(mcp.key, { modern })
        expect(t.status).toBe(200)
        expect([...t.names].sort(), `tools/list (${modern ? "2026" : "2025"})`).toEqual(expected)
      }
      // every tool on every account of the platform: served iff the platform grants the permission
      const first = accountsOf(platform)[0]!
      for (const tool of [...Object.keys(COMMON_TOOLS), ...Object.keys(platformTools(platform))]) {
        const need = COMMON_TOOLS[tool] ?? platformTools(platform)[tool]!
        await assertCall(mcp.key, tool, platform, first, effective.includes(need), `${platform}[${label}]`)
      }
      // read tools reach every account in scope
      for (const acc of accountsOf(platform)) await assertCall(mcp.key, "ads_list_objects", platform, acc, true, "all accounts")
      // the other platforms' accounts are never reachable, whatever the permission
      for (const other of PLATFORMS.filter((p) => p !== platform)) {
        await assertCall(mcp.key, "ads_list_objects", other, accountsOf(other)[0]!, false, "other platform")
        await assertCall(mcp.key, "ads_get_report", other, accountsOf(other)[0]!, false, "other platform report")
      }
    })
  })

  // ---------------------------------------------------------------------------------------------
  it("mixed MCP: each platform keeps its OWN permissions (a tool visible through platform A is refused on platform B)", async () => {
    const grants: Partial<Record<Platform, Permission[]>> = {
      meta: ["read", "status", "update"],
      tiktok: ["read"],
      google_ads: ["read", "copy", "create"],
      openai_ads: ["read", "delete"],
    }
    const cfg: McpCfg = {
      settings: { twoStepConfirm: false },
      platforms: Object.fromEntries(PLATFORMS.map((p) => [p, { permissions: grants[p]!, connections: [{ conn: conns[p] }] }])),
    }
    const mcp = await w.mcp(w.users.staff, cfg)
    for (const modern of [true, false]) {
      expect([...(await w.tools(mcp.key, { modern })).names].sort()).toEqual(expectedTools(grants))
    }
    for (const platform of PLATFORMS) {
      const acc = accountsOf(platform)[0]!
      for (const tool of Object.keys(COMMON_TOOLS)) {
        await assertCall(mcp.key, tool, platform, acc, grants[platform]!.includes(COMMON_TOOLS[tool]!), `mixed ${platform}`)
      }
      for (const [tool, need] of Object.entries(platformTools(platform))) {
        await assertCall(mcp.key, tool, platform, acc, grants[platform]!.includes(need), `mixed ${platform}`)
      }
      // a platform tool of platform B never accepts an account of platform A
      for (const other of PLATFORMS.filter((p) => p !== platform)) {
        await assertCall(mcp.key, `${other}_fake_insight`, other, acc, false, `cross ${platform}→${other}`)
      }
    }
    // ads_list_accounts shows each platform's permissions
    const list = await w.call(mcp.key, "ads_list_accounts", {})
    for (const a of list.sc.accounts as { platform: Platform; permissions: string[] }[]) {
      expect(a.permissions).toEqual(normalize(grants[a.platform]!))
    }
  })

  // ---------------------------------------------------------------------------------------------
  describe("account scope", () => {
    it("all accounts vs specific accounts vs account switched off later vs account found later", async () => {
      const p: Platform = "meta"
      const c = conns[p]
      const [a1, a2, a3] = c.accounts
      const mcpAll = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: c }] } } })
      const mcpPick = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: c, accounts: [a2!.externalId] }] } } })
      const ids = (xs: { externalId: string }[]) => xs.map((x) => `meta:${x.externalId}`).sort()
      expect(await w.visibleAccounts(mcpAll.key)).toEqual(ids([a1!, a2!, a3!]))
      expect(await w.visibleAccounts(mcpPick.key)).toEqual(ids([a2!]))
      // calls follow the same scope
      await assertCall(mcpPick.key, "ads_list_objects", p, a2!.externalId, true, "picked")
      await assertCall(mcpPick.key, "ads_list_objects", p, a1!.externalId, false, "not picked")
      await assertCall(mcpPick.key, "ads_set_status", p, a1!.externalId, false, "write on not picked")

      // switch the picked account off → even an explicitly picked account disappears
      await w.toggle(w.users.staff, c, [a2!.externalId], false)
      expect(await w.visibleAccounts(mcpPick.key)).toEqual([])
      await assertCall(mcpPick.key, "ads_list_objects", p, a2!.externalId, false, "picked but disabled")
      expect(await w.visibleAccounts(mcpAll.key)).toEqual(ids([a1!, a3!]))
      await w.toggle(w.users.staff, c, [a2!.externalId], true)
      expect(await w.visibleAccounts(mcpPick.key)).toEqual(ids([a2!]))

      // a newly synced account is disabled: not in "all", not reachable
      const extra = demoAccounts(w.prefix, "meta")[0]!
      const fresh = { ...extra, externalId: `${extra.externalId}77`, name: "Mới phát hiện" }
      w.setToken("meta", c.token, { accounts: [...demoAccounts(w.prefix, "meta"), fresh] })
      await w.sync(w.users.staff, c.id)
      expect(await w.visibleAccounts(mcpAll.key)).toEqual(ids([a1!, a2!, a3!]))
      await assertCall(mcpAll.key, "ads_list_objects", p, fresh.externalId, false, "new account")
      await w.toggle(w.users.staff, c, [fresh.externalId], true)
      expect(await w.visibleAccounts(mcpAll.key)).toEqual(ids([a1!, a2!, a3!, fresh]))
      await w.toggle(w.users.staff, c, [fresh.externalId], false)
      // restore the token spec for later tests
      w.setToken("meta", c.token, { accounts: demoAccounts(w.prefix, "meta") })
      await w.sync(w.users.staff, c.id)
    })

    it("a platform with permissions but no enabled account: tools stay listed, the AI is told there is nothing to act on, every call is refused", async () => {
      const c = await w.connect(w.users.staff, "openai_ads", [{ ...demoAccounts(w.prefix, "openai_ads")[0]!, externalId: `adacct_${w.prefix}off` }], { disabledExternalIds: [`adacct_${w.prefix}off`] })
      const mcp = await w.mcp(w.users.staff, {
        platforms: { openai_ads: { permissions: ["read", "update"], connections: [{ conn: c }] } },
      })
      expect([...(await w.tools(mcp.key)).names].sort()).toEqual(expectedTools({ openai_ads: ["read", "update"] }))
      const list = await w.call(mcp.key, "ads_list_accounts", {})
      expect(list.sc.accounts).toEqual([])
      expect((list.sc.warnings as string[]).join(" ")).toMatch(/chưa có tài khoản quảng cáo nào đang bật/)
      const report = await w.call(mcp.key, "ads_get_report", { level: "account", preset: "yesterday" })
      expect(report.sc.code).toBe("no_accounts")
      await assertCall(mcp.key, "ads_list_objects", "openai_ads", c.accounts[0]!.externalId, false, "only a disabled account")
    })

    it("a closed account (not returned by the platform any more) stays listed with status closed, a disabled connection exposes nothing", async () => {
      const own = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta").slice(0, 2).map((a) => ({ ...a, externalId: `${a.externalId}1` })))
      const mcp = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: own }] } } })
      const [x, y] = own.accounts
      w.setToken("meta", own.token, { accounts: demoAccounts(w.prefix, "meta").slice(0, 1).map((a) => ({ ...a, externalId: x!.externalId })) })
      await w.sync(w.users.staff, own.id)
      const list = await w.call(mcp.key, "ads_list_accounts", {})
      const byId = new Map((list.sc.accounts as { account_id: string; status: string }[]).map((a) => [a.account_id, a.status]))
      expect(byId.get(y!.externalId)).toBe("closed")
      expect(byId.get(x!.externalId)).toBe("active")
      // connection status "disabled" (set by an operator): accounts vanish and calls are refused at once
      await db.update(connections).set({ status: "disabled" }).where(eq(connections.id, own.id))
      w.reset()
      expect(await w.visibleAccounts(mcp.key)).toEqual([])
      await assertCall(mcp.key, "ads_list_objects", "meta", x!.externalId, false, "disabled connection")
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe("connection status as seen by the MCP", () => {
    it.each(["active", "expiring", "invalid"] as const)("%s connection: accounts listed; calls served unless the token is invalid", async (status) => {
      const c = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta").slice(0, 2).map((a) => ({ ...a, externalId: `${a.externalId}x${status.length}` })))
      for (const a of c.accounts) w.seedObjects(a.externalId, [{ id: "c1", level: "campaign", name: "C1", status: "active", parentId: null }])
      const mcp = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: c }] } } })
      await db.update(connections).set({ status }).where(eq(connections.id, c.id))
      w.reset()
      expect(await w.visibleAccounts(mcp.key)).toHaveLength(2)
      // the AI is told which connections are unhealthy BEFORE its calls start failing
      const listed = await w.call(mcp.key, "ads_list_accounts", {})
      expect((listed.sc.accounts as { connection_status: string }[]).map((x) => x.connection_status)).toEqual([status, status])
      expect(((listed.sc.warnings as string[]).join(" ").includes("token lỗi"))).toBe(status === "invalid")
      const r = await w.call(mcp.key, "ads_list_objects", invocation("ads_list_objects", "meta", c.accounts[0]!.externalId))
      if (status === "invalid") {
        expect(r.isError).toBe(true)
        expect(r.sc.code).toBe("auth_invalid")
        expect(r.sc.message).toMatch(/Token/)
      } else {
        expect(r.isError, r.text).toBe(false)
      }
    })

    it("a soft-deleted connection exposes nothing", async () => {
      const c = await w.connect(w.users.staff, "openai_ads", [{ ...demoAccounts(w.prefix, "openai_ads")[0]!, externalId: `adacct_${w.prefix}del` }])
      const mcp = await w.mcp(w.users.staff, { platforms: { openai_ads: { permissions: ["read"], connections: [{ conn: c }] } } })
      expect(await w.visibleAccounts(mcp.key)).toHaveLength(1)
      await w.removeConnection(w.users.staff, c.id)
      expect(await w.visibleAccounts(mcp.key)).toEqual([])
      await assertCall(mcp.key, "ads_list_objects", "openai_ads", c.accounts[0]!.externalId, false, "deleted connection")
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe("MCP status × owner → HTTP", () => {
    it.each([
      ["staff", "active", 200],
      ["admin", "active", 200],
      ["staff", "disabled", 404],
      ["staff", "expired", 404],
      ["staff", "deleted", 404],
      ["banned", "active", 404],
      ["admin", "disabled", 404],
      ["admin", "expired", 404],
    ] as const)("owner %s, MCP %s → %s", async (ownerKey, state, httpStatus) => {
      const owner = w.users[ownerKey]
      // the banned user (created banned) cannot create through the UI, so give it a connection + MCP directly
      const conn = ownerKey === "banned" ? await mkRawConnection(owner.id) : await w.connect(owner, "meta", demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}${ownerKey[0]}${state[0]}` })))
      const mcp = ownerKey === "banned" ? await mkRawMcp(owner.id, conn) : await w.mcp(owner, { platforms: { meta: { permissions: ["read"], connections: [{ conn }] } } })
      if (state === "disabled") await db.update(mcpServers).set({ status: "disabled" }).where(eq(mcpServers.id, mcp.id))
      if (state === "expired") await db.update(mcpServers).set({ expiresAt: new Date(Date.now() - 5000) }).where(eq(mcpServers.id, mcp.id))
      if (state === "deleted") await db.update(mcpServers).set({ deletedAt: new Date() }).where(eq(mcpServers.id, mcp.id))
      w.reset()
      for (const modern of [true, false]) {
        const t = await w.tools(mcp.key, { modern })
        expect(t.status).toBe(httpStatus)
      }
      const bad = await w.rpc(mcp.key, "tools/call", { name: "ads_list_accounts", arguments: {} })
      expect(bad.res.status).toBe(httpStatus)
      expect(bad.res.headers.get("www-authenticate")).toBeNull()
    })

    // ---- helpers for a banned owner (cannot go through the services as that user)
    async function mkRawConnection(ownerId: string): Promise<ConnInfo> {
      const { randomUUID } = await import("node:crypto")
      const { aad, encryptJson } = await import("@/server/crypto/secret-box")
      const id = randomUUID()
      await db.insert(connections).values({
        id,
        ownerId,
        platform: "meta",
        name: `${w.prefix} banned conn`,
        credentialsEncrypted: encryptJson({ token: "x" }, aad.connectionCredentials(id)),
        credentialHint: "xxxx",
        status: "active",
      })
      const [acc] = await db
        .insert(adAccounts)
        .values({ connectionId: id, platform: "meta", externalId: `act_${w.prefix}b`, name: "b", currency: "VND", timezone: "UTC", status: "active", isEnabled: true })
        .returning()
      return { id, platform: "meta", token: "x", ownerId, accounts: [{ id: acc!.id, externalId: acc!.externalId, isEnabled: true }] }
    }
    async function mkRawMcp(ownerId: string, conn: ConnInfo) {
      const { randomUUID } = await import("node:crypto")
      const { generateMcpKey, hashMcpKey, mcpKeyPrefix } = await import("@/server/crypto/mcp-key")
      const { aad, encryptSecret } = await import("@/server/crypto/secret-box")
      const { mcpPlatformPermissions } = await import("@/server/db/schema")
      const key = generateMcpKey()
      const id = randomUUID()
      await db.insert(mcpServers).values({ id, ownerId, name: `${w.prefix} banned mcp`, keyHash: hashMcpKey(key), keyPrefix: mcpKeyPrefix(key), keyEncrypted: encryptSecret(key, aad.mcpKey(id)), status: "active", settings: {} })
      await db.insert(mcpPlatformPermissions).values({ mcpId: id, platform: "meta", permissions: ["read"] })
      await db.insert(mcpAccountScopes).values({ mcpId: id, connectionId: conn.id, adAccountId: null })
      return { id, key }
    }
  })

  // ---------------------------------------------------------------------------------------------
  describe("randomised configurations against a reference model", () => {
    /** tiny seeded PRNG (mulberry32) so a failing configuration can be replayed */
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    it.each([11, 22, 33, 44, 55, 66, 77, 88])("seed %i", async (seed) => {
      const rand = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
      const subset = <T,>(xs: readonly T[], min = 0): T[] => {
        const out = xs.filter(() => rand() < 0.5)
        while (out.length < min) {
          const x = pick(xs)
          if (!out.includes(x)) out.push(x)
        }
        return out
      }
      const owner = pick([w.users.staff, w.users.staff2])
      const platforms = subset(PLATFORMS, 1)

      // fresh connections for this run: 1–2 per platform, some accounts switched off, some statuses degraded
      interface Model { conn: ConnInfo; status: "active" | "expiring" | "invalid" | "disabled"; enabled: Set<string>; picked: string[] | "all" }
      const model: Record<string, { perms: Permission[]; scopes: Model[] }> = {}
      for (const p of platforms) {
        const perms = normalize(subset(ALL_PERMS.filter((x) => x !== "read")))
        const scopes: Model[] = []
        const nConns = pick([1, 2])
        for (let c = 0; c < nConns; c++) {
          const accs = demoAccounts(w.prefix, p).map((a) => ({ ...a, externalId: `${a.externalId}${seed}${c}` }))
          const conn = await w.connect(owner, p, accs, { name: `${w.prefix} rnd ${seed} ${p} ${c}` })
          for (const a of conn.accounts) {
            w.seedObjects(a.externalId, [
              { id: "c1", level: "campaign", name: "C1", status: "active", parentId: null, budget: null },
              { id: "c2", level: "campaign", name: "C2", status: "paused", parentId: null, budget: null },
              { id: "g1", level: "ad_group", name: "G1", status: "active", parentId: "c1", budget: { type: "daily", amount: 100, level: "ad_group" } },
            ])
          }
          const off = subset(conn.accounts.map((a) => a.externalId))
          if (off.length) await w.toggle(owner, conn, off, false)
          const enabled = new Set(conn.accounts.map((a) => a.externalId).filter((e) => !off.includes(e)))
          const all = rand() < 0.5
          const wanted = all ? ("all" as const) : subset([...enabled], 1)
          scopes.push({ conn, status: "active", enabled, picked: all || enabled.size === 0 ? "all" : wanted })
        }
        model[p] = { perms, scopes }
      }
      const mcp = await w.mcp(owner, {
        settings: { twoStepConfirm: false },
        platforms: Object.fromEntries(
          platforms.map((p) => [p, { permissions: model[p]!.perms, connections: model[p]!.scopes.map((m) => ({ conn: m.conn, accounts: m.picked })) }])
        ),
      })
      // degrade connections AFTER the MCP exists (health changes behind its back)
      for (const p of platforms) {
        for (const m of model[p]!.scopes) {
          m.status = pick(["active", "active", "expiring", "invalid", "disabled"] as const)
          if (m.status !== "active") await db.update(connections).set({ status: m.status }).where(eq(connections.id, m.conn.id))
        }
      }
      w.reset()

      // ---- reference model: what the MCP may reach
      const reachable = new Map<string, Permission[]>() // "platform:account" → platform permissions
      for (const p of platforms) {
        for (const m of model[p]!.scopes) {
          if (m.status === "disabled") continue
          for (const e of m.enabled) if (m.picked === "all" || m.picked.includes(e)) reachable.set(`${p}:${e}`, model[p]!.perms)
        }
      }
      const label = `seed ${seed}`
      expect(await w.visibleAccounts(mcp.key), label).toEqual([...reachable.keys()].sort())
      const grants = Object.fromEntries(platforms.map((p) => [p, model[p]!.perms])) as Partial<Record<Platform, Permission[]>>
      for (const modern of [true, false]) expect([...(await w.tools(mcp.key, { modern })).names].sort(), label).toEqual(expectedTools(grants))

      // every account the test knows about, with every tool: served iff reachable AND the platform grants the permission
      const everyAccount: { platform: Platform; ext: string }[] = []
      for (const p of PLATFORMS) {
        for (const a of demoAccounts(w.prefix, p)) everyAccount.push({ platform: p, ext: a.externalId }) // never created in this run: foreign by construction
      }
      for (const p of platforms) for (const m of model[p]!.scopes) for (const a of m.conn.accounts) everyAccount.push({ platform: p, ext: a.externalId })
      for (const { platform: p, ext } of everyAccount) {
        const perms = reachable.get(`${p}:${ext}`)
        for (const tool of Object.keys(COMMON_TOOLS)) {
          if (tool === "ads_list_accounts") continue // not account scoped: it lists what IS reachable (asserted above)
          const served = !!perms && perms.includes(COMMON_TOOLS[tool]!)
          await assertCall(mcp.key, tool, p, ext, served, `${label} ${p}:${ext}`)
        }
      }
    })
  })

  // ---------------------------------------------------------------------------------------------
  describe("ownership: staff vs staff vs admin", () => {
    it("staff cannot put another user's connection into an MCP (service), a crafted scope row is ignored by the endpoint, admin can (D4)", async () => {
      const foreign = await w.connect(w.users.staff2, "meta", demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}f` })))
      const foreignAcc = foreign.accounts[0]!.externalId
      // 1) through the service (what the server action calls) → refused with a Vietnamese message
      await expect(
        w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: foreign }] } } })
      ).rejects.toThrow(/Kết nối không tồn tại|không có quyền/)
      await expect(
        w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: foreign, accounts: [foreignAcc] }] } } })
      ).rejects.toThrow()

      // 2) a crafted row written behind the service's back (SQL injection, old data, a bug elsewhere) is dropped by the grant loader
      const mine = conns.meta
      const mcp = await w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: mine, accounts: [mine.accounts[0]!.externalId] }] } } })
      await db.insert(mcpAccountScopes).values({ mcpId: mcp.id, connectionId: foreign.id, adAccountId: null })
      await db.insert(mcpAccountScopes).values({ mcpId: mcp.id, connectionId: foreign.id, adAccountId: foreign.accounts[0]!.id })
      w.reset()
      expect(await w.visibleAccounts(mcp.key)).toEqual([`meta:${mine.accounts[0]!.externalId}`])
      await assertCall(mcp.key, "ads_list_objects", "meta", foreignAcc, false, "crafted scope")
      await assertCall(mcp.key, "ads_set_status", "meta", foreignAcc, false, "crafted scope write")

      // 3) editing: staff2 cannot touch staff's MCP; an admin can edit it but the OWNER's rules still apply
      await expect(w.setEnabled(w.users.staff2, mcp.id, false)).rejects.toThrow(/Không tìm thấy MCP/)
      await expect(w.update(w.users.staff2, { id: mcp.id, ...w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: foreign }] } } }) })).rejects.toThrow(/Không tìm thấy MCP/)
      const adminOwn = await w.connect(w.users.admin, "meta", demoAccounts(w.prefix, "meta").map((a) => ({ ...a, externalId: `${a.externalId}a` })))
      await expect(
        w.update(w.users.admin, { id: mcp.id, ...w.toInput({ name: "edited by admin", platforms: { meta: { permissions: ["read"], connections: [{ conn: adminOwn }] } } }) })
      ).rejects.toThrow(/Kết nối không tồn tại/)
      const ok = await w.update(w.users.admin, { id: mcp.id, ...w.toInput({ name: "edited by admin", platforms: { meta: { permissions: ["read"], connections: [{ conn: mine }] } } }) })
      expect(ok.changed).toBe(true)
      expect(await w.visibleAccounts(mcp.key)).toHaveLength(mine.accounts.length)

      // 4) an admin-owned MCP may use any connection (D4)
      const adminMcp = await w.mcp(w.users.admin, {
        platforms: { meta: { permissions: ["read", "status"], connections: [{ conn: foreign }, { conn: mine }, { conn: adminOwn }] } },
      })
      expect(await w.visibleAccounts(adminMcp.key)).toEqual(
        [...foreign.accounts, ...mine.accounts, ...adminOwn.accounts].map((a) => `meta:${a.externalId}`).sort()
      )
      await assertCall(adminMcp.key, "ads_list_objects", "meta", foreignAcc, true, "admin MCP, staff connection")

      // 4b) a role string that merely CONTAINS "admin" is not admin anywhere (editor, wizard lists and endpoint agree)
      const userTable = (await import("@/server/db/schema")).user
      await db.update(userTable).set({ role: "admin,staff" }).where(eq(userTable.id, w.users.admin.id))
      expect((await (await import("@/server/services/mcp-servers")).getMcpServer(w.users.admin, adminMcp.id))!.ownerRole).toBe("staff")
      await db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, w.users.admin.id))

      // 5) demote the owner: an MCP that references somebody else's connection stops reaching it (fail closed)
      await db.update((await import("@/server/db/schema")).user).set({ role: "staff" }).where(eq((await import("@/server/db/schema")).user.id, w.users.admin.id))
      w.reset()
      expect(await w.visibleAccounts(adminMcp.key)).toEqual(adminOwn.accounts.map((a) => `meta:${a.externalId}`).sort())
      await db.update((await import("@/server/db/schema")).user).set({ role: "admin" }).where(eq((await import("@/server/db/schema")).user.id, w.users.admin.id))
    })

    it("rejects scope refs that do not belong together (account of another connection, wrong platform, duplicates)", async () => {
      const m = conns.meta
      const t = conns.openai_ads
      const bad = async (cfg: McpCfg, re: RegExp) => expect(w.mcp(w.users.staff, cfg)).rejects.toThrow(re)
      // account id of another connection of the same user
      const input = w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: m }] } } })
      input.platforms[0]!.connections[0]!.accountIds = [t.accounts[0]!.id]
      await expect(w.mcpRaw(w.users.staff, input)).rejects.toThrow(/Tài khoản quảng cáo không thuộc kết nối/)
      // OpenAI Ads connection listed under meta
      const wrong = w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: t }] } } })
      await expect(w.mcpRaw(w.users.staff, wrong)).rejects.toThrow(/không thuộc nền tảng/)
      // same connection twice
      const dup = w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: m }, { conn: m }] } } })
      await expect(w.mcpRaw(w.users.staff, dup)).rejects.toThrow(/trùng/)
      // nothing selected / unknown permission
      await bad({ platforms: {} }, /Chọn ít nhất 1 nền tảng/)
      const unknownPerm = w.toInput({ platforms: { meta: { permissions: ["read"], connections: [{ conn: m }] } } })
      ;(unknownPerm.platforms[0]!.permissions as string[]).push("superuser")
      await expect(w.mcpRaw(w.users.staff, unknownPerm)).rejects.toThrow()
      // a disabled account cannot be picked
      await w.toggle(w.users.staff, m, [m.accounts[2]!.externalId], false)
      await expect(w.mcp(w.users.staff, { platforms: { meta: { permissions: ["read"], connections: [{ conn: m, accounts: [m.accounts[2]!.externalId] }] } } })).rejects.toThrow(/đang bị tắt|không thuộc/)
      await w.toggle(w.users.staff, m, [m.accounts[2]!.externalId], true)
    })
  })
})
