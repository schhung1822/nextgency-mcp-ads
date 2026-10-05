// Regression (owner decision 2026-10-05, .claude/docs/13-system-notices.md §4): MCP tool results carry NO system
// notice and NO update reminder - webhook content must never reach the AI context (prompt injection). A real MCP
// created through the services, called through the real endpoint, while an update is waiting and two notices are
// stored. The dev database values are restored afterwards.
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { db } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"
import {
  readStoredNotices,
  resetNoticesCache,
  SYSTEM_NOTICES_KEY,
  writeStoredNotices,
  type StoredNotices,
} from "@/server/jobs/lib/system-notices"
import { UPDATE_LATEST_KEY } from "@/server/jobs/lib/update-check"
import { demoAccounts, loadTestEnv, World, type McpInfo } from "./world"

const hasDb = loadTestEnv()

const NOTICE_MARKERS = /Thông báo hệ thống|có bản update|Bảo trì máy chủ|Có video hướng dẫn/

describe.skipIf(!hasDb)("MCP tool results never carry system notices", { timeout: 120_000 }, () => {
  let w: World
  let mcp: McpInfo
  let savedNotices: StoredNotices | null = null
  let savedLatest: unknown = undefined
  const env = {
    url: process.env.SYSTEM_NOTICES_URL,
    build: process.env.APP_BUILD_VERSION,
  }

  const setLatest = async (version: string | null) => {
    if (version === null) {
      await db.delete(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY))
      return
    }
    const value = {
      version,
      tag: `v${version}`,
      publishedAt: null,
      notes: "",
      url: "https://github.com/x/y",
      checkedAt: new Date().toISOString(),
    }
    await db
      .insert(appSettings)
      .values({ key: UPDATE_LATEST_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } })
  }

  beforeAll(async () => {
    savedNotices = await readStoredNotices()
    savedLatest = (await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, UPDATE_LATEST_KEY)))[0]?.v
    // the notices feature is ON (web top bar would show them) - MCP must still ignore them
    process.env.SYSTEM_NOTICES_URL = "https://notices.example.test/hook"
    w = await World.create()
    const conn = await w.connect(w.users.staff, "meta", demoAccounts(w.prefix, "meta"))
    mcp = await w.mcp(w.users.staff, {
      platforms: { meta: { permissions: ["read"], connections: [{ conn }] } },
    })
  }, 60_000)

  afterAll(async () => {
    if (savedNotices) await writeStoredNotices(db, savedNotices)
    else await db.delete(appSettings).where(eq(appSettings.key, SYSTEM_NOTICES_KEY))
    if (savedLatest === undefined) await setLatest(null)
    else
      await db
        .insert(appSettings)
        .values({ key: UPDATE_LATEST_KEY, value: savedLatest })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: savedLatest } })
    process.env.SYSTEM_NOTICES_URL = env.url
    process.env.APP_BUILD_VERSION = env.build
    if (env.build === undefined) delete process.env.APP_BUILD_VERSION
    resetNoticesCache()
    if (w) await w.cleanup()
  }, 60_000)

  beforeEach(async () => {
    // an update is waiting (1.1.0 > 1.0.0) and two notices are stored
    process.env.APP_BUILD_VERSION = "1.0.0"
    await setLatest("1.1.0")
    await writeStoredNotices(db, {
      items: [
        { id: "n-1", content: "Bảo trì máy chủ lúc 22h" },
        { id: "n-2", content: "Có video hướng dẫn mới" },
      ],
      fetchedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      error: null,
    })
    resetNoticesCache()
  })

  it("a successful tool call returns only the tool's own content", async () => {
    const r = await w.call(mcp.key, "ads_list_accounts", {})
    expect(r.isError).toBe(false)
    expect(r.texts).toHaveLength(1)
    expect(r.texts![0]).toBe(r.text)
    expect(r.text).not.toMatch(NOTICE_MARKERS)
    expect(JSON.stringify(r.sc)).not.toMatch(NOTICE_MARKERS)
    expect(Array.isArray(r.sc.accounts)).toBe(true)
  })

  it("an error tool result returns only the tool's own content", async () => {
    const r = await w.call(mcp.key, "ads_get_object", {
      platform: "meta",
      account_id: "act_not_in_grant",
      level: "campaign",
      id: "1",
    })
    expect(r.isError).toBe(true)
    expect(r.texts).toHaveLength(1)
    expect(r.text.startsWith("Lỗi: ")).toBe(true)
    expect(r.text).not.toMatch(NOTICE_MARKERS)
    expect(JSON.stringify(r.sc)).not.toMatch(NOTICE_MARKERS)
  })
})
