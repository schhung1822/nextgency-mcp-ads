// TikTok Social end to end (17-tiktok-social.md): REAL services + REAL endpoint, TikTok's Social MCP server faked at
// fetch level (shapes of the live probe 2026-11-15). Covers: an MCP with only TikTok accounts, owner rule on save,
// tool list, comments masked, call logs without third-party text, token refresh (expiring token, rejected token).
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { flushMcpLogs } from "@/server/audit/mcp-log-writer"
import { db } from "@/server/db/client"
import { mcpCallLogs, tiktokSocialAccounts } from "@/server/db/schema"
import { __setTiktokSocialFetch } from "@/server/tiktok-social/api"
import { decryptTiktokSocialTokens, encryptTiktokSocialTokens } from "@/server/tiktok-social/store"
import type { McpActor } from "@/server/services/mcp-servers"
import { DEFAULT_SETTINGS, loadTestEnv, World } from "./world"

const hasDb = loadTestEnv()
const TOOLS = [
  "tiktok_social_get_account",
  "tiktok_social_list_accounts",
  "tiktok_social_list_comments",
  "tiktok_social_list_mentions",
  "tiktok_social_list_videos",
  "tiktok_social_trends",
]

describe.skipIf(!hasDb)("TikTok Social (faked TikTok Social MCP server)", { timeout: 120_000 }, () => {
  let w: World
  const ids: string[] = []
  /** TikTok tool calls seen: tool name + bearer token */
  const seen: { tool: string; token: string; args: Record<string, unknown> }[] = []
  let tokenCalls = 0
  /** tokens TikTok rejects (HTTP 401) */
  const rejected = new Set<string>()

  async function seedAccount(owner: McpActor, username: string, o: { accessExpiresAt?: Date } = {}) {
    const id = crypto.randomUUID()
    await db.insert(tiktokSocialAccounts).values({
      id,
      ownerId: owner.id,
      name: `Kênh ${username}`,
      username,
      clientId: "client-test",
      credentialsEncrypted: encryptTiktokSocialTokens(id, { accessToken: `AT_${username}`, refreshToken: `RT_${username}` }),
      accessExpiresAt: o.accessExpiresAt ?? new Date(Date.now() + 20 * 3_600_000),
      refreshExpiresAt: new Date(Date.now() + 300 * 86_400_000),
      isBusinessAccount: false,
    })
    ids.push(id)
    return id
  }

  const input = (accountIds: string[], over: Record<string, unknown> = {}) => ({
    name: `${w.prefix} tiktok social`,
    description: null,
    platforms: [],
    settings: DEFAULT_SETTINGS,
    expiresAt: null,
    tiktokSocialAccountIds: accountIds,
    ...over,
  })

  beforeAll(async () => {
    w = await World.create()
    __setTiktokSocialFetch(async (url, init) => {
      if (url.endsWith("/oauth/tiktok/token")) {
        tokenCalls++
        const body = new URLSearchParams(String(init.body))
        const rt = body.get("refresh_token") ?? ""
        return new Response(JSON.stringify({ access_token: `${rt.replace("RT_", "AT2_")}`, expires_in: 86400, token_type: "Bearer" }), {
          headers: { "content-type": "application/json" },
        })
      }
      const token = String((init.headers as Record<string, string>).authorization ?? "").replace("Bearer ", "")
      if (rejected.has(token)) return new Response("", { status: 401 })
      const rpc = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } }
      seen.push({ tool: rpc.params.name, token, args: rpc.params.arguments })
      const api =
        rpc.params.name === "account_user_comment_list_get"
          ? {
              code: 0,
              message: "OK",
              data: {
                has_more: false,
                comments: [
                  {
                    comment_id: "7690031793488233236",
                    create_time: "1790475100",
                    text: "Inbox em sđt 0912345678 nha",
                    username: "khach_lan",
                    display_name: "Lan Nguyễn",
                    profile_image: "https://p16.tiktokcdn.com/a.jpeg?x-signature=SIG",
                    owner: false,
                    likes: 2,
                    reply_list: [],
                  },
                ],
              },
            }
          : rpc.params.name === "discovery_search"
            ? { code: 0, data: { search_keywords: ["trend A", "trend B"] } }
            : { code: 40002, message: "Invalid params: test" }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(api) }] } }), {
        headers: { "content-type": "application/json" },
      })
    })
  }, 120_000)

  afterAll(async () => {
    __setTiktokSocialFetch(null)
    if (ids.length) await db.delete(tiktokSocialAccounts).where(inArray(tiktokSocialAccounts.id, ids))
    if (w) await w.cleanup()
  }, 60_000)

  beforeEach(() => {
    w.reset()
    seen.length = 0
    tokenCalls = 0
    rejected.clear()
  })

  it("an MCP with only TikTok accounts is valid and lists exactly the tiktok_social_* tools; staff cannot pick another's account", async () => {
    const mine = await seedAccount(w.users.staff, `${w.prefix}a`)
    const other = await seedAccount(w.users.staff2, `${w.prefix}b`)
    await expect(w.mcpRaw(w.users.staff, input([other]))).rejects.toMatchObject({ fieldErrors: { tiktokSocialAccountIds: expect.any(String) } })
    const m = await w.mcpRaw(w.users.staff, input([mine]))
    expect((await w.tools(m.key)).names.sort()).toEqual(TOOLS)
    const r = await w.call(m.key, "tiktok_social_list_accounts", {})
    expect(r.isError, r.text).toBe(false)
    expect(r.sc.accounts).toEqual([expect.objectContaining({ account_id: mine, username: `${w.prefix}a`, is_business_account: false })])
    // nothing at all → refused
    await expect(w.mcpRaw(w.users.staff, input([]))).rejects.toMatchObject({ fieldErrors: { platforms: expect.any(String) } })
  })

  it("comments: Page token of the account, contacts masked, call logs keep counts / ids only", async () => {
    const acc = await seedAccount(w.users.staff, `${w.prefix}c`)
    const m = await w.mcpRaw(w.users.staff, input([acc]))
    const r = await w.call(m.key, "tiktok_social_list_comments", { account_id: `@${w.prefix}c`, video_id: "7690027971402337544" })
    expect(r.isError, r.text).toBe(false)
    expect(seen[0]).toMatchObject({ tool: "account_user_comment_list_get", token: `AT_${w.prefix}c` })
    expect(r.sc.comments[0]).toMatchObject({ text: "Inbox em sđt [SĐT ẩn …678] nha", author: { username: "khach_lan", display_name: "Lan Nguyễn" } })
    expect(r.sc.masked).toEqual({ phones: 1, emails: 0 })
    expect(JSON.stringify(r.sc)).not.toMatch(/0912345678|x-signature/)
    await flushMcpLogs()
    const logs = JSON.stringify(await db.select().from(mcpCallLogs).where(eq(mcpCallLogs.mcpId, m.id)))
    expect(logs).toContain("7690031793488233236")
    for (const s of ["Lan Nguyễn", "khach_lan", "Inbox em", "SĐT ẩn", `AT_${w.prefix}c`]) expect(logs, s).not.toContain(s)
  })

  it("an account outside the MCP is refused; TikTok parameter errors come back as tool errors", async () => {
    const acc = await seedAccount(w.users.staff, `${w.prefix}d`)
    const m = await w.mcpRaw(w.users.staff, input([acc]))
    let r = await w.call(m.key, "tiktok_social_get_account", { account_id: "@someone_else" })
    expect(r.sc.code).toBe("tiktok_account_not_in_scope")
    r = await w.call(m.key, "tiktok_social_list_mentions", { account_id: acc, kind: "posts" })
    expect(r.isError).toBe(true)
    expect(r.sc.code).toBe("tiktok_invalid_request")
  })

  it("an expiring token is refreshed before the call; a rejected token is refreshed once and retried", async () => {
    const acc = await seedAccount(w.users.staff, `${w.prefix}e`, { accessExpiresAt: new Date(Date.now() + 60_000) })
    const m = await w.mcpRaw(w.users.staff, input([acc]))
    let r = await w.call(m.key, "tiktok_social_trends", { account_id: acc, kind: "trending_keywords" })
    expect(r.isError, r.text).toBe(false)
    expect(tokenCalls).toBe(1)
    expect(seen[0]!.token).toBe(`AT2_${w.prefix}e`)
    const [row] = await db.select().from(tiktokSocialAccounts).where(eq(tiktokSocialAccounts.id, acc))
    expect(decryptTiktokSocialTokens(row!)).toEqual({ accessToken: `AT2_${w.prefix}e`, refreshToken: `RT_${w.prefix}e` })
    expect(row!.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000)

    // TikTok now rejects the stored token: one forced refresh, the call goes through with the new one
    rejected.add(`AT2_${w.prefix}e`)
    seen.length = 0
    tokenCalls = 0
    r = await w.call(m.key, "tiktok_social_trends", { account_id: acc, kind: "trending_keywords" })
    expect(tokenCalls).toBe(1)
    // the fake issues the same AT2_ token again → still rejected → the account is flagged invalid
    expect(r.isError).toBe(true)
    expect(r.sc.code).toBe("tiktok_account_needs_reconnect")
    const [after] = await db.select().from(tiktokSocialAccounts).where(eq(tiktokSocialAccounts.id, acc))
    expect(after!.status).toBe("invalid")
  })
})

