// v1.1.5 review fixes: deeplink safety, sanitised tiktok_messaging_assets output, BC_AUTH_TT identities, phone format
// outside VN, Spark photo carousel, copy of messaging-app ads without links.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import adFixture from "./__fixtures__/ad_get.json"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import {
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { adCreativeFromSource, copyTikTokObject } from "./copy"
import { tiktokExtensions } from "./extensions"
import { PROMO_DM, PROMO_IM } from "./messaging"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

type Json = Record<string, unknown>
const ext = (name: string) => tiktokExtensions.find((e) => e.name === name)!
const RLO = String.fromCharCode(0x202e)
const BEL = String.fromCharCode(7)
const ZWSP = String.fromCharCode(0x200b)
const NOW = new Date("2026-10-02T08:00:00Z")

function withRow(fixture: Json, patch: Json, i = 0): Json {
  const f = structuredClone(fixture) as { data: { list: Json[] } }
  f.data.list[i] = { ...f.data.list[i], ...patch }
  return f as unknown as Json
}

const video = {
  ad_name: "Spark 01",
  ad_format: "SINGLE_VIDEO",
  identity_type: "TT_USER",
  identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
  video_id: "v10033g50000bbbb",
  image_ids: ["cover-1"],
  ad_text: "Freeship toàn quốc",
  call_to_action: "SHOP_NOW",
  landing_page_url: "https://shop.example.vn/a",
}

describe("deeplink: chỉ dạng scheme:…, không ký tự điều khiển / bidi, không scheme nguy hiểm", () => {
  const parse = (deeplink: string) =>
    ext("tiktok_create_ads").input.safeParse({
      adgroup_id: "1",
      creatives: [{ ...video, deeplink }],
    })

  it("nhận scheme ứng dụng và https", () => {
    for (const ok of [
      "whatsapp://send?phone=84901234567",
      "shopapp://product/1",
      "https://shop.vn/p",
      "zalo.me:x",
    ])
      expect(parse(ok).success, ok).toBe(true)
  })

  it("từ chối javascript: / data: / vbscript: / file:, thiếu scheme, ký tự điều khiển / bidi", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "//shop.vn/x",
      "1abc://x",
      "shop app://x".replace(" ", ""),
      `whatsapp://send${RLO}gpj`,
      `whatsapp://send${BEL}`,
      `whatsapp://se${ZWSP}nd`,
    ].filter((b) => b !== "shopapp://x")) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it("nhóm IM_URL chỉ dùng deeplink_type NORMAL", async () => {
    mockTikTok({
      "GET /adgroup/get/": {
        body: withRow(adgroupFixture, {
          promotion_type: PROMO_IM,
          messaging_app_type: "IM_URL",
          optimization_goal: "CLICK",
          pixel_id: undefined,
        }),
      },
      "GET /ad/get/": ok({ list: [], page_info: { total_number: 0 } }),
    })
    const e = ext("tiktok_create_ads")
    const creative = {
      ...video,
      call_to_action: "SEND_MESSAGE",
      landing_page_url: "https://wa.me/1",
      deeplink: "whatsapp://send",
      fallback_type: "WEBSITE",
      deeplink_type: "DEFERRED_DEEPLINK",
    }
    await expect(
      e.run(
        makeCtx(),
        e.input.parse({
          adgroup_id: "1810000000000000101",
          creatives: [creative],
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(/deeplink_type NORMAL/)
  })
})

describe("CAROUSEL_ADS từ bài ảnh Spark (tiktok_item_id) không cần image_ids", () => {
  const routes = {
    "GET /adgroup/get/": { body: adgroupFixture },
    "GET /ad/get/": ok({ list: [], page_info: { total_number: 0 } }),
    "POST /ad/create/": ok({ ad_ids: ["1850000000000000001"] }),
  }
  const e = () => ext("tiktok_create_ads")

  it("có tiktok_item_id → tạo được; không có → vẫn bắt buộc image_ids", async () => {
    const m = mockTikTok(routes)
    const carousel = {
      ad_name: "Ảnh Spark",
      ad_format: "CAROUSEL_ADS",
      identity_type: "TT_USER",
      identity_id: "id-1",
      tiktok_item_id: "7400000000000000999",
    }
    await e().run(
      makeCtx(),
      e().input.parse({
        adgroup_id: "1810000000000000101",
        creatives: [carousel],
      }),
      {}
    )
    expect(
      (m.callsTo("POST /ad/create/")[0]!.body!.creatives as Json[])[0]
    ).toMatchObject({
      ad_format: "CAROUSEL_ADS",
      tiktok_item_id: "7400000000000000999",
    })
    mockTikTok(routes)
    await expect(
      e().run(
        makeCtx(),
        e().input.parse({
          adgroup_id: "1810000000000000101",
          creatives: [{ ...carousel, tiktok_item_id: undefined, ad_text: "x" }],
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(/cần image_ids/)
  })
})

describe("tiktok_messaging_assets: đầu ra được làm sạch", () => {
  const run = (input: Json) =>
    ext("tiktok_messaging_assets").run(
      makeCtx(),
      ext("tiktok_messaging_assets").input.parse(input),
      {}
    ) as Promise<{ items: Json[]; warnings: string[] }>

  it("id chỉ nhận chuỗi chữ số; chuỗi ngắn qua label; preview_url bỏ ký tự ẩn / khoảng trắng rồi mới kiểm tra https", async () => {
    mockTikTok({
      "GET /page/get/": ok({
        list: [
          {
            page_id: "7400000000000000000001",
            title: `Trang${RLO}A`,
            status: `PUBLISHED${BEL}`,
            messaging_app_type: `WHATSAPP${RLO}`,
            messaging_app_account_id: "84901234567",
            preview_url: ` https://ads.tiktok.com/${ZWSP}p/1 `,
            supported_objectives: ["LEAD_GENERATION", `X${RLO}`],
          },
          {
            page_id: 7400000000000000000,
            title: "số JSON",
            preview_url: "javascript:alert(1)",
          },
          { page_id: "abc", preview_url: `${RLO}https://x.vn` },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const r = await run({ kind: "instant_pages" })
    expect(r.items[0]).toMatchObject({
      page_id: "7400000000000000000001",
      title: "TrangA",
      status: "PUBLISHED",
      messaging_app_type: "WHATSAPP",
      messaging_app_account_id: "84901234567",
      preview_url: "https://ads.tiktok.com/p/1",
      supported_objectives: ["LEAD_GENERATION", "X"],
    })
    expect(r.items[1]).toMatchObject({ page_id: null, preview_url: null })
    expect(r.items[2]).toMatchObject({
      page_id: null,
      preview_url: "https://x.vn",
    })
  })

  it("welcome / event set: id không phải chữ số → null; event set không id hợp lệ bị bỏ", async () => {
    mockTikTok({
      "GET /creative/auto_message/get/": ok({
        list: [
          {
            auto_message_id: `12${RLO}3`,
            audit_status: `PASS${RLO}`,
            welcome_message: { title: "t", content: "c" },
          },
        ],
        page_info: { total_page: 1 },
      }),
      "GET /ctm/message_event_set/get/": ok({
        message_event_set_list: [
          { message_event_set_id: "x1" },
          {
            message_event_set_id: "7430000000000000001",
            message_event_name: `Zalo${BEL}`,
          },
        ],
      }),
    })
    const w = await run({ kind: "welcome_messages" })
    expect(w.items[0]).toMatchObject({
      auto_message_id: null,
      audit_status: "PASS",
    })
    const ev = await run({
      kind: "message_event_sets",
      messaging_app_type: "ZALO",
      messaging_app_account_id: "123",
    })
    expect(ev.items).toEqual([
      {
        message_event_set_id: "7430000000000000001",
        message_event_name: "Zalo",
        create_time: null,
      },
    ])
  })

  it("dm_identities: hỏi thêm identity_type=BC_AUTH_TT theo Business Center đã biết; cảnh báo nhắc kiểm tra Business Center", async () => {
    const m = mockTikTok({
      "GET /identity/get/": (c: RecordedCall) =>
        c.query.identity_type === "BC_AUTH_TT"
          ? ok({
              identity_list: [
                {
                  identity_id: "bc-1",
                  identity_type: "BC_AUTH_TT",
                  identity_authorized_bc_id: c.query.identity_authorized_bc_id,
                  can_manage_message: false,
                },
                {
                  identity_id: "bc-2",
                  identity_type: "BC_AUTH_TT",
                  identity_authorized_bc_id: c.query.identity_authorized_bc_id,
                  can_manage_message: false,
                },
              ],
            })
          : ok({
              identity_list: [
                {
                  identity_id: "tt-1",
                  identity_type: "TT_USER",
                  can_manage_message: false,
                },
                {
                  identity_id: "bc-1",
                  identity_type: "BC_AUTH_TT",
                  identity_authorized_bc_id: "7000000000000000009",
                  can_manage_message: false,
                },
              ],
              page_info: { total_page: 1 },
            }),
    })
    const r = await run({
      kind: "dm_identities",
      identity_authorized_bc_id: "7000000000000000001",
    })
    const bcCalls = m
      .callsTo("GET /identity/get/")
      .filter((c) => c.query.identity_type === "BC_AUTH_TT")
    expect(
      bcCalls.map((c) => c.query.identity_authorized_bc_id).sort()
    ).toEqual(["7000000000000000001", "7000000000000000009"])
    expect(r.items.map((i) => i.identity_id).sort()).toEqual([
      "bc-1",
      "bc-2",
      "tt-1",
    ])
    expect(r.warnings.join(" ")).toMatch(
      /Business Center \(BC_AUTH_TT\) có thể không hiện/
    )
  })
})

describe("số điện thoại ngoài VN", () => {
  it("không bỏ / không từ chối số 0 đầu, gửi nguyên chữ số kèm cảnh báo; VN vẫn từ chối số 0 đầu", async () => {
    const lead = withRow(campaignFixture, { objective_type: "LEAD_GENERATION" })
    const e = ext("tiktok_create_adgroup")
    const base = {
      campaign_id: "1810000000000000001",
      name: "WA",
      location_ids: ["1562822"],
      budget_type: "daily",
      budget: 300000,
      optimization_goal: "CLICK",
      schedule_start_time: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`,
    }
    const m = mockTikTok({
      "GET /campaign/get/": { body: lead },
      "POST /adgroup/create/": ok({ adgroup_id: "1" }),
    })
    const res = (await e.run(
      makeCtx(),
      e.input.parse({
        ...base,
        messaging: {
          destination: "WHATSAPP",
          phone_region_code: "TH",
          phone_region_calling_code: "+66",
          phone_number: "081 234 5678",
        },
      }),
      {}
    )) as { warnings: string[] }
    expect(m.callsTo("POST /adgroup/create/")[0]!.body).toMatchObject({
      phone_region_code: "TH",
      phone_region_calling_code: "+66",
      phone_number: "0812345678",
    })
    expect(res.warnings.join(" ")).toMatch(
      /mã vùng TH chưa được TikTok mô tả rõ/
    )
    mockTikTok({ "GET /campaign/get/": { body: lead } })
    await expect(
      e.run(
        makeCtx(),
        e.input.parse({
          ...base,
          messaging: { destination: "ZALO", phone_number: "0987654321" },
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(/số 0 ở đầu/)
  })
})

describe("sao chép quảng cáo nhóm ứng dụng nhắn tin: không gửi lại link TikTok tự điền", () => {
  const imGroup = (app: string) =>
    withRow(adgroupFixture, {
      promotion_type: PROMO_IM,
      messaging_app_type: app,
      optimization_goal: "CLICK",
    })
  const adWithLinks = withRow(adFixture, {
    call_to_action: "SEND_MESSAGE",
    landing_page_url: "https://zalo.me/84901234567",
    deeplink: "zalo://chat",
    fallback_type: "WEBSITE",
    page_id: "7400000000000000000001",
  })

  it("adCreativeFromSource: Zalo / Messenger / WhatsApp / LINE bỏ landing_page_url + deeplink*, giữ page_id; IM_URL, DM và nhóm thường giữ nguyên", () => {
    const src = (adWithLinks as { data: { list: Json[] } }).data.list[0]!
    const row = (f: Json) => (f as { data: { list: Json[] } }).data.list[0]!
    for (const app of ["ZALO", "MESSENGER", "WHATSAPP", "LINE"]) {
      const c = adCreativeFromSource(src, "x", row(imGroup(app)))
      expect(c, app).not.toHaveProperty("landing_page_url")
      expect(c, app).not.toHaveProperty("deeplink")
      expect(c, app).not.toHaveProperty("fallback_type")
      expect(c.page_id, app).toBe("7400000000000000000001")
    }
    const plain = adCreativeFromSource(src, "x")
    expect(adCreativeFromSource(src, "x", row(imGroup("IM_URL")))).toEqual(
      plain
    )
    expect(
      adCreativeFromSource(
        src,
        "x",
        row(withRow(adgroupFixture, { promotion_type: PROMO_DM }))
      )
    ).toEqual(plain)
    expect(
      adCreativeFromSource(src, "x", row(adgroupFixture as unknown as Json))
    ).toEqual(plain)
    expect(plain).toMatchObject({
      landing_page_url: "https://zalo.me/84901234567",
      deeplink: "zalo://chat",
    })
  })

  it("copy ad trong cùng nhóm Zalo: đọc nhóm rồi tạo không có link", async () => {
    const m = mockTikTok({
      "GET /ad/get/": { body: adWithLinks },
      "GET /adgroup/get/": { body: imGroup("ZALO") },
      "POST /ad/create/": ok({ ad_ids: ["1990000000000000001"] }),
    })
    await copyTikTokObject(makeCtx(), {
      level: "ad",
      id: "1810000000000001001",
      deep: false,
      nameSuffix: " v2",
    })
    const cr = (m.callsTo("POST /ad/create/")[0]!.body!.creatives as Json[])[0]!
    expect(cr).not.toHaveProperty("landing_page_url")
    expect(cr).toMatchObject({
      call_to_action: "SEND_MESSAGE",
      page_id: "7400000000000000000001",
      operation_status: "DISABLE",
    })
  })

  it("copy nhóm Zalo (deep): quảng cáo trong bản sao không có link; nhóm thường giữ nguyên link", async () => {
    const run = async (group: Json) => {
      const m = mockTikTok({
        "GET /adgroup/get/": { body: group },
        "GET /ad/get/": { body: adWithLinks },
        "POST /adgroup/create/": ok({ adgroup_id: "1980000000000000101" }),
        "POST /ad/create/": ok({
          ad_ids: ["1990000000000000001", "1990000000000000002"],
        }),
      })
      await copyTikTokObject(
        makeCtx(),
        { level: "ad_group", id: "1810000000000000101", deep: true },
        { now: NOW }
      )
      return (m.callsTo("POST /ad/create/")[0]!.body!.creatives as Json[])[0]!
    }
    expect(await run(imGroup("ZALO"))).not.toHaveProperty("landing_page_url")
    expect(
      (await run(adgroupFixture as unknown as Json)).landing_page_url
    ).toBe("https://zalo.me/84901234567")
  })
})

describe("rà soát bảo mật 2: làm sạch chữ, tra cứu sau timeout, id trả về", () => {
  const TAG_A = String.fromCodePoint(0xe0041)
  const VS16 = String.fromCharCode(0xfe0f)
  const VS_SUP = String.fromCodePoint(0xe0100)
  const EMOJI = String.fromCodePoint(0x1f600)
  const assets = (input: Json) =>
    ext("tiktok_messaging_assets").run(makeCtx(), ext("tiktok_messaging_assets").input.parse(input), {}) as Promise<{ items: Json[] }>
  const welcome = () => ext("tiktok_create_welcome_message")
  const input = { content: "Chào bạn", suggested_questions: [{ question: "Giá?", answer: "Inbox" }] }

  it("đầu ra: bỏ tag character / variation selector, giữ xuống dòng (cả U+2028), cắt không vỡ surrogate, bỏ phần tử câu hỏi không phải object", async () => {
    mockTikTok({
      "GET /creative/auto_message/get/": ok({
        list: [
          {
            auto_message_id: "1",
            welcome_message: {
              title: "t",
              content: `Xin${TAG_A} chào${VS16}${VS_SUP}${String.fromCharCode(0x2028)}bạn`,
              suggested_questions: [null, 5, "x", ["a"], { question: "Giá?", answer: `${"a".repeat(598)}${EMOJI}b` }],
            },
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const r = await assets({ kind: "welcome_messages" })
    const item = r.items[0] as { content: string; suggested_questions: { question: string; answer: string }[] }
    expect(item.content).toBe("Xin chào\nbạn")
    expect(item.suggested_questions).toHaveLength(1)
    // 600-char limit: cut at 599 would split the emoji (positions 598-599) → the high surrogate is dropped
    expect(item.suggested_questions[0]!.answer).toBe(`${"a".repeat(598)}…`)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(item.suggested_questions[0]!.answer)).toBe(false)
  })

  it("lời chào gửi lên: bỏ tag character / variation selector", async () => {
    mockTikTok({})
    const r = (await welcome().run(makeCtx(), welcome().input.parse({ ...input, content: `Chào${TAG_A} bạn${VS16}` }), { dryRun: true })) as {
      payload: { welcome_message: Json }
    }
    expect(r.payload.welcome_message.content).toBe("Chào bạn")
  })

  it("timeout: bản ghi khớp nhưng create_time không đọc được không được coi là vừa tạo", async () => {
    let title = ""
    const m = mockTikTok({
      "POST /creative/auto_message/create/": (c: RecordedCall) => {
        title = (c.body!.welcome_message as Json).title as string
        return { status: 504, body: "gateway timeout" }
      },
      "GET /creative/auto_message/get/": () =>
        ok({ list: [{ auto_message_id: "1855000000000000000003", welcome_message: { title, content: input.content } }], page_info: { total_page: 1 } }),
    })
    await expect(welcome().run(makeCtx(), welcome().input.parse(input), {})).rejects.toMatchObject({ retryable: false })
    expect(m.callsTo("POST /creative/auto_message/create/")).toHaveLength(1)
  })

  it("id trả về không phải chuỗi chữ số → lỗi không thử lại kèm gợi ý kiểm tra", async () => {
    mockTikTok({ "POST /creative/auto_message/create/": ok({ auto_message_id: "12ab" }) })
    await expect(welcome().run(makeCtx(), welcome().input.parse(input), {})).rejects.toMatchObject({
      code: "upstream_error",
      retryable: false,
      hint: expect.stringContaining("kind=welcome_messages"),
    })
  })

  it("chỉ tool lời chào bỏ ghi chú \"tạo ở trạng thái tạm dừng\"", () => {
    expect(tiktokExtensions.filter((e) => e.createsAdObject === false).map((e) => e.name)).toEqual(["tiktok_create_welcome_message"])
  })
})
