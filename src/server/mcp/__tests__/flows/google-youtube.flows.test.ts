// Google Ads (incl. YouTube) + TikTok specifics of the common tools, through the real services and endpoint:
// account ids with dashes, level keyword (Google only), channel / network filters (Google only, handed to the
// adapter), YouTube videos in ads_upload_media (no download), TikTok effective_at.
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

import {
  demoAccounts,
  loadTestEnv,
  World,
  type ConnInfo,
  type McpInfo,
} from "./world"

const hasDb = loadTestEnv()

describe.skipIf(!hasDb)(
  "Google Ads / YouTube / TikTok in the common tools",
  { timeout: 180_000 },
  () => {
    let w: World
    let google: ConnInfo
    let meta: ConnInfo
    let tiktok: ConnInfo
    let mcp: McpInfo

    beforeAll(async () => {
      w = await World.create()
      google = await w.connect(
        w.users.staff,
        "google_ads",
        demoAccounts(w.prefix, "google_ads")
      )
      meta = await w.connect(
        w.users.staff,
        "meta",
        demoAccounts(w.prefix, "meta")
      )
      tiktok = await w.connect(
        w.users.staff,
        "tiktok",
        demoAccounts(w.prefix, "tiktok")
      )
      for (const c of [google, meta, tiktok]) {
        for (const a of c.accounts) {
          w.seedObjects(a.externalId, [
            {
              id: "c1",
              level: "campaign",
              name: "C1",
              status: "active",
              parentId: null,
              budget: { type: "daily", amount: 100, level: "campaign" },
            },
          ])
        }
      }
      const all = ["read", "status", "update", "create", "delete"] as const
      mcp = await w.mcp(w.users.staff, {
        settings: { twoStepConfirm: false },
        platforms: {
          google_ads: {
            permissions: [...all],
            connections: [{ conn: google }],
          },
          meta: { permissions: [...all], connections: [{ conn: meta }] },
          tiktok: { permissions: [...all], connections: [{ conn: tiktok }] },
        },
      })
    }, 120_000)
    afterAll(async () => {
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      w.state.reportCalls.length = 0
    })

    const gAcc = () => google.accounts[0]!.externalId
    const dashed = (id: string) =>
      `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`

    it("Google account ids are accepted with dashes (123-456-7890)", async () => {
      const r = await w.call(mcp.key, "ads_list_objects", {
        platform: "google_ads",
        account_id: dashed(gAcc()),
        level: "campaign",
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.account_id).toBe(gAcc())
    })

    it("level keyword only for Google Ads", async () => {
      const m = meta.accounts[0]!.externalId
      for (const [tool, args] of [
        [
          "ads_list_objects",
          { platform: "meta", account_id: m, level: "keyword" },
        ],
        [
          "ads_get_object",
          { platform: "meta", account_id: m, level: "keyword", id: "k1" },
        ],
        [
          "ads_set_status",
          {
            platform: "meta",
            account_id: m,
            level: "keyword",
            ids: ["k1"],
            status: "paused",
          },
        ],
        [
          "ads_delete_object",
          { platform: "meta", account_id: m, level: "keyword", id: "k1" },
        ],
        [
          "ads_update_object",
          {
            platform: "meta",
            account_id: m,
            level: "keyword",
            id: "k1",
            name: "x",
          },
        ],
        [
          "ads_get_report",
          {
            platforms: ["meta", "google_ads"],
            level: "keyword",
            preset: "yesterday",
          },
        ],
      ] as const) {
        const r = await w.call(mcp.key, tool, args as Record<string, unknown>)
        expect(r.isError, `${tool}: ${r.text}`).toBe(true)
        expect(r.sc.code, tool).toBe("invalid_level")
      }
      const ok = await w.call(mcp.key, "ads_list_objects", {
        platform: "google_ads",
        account_id: gAcc(),
        level: "keyword",
      })
      expect(ok.isError, ok.text).toBe(false)
    })

    it("channel_types / ad_network_types: Google only, handed to the adapter; not at level account", async () => {
      const mixed = await w.call(mcp.key, "ads_get_report", {
        level: "campaign",
        preset: "yesterday",
        filters: { channel_types: ["youtube"] },
      })
      expect(mixed.isError).toBe(true)
      expect(mixed.sc.code).toBe("invalid_filter")
      const accountLevel = await w.call(mcp.key, "ads_get_report", {
        platforms: ["google_ads"],
        level: "account",
        preset: "yesterday",
        filters: { channel_types: ["VIDEO"] },
      })
      expect(accountLevel.sc.code).toBe("invalid_filter")
      const bad = await w.call(mcp.key, "ads_get_report", {
        platforms: ["google_ads"],
        level: "campaign",
        filters: { channel_types: ["TV"] },
      })
      expect(bad.isError).toBe(true)

      const r = await w.call(mcp.key, "ads_get_report", {
        platforms: ["google_ads"],
        level: "campaign",
        preset: "yesterday",
        filters: {
          channel_types: ["youtube", "PERFORMANCE_MAX"],
          ad_network_types: ["YOUTUBE"],
        },
      })
      expect(r.isError, r.text).toBe(false)
      expect(w.state.reportCalls.length).toBeGreaterThan(0)
      for (const c of w.state.reportCalls) {
        expect(c.platform).toBe("google_ads")
        expect(c.filters).toMatchObject({
          channelTypes: ["youtube", "PERFORMANCE_MAX"],
          adNetworkTypes: ["YOUTUBE"],
        })
      }

      const listMeta = await w.call(mcp.key, "ads_list_objects", {
        platform: "meta",
        account_id: meta.accounts[0]!.externalId,
        level: "campaign",
        channel_types: ["youtube"],
      })
      expect(listMeta.sc.code).toBe("invalid_filter")
      const listGoogle = await w.call(mcp.key, "ads_list_objects", {
        platform: "google_ads",
        account_id: gAcc(),
        level: "campaign",
        channel_types: ["youtube"],
      })
      expect(listGoogle.isError, listGoogle.text).toBe(false)
    })

    it("ads_upload_media on Google: a YouTube video becomes an asset without any download; other video URLs are refused", async () => {
      const refused = await w.call(mcp.key, "ads_upload_media", {
        platform: "google_ads",
        account_id: gAcc(),
        type: "video",
        url: "https://example.com/a.mp4",
      })
      expect(refused.isError).toBe(true)
      expect(refused.sc.code).toBe("unsupported_media")
      expect(w.state.executions.filter((e) => e.op === "upload")).toHaveLength(
        0
      )

      const fetchSpy = vi.spyOn(globalThis, "fetch")
      const ok = await w.call(mcp.key, "ads_upload_media", {
        platform: "google_ads",
        account_id: gAcc(),
        type: "video",
        url: "https://youtu.be/dQw4w9WgXcQ",
      })
      expect(ok.isError, ok.text).toBe(false)
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
      const up = w.state.executions.filter((e) => e.op === "upload")
      expect(up).toHaveLength(1)
      expect(up[0]!.args).toMatchObject({
        type: "video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      })
    })

    it("TikTok budget changes report when they take effect", async () => {
      const r = await w.call(mcp.key, "ads_update_budget", {
        platform: "tiktok",
        account_id: tiktok.accounts[0]!.externalId,
        level: "campaign",
        id: "c1",
        budget_type: "daily",
        amount: 120,
      })
      expect(r.isError, r.text).toBe(false)
      expect(r.sc.effective_at).toBe("next_day")
    })
  }
)
