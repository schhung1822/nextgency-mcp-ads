// System notices as an AI client sees them (.claude/docs/13-system-notices.md §4): a real MCP created through the
// services, called through the real endpoint. The notice block is the LAST text item of every tool result
// (success and error); structuredContent never changes. The dev database values are restored afterwards.
import { eq } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("server-only", () => ({}))

import { MCP_UPDATE_NOTICE } from "@/lib/system-notices"
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
import { resetNoticeCacheForTests } from "@/server/mcp/notices"
import { demoAccounts, loadTestEnv, World, type McpInfo } from "./world"

const hasDb = loadTestEnv()

describe.skipIf(!hasDb)(
  "system notices in MCP tool results",
  { timeout: 120_000 },
  () => {
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
        await db
          .delete(appSettings)
          .where(eq(appSettings.key, UPDATE_LATEST_KEY))
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
    const setNotices = (contents: string[]) =>
      writeStoredNotices(db, {
        items: contents.map((content, i) => ({ id: `n-${i}`, content })),
        fetchedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        error: null,
      })

    beforeAll(async () => {
      savedNotices = await readStoredNotices()
      savedLatest = (
        await db
          .select({ v: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, UPDATE_LATEST_KEY))
      )[0]?.v
      process.env.SYSTEM_NOTICES_URL = "https://notices.example.test/hook"
      w = await World.create()
      const conn = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(w.prefix, "meta")
      )
      mcp = await w.mcp(w.users.staff, {
        platforms: { meta: { permissions: ["read"], connections: [{ conn }] } },
      })
    }, 60_000)

    afterAll(async () => {
      if (savedNotices) await writeStoredNotices(db, savedNotices)
      else
        await db
          .delete(appSettings)
          .where(eq(appSettings.key, SYSTEM_NOTICES_KEY))
      if (savedLatest === undefined) await setLatest(null)
      else
        await db
          .insert(appSettings)
          .values({ key: UPDATE_LATEST_KEY, value: savedLatest })
          .onConflictDoUpdate({
            target: appSettings.key,
            set: { value: savedLatest },
          })
      process.env.SYSTEM_NOTICES_URL = env.url
      process.env.APP_BUILD_VERSION = env.build
      if (env.build === undefined) delete process.env.APP_BUILD_VERSION
      resetNoticesCache()
      resetNoticeCacheForTests()
      if (w) await w.cleanup()
    }, 60_000)

    beforeEach(() => {
      resetNoticesCache()
      resetNoticeCacheForTests()
    })

    it("update waiting + 2 notices → one block, update line first, one notice per line", async () => {
      process.env.APP_BUILD_VERSION = "1.0.0"
      await setLatest("1.1.0")
      await setNotices(["Bảo trì máy chủ lúc 22h", "Có video hướng dẫn mới"])
      const r = await w.call(mcp.key, "ads_list_accounts", {})
      expect(r.isError).toBe(false)
      expect(r.texts).toHaveLength(2)
      expect(r.texts![1]).toBe(
        [
          MCP_UPDATE_NOTICE,
          'Thông báo hệ thống Ads MCP Simple: "Bảo trì máy chủ lúc 22h"',
          'Thông báo hệ thống Ads MCP Simple: "Có video hướng dẫn mới"',
        ].join("\n")
      )
      // structured result is exactly what the tool produced (no notice inside)
      expect(JSON.stringify(r.sc)).not.toContain("Thông báo hệ thống")
      expect(Array.isArray(r.sc.accounts)).toBe(true)
    })

    it("error results carry the block too", async () => {
      process.env.APP_BUILD_VERSION = "1.0.0"
      await setLatest("1.1.0")
      await setNotices([])
      const r = await w.call(mcp.key, "ads_get_object", {
        platform: "meta",
        account_id: "act_not_in_grant",
        level: "campaign",
        id: "1",
      })
      expect(r.isError).toBe(true)
      expect(r.texts!.at(-1)).toBe(MCP_UPDATE_NOTICE)
    })

    it("already on the latest version and no notice → no extra item", async () => {
      process.env.APP_BUILD_VERSION = "1.1.0"
      await setLatest("1.1.0")
      await setNotices([])
      const r = await w.call(mcp.key, "ads_list_accounts", {})
      expect(r.texts).toHaveLength(1)
    })

    it("dev build (no release version) never shows the update line, notices still show", async () => {
      process.env.APP_BUILD_VERSION = "dev"
      await setLatest("9.9.9")
      await setNotices(["Chỉ thông báo"])
      const r = await w.call(mcp.key, "ads_list_accounts", {})
      expect(r.texts!.at(-1)).toBe(
        'Thông báo hệ thống Ads MCP Simple: "Chỉ thông báo"'
      )
    })
  }
)
