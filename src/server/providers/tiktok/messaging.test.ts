// TikTok messaging ads (v1.1.5): ad group destination, creative rules, tiktok_messaging_assets, welcome messages,
// report metrics. Official rules: providers/tiktok.md "Quảng cáo nhắn tin".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import adgroupFixture from "./__fixtures__/adgroup_get.json"
import campaignFixture from "./__fixtures__/campaign_get.json"
import {
  fail,
  makeCtx,
  mockTikTok,
  ok,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"
import { mapTikTokError } from "./client"
import { tiktokExtensions } from "./extensions"
import { tiktokLookup } from "./lookup"
import { DEFAULT_SUGGESTED_QUESTION, PROMO_DM, PROMO_IM } from "./messaging"
import {
  getTikTokReport,
  metricsForPreset,
  normalizeTikTokMetrics,
} from "./report"

beforeEach(() => __resetBuckets())
afterEach(() => vi.unstubAllGlobals())

const ext = (name: string) => tiktokExtensions.find((e) => e.name === name)!
const FUTURE_START = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 00:00:00`

type Json = Record<string, unknown>
function withRow(fixture: Json, patch: Json): Json {
  const f = structuredClone(fixture) as { data: { list: Json[] } }
  f.data.list[0] = { ...f.data.list[0], ...patch }
  return f as unknown as Json
}
const leadCampaign = withRow(campaignFixture, {
  objective_type: "LEAD_GENERATION",
  objective: "LEAD_GENERATION",
})

const MESSAGING_KEYS = [
  "messaging_app_type",
  "messaging_app_account_id",
  "phone_region_code",
  "phone_region_calling_code",
  "phone_number",
  "message_event_set_id",
]

// ---------------------------------------------------------------------------
// tiktok_create_adgroup
// ---------------------------------------------------------------------------

describe("tiktok_create_adgroup: nhóm nhắn tin", () => {
  const routes = (campaign: Json = leadCampaign) => ({
    "GET /campaign/get/": { body: campaign },
    "POST /adgroup/create/": ok({ adgroup_id: "1840000000000000009" }),
  })
  const base = {
    campaign_id: "1810000000000000001",
    name: "Nhắn tin HCM",
    location_ids: ["1562822"],
    budget_type: "daily",
    budget: 300000,
    optimization_goal: "CLICK",
    schedule_start_time: FUTURE_START,
  }
  const e = () => ext("tiktok_create_adgroup")
  async function body(input: Json, campaign?: Json) {
    const m = mockTikTok(routes(campaign))
    const res = (await e().run(makeCtx(), e().input.parse(input), {
      idempotencyKey: "msg-1",
    })) as { warnings: string[] }
    return {
      body: m.callsTo("POST /adgroup/create/")[0]!.body!,
      warnings: res.warnings,
    }
  }
  async function refused(input: Json, re: RegExp, campaign?: Json) {
    const m = mockTikTok(routes(campaign))
    await expect(
      e().run(makeCtx(), e().input.parse(input), { dryRun: true })
    ).rejects.toThrow(re)
    expect(m.posts()).toHaveLength(0)
  }

  it("TIKTOK_DM: promotion_type DM, vị trí chỉ TikTok (thay automatic + cảnh báo), không có trường ứng dụng", async () => {
    const { body: b, warnings } = await body({
      ...base,
      messaging: { destination: "TIKTOK_DM" },
    })
    expect(b).toMatchObject({
      promotion_type: PROMO_DM,
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      optimization_goal: "CLICK",
      billing_event: "CPC",
      operation_status: "DISABLE",
    })
    for (const k of MESSAGING_KEYS) expect(b).not.toHaveProperty(k)
    expect(b).not.toHaveProperty("messaging")
    expect(b).not.toHaveProperty("optimization_event")
    expect(warnings.join(" ")).toMatch(/PLACEMENT_TIKTOK/)
    expect(warnings.join(" ")).toMatch(/không sửa được sau khi tạo/)
  })

  it("MESSENGER: messaging_app_account_id = ID Trang Facebook (chuỗi, giữ đủ chữ số)", async () => {
    const pageId = "123456789012345678901"
    const { body: b } = await body({
      ...base,
      messaging: { destination: "MESSENGER", facebook_page_id: pageId },
    })
    expect(b).toMatchObject({
      promotion_type: PROMO_IM,
      messaging_app_type: "MESSENGER",
      messaging_app_account_id: pageId,
    })
    expect(b).not.toHaveProperty("phone_number")
  })

  it("ZALO: bộ ba số điện thoại, mặc định VN +84, bỏ khoảng trắng; không gửi messaging_app_account_id", async () => {
    const { body: b, warnings } = await body({
      ...base,
      messaging: { destination: "ZALO", phone_number: "901 234 567" },
    })
    expect(b).toMatchObject({
      promotion_type: PROMO_IM,
      messaging_app_type: "ZALO",
      phone_region_code: "VN",
      phone_region_calling_code: "+84",
      phone_number: "901234567",
    })
    expect(b).not.toHaveProperty("messaging_app_account_id")
    expect(warnings.join(" ")).toMatch(/mặc định Việt Nam/)
  })

  it("WHATSAPP CONVERSATION + message_event_set_id: OCPM, cảnh báo allowlist, optimization_event MESSAGE được giữ", async () => {
    const { body: b, warnings } = await body({
      ...base,
      optimization_goal: "CONVERSATION",
      optimization_event: "MESSAGE",
      messaging: {
        destination: "WHATSAPP",
        phone_region_code: "vn",
        phone_number: "912345678",
        message_event_set_id: "7430000000000000001",
      },
    })
    expect(b).toMatchObject({
      messaging_app_type: "WHATSAPP",
      phone_region_code: "VN",
      phone_region_calling_code: "+84",
      billing_event: "OCPM",
      optimization_event: "MESSAGE",
      message_event_set_id: "7430000000000000001",
    })
    expect(warnings.join(" ")).toMatch(/allowlist/)
  })

  it("LINE và IM_URL", async () => {
    const line = await body({
      ...base,
      messaging: { destination: "LINE", line_business_id: "@shopvn" },
    })
    expect(line.body).toMatchObject({
      messaging_app_type: "LINE",
      messaging_app_account_id: "@shopvn",
    })
    const im = await body({
      ...base,
      placement_type: "manual",
      placements: ["PLACEMENT_TIKTOK"],
      messaging: { destination: "IM_URL" },
    })
    expect(im.body).toMatchObject({
      promotion_type: PROMO_IM,
      messaging_app_type: "IM_URL",
      placements: ["PLACEMENT_TIKTOK"],
    })
    expect(im.body).not.toHaveProperty("messaging_app_account_id")
    expect(im.warnings.join(" ")).not.toMatch(/đã đặt PLACEMENT_TYPE_NORMAL/)
  })

  it("từ chối: chiến dịch không phải LEAD_GENERATION", async () => {
    await refused(
      { ...base, messaging: { destination: "TIKTOK_DM" } },
      /LEAD_GENERATION/,
      campaignFixture as unknown as Json
    )
  })

  it("từ chối: mục tiêu sai, Zalo / LINE / IM_URL với CONVERSATION, optimization_event với CLICK", async () => {
    await refused(
      {
        ...base,
        optimization_goal: "CONVERT",
        messaging: { destination: "TIKTOK_DM" },
      },
      /CLICK/
    )
    await refused(
      {
        ...base,
        optimization_goal: "CONVERSATION",
        messaging: { destination: "ZALO", phone_number: "901234567" },
      },
      /chỉ hỗ trợ optimization_goal CLICK/
    )
    await refused(
      {
        ...base,
        optimization_goal: "CONVERSATION",
        messaging: { destination: "IM_URL" },
      },
      /chỉ hỗ trợ optimization_goal CLICK/
    )
    await refused(
      {
        ...base,
        optimization_event: "MESSAGE",
        messaging: { destination: "TIKTOK_DM" },
      },
      /không dùng optimization_event/
    )
    await refused(
      {
        ...base,
        optimization_goal: "CONVERSATION",
        optimization_event: "FORM",
        messaging: { destination: "TIKTOK_DM" },
      },
      /chỉ được là MESSAGE/
    )
  })

  it("từ chối: 13-17 tuổi, pixel, NO_BID + FAST, vị trí khác TikTok, advanced cấm", async () => {
    await refused(
      {
        ...base,
        age_groups: ["AGE_13_17", "AGE_18_24"],
        messaging: { destination: "TIKTOK_DM" },
      },
      /13-17/
    )
    await refused(
      {
        ...base,
        pixel_id: "7200000000000000009",
        messaging: { destination: "TIKTOK_DM" },
      },
      /pixel_id/
    )
    await refused(
      {
        ...base,
        pacing: "PACING_MODE_FAST",
        messaging: { destination: "TIKTOK_DM" },
      },
      /PACING_MODE_SMOOTH/
    )
    await refused(
      {
        ...base,
        placement_type: "manual",
        placements: ["PLACEMENT_TIKTOK", "PLACEMENT_PANGLE"],
        messaging: { destination: "TIKTOK_DM" },
      },
      /chỉ chạy ở vị trí TikTok/
    )
    await refused(
      {
        ...base,
        advanced: { promotion_target_type: "EXTERNAL_WEBSITE" },
        messaging: { destination: "TIKTOK_DM" },
      },
      /promotion_target_type/
    )
    await refused(
      {
        ...base,
        advanced: { search_result_enabled: true },
        messaging: { destination: "TIKTOK_DM" },
      },
      /search_result_enabled/
    )
    await refused(
      {
        ...base,
        advanced: { click_attribution_window: "SEVEN_DAYS" },
        messaging: { destination: "TIKTOK_DM" },
      },
      /click_attribution_window/
    )
    await refused(
      {
        ...base,
        advanced: { messaging_app_account_id: "1" },
        messaging: { destination: "WHATSAPP", phone_number: "901234567" },
      },
      /không truyền messaging_app_account_id trong advanced/
    )
    await refused(
      {
        ...base,
        promotion_type: "WEBSITE",
        messaging: { destination: "TIKTOK_DM" },
      },
      /mâu thuẫn/
    )
  })

  it("từ chối: trường tài khoản sai đích, thiếu trường bắt buộc, event set không phải CONVERSATION", async () => {
    await refused(
      {
        ...base,
        messaging: { destination: "TIKTOK_DM", phone_number: "901234567" },
      },
      /không dùng phone_number/
    )
    await refused(
      {
        ...base,
        messaging: {
          destination: "WHATSAPP",
          facebook_page_id: "1",
          phone_number: "901234567",
        },
      },
      /không dùng facebook_page_id/
    )
    await refused(
      { ...base, messaging: { destination: "MESSENGER" } },
      /facebook_page_id/
    )
    await refused(
      { ...base, messaging: { destination: "LINE" } },
      /line_business_id/
    )
    await refused(
      { ...base, messaging: { destination: "ZALO" } },
      /cần phone_number/
    )
    await refused(
      {
        ...base,
        messaging: {
          destination: "MESSENGER",
          facebook_page_id: "1",
          message_event_set_id: "2",
        },
      },
      /chỉ dùng với optimization_goal CONVERSATION/
    )
    expect(
      e().input.safeParse({
        ...base,
        messaging: { destination: "MESSENGER", facebook_page_id: "abc" },
      }).success
    ).toBe(false)
    expect(
      e().input.safeParse({
        ...base,
        messaging: { destination: "TIKTOK_DM", unknown_field: 1 },
      }).success
    ).toBe(false)
  })

  it("số điện thoại: chỉ chữ số, không số 0 đầu, không kèm 84, độ dài VN - lỗi không lặp lại số", async () => {
    const cases: [string, RegExp][] = [
      ["0987654321", /số 0 ở đầu/],
      ["+84987654321", /chỉ gồm chữ số/],
      ["84987654321", /không kèm mã quốc gia/],
      ["98765", /6-14 chữ số|9-10 chữ số/],
      ["9876543", /9-10 chữ số/],
      ["98a654321", /chỉ gồm chữ số/],
    ]
    for (const [phone, re] of cases) {
      const m = mockTikTok(routes())
      const err = await e()
        .run(
          makeCtx(),
          e().input.parse({
            ...base,
            messaging: { destination: "ZALO", phone_number: phone },
          }),
          { dryRun: true }
        )
        .catch((x: unknown) => x)
      expect(err, phone).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).userMessageVi, phone).toMatch(re)
      expect(JSON.stringify(err), phone).not.toContain(
        phone.replace(/\D/g, "").slice(-6)
      )
      expect(m.posts()).toHaveLength(0)
    }
    await refused(
      {
        ...base,
        messaging: {
          destination: "ZALO",
          phone_number: "901234567",
          phone_region_code: "VN",
          phone_region_calling_code: "+1",
        },
      },
      /\+84/
    )
    await refused(
      {
        ...base,
        messaging: {
          destination: "WHATSAPP",
          phone_number: "2025550123",
          phone_region_code: "US",
        },
      },
      /Cần cả phone_region_code/
    )
    const us = await body({
      ...base,
      messaging: {
        destination: "WHATSAPP",
        phone_number: "2025550123",
        phone_region_code: "US",
        phone_region_calling_code: "+1",
      },
    })
    expect(us.body).toMatchObject({
      phone_region_code: "US",
      phone_region_calling_code: "+1",
      phone_number: "2025550123",
    })
    expect(us.warnings.join(" ")).toMatch(/chưa được TikTok mô tả rõ/)
  })

  it("đường cũ: promotion_type thô + advanced.messaging_* được kiểm tra như messaging", async () => {
    const { body: b } = await body({
      ...base,
      promotion_type: PROMO_IM,
      advanced: {
        messaging_app_type: "ZALO",
        phone_region_code: "VN",
        phone_region_calling_code: "+84",
        phone_number: "901234567",
        video_download_disabled: true,
      },
    })
    expect(b).toMatchObject({
      promotion_type: PROMO_IM,
      messaging_app_type: "ZALO",
      phone_number: "901234567",
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      video_download_disabled: true,
    })
    // CLICK without messaging_app_type → IM_URL (TikTok default)
    const im = await body({ ...base, promotion_type: PROMO_IM })
    expect(im.body).toMatchObject({ messaging_app_type: "IM_URL" })
    await refused(
      {
        ...base,
        promotion_type: PROMO_IM,
        advanced: { messaging_app_type: "ZALO", phone_number: "0901234567" },
      },
      /số 0 ở đầu/
    )
    await refused(
      {
        ...base,
        promotion_type: PROMO_IM,
        advanced: {
          messaging_app_type: "MESSENGER",
          messaging_app_account_id: 123456789012345680,
        },
      },
      /phải là chuỗi/
    )
    await refused(
      {
        ...base,
        promotion_type: PROMO_DM,
        advanced: { messaging_app_type: "ZALO" },
      },
      /không dùng messaging_app_type/
    )
    await refused(
      { ...base, promotion_type: PROMO_IM, optimization_goal: "CONVERSATION" },
      /cần messaging_app_type/
    )
    await refused(
      { ...base, promotion_type: PROMO_DM },
      /LEAD_GENERATION/,
      campaignFixture as unknown as Json
    )
  })

  it("không hồi quy: nhóm WEBSITE thường giữ nguyên body (vị trí tự động, không có trường nhắn tin, không cảnh báo nhắn tin)", async () => {
    const input = {
      campaign_id: "1810000000000000001",
      name: "HN - 25-44",
      promotion_type: "WEBSITE",
      location_ids: ["1562822"],
      budget_type: "daily",
      budget: 300000,
      optimization_goal: "CONVERT",
      pixel_id: "7200000000000000009",
      optimization_event: "SHOPPING",
      schedule_start_time: FUTURE_START,
      advanced: { video_download_disabled: true },
    }
    const { body: b, warnings } = await body(
      input,
      campaignFixture as unknown as Json
    )
    expect(b).toEqual({
      advertiser_id: "7100000000000000001",
      campaign_id: "1810000000000000001",
      adgroup_name: "HN - 25-44",
      request_id: expect.any(String),
      operation_status: "DISABLE",
      placement_type: "PLACEMENT_TYPE_AUTOMATIC",
      location_ids: ["1562822"],
      optimization_goal: "CONVERT",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: FUTURE_START,
      promotion_type: "WEBSITE",
      pixel_id: "7200000000000000009",
      optimization_event: "SHOPPING",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 300000,
      video_download_disabled: true,
    })
    expect(warnings).toEqual([
      "Nhóm quảng cáo được tạo ở trạng thái TẮT (DISABLE). Thời gian lịch tính theo UTC.",
    ])
    // LEAD_GENERATION with Instant Form is not messaging either
    const form = await body({ ...base, promotion_type: "INSTANT_FORM" })
    for (const k of MESSAGING_KEYS) expect(form.body).not.toHaveProperty(k)
    expect(form.body.placement_type).toBe("PLACEMENT_TYPE_AUTOMATIC")
  })

  it("trường nhắn tin không bị coi là tiền (moneyOf chỉ ngân sách/giá thầu)", () => {
    const items = e().moneyOf!(
      e().input.parse({
        ...base,
        messaging: {
          destination: "WHATSAPP",
          phone_number: "912345678",
          message_event_set_id: "7430000000000000001",
        },
      })
    )
    expect(items.map((i) => i.field)).toEqual(["budget"])
  })
})

// ---------------------------------------------------------------------------
// tiktok_create_ads
// ---------------------------------------------------------------------------

describe("tiktok_create_ads: quảng cáo nhắn tin", () => {
  const groupRoutes = (patch: Json) => ({
    "GET /adgroup/get/": { body: withRow(adgroupFixture, patch) },
    "GET /ad/get/": ok({
      list: [],
      page_info: { total_number: 0, total_page: 1 },
    }),
    "POST /ad/create/": ok({ ad_ids: ["1850000000000000009"] }),
  })
  const DM_GROUP = {
    promotion_type: PROMO_DM,
    optimization_goal: "CLICK",
    pixel_id: undefined,
    optimization_event: undefined,
  }
  const IM = (app: string | undefined, goal = "CLICK") => ({
    promotion_type: PROMO_IM,
    messaging_app_type: app,
    optimization_goal: goal,
    pixel_id: undefined,
  })
  const spark = {
    ad_name: "Nhắn tin 01",
    ad_format: "SINGLE_VIDEO",
    identity_type: "TT_USER",
    identity_id: "6f1d2c3b-aaaa-bbbb-cccc-000000000001",
    tiktok_item_id: "7400000000000000123",
  }
  const e = () => ext("tiktok_create_ads")
  async function created(patch: Json, creative: Json) {
    const m = mockTikTok(groupRoutes(patch))
    const res = (await e().run(
      makeCtx(),
      e().input.parse({
        adgroup_id: "1810000000000000101",
        creatives: [creative],
      }),
      {}
    )) as {
      warnings: string[]
    }
    return {
      creative: (
        m.callsTo("POST /ad/create/")[0]!.body!.creatives as Json[]
      )[0]!,
      warnings: res.warnings,
    }
  }
  async function refused(patch: Json, creative: Json, re: RegExp) {
    const m = mockTikTok(groupRoutes(patch))
    await expect(
      e().run(
        makeCtx(),
        e().input.parse({
          adgroup_id: "1810000000000000101",
          creatives: [creative],
        }),
        { dryRun: true }
      )
    ).rejects.toThrow(re)
    expect(m.posts()).toHaveLength(0)
  }

  it("tin nhắn TikTok: auto_message_id (chuỗi) gửi đi, CTA mặc định SEND_MESSAGE kèm cảnh báo", async () => {
    const id = "1855000000000000000001"
    const { creative, warnings } = await created(DM_GROUP, {
      ...spark,
      auto_message_id: id,
    })
    expect(creative).toMatchObject({
      auto_message_id: id,
      call_to_action: "SEND_MESSAGE",
      operation_status: "DISABLE",
    })
    expect(typeof creative.auto_message_id).toBe("string")
    expect(warnings.join(" ")).toMatch(/SEND_MESSAGE/)
  })

  it("tin nhắn TikTok: từ chối thiếu lời chào, identity không Spark, CTA khác, link đích, ảnh đơn, CONVERSATION với BC_AUTH_TT", async () => {
    await refused(DM_GROUP, spark, /auto_message_id/)
    await refused(
      DM_GROUP,
      {
        ...spark,
        identity_type: "CUSTOMIZED_USER",
        tiktok_item_id: undefined,
        video_id: "v1",
        image_ids: ["c1"],
        ad_text: "Hi",
        auto_message_id: "1",
      },
      /TT_USER hoặc BC_AUTH_TT/
    )
    await refused(
      DM_GROUP,
      { ...spark, auto_message_id: "1", call_to_action: "LEARN_MORE" },
      /SEND_MESSAGE/
    )
    await refused(
      DM_GROUP,
      { ...spark, auto_message_id: "1", landing_page_url: "https://shop.vn" },
      /không dùng landing_page_url/
    )
    await refused(
      DM_GROUP,
      {
        ...spark,
        auto_message_id: "1",
        ad_format: "SINGLE_IMAGE",
        tiktok_item_id: undefined,
        image_ids: ["i1"],
        ad_text: "x",
      },
      /SINGLE_VIDEO hoặc CAROUSEL_ADS/
    )
    await refused(
      { ...DM_GROUP, optimization_goal: "CONVERSATION" },
      {
        ...spark,
        identity_type: "BC_AUTH_TT",
        identity_authorized_bc_id: "7000000000000000009",
        auto_message_id: "1",
      },
      // C1 (v1.1.6): the error names both ways out - TT_USER with can_manage_message, or a new CLICK ad group for BC_AUTH_TT
      /chỉ dùng identity TT_USER[\s\S]*can_manage_message[\s\S]*BC_AUTH_TT[\s\S]*CLICK/
    )
  })

  it("Zalo / Messenger: không gửi link (TikTok tự tạo), page_id chỉ khi CLICK, tracking chỉ Messenger/WhatsApp, không CALL_NOW", async () => {
    const zalo = await created(IM("ZALO"), { ...spark })
    expect(zalo.creative.call_to_action).toBe("SEND_MESSAGE")
    expect(zalo.creative).not.toHaveProperty("landing_page_url")
    await refused(
      IM("ZALO"),
      { ...spark, landing_page_url: "https://zalo.me/0901234567" },
      /không tự gửi link/
    )
    await refused(
      IM("ZALO"),
      { ...spark, call_to_action: "CALL_NOW" },
      /CALL_NOW/
    )
    await refused(
      IM("ZALO"),
      { ...spark, auto_message_id: "1" },
      /auto_message_id/
    )
    await refused(
      IM("ZALO"),
      { ...spark, tracking_message_event_set_id: "7" },
      /tracking_message_event_set_id/
    )
    const page = "7400000000000000000001"
    const ms = await created(IM("MESSENGER"), { ...spark, page_id: page })
    expect(ms.creative.page_id).toBe(page)
    await refused(
      IM("MESSENGER", "CONVERSATION"),
      { ...spark, page_id: page },
      /chỉ dùng khi nhóm tối ưu CLICK/
    )
    const tr = await created(IM("WHATSAPP"), {
      ...spark,
      tracking_message_event_set_id: "7430000000000000001",
    })
    expect(tr.creative.tracking_message_event_set_id).toBe(
      "7430000000000000001"
    )
    await refused(
      IM("WHATSAPP"),
      { ...spark, page_id: page, tracking_message_event_set_id: "7" },
      /không có page_id/
    )
  })

  it("IM_URL: cần landing_page_url https hoặc page_id; deeplink cần fallback WEBSITE", async () => {
    await refused(IM("IM_URL"), spark, /cần landing_page_url/)
    await refused(
      IM("IM_URL"),
      { ...spark, landing_page_url: "http://zalo.me/x" },
      /https/
    )
    const url = await created(IM("IM_URL"), {
      ...spark,
      landing_page_url: "https://zalo.me/shop",
    })
    expect(url.creative.landing_page_url).toBe("https://zalo.me/shop")
    await refused(
      IM("IM_URL"),
      {
        ...spark,
        landing_page_url: "https://wa.me/1",
        deeplink: "whatsapp://send",
      },
      /fallback_type WEBSITE/
    )
    const dl = await created(IM("IM_URL"), {
      ...spark,
      landing_page_url: "https://wa.me/1",
      deeplink: "whatsapp://send",
      fallback_type: "WEBSITE",
    })
    expect(dl.creative).toMatchObject({
      deeplink: "whatsapp://send",
      fallback_type: "WEBSITE",
    })
    await refused(
      IM("IM_URL"),
      {
        ...spark,
        landing_page_url: "https://wa.me/1",
        fallback_type: "WEBSITE",
      },
      /không có deeplink/
    )
    await refused(
      IM("IM_URL"),
      { ...spark, page_id: "7", landing_page_url: "https://wa.me/1" },
      /dùng page_id/
    )
  })

  it("nhóm không đọc được messaging_app_type: chỉ quy tắc chung + cảnh báo", async () => {
    const r = await created(IM(undefined), {
      ...spark,
      landing_page_url: "https://zalo.me/shop",
    })
    expect(r.warnings.join(" ")).toMatch(/không đọc được messaging_app_type/)
  })

  it("không hồi quy: nhóm WEBSITE giữ nguyên creative (page_id / deeplink đi qua), chỉ từ chối auto_message_id / tracking_message_event_set_id", async () => {
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
    const r = await created({}, video)
    expect(r.creative).toEqual({ ...video, operation_status: "DISABLE" })
    expect(r.warnings).toEqual([
      "Quảng cáo được tạo ở trạng thái TẮT (DISABLE) và sẽ qua kiểm duyệt của TikTok.",
    ])
    const img = await created(
      {},
      {
        ...video,
        ad_format: "SINGLE_IMAGE",
        video_id: undefined,
        call_to_action: undefined,
      }
    )
    expect(img.creative).not.toHaveProperty("call_to_action")
    for (const extra of [{ auto_message_id: "1" }, { tracking_message_event_set_id: "3" }]) {
      await refused({}, { ...video, ...extra }, /chỉ dùng cho nhóm quảng cáo nhắn tin/)
    }
    // page_id / deeplink / deeplink_type / fallback_type are general /ad/create/ fields: passed through unchanged
    const general = { page_id: "7400000000000000000001", deeplink: "shopapp://product/1", deeplink_type: "DEFERRED_DEEPLINK", fallback_type: "APP_INSTALL" }
    const g = await created({}, { ...video, ...general })
    expect(g.creative).toEqual({ ...video, ...general, operation_status: "DISABLE" })
  })
})

// ---------------------------------------------------------------------------
// tiktok_messaging_assets
// ---------------------------------------------------------------------------

describe("tiktok_messaging_assets", () => {
  const e = () => ext("tiktok_messaging_assets")
  const run = (input: Json) =>
    e().run(makeCtx(), e().input.parse(input), {}) as Promise<
      Json & { items: Json[]; warnings: string[] }
    >

  it("quyền read, không ghi", () => {
    expect(e().permission).toBe("read")
    expect(e().write).toBe(false)
  })

  it("welcome_messages: GET /creative/auto_message/get/ WELCOME_MESSAGE, đọc cả list lẫn auto_message_list, làm sạch chữ", async () => {
    const m = mockTikTok({
      "GET /creative/auto_message/get/": ok({
        auto_message_list: [
          {
            auto_message_id: "1855000000000000000001",
            auto_message_type: "WELCOME_MESSAGE",
            audit_status: "PASS",
            create_time: "2026-10-01 00:00:01",
            welcome_message: {
              title: "Chào\u202Egnp",
              content: "Xin chào!\u0007 Shop giúp gì?",
              suggested_questions: [{ question: "Giá?", answer: "Inbox nhé" }],
            },
          },
        ],
        page_info: { page: 1, page_size: 50, total_number: 1, total_page: 1 },
      }),
    })
    const r = await run({ kind: "welcome_messages" })
    expect(m.calls[0]!.query).toMatchObject({
      advertiser_id: "7100000000000000001",
      auto_message_type: "WELCOME_MESSAGE",
      page: "1",
      page_size: "50",
    })
    expect(r.items).toEqual([
      {
        auto_message_id: "1855000000000000000001",
        title: "Chàognp",
        content: "Xin chào! Shop giúp gì?",
        suggested_questions: [{ question: "Giá?", answer: "Inbox nhé" }],
        audit_status: "PASS",
        create_time: "2026-10-01 00:00:01",
      },
    ])
    expect(r.next_page).toBeNull()
    mockTikTok({
      "GET /creative/auto_message/get/": ok({
        list: [],
        page_info: { total_page: 0 },
      }),
    })
    expect(
      (await run({ kind: "welcome_messages" })).warnings.join(" ")
    ).toMatch(/tiktok_create_welcome_message/)
  })

  it("instant_pages: business_types TIKTOK_INSTANT_PAGE + PUBLISHED, page_id chuỗi", async () => {
    const m = mockTikTok({
      "GET /page/get/": ok({
        list: [
          {
            page_id: "7400000000000000000001",
            title: "Trang Zalo",
            status: "PUBLISHED",
            messaging_app_type: "WHATSAPP",
            messaging_app_account_id: "84901234567",
            preview_url: "https://ads.tiktok.com/p/1",
          },
        ],
        page_info: { page: 1, total_page: 2, total_number: 60 },
      }),
    })
    const r = await run({ kind: "instant_pages" })
    expect(m.calls[0]!.query).toMatchObject({
      business_types: ["TIKTOK_INSTANT_PAGE"],
      status: "PUBLISHED",
    })
    expect(r.items[0]).toMatchObject({
      page_id: "7400000000000000000001",
      messaging_app_type: "WHATSAPP",
      messaging_app_account_id: "84901234567",
    })
    expect(r.next_page).toBe(2)
  })

  it("message_event_sets: cần app + account; matched_event_set; 40001 → gợi ý quyền CTX Events Management", async () => {
    mockTikTok({})
    await expect(run({ kind: "message_event_sets" })).rejects.toThrow(
      /messaging_app_type và messaging_app_account_id/
    )
    const m = mockTikTok({
      "GET /ctm/message_event_set/get/": ok({
        message_event_set_list: [
          {
            message_event_set_id: "7430000000000000001",
            message_event_name: "Zalo OA",
            create_time: "2024-10-25 09:42:04",
          },
        ],
        matched_event_set: {
          message_event_set_id: "7430000000000000001",
          message_event_name: "Zalo OA",
          create_time: "2024-10-25 09:42:04",
        },
      }),
    })
    const r = await run({
      kind: "message_event_sets",
      messaging_app_type: "WHATSAPP",
      messaging_app_account_id: "84901234567",
    })
    expect(m.calls[0]!.query).toMatchObject({
      messaging_app_type: "WHATSAPP",
      messaging_app_account_id: "84901234567",
    })
    expect(r.matched_event_set).toMatchObject({
      message_event_set_id: "7430000000000000001",
    })
    expect(r.warnings.join(" ")).toMatch(/tự điền/)
    mockTikTok({
      "GET /ctm/message_event_set/get/": fail(40001, "No permission"),
    })
    await expect(
      run({
        kind: "message_event_sets",
        messaging_app_type: "ZALO",
        messaging_app_account_id: "123",
      })
    ).rejects.toMatchObject({
      code: "permission_denied",
      hint: expect.stringContaining("CTX Events Management"),
    })
  })

  it("dm_identities: chỉ TT_USER / BC_AUTH_TT kèm can_manage_message; cảnh báo khi không có tài khoản nhắn tin được", async () => {
    mockTikTok({
      "GET /identity/get/": ok({
        identity_list: [
          {
            identity_id: "a",
            identity_type: "TT_USER",
            display_name: "Shop",
            can_manage_message: false,
          },
          {
            identity_id: "b",
            identity_type: "CUSTOMIZED_USER",
            display_name: "Custom",
          },
          {
            identity_id: "c",
            identity_type: "BC_AUTH_TT",
            identity_authorized_bc_id: "7000",
            display_name: "BC",
            can_manage_message: false,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const r = await run({ kind: "dm_identities" })
    expect(r.items.map((i) => [i.identity_id, i.can_manage_message])).toEqual([
      ["a", false],
      ["c", false],
    ])
    expect(r.warnings.join(" ")).toMatch(/Read and manage messages/)
  })

  it("phone_region_codes: lọc theo q", async () => {
    mockTikTok({
      "GET /tool/phone_region_code/": ok({
        phone_region_code_infos: [
          {
            phone_region_code: "VN",
            phone_region_name: "Viet Nam",
            phone_region_calling_code: "+84",
          },
          {
            phone_region_code: "US",
            phone_region_name: "United States",
            phone_region_calling_code: "+1",
          },
        ],
      }),
    })
    const r = await run({ kind: "phone_region_codes", q: "viet" })
    expect(r.items).toEqual([
      {
        phone_region_code: "VN",
        phone_region_name: "Viet Nam",
        phone_region_calling_code: "+84",
      },
    ])
  })

  it("ads_lookup kind=identities có thêm can_manage_message", async () => {
    mockTikTok({
      "GET /identity/get/": ok({
        identity_list: [
          {
            identity_id: "a",
            identity_type: "TT_USER",
            display_name: "Shop",
            can_manage_message: true,
          },
        ],
        page_info: { total_page: 1 },
      }),
    })
    const r = await tiktokLookup(makeCtx(), "identities")
    expect(r.items[0]!.extra).toMatchObject({
      identity_type: "TT_USER",
      can_manage_message: true,
    })
  })
})

// ---------------------------------------------------------------------------
// tiktok_create_welcome_message
// ---------------------------------------------------------------------------

describe("tiktok_create_welcome_message", () => {
  const e = () => ext("tiktok_create_welcome_message")
  const input = {
    content: "Chào bạn! Shop có thể giúp gì?",
    suggested_questions: [
      { question: "Giá bao nhiêu?", answer: "Shop báo giá ngay ạ." },
    ],
  }

  it("quyền create, ghi, không có tiền", () => {
    expect(e().permission).toBe("create")
    expect(e().write).toBe(true)
    expect(e().moneyOf).toBeUndefined()
  })

  it("dryRun không gọi API; thực thi gửi WELCOME_MESSAGE một lần, trả auto_message_id", async () => {
    const m = mockTikTok({
      "POST /creative/auto_message/create/": ok({
        auto_message_id: "1855000000000000000002",
      }),
    })
    const preview = (await e().run(makeCtx(), e().input.parse(input), {
      dryRun: true,
    })) as { preview: boolean; changes: { after: Json }[] }
    expect(preview.preview).toBe(true)
    expect(m.calls).toHaveLength(0)
    const title = preview.changes[0]!.after.title as string
    expect(title).toMatch(/^Chào bạn! Shop có thể giúp gì\? #[0-9a-f]{6}$/)
    const res = (await e().run(makeCtx(), e().input.parse(input), {})) as {
      createdIds: string[]
      changes: { after: Json }[]
    }
    expect(res.createdIds).toEqual(["1855000000000000000002"])
    expect(res.changes[0]!.after).toMatchObject({
      auto_message_id: "1855000000000000000002",
      title,
    })
    const body = m.callsTo("POST /creative/auto_message/create/")[0]!.body!
    expect(body).toEqual({
      advertiser_id: "7100000000000000001",
      auto_message_type: "WELCOME_MESSAGE",
      welcome_message: {
        title,
        content: input.content,
        suggested_questions: input.suggested_questions,
      },
    })
    expect(m.callsTo("POST /creative/auto_message/create/")).toHaveLength(1)
  })

  it("làm sạch ký tự điều khiển / bidi; câu hỏi mặc định khi bỏ trống; giới hạn độ dài", async () => {
    mockTikTok({})
    const r = (await e().run(
      makeCtx(),
      e().input.parse({
        title: "Lời\u202E chào",
        content: "Xin\u200B chào\r\nbạn",
      }),
      { dryRun: true }
    )) as {
      payload: { welcome_message: Json }
      warnings: string[]
    }
    expect(r.payload.welcome_message).toEqual({
      title: "Lời chào",
      content: "Xin chào\nbạn",
      suggested_questions: [DEFAULT_SUGGESTED_QUESTION],
    })
    expect(r.warnings.join(" ")).toMatch(/câu mặc định/)
    expect(e().input.safeParse({ content: "x".repeat(201) }).success).toBe(
      false
    )
    expect(
      e().input.safeParse({
        content: "x",
        suggested_questions: [{ question: "q".repeat(71), answer: "a" }],
      }).success
    ).toBe(false)
    expect(
      e().input.safeParse({
        content: "x",
        suggested_questions: [1, 2, 3, 4].map(() => ({
          question: "q",
          answer: "a",
        })),
      }).success
    ).toBe(false)
    await expect(
      e().run(makeCtx(), e().input.parse({ content: "\u200B\u202E" }), {
        dryRun: true,
      })
    ).rejects.toThrow(/trống/)
  })

  it("timeout: không gửi lại, tìm theo tiêu đề + nội dung; thấy → dùng id; không thấy → lỗi không thử lại", async () => {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ")
    let title = ""
    const m = mockTikTok({
      "POST /creative/auto_message/create/": (c: RecordedCall) => {
        title = (c.body!.welcome_message as Json).title as string
        return { status: 504, body: "gateway timeout" }
      },
      "GET /creative/auto_message/get/": () =>
        ok({
          list: [
            {
              auto_message_id: "1855000000000000000003",
              create_time: now,
              welcome_message: { title, content: input.content },
            },
          ],
          page_info: { total_page: 1 },
        }),
    })
    const res = (await e().run(makeCtx(), e().input.parse(input), {})) as {
      createdIds: string[]
      warnings: string[]
    }
    expect(res.createdIds).toEqual(["1855000000000000000003"])
    expect(res.warnings.join(" ")).toMatch(/không tạo lại/)
    expect(m.callsTo("POST /creative/auto_message/create/")).toHaveLength(1)

    const m2 = mockTikTok({
      "POST /creative/auto_message/create/": {
        status: 504,
        body: "gateway timeout",
      },
      "GET /creative/auto_message/get/": ok({
        list: [],
        page_info: { total_page: 0 },
      }),
    })
    await expect(
      e().run(makeCtx(), e().input.parse(input), {})
    ).rejects.toMatchObject({
      retryable: false,
      hint: expect.stringContaining("kind=welcome_messages"),
    })
    expect(m2.callsTo("POST /creative/auto_message/create/")).toHaveLength(1)
  })

  it("lỗi nghiệp vụ rõ ràng (vd 40002) → ném lỗi ngay, không tra cứu; 40001 → gợi ý quyền TikTok Message Management", async () => {
    const m = mockTikTok({
      "POST /creative/auto_message/create/": fail(40002, "content too long"),
    })
    await expect(
      e().run(makeCtx(), e().input.parse(input), {})
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(m.callsTo("GET /creative/auto_message/get/")).toHaveLength(0)
    expect(
      mapTikTokError(
        40001,
        "no permission",
        null,
        200,
        "creative/auto_message/create"
      ).hint
    ).toMatch(/TikTok Message Management/)
    expect(
      mapTikTokError(40001, "no permission", null, 200, "campaign/get").hint
    ).toMatch(/Bật thêm scope/)
  })
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe("báo cáo: tin nhắn TikTok + ứng dụng nhắn tin", () => {
  const DM = "messaging_total_conversation_tiktok_direct_message"
  const IM_APP = "messaging_total_conversation_instant_messaging_app"

  it("preset conversion yêu cầu cả 2 chỉ số; all thêm chi phí / tỉ lệ từng đích", () => {
    expect(metricsForPreset("conversion")).toEqual(
      expect.arrayContaining([DM, IM_APP])
    )
    expect(metricsForPreset("all")).toEqual(
      expect.arrayContaining([
        "messaging_cost_per_conversation_tiktok_direct_message",
        "messaging_conversation_rate_tiktok_direct_message",
        "messaging_cost_per_conversation_instant_messaging_app",
        "messaging_conversation_rate_instant_messaging_app",
      ])
    )
    expect(metricsForPreset("basic")).not.toContain(IM_APP)
  })

  it("messages = DM + ứng dụng; thiếu một bên tính 0 chỉ khi bên kia có; cả hai thiếu → null", () => {
    const req = new Set(metricsForPreset("conversion"))
    expect(
      normalizeTikTokMetrics({ [DM]: "3", [IM_APP]: "4" }, req).messages
    ).toBe(7)
    expect(normalizeTikTokMetrics({ [IM_APP]: "4" }, req).messages).toBe(4)
    expect(normalizeTikTokMetrics({ [DM]: "3" }, req).messages).toBe(3)
    expect(normalizeTikTokMetrics({}, req).messages).toBeNull()
    expect(
      normalizeTikTokMetrics(
        { [DM]: "3", [IM_APP]: "4" },
        new Set(metricsForPreset("basic"))
      ).messages
    ).toBeNull()
  })

  it("TikTok không nhận chỉ số ứng dụng nhắn tin → bỏ, thử lại 1 lần, vẫn có số tin nhắn DM", async () => {
    const m = mockTikTok({
      "GET /report/integrated/get/": (c: RecordedCall) => {
        const metrics = c.query.metrics as string[]
        if (metrics.includes(IM_APP))
          return fail(40002, `Invalid metric: ${IM_APP}`)
        return ok({
          list: [
            {
              dimensions: {
                campaign_id: "1",
                stat_time_day: "2026-06-01 00:00:00",
              },
              metrics: { campaign_name: "C1", spend: "10", [DM]: "5" },
            },
          ],
          page_info: { page: 1, total_page: 1 },
        })
      },
    })
    const res = await getTikTokReport(makeCtx(), {
      level: "campaign",
      dateRange: { from: "2026-06-01", to: "2026-06-01" },
      granularity: "day",
      metrics: "conversion",
      limit: 100,
    })
    const calls = m.callsTo("GET /report/integrated/get/")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query.metrics).not.toContain(IM_APP)
    expect(calls[1]!.query.metrics).toContain(DM)
    expect(res.rows[0]!.metrics.messages).toBe(5)
    expect(res.warnings.join(" ")).toMatch(new RegExp(IM_APP))
  })

  it("preset all: tách số cuộc trò chuyện từng đích trong extra", async () => {
    mockTikTok({
      "GET /report/integrated/get/": ok({
        list: [
          {
            dimensions: { campaign_id: "1" },
            metrics: {
              campaign_name: "C1",
              spend: "10",
              [DM]: "2",
              [IM_APP]: "6",
            },
          },
        ],
        page_info: { page: 1, total_page: 1 },
      }),
    })
    const res = await getTikTokReport(makeCtx(), {
      level: "campaign",
      dateRange: { from: "2026-06-01", to: "2026-06-01" },
      granularity: "total",
      metrics: "all",
      limit: 100,
    })
    expect(res.rows[0]!.metrics.messages).toBe(8)
    expect(res.rows[0]!.extra).toMatchObject({ [DM]: 2, [IM_APP]: 6 })
  })
})
