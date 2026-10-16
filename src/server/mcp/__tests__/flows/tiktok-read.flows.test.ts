// TikTok read additions of v1.1.6 end to end on the REAL MCP endpoint + DB, with the REAL TikTok getObject / lookup
// (TikTok API faked at fetch level): ads_get_object attaches extra.review + status_detail (C2/C3), ads_lookup
// kind=tiktok_posts takes parent_id / cursor and answers next_cursor without any temporary URL (C4).
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

import { __resetBuckets } from "@/server/providers/rate-limit"
import { registerProvider } from "@/server/providers/registry"
import {
  mockTikTok,
  type RecordedCall,
} from "@/server/providers/tiktok/__fixtures__/mock-fetch"
import { tiktokProvider } from "@/server/providers/tiktok"
import { createFlowsProvider } from "./fake-platforms"
import { demoAccounts, loadTestEnv, World, type ConnInfo } from "./world"

const hasDb = loadTestEnv()

const AD = {
  campaign_id: "1810000000000000001",
  adgroup_id: "1810000000000000101",
  ad_id: "1810000000000001001",
  ad_id_v2: "1810000000000001001",
  ad_name: "Video review 01",
  campaign_automation_type: "MANUAL",
  operation_status: "ENABLE",
  secondary_status: "AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK",
  tiktok_item_id: "7400000000000000001",
}
const IDENTITY = {
  identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
  identity_type: "TT_USER",
  display_name: "Shop",
}

describe.skipIf(!hasDb)(
  "TikTok read v1.1.6 (real getObject / lookup, faked TikTok API)",
  { timeout: 120_000 },
  () => {
    let w: World
    let api: ReturnType<typeof mockTikTok>

    beforeAll(async () => {
      w = await World.create()
      const base = createFlowsProvider("tiktok", w.state)
      registerProvider({
        ...base,
        parseCredentials: (raw) => {
          const c = base.parseCredentials(raw) as { token: string }
          return {
            ...c,
            accessToken: c.token,
            appId: "7000000000000000123",
            secret: "flows-secret",
          }
        },
        getObject: tiktokProvider.getObject as typeof base.getObject,
        lookup: tiktokProvider.lookup as typeof base.lookup,
      })
    }, 120_000)
    afterAll(async () => {
      vi.unstubAllGlobals()
      if (w) await w.cleanup()
    }, 60_000)
    beforeEach(() => {
      w.reset()
      __resetBuckets()
      api = mockTikTok({
        "GET /ad/get/": { list: [AD], page_info: { page: 1, total_page: 1 } },
        "GET /ad/review_info/": {
          ad_review_map: {
            [AD.ad_id]: {
              ad_id: AD.ad_id,
              is_approved: true,
              review_status: "PART_AVAILABLE",
              forbidden_placements: ["PLACEMENT_PANGLE"],
              reject_info: [
                {
                  reasons: ["Unclear audio"],
                  suggestion: "Add background audio",
                },
              ],
            },
          },
        },
        "GET /identity/get/": {
          identity_list: [IDENTITY],
          page_info: { total_page: 1 },
        },
        "GET /identity/video/get/": (c: RecordedCall) =>
          c.query.item_type === "CAROUSEL"
            ? { has_more: false, video_list: [] }
            : c.query.cursor
              ? {
                  cursor: "1700000000000",
                  has_more: false,
                  video_list: [
                    {
                      item_id: "7400000000000000002",
                      item_type: "VIDEO",
                      text: "Cũ",
                      video_info: { url: "https://cdn.example/v2.mp4" },
                    },
                  ],
                }
              : {
                  cursor: "1780432720000",
                  has_more: true,
                  video_list: [
                    {
                      item_id: "7400000000000000001",
                      item_type: "VIDEO",
                      status: "ITEM_STATUS_HESITATE_RECOMMEND",
                      text: "Sale",
                      video_info: {
                        duration: 12,
                        url: "https://cdn.example/v1.mp4",
                        poster_url: "https://cdn.example/p1.jpg",
                      },
                    },
                  ],
                },
      })
    })

    const connect = (): Promise<ConnInfo> =>
      w.connect(
        w.users.staff,
        "tiktok",
        demoAccounts(w.prefix, "tiktok").map((a) => ({
          ...a,
          externalId: `${a.externalId}${Math.floor(Math.random() * 1e6)}`,
        }))
      )

    it("ads_get_object (ad): extra.review + status_detail; lỗi review không làm hỏng kết quả", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        platforms: {
          tiktok: { permissions: ["read"], connections: [{ conn }] },
        },
      })
      const r = await w.call(mcp.key, "ads_get_object", {
        platform: "tiktok",
        account_id: conn.accounts[0]!.externalId,
        level: "ad",
        id: AD.ad_id,
      })
      expect(r.isError, r.text).toBe(false)
      const obj = r.sc.object as Record<string, unknown>
      expect(obj.status).toBe("active")
      expect(obj.status_detail).toBe("partially_approved")
      expect((obj.extra as Record<string, unknown>).review).toMatchObject({
        review_status: "PART_AVAILABLE",
        partially_approved: true,
        forbidden_placements: ["PLACEMENT_PANGLE"],
        reject_info: [
          { reasons: ["Unclear audio"], suggestion: "Add background audio" },
        ],
      })
      expect(
        api.callsTo("GET /ad/review_info/")[0]!.headers["access-token"]
      ).toBe(conn.token)
      expect(r.text).toMatch(/PART_AVAILABLE/)
    })

    it("ads_lookup kind=tiktok_posts: parent_id → bài đăng + used_in_ads, next_cursor → trang sau; không có URL", async () => {
      const conn = await connect()
      const mcp = await w.mcp(w.users.staff, {
        platforms: {
          tiktok: { permissions: ["read"], connections: [{ conn }] },
        },
      })
      const args = {
        platform: "tiktok",
        account_id: conn.accounts[0]!.externalId,
        kind: "tiktok_posts",
        parent_id: IDENTITY.identity_id,
        limit: 1,
      }
      const p1 = await w.call(mcp.key, "ads_lookup", args)
      expect(p1.isError, p1.text).toBe(false)
      const items = p1.sc.items as {
        id: string
        extra: Record<string, unknown>
      }[]
      expect(items.map((i) => i.id)).toEqual(["7400000000000000001"])
      expect(items[0]!.extra).toMatchObject({
        used_in_ads: 1,
        visibility: "công khai",
      })
      expect(typeof p1.sc.next_cursor).toBe("string")
      expect(p1.text).not.toMatch(/cdn\.example|https?:\/\//)

      const p2 = await w.call(mcp.key, "ads_lookup", {
        ...args,
        cursor: p1.sc.next_cursor,
      })
      expect(p2.isError, p2.text).toBe(false)
      expect((p2.sc.items as { id: string }[]).map((i) => i.id)).toEqual([
        "7400000000000000002",
      ])
      expect(
        api
          .callsTo("GET /identity/video/get/")
          .some((c) => c.query.cursor === "1780432720000")
      ).toBe(true)

      const missing = await w.call(mcp.key, "ads_lookup", {
        platform: "tiktok",
        account_id: conn.accounts[0]!.externalId,
        kind: "tiktok_posts",
      })
      expect(missing.isError).toBe(true)
      expect(missing.text).toMatch(/parent_id/)
    })
  }
)
