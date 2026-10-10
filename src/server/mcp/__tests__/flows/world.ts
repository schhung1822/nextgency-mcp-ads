// End-to-end test world: real users in the dev DB, fake providers for all four platforms, and helpers
// that drive the REAL services (connections, ad-accounts, mcp-servers) and the REAL endpoint (serveMcp).
//
// Test files that use this module MUST declare `vi.mock("server-only", () => ({}))` (the services import it)
// and skip themselves when `loadTestEnv()` finds no DATABASE_URL:
//
//   const hasDb = loadTestEnv()
//   describe.skipIf(!hasDb)("…", () => { const w = await createWorld() … })
//
// Run: DATABASE_URL=postgres://…/some_test_db node vitest.mjs run src/server/mcp/__tests__/flows
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { expect } from "vitest"

import { toStoredMcpSettings, type McpSettingsInput } from "@/lib/schemas/mcp-servers"
import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import { db } from "@/server/db/client"
import { activityLogs, adAccounts, connections, mcpCallLogs, mcpServers, user } from "@/server/db/schema"
import { invalidateGrantCache } from "@/server/mcp/grant"
import { __resetRateLimits } from "@/server/mcp/rate-limit"
import { serveMcp } from "@/server/mcp/serve"
import type { Permission } from "@/server/mcp/types"
import { registerProvider } from "@/server/providers/registry"
import { PLATFORMS, type AdAccountInfo, type Platform } from "@/server/providers/types"
import {
  createConnection,
  deleteConnection,
  previewConnection,
  renameConnection,
  replaceCredentials,
  syncConnectionAccounts,
  testConnection,
  type Actor,
} from "@/server/services/connections"
import { setAdAccountsEnabled } from "@/server/services/ad-accounts"
import { acceptDisclaimer } from "@/server/services/disclaimers"
import { DISCLAIMER_KINDS, DISCLAIMER_VERSIONS, type DisclaimerKind } from "@/lib/disclaimers"
import {
  createMcpServer,
  rotateMcpKey,
  setMcpEnabled,
  updateMcpServer,
  deleteMcpServer,
  type McpActor,
} from "@/server/services/mcp-servers"

import { loadTestEnv, mcpRequest, modernMeta, readRpc, TEST_HOST } from "../helpers"
import { createFlowsProvider, newFlowsState, type FlowsState, type TokenSpec } from "./fake-platforms"

export { loadTestEnv, TEST_HOST }
// the endpoint validates Host against APP_DOMAIN
process.env.APP_DOMAIN = TEST_HOST

export const okVerify = async () => "ok" as const

export interface ConnInfo {
  id: string
  platform: Platform
  token: string
  ownerId: string
  /** ad_accounts rows (uuid + external id) in creation order */
  accounts: { id: string; externalId: string; isEnabled: boolean }[]
}

export interface McpPlatformCfg {
  permissions: Permission[]
  connections: {
    conn: ConnInfo
    /** "all" (default) or the external ids of the accounts to pick */
    accounts?: "all" | string[]
  }[]
}

export interface McpCfg {
  name?: string
  platforms: Partial<Record<Platform, McpPlatformCfg>>
  settings?: Partial<McpSettingsInput>
  expiresAt?: Date | null
  /** Telegram channel ids in scope (omitted = none) */
  notificationChannelIds?: string[]
}

export interface McpInfo {
  id: string
  key: string
  url: string
}

export interface ToolResult {
  isError: boolean
  sc: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: structured content is inspected loosely
  text: string
  /** every text content item */
  texts?: string[]
}

/**
 * Daily caps every test MCP gets unless the test overrides that currency: caps are mandatory for MCPs with
 * write permissions, and this high value never limits a test that is not about caps.
 */
export const DEFAULT_TEST_DAILY_CAPS: Record<string, number> = { VND: 1e12, USD: 1e12, JPY: 1e12, EUR: 1e12 }

export const DEFAULT_SETTINGS: McpSettingsInput = {
  twoStepConfirm: true,
  budgetChangeMaxPct: 50,
  maxDailyBudget: {},
  maxLifetimeBudget: {},
  maxBid: {},
  rateLimitPerMin: 600,
  writeRateLimitPer10Min: 1000,
  allowedIps: [],
  telegramTool: false,
  telegramNotifyWrites: false,
  telegramMessagesPerHour: 20,
  // off in the shared fixture: a system Drive API key created by the Drive flows (same test DB, files run in
  // parallel) must not add drive_* tools to the exact tool lists other flows assert; drive.flows turns it on
  drivePublicLinks: false,
  driveSheetWriteback: true,
  tiktokGmvMaxWrite: false,
}

export class World {
  readonly prefix = `fl${randomUUID().slice(0, 8)}`
  readonly state: FlowsState = newFlowsState()
  users!: { admin: McpActor; staff: McpActor; staff2: McpActor; banned: McpActor }
  private readonly mcpIds: string[] = []
  private readonly userIds: string[] = []
  private seq = 0

  /** Register fakes for all platforms and create the users. */
  static async create(): Promise<World> {
    const w = new World()
    for (const p of PLATFORMS) registerProvider(createFlowsProvider(p, w.state))
    const mk = async (role: "admin" | "staff", label: string, banned = false): Promise<McpActor> => {
      const id = `${w.prefix}_${label}`
      const email = `${id}@example.test`
      await db.insert(user).values({ id, name: `${w.prefix} ${label}`, email, emailVerified: true, role, banned })
      w.userIds.push(id)
      return { id, email, role }
    }
    w.users = {
      admin: await mk("admin", "admin"),
      staff: await mk("staff", "staff"),
      staff2: await mk("staff", "staff2"),
      banned: await mk("staff", "banned", true),
    }
    return w
  }

  async cleanup() {
    await flushMcpLogs()
    if (this.mcpIds.length) await db.delete(mcpCallLogs).where(inArray(mcpCallLogs.mcpId, this.mcpIds))
    await db.delete(mcpServers).where(inArray(mcpServers.ownerId, this.userIds))
    await db.delete(connections).where(inArray(connections.ownerId, this.userIds))
    await db.delete(activityLogs).where(inArray(activityLogs.actorId, this.userIds))
    await db.delete(user).where(inArray(user.id, this.userIds))
  }

  /** Per-test reset of process-level state (rate limiters, grant cache) and of the fake state. */
  reset() {
    __resetRateLimits()
    invalidateGrantCache()
    this.state.executions.length = 0
    this.state.reportCalls.length = 0
    this.state.credentialsSeen.length = 0
    this.state.failingAccounts.clear()
  }

  // -------------------------------------------------------------------------
  // Platform side
  // -------------------------------------------------------------------------
  /** Register a token (what the fake platform answers for it) and return it. */
  token(platform: Platform, accounts: AdAccountInfo[], o: Omit<TokenSpec, "accounts"> = {}): string {
    const token = `tok_${platform}_${this.prefix}_${++this.seq}`
    this.state.tokens.set(`${platform}:${token}`, { accounts, ...o })
    return token
  }

  setToken(platform: Platform, token: string, patch: Partial<TokenSpec>) {
    const key = `${platform}:${token}`
    this.state.tokens.set(key, { accounts: [], ...this.state.tokens.get(key), ...patch })
  }

  /** Seed fake objects for an account (campaigns / ad groups / ads). */
  seedObjects(externalId: string, objects: import("../fake-provider").FakeObject[]) {
    this.state.objects.set(externalId, objects)
  }

  // -------------------------------------------------------------------------
  // Connections (REAL services)
  // -------------------------------------------------------------------------
  async connect(
    actor: Actor,
    platform: Platform,
    accounts: AdAccountInfo[],
    o: { name?: string; disabledExternalIds?: string[]; spec?: Omit<TokenSpec, "accounts"> } = {}
  ): Promise<ConnInfo> {
    const token = this.token(platform, accounts, o.spec)
    const { id } = await createConnection(actor, {
      platform,
      name: o.name ?? `${this.prefix} ${platform} ${this.seq}`,
      credentials: { token },
      disabledExternalIds: o.disabledExternalIds,
    })
    return { id, platform, token, ownerId: actor.id, accounts: await this.accountRows(id) }
  }

  async accountRows(connectionId: string) {
    const rows = await db.select().from(adAccounts).where(eq(adAccounts.connectionId, connectionId)).orderBy(adAccounts.externalId)
    return rows.map((r) => ({ id: r.id, externalId: r.externalId, isEnabled: r.isEnabled }))
  }

  async refreshConn(c: ConnInfo): Promise<ConnInfo> {
    return { ...c, accounts: await this.accountRows(c.id) }
  }

  async connRow(id: string) {
    const [r] = await db.select().from(connections).where(eq(connections.id, id))
    return r!
  }

  preview = previewConnection
  sync = syncConnectionAccounts
  test = testConnection
  replace = replaceCredentials
  rename = renameConnection
  removeConnection = deleteConnection
  toggleAccounts = setAdAccountsEnabled

  /** Enable/disable accounts (by external id) through the service. */
  async toggle(actor: Actor, c: ConnInfo, externalIds: string[], enabled: boolean) {
    const rows = await this.accountRows(c.id)
    const changes = rows.filter((r) => externalIds.includes(r.externalId)).map((r) => ({ adAccountId: r.id, enabled }))
    await setAdAccountsEnabled(actor, { connectionId: c.id, changes })
  }

  // -------------------------------------------------------------------------
  // MCP servers (REAL services)
  // -------------------------------------------------------------------------
  toInput(cfg: McpCfg) {
    return {
      name: cfg.name ?? `${this.prefix} mcp ${++this.seq}`,
      description: null,
      platforms: (Object.entries(cfg.platforms) as [Platform, McpPlatformCfg][]).map(([platform, p]) => ({
        platform,
        permissions: p.permissions,
        connections: p.connections.map(({ conn, accounts }) => ({
          connectionId: conn.id,
          accountIds:
            accounts === undefined || accounts === "all"
              ? null
              : conn.accounts.filter((a) => accounts.includes(a.externalId)).map((a) => a.id),
        })),
      })),
      settings: {
        ...DEFAULT_SETTINGS,
        ...cfg.settings,
        maxDailyBudget: { ...DEFAULT_TEST_DAILY_CAPS, ...cfg.settings?.maxDailyBudget },
      },
      expiresAt: cfg.expiresAt ? cfg.expiresAt.toISOString() : null,
      ...(cfg.notificationChannelIds ? { notificationChannelIds: cfg.notificationChannelIds } : {}),
    }
  }

  /**
   * Record that `actor` read and accepted the current "Miễn trừ trách nhiệm" texts (what the popup does): the create
   * ACTIONS (connection, Telegram, Drive source, MCP) refuse without it. Services called directly do not check it.
   */
  async acceptDisclaimers(actor: McpActor, kinds: readonly DisclaimerKind[] = DISCLAIMER_KINDS) {
    for (const kind of kinds) await acceptDisclaimer(actor, { kind, version: DISCLAIMER_VERSIONS[kind] })
  }

  async mcp(actor: McpActor, cfg: McpCfg): Promise<McpInfo> {
    return this.mcpRaw(actor, this.toInput(cfg))
  }

  /** createMcpServer with a hand-made (possibly invalid) input. */
  async mcpRaw(actor: McpActor, input: unknown): Promise<McpInfo> {
    const r = await createMcpServer(actor, input, okVerify)
    this.mcpIds.push(r.id)
    return { id: r.id, url: r.url, key: keyOf(r.url) }
  }

  /**
   * Turn an MCP into a row written before the security release: stored settings WITHOUT `money_caps_required`
   * (caps optional, preview warnings only). `settings` replaces the defaults (daily caps default to none).
   */
  async makeLegacy(mcpId: string, settings: Partial<McpSettingsInput> = {}) {
    const { money_caps_required: _flag, ...stored } = toStoredMcpSettings({ ...DEFAULT_SETTINGS, ...settings })
    await db.update(mcpServers).set({ settings: stored }).where(eq(mcpServers.id, mcpId))
    invalidateGrantCache(mcpId)
  }

  update = updateMcpServer
  rotate = rotateMcpKey
  setEnabled = setMcpEnabled
  removeMcp = deleteMcpServer

  // -------------------------------------------------------------------------
  // Endpoint
  // -------------------------------------------------------------------------
  async rpc(
    key: string,
    method: string,
    params: Record<string, unknown> = {},
    o: { modern?: boolean; headers?: Record<string, string> } = {}
  ) {
    const modern = o.modern ?? true
    const body = { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params: modern ? { ...params, _meta: modernMeta() } : params }
    const res = await serveMcp(mcpRequest(key, body, { modern, headers: o.headers }), key)
    const msgs = res.status === 200 ? await readRpc(res) : []
    return { res, msg: msgs.find((m) => m.id === body.id) ?? msgs[0] }
  }

  /** tools/list (status code + tool names). */
  async tools(key: string, o: { modern?: boolean } = {}): Promise<{ status: number; names: string[] }> {
    const { res, msg } = await this.rpc(key, "tools/list", {}, o)
    if (res.status !== 200) return { status: res.status, names: [] }
    return { status: 200, names: (msg.result.tools as { name: string }[]).map((t) => t.name) }
  }

  /**
   * tools/call. A JSON-RPC level error (tool not registered / input rejected by the SDK) is reported as
   * `{ isError: true, rpcError }` so permission tests can treat "refused" uniformly.
   */
  async call(
    key: string,
    name: string,
    args: Record<string, unknown>,
    o: { modern?: boolean; headers?: Record<string, string> } = {}
  ): Promise<ToolResult & { status: number; rpcError?: { code: number; message: string } }> {
    const { res, msg } = await this.rpc(key, "tools/call", { name, arguments: args }, o)
    if (res.status !== 200) return { status: res.status, isError: true, sc: {}, text: "" }
    if (msg?.error) return { status: 200, isError: true, sc: {}, text: String(msg.error.message ?? ""), rpcError: msg.error }
    return {
      status: 200,
      isError: Boolean(msg.result.isError),
      sc: (msg.result.structuredContent ?? {}) as ToolResult["sc"],
      text: String(msg.result.content?.[0]?.text ?? ""),
      texts: ((msg.result.content ?? []) as { text?: string }[]).map((c) => String(c.text ?? "")),
    }
  }

  /** accounts as the AI sees them (ads_list_accounts) - `platform:account_id`, sorted. */
  async visibleAccounts(key: string): Promise<string[]> {
    const r = await this.call(key, "ads_list_accounts", {})
    expect(r.isError, r.text).toBe(false)
    return (r.sc.accounts as { platform: string; account_id: string }[]).map((a) => `${a.platform}:${a.account_id}`).sort()
  }
}

export function keyOf(url: string): string {
  return url.slice(url.lastIndexOf("/mcp/") + 5)
}

/** Deterministic digits derived from the world prefix (unique per test run). */
function digitsOf(prefix: string, len: number): string {
  let h = 7
  for (const ch of prefix) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000_007
  return String(h).padStart(len, "1").slice(0, len)
}

/** Standard fixture accounts of a platform (ids are unique per world prefix). */
export function demoAccounts(prefix: string, platform: Platform): AdAccountInfo[] {
  const d = digitsOf(prefix, 9)
  const idOf = (n: number) =>
    platform === "meta"
      ? `act_${d}${n}`
      : platform === "tiktok"
        ? `70${d}${n}`
        : platform === "google_ads"
          ? `${[...d].reverse().join("")}${n}` // differs from the Meta digits: a bare number must not match across platforms
          : `adacct_${prefix}${n}`
  const mk = (n: number, currency: string, timezone: string): AdAccountInfo => ({
    externalId: idOf(n),
    name: `${platform} ${n} ${currency}`,
    currency,
    timezone,
    status: "active",
    statusRaw: "ACTIVE",
  })
  switch (platform) {
    case "meta":
      return [mk(1, "VND", "Asia/Ho_Chi_Minh"), mk(2, "USD", "America/New_York"), mk(3, "JPY", "Asia/Tokyo")]
    case "tiktok":
      return [mk(1, "VND", "Asia/Ho_Chi_Minh"), mk(2, "USD", "UTC")]
    case "google_ads":
      return [mk(1, "EUR", "Europe/Berlin"), mk(2, "USD", "America/Los_Angeles")]
    case "openai_ads":
      return [mk(1, "USD", "America/Los_Angeles")] // one key = one account
    default:
      throw new Error(`no fixture accounts for ${platform} (not shipped in this build)`)
  }
}
