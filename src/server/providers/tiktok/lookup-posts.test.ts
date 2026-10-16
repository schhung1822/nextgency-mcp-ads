// C4 (v1.1.6): ads_lookup kind=tiktok_posts → GET /identity/video/get/ (doc 1740218475032577) + used_in_ads estimate
// from /ad/get/ (no tiktok_item_id filter there, doc 1735735588640770).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import {
  fail,
  makeCtx,
  mockTikTok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { tiktokLookup } from "./lookup"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const TT_USER = {
  identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
  identity_type: "TT_USER",
  display_name: "Shop",
  can_pull_video: true,
}
const BC = {
  identity_id: "7000000000000000777",
  identity_type: "BC_AUTH_TT",
  identity_authorized_bc_id: "7000000000000000009",
  display_name: "BC acc",
}
const AUTH = { identity_id: "a1", identity_type: "AUTH_CODE", display_name: "Auth" }
const CUSTOM = {
  identity_id: "c1",
  identity_type: "CUSTOMIZED_USER",
  display_name: "Custom",
}

const video = (
  id: string,
  text: string,
  extra: Record<string, unknown> = {}
) => ({
  item_id: id,
  item_type: "VIDEO",
  status: "ITEM_STATUS_HESITATE_RECOMMEND",
  text,
  auth_info: null,
  anchor_list: null,
  carousel_info: null,
  video_info: {
    duration: 13.84,
    width: 1080,
    height: 1920,
    url: "https://v16.tiktokcdn.example/video.mp4?x-expires=1",
    poster_url: "https://p16.tiktokcdn.example/poster.jpg",
    signature: "abc",
  },
  ...extra,
})
const carousel = (id: string) => ({
  item_id: id,
  item_type: "CAROUSEL",
  status: "ITEM_STATUS_ONLY_AUTHOR_SEE",
  text: "Ảnh",
  video_info: null,
  carousel_info: {
    image_info: [
      { image_id: "i1", image_url: "https://p16.example/1.jpg" },
      { image_id: "i2", image_url: "https://p16.example/2.jpg" },
    ],
    music_info: { music_id: "m1", music_url: "https://m.example/1.mp3" },
  },
})

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /identity/get/": {
      identity_list: [TT_USER, BC, CUSTOM, AUTH],
      page_info: { total_page: 1 },
    },
    "GET /identity/video/get/": (c: RecordedCall) =>
      c.query.item_type === "CAROUSEL"
        ? {
            cursor: "0",
            has_more: false,
            video_list: [carousel("7400000000000000003")],
          }
        : {
            cursor: "1780432720000",
            has_more: false,
            video_list: [
              video("7400000000000000001", "Sale 50%\u202E"),
              video("7400000000000000002", "Review"),
            ],
          },
    "GET /ad/get/": {
      list: [
        {
          ad_id: "1",
          ad_id_v2: "1",
          ad_name: "Spark A",
          tiktok_item_id: "7400000000000000001",
          operation_status: "ENABLE",
          secondary_status: "AD_STATUS_DELIVERY_OK",
        },
        {
          ad_id: "2",
          ad_id_v2: "2",
          ad_name: "Spark B",
          tiktok_item_id: "7400000000000000001",
          operation_status: "DISABLE",
          secondary_status: "AD_STATUS_DISABLE",
        },
        {
          ad_id: "3",
          ad_id_v2: "3",
          ad_name: "Video",
          operation_status: "ENABLE",
          secondary_status: "AD_STATUS_DELIVERY_OK",
        },
      ],
      page_info: { total_page: 1 },
    },
    ...over,
  }
}

describe("ads_lookup kind=tiktok_posts", () => {
  it("TT_USER: tự tra identity_type, gọi VIDEO rồi CAROUSEL, đánh dấu used_in_ads, không trả URL", async () => {
    const m = mockTikTok(routes())
    const r = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
    })
    const calls = m.callsTo("GET /identity/video/get/")
    expect(calls.map((c) => c.query.item_type)).toEqual(["VIDEO", "CAROUSEL"])
    expect(calls[0]!.query).toMatchObject({
      identity_id: TT_USER.identity_id,
      identity_type: "TT_USER",
      count: "20",
    })
    expect(calls[0]!.query).not.toHaveProperty("identity_authorized_bc_id")
    expect(calls[0]!.query).not.toHaveProperty("keyword")
    expect(r.items.map((i) => i.id)).toEqual([
      "7400000000000000001",
      "7400000000000000002",
      "7400000000000000003",
    ])
    expect(r.items[0]).toMatchObject({
      name: "Sale 50%",
      extra: {
        item_type: "VIDEO",
        visibility: "công khai",
        duration_s: 13.8,
        width: 1080,
        height: 1920,
        used_in_ads: 2,
      },
    })
    expect((r.items[0]!.extra!.ads as unknown[]).length).toBe(2)
    expect(r.items[0]!.extra!.ads).toEqual([
      { ad_id: "1", ad_name: "Spark A", status: "active" },
      { ad_id: "2", ad_name: "Spark B", status: "paused" },
    ])
    expect(r.items[1]!.extra!.used_in_ads).toBe(0)
    expect(r.items[2]!.extra).toMatchObject({
      item_type: "CAROUSEL",
      visibility: "riêng tư",
      image_count: 2,
      has_music: true,
    })
    expect(JSON.stringify(r.items)).not.toMatch(/https?:|tiktokcdn|signature/)
    expect(r.nextCursor).toBeNull()
    expect(r.warnings.join(" ")).toMatch(/ước lượng/)
    // /ad/get/ scan asks only the fields it needs
    expect(m.callsTo("GET /ad/get/")[0]!.query).toMatchObject({
      filtering: { primary_status: "STATUS_NOT_DELETE" },
      page_size: "1000",
    })
    expect(m.callsTo("GET /ad/get/")[0]!.query.fields).toContain(
      "tiktok_item_id"
    )
  })

  it("BC_AUTH_TT: gửi identity_authorized_bc_id (tự lấy từ danh sách khi thiếu)", async () => {
    const m = mockTikTok(routes())
    await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: BC.identity_id,
      identityType: "BC_AUTH_TT",
    })
    expect(m.callsTo("GET /identity/video/get/")[0]!.query).toMatchObject({
      identity_type: "BC_AUTH_TT",
      identity_authorized_bc_id: "7000000000000000009",
    })
    // explicit values are still checked against the account's identities (BC not in the plain list → BC query)
    const m2 = mockTikTok(
      routes({
        "GET /identity/get/": (c: RecordedCall) =>
          c.query.identity_type === "BC_AUTH_TT"
            ? { identity_list: [{ identity_id: "777", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "123" }] }
            : { identity_list: [TT_USER], page_info: { total_page: 1 } },
      })
    )
    await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: "777",
      identityType: "BC_AUTH_TT",
      identityAuthorizedBcId: "123",
    })
    expect(m2.callsTo("GET /identity/get/").map((c) => c.query.identity_type ?? null)).toEqual([null, "BC_AUTH_TT"])
    expect(m2.callsTo("GET /identity/get/")[1]!.query.identity_authorized_bc_id).toBe("123")
    expect(m2.callsTo("GET /identity/video/get/")[0]!.query).toMatchObject({
      identity_id: "777",
      identity_authorized_bc_id: "123",
    })
  })

  it("identity_type / BC id do AI truyền vẫn phải thuộc tài khoản quảng cáo; BC id lệch → từ chối, không gọi /identity/video/get/", async () => {
    const m = mockTikTok(routes())
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", { parentId: "999", identityType: "TT_USER" })
    ).rejects.toThrow(/Không tìm thấy identity/)
    // type mismatch: TT_USER id passed as AUTH_CODE
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", { parentId: TT_USER.identity_id, identityType: "AUTH_CODE" })
    ).rejects.toThrow(/Không tìm thấy identity/)
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", {
        parentId: BC.identity_id,
        identityType: "BC_AUTH_TT",
        identityAuthorizedBcId: "7000000000000000010",
      })
    ).rejects.toThrow(/không khớp/)
    expect(m.callsTo("GET /identity/video/get/")).toHaveLength(0)
  })

  it("item_type / status / ad_auth_status được làm sạch (ký tự ẩn, độ dài)", async () => {
    mockTikTok(
      routes({
        "GET /identity/video/get/": (c: RecordedCall) =>
          c.query.item_type === "CAROUSEL"
            ? { has_more: false, video_list: [] }
            : {
                has_more: false,
                video_list: [
                  video("7400000000000000001", "A", {
                    item_type: "VIDEO\u202E",
                    status: "S".repeat(100),
                    auth_info: { ad_auth_status: "AUTHORIZED\u200B\n", auth_end_time: "2026-12-01 00:00:00" },
                  }),
                ],
              },
      })
    )
    const r = await tiktokLookup(makeCtx(), "tiktok_posts", { parentId: AUTH.identity_id })
    const extra = r.items[0]!.extra!
    expect(extra.item_type).toBe("VIDEO")
    expect(String(extra.status).length).toBeLessThanOrEqual(40)
    expect(extra.ad_auth_status).toBe("AUTHORIZED")
    expect(extra.auth_end_time).toBe("2026-12-01T00:00:00.000Z")
  })

  it("thiếu parent_id / identity không có / CUSTOMIZED_USER → lỗi tiếng Việt có gợi ý", async () => {
    mockTikTok(routes())
    await expect(tiktokLookup(makeCtx(), "tiktok_posts", {})).rejects.toThrow(
      /parent_id/
    )
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", { parentId: "nope" })
    ).rejects.toThrow(/Không tìm thấy identity/)
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", { parentId: "c1" })
    ).rejects.toThrow(/CUSTOMIZED_USER/)
    const e = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: "nope",
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ProviderError)
    expect((e as ProviderError).hint).toMatch(/kind=identities/)
  })

  it("phân trang: cursor TikTok (chuỗi số) gửi lại nguyên vẹn qua next_cursor; cursor sai truy vấn bị từ chối", async () => {
    const m = mockTikTok(
      routes({
        "GET /identity/video/get/": (c: RecordedCall) =>
          c.query.cursor === "1780432720000"
            ? {
                cursor: "1780000000000",
                has_more: false,
                video_list: [video("7400000000000000009", "Cũ")],
              }
            : {
                cursor: "1780432720000",
                has_more: true,
                video_list: [
                  video("7400000000000000001", "Mới"),
                  video("7400000000000000002", "Mới 2"),
                ],
              },
      })
    )
    const p1 = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
      limit: 2,
    })
    expect(p1.items).toHaveLength(2)
    expect(p1.nextCursor).toBeTruthy()
    expect(m.callsTo("GET /identity/video/get/")[0]!.query.count).toBe("2")
    const p2 = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
      limit: 2,
      cursor: p1.nextCursor!,
    })
    const last = m
      .callsTo("GET /identity/video/get/")
      .find((c) => c.query.cursor === "1780432720000")
    expect(last).toBeTruthy()
    expect(p2.items[0]!.id).toBe("7400000000000000009")
    await expect(
      tiktokLookup(makeCtx(), "tiktok_posts", {
        parentId: TT_USER.identity_id,
        q: "khác",
        cursor: p1.nextCursor!,
      })
    ).rejects.toThrow(/Cursor không hợp lệ/)
  })

  it("q: AUTH_CODE gửi keyword; loại khác lọc phía app và cảnh báo", async () => {
    const m = mockTikTok(routes())
    await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: "a1",
      identityType: "AUTH_CODE",
      q: "sale",
    })
    expect(m.callsTo("GET /identity/video/get/")[0]!.query.keyword).toBe("sale")
    const m2 = mockTikTok(routes())
    const r = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
      q: "review",
    })
    expect(m2.callsTo("GET /identity/video/get/")[0]!.query).not.toHaveProperty(
      "keyword"
    )
    expect(r.items.map((i) => i.id)).toEqual(["7400000000000000002"])
    expect(r.warnings.join(" ")).toMatch(/Lọc theo q/)
  })

  it("lỗi đọc /ad/get/ → used_in_ads null + cảnh báo; lỗi CAROUSEL giữ bài video", async () => {
    mockTikTok(
      routes({
        "GET /ad/get/": fail(40001, "no permission"),
        "GET /identity/video/get/": (c: RecordedCall) =>
          c.query.item_type === "CAROUSEL"
            ? fail(40002, "bad item_type")
            : {
                has_more: false,
                video_list: [video("7400000000000000001", "A")],
              },
      })
    )
    const r = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
    })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.extra).not.toHaveProperty("used_in_ads")
    expect(r.warnings.join(" ")).toMatch(/Không đối chiếu được/)
    expect(r.warnings.join(" ")).toMatch(/CAROUSEL/)
  })

  it("item_id dạng số đã mất chữ số → bỏ qua kèm cảnh báo", async () => {
    mockTikTok(
      routes({
        "GET /identity/video/get/": (c: RecordedCall) =>
          c.query.item_type === "CAROUSEL"
            ? { has_more: false, video_list: [] }
            : {
                has_more: false,
                video_list: [video("x", "A", { item_id: 7.4e18 })],
              },
      })
    )
    const r = await tiktokLookup(makeCtx(), "tiktok_posts", {
      parentId: TT_USER.identity_id,
    })
    expect(r.items).toHaveLength(0)
    expect(r.warnings.join(" ")).toMatch(/item_id không hợp lệ/)
  })
})
