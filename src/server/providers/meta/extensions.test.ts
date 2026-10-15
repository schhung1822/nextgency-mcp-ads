import { beforeEach, describe, expect, it, vi } from "vitest"

import { __resetBuckets } from "../rate-limit"
import type { MutationOptions, ProviderExtension } from "../types"
import type { MetaCredentials } from "./client"
import { metaExtensions, type MetaWriteResult } from "./extensions"
import { graphError, json, mockGraph, providerCtx, type Route } from "./test-utils"

beforeEach(() => __resetBuckets())

function ext(name: string) {
  const e = metaExtensions.find((x) => x.name === name)
  if (!e) throw new Error(`missing ${name}`)
  return e as ProviderExtension<MetaCredentials, unknown, MetaWriteResult>
}

async function run(name: string, raw: unknown, opts: MutationOptions = {}, ctx = providerCtx()) {
  const e = ext(name)
  const input = e.input.parse(raw)
  return e.run(ctx, input, opts)
}

describe("extension metadata", () => {
  it("exposes the four Meta tools with Vietnamese 'Dùng khi…' descriptions ≤1500 chars", () => {
    expect(metaExtensions.map((e) => e.name)).toEqual([
      "meta_create_campaign",
      "meta_create_adset",
      "meta_create_ad",
      "meta_update_targeting",
    ])
    for (const e of metaExtensions) {
      expect(e.description.startsWith("Dùng khi")).toBe(true)
      expect(e.description.length).toBeLessThanOrEqual(1500)
      expect(e.name.length).toBeLessThanOrEqual(40)
      expect(e.write).toBe(true)
    }
  })
})

describe("meta_create_campaign", () => {
  it("ABO: always PAUSED and sends is_adset_budget_sharing_enabled", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3001" })]])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" })
    const p = m.mutatingPosts()[0].params
    expect(p).toMatchObject({ name: "Camp", objective: "OUTCOME_SALES", status: "PAUSED", buying_type: "AUCTION", is_adset_budget_sharing_enabled: "false" })
    expect(JSON.parse(p.special_ad_categories)).toEqual([])
    expect(p.daily_budget).toBeUndefined()
    expect(p.bid_strategy).toBeUndefined()
    expect(res.createdIds).toEqual(["3001"])
  })

  it("CBO with a VND budget sends minor units with offset 1 and an explicit bid_strategy", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3002" })]])
    const res = await run("meta_create_campaign", { name: "CBO", objective: "OUTCOME_TRAFFIC", budget: { type: "daily", amount: 300000 } })
    const p = m.mutatingPosts()[0].params
    expect(p.daily_budget).toBe("300000")
    expect(p.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP")
    expect(p.is_adset_budget_sharing_enabled).toBeUndefined()
    expect(p.status).toBe("PAUSED")
    expect(res.payload.budget).toMatchObject({ amount: 300000, currency: "VND", minor_units_sent: 300000 })
  })

  it("CBO with a USD budget sends cents", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ id: "3003" })]])
    await run("meta_create_campaign", { name: "CBO", objective: "OUTCOME_TRAFFIC", budget: { type: "daily", amount: 25.5 } }, {}, providerCtx({ currency: "USD" }))
    expect(m.mutatingPosts()[0].params.daily_budget).toBe("2550")
  })

  it("dryRun only sends validate_only", async () => {
    const m = mockGraph([["POST", "act_1001/campaigns", () => json({ success: true })]])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" }, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
    expect(JSON.parse(m.calls[0].params.execution_options)).toEqual(["validate_only"])
    expect(m.calls[0].params.status).toBe("PAUSED")
  })

  it("special ad categories require a country", async () => {
    mockGraph([])
    await expect(run("meta_create_campaign", { name: "Nhà", objective: "OUTCOME_LEADS", special_ad_categories: ["HOUSING"] })).rejects.toMatchObject({
      code: "invalid_request",
    })
  })

  it("recovers the id after a create timeout instead of retrying blindly", async () => {
    let posts = 0
    const m = mockGraph([
      [
        "POST",
        "act_1001/campaigns",
        () => {
          posts++
          return json({ error: { code: 2, message: "Service temporarily unavailable", is_transient: true } }, 500)
        },
      ],
      ["GET", "act_1001/campaigns", () => json({ data: [{ id: "3009", name: "Camp", created_time: new Date().toISOString() }] })],
    ])
    const res = await run("meta_create_campaign", { name: "Camp", objective: "OUTCOME_SALES" })
    expect(posts).toBe(1)
    expect(res.createdIds).toEqual(["3009"])
    expect(JSON.parse(m.calls[1].params.filtering)).toEqual([{ field: "name", operator: "EQUAL", value: "Camp" }])
  })
})

const aboCampaign = {
  id: "3001",
  name: "Camp",
  account_id: "1001",
  objective: "OUTCOME_SALES",
  special_ad_categories: [],
  status: "PAUSED",
}

const adsetInput = {
  campaign_id: "3001",
  name: "Nhóm VN 25-45",
  optimization_goal: "OFFSITE_CONVERSIONS",
  budget: { type: "daily", amount: 200000 },
  promoted_object: { pixel_id: "777", custom_event_type: "PURCHASE" },
  targeting: { countries: ["vn"], age_min: 25, age_max: 45, interests: [{ id: "6003139266461", name: "Fashion" }] },
}

describe("meta_create_adset", () => {
  it("ABO ad set: PAUSED, budget in minor units, explicit advantage_audience=0", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2001" })],
    ])
    const res = await run("meta_create_adset", adsetInput)
    const p = m.mutatingPosts()[0].params
    expect(p).toMatchObject({ status: "PAUSED", daily_budget: "200000", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })
    const t = JSON.parse(p.targeting)
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 })
    expect(t.geo_locations).toEqual({ countries: ["VN"] })
    expect(t.flexible_spec).toEqual([{ interests: [{ id: "6003139266461", name: "Fashion" }] }])
    expect(JSON.parse(p.promoted_object)).toEqual({ pixel_id: "777", custom_event_type: "PURCHASE" })
    expect(res.createdIds).toEqual(["2001"])
  })

  it("advantage_audience=true is sent as 1", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2001" })],
    ])
    await run("meta_create_adset", { ...adsetInput, targeting: { ...adsetInput.targeting, advantage_audience: true } })
    expect(JSON.parse(m.mutatingPosts()[0].params.targeting).targeting_automation).toEqual({ advantage_audience: 1 })
  })

  it("rejects a budget on a CBO campaign and a missing budget on an ABO campaign", async () => {
    mockGraph([["GET", "3001", () => json({ ...aboCampaign, daily_budget: "1000000" })]])
    await expect(run("meta_create_adset", adsetInput)).rejects.toMatchObject({ code: "invalid_request" })
    mockGraph([["GET", "3001", () => json(aboCampaign)]])
    await expect(run("meta_create_adset", { ...adsetInput, budget: undefined })).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("validates objective → optimization_goal and promoted_object", async () => {
    mockGraph([["GET", "3001", () => json(aboCampaign)]])
    await expect(run("meta_create_adset", { ...adsetInput, optimization_goal: "LINK_CLICKS" })).rejects.toThrow(/OFFSITE_CONVERSIONS, VALUE/)
    await expect(run("meta_create_adset", { ...adsetInput, promoted_object: { pixel_id: "777" } })).rejects.toThrow(/custom_event_type/)
  })

  it("requires DSA fields when targeting EU countries", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ id: "2002" })],
    ])
    const eu = { ...adsetInput, targeting: { countries: ["DE", "VN"] } }
    await expect(run("meta_create_adset", eu)).rejects.toThrow(/dsa_beneficiary/)
    await run("meta_create_adset", { ...eu, dsa_beneficiary: "Shop VN", dsa_payor: "Shop VN" })
    expect(m.mutatingPosts()[0].params).toMatchObject({ dsa_beneficiary: "Shop VN", dsa_payor: "Shop VN" })
  })

  it("dryRun validates without creating", async () => {
    const m = mockGraph([
      ["GET", "3001", () => json(aboCampaign)],
      ["POST", "act_1001/adsets", () => json({ success: true })],
    ])
    const res = await run("meta_create_adset", adsetInput, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
    expect(res.payload.budget).toMatchObject({ amount: 200000, currency: "VND" })
  })

  it("refuses a campaign from another ad account", async () => {
    const m = mockGraph([["GET", "3001", () => json({ ...aboCampaign, account_id: "4242" })]])
    await expect(run("meta_create_adset", adsetInput)).rejects.toMatchObject({ code: "not_found" })
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})

/** Pages of act_1001 usable for ads: 888 (promote_pages), 777 (me/accounts + ADVERTISE); 666 is moderate-only. */
const advertisable: Route[] = [
  ["GET", "act_1001/promote_pages", () => json({ data: [{ id: "888", name: "Shop VN" }] })],
  [
    "GET",
    "me/accounts",
    () => json({ data: [{ id: "777", name: "Via Page", tasks: ["ADVERTISE"] }, { id: "666", name: "Mod only", tasks: ["MODERATE"] }] }),
  ],
  // video library of act_1001 (S-M1 ownership check): only video 555 (filtering id IN […])
  ["GET", "act_1001/advideos", (c) => json({ data: (c.params.filtering ?? "").includes('"555"') ? [{ id: "555" }] : [] })],
]

describe("meta_create_ad", () => {
  const adset = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    optimization_goal: "OFFSITE_CONVERSIONS",
    campaign: { id: "3001", objective: "OUTCOME_SALES" },
  }

  it("link ad: PAUSED, inline creative, Advantage+ creative features OPT_OUT unless requested", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["POST", "act_1001/ads", () => json({ id: "11" })],
    ])
    await run("meta_create_ad", {
      adset_id: "2001",
      name: "Ad 1",
      page_id: "888",
      creative: {
        type: "link",
        link: "https://shop.vn/sp",
        message: "Giảm 50%",
        headline: "Sale",
        image_hash: "0123456789abcdef0123456789abcdef",
        call_to_action: { type: "SHOP_NOW" },
      },
      url_tags: "utm_source=facebook",
      advantage_creative_opt_in: ["image_touchups"],
    })
    const p = m.mutatingPosts()[0].params
    expect(p.status).toBe("PAUSED")
    const creative = JSON.parse(p.creative)
    expect(creative.object_story_spec).toEqual({
      page_id: "888",
      link_data: {
        link: "https://shop.vn/sp",
        message: "Giảm 50%",
        name: "Sale",
        image_hash: "0123456789abcdef0123456789abcdef",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.vn/sp" } },
      },
    })
    const features = creative.degrees_of_freedom_spec.creative_features_spec
    expect(features.text_optimizations).toEqual({ enroll_status: "OPT_OUT" })
    expect(features.image_templates).toEqual({ enroll_status: "OPT_OUT" })
    expect(features.image_touchups).toEqual({ enroll_status: "OPT_IN" })
    expect(creative.url_tags).toBe("utm_source=facebook")
  })

  it("video ad without a cover needs a ready video (auto cover, D1); existing post uses object_story_id", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["GET", "555", () => json({ status: { video_status: "processing" } })],
      ["POST", "act_1001/ads", () => json({ id: "12" })],
    ])
    await expect(
      run("meta_create_ad", { adset_id: "2001", name: "V", page_id: "888", creative: { type: "video", video_id: "555" } })
    ).rejects.toMatchObject({ toolCode: "video_processing" })
    expect(m.mutatingPosts()).toHaveLength(0)
    await run("meta_create_ad", { adset_id: "2001", name: "Post", creative: { type: "existing_post", object_story_id: "888_999" } })
    const creative = JSON.parse(m.mutatingPosts()[0].params.creative)
    expect(creative.object_story_id).toBe("888_999")
    expect(creative.degrees_of_freedom_spec.creative_features_spec.enhance_cta).toEqual({ enroll_status: "OPT_OUT" })
  })

  it("lead ads need a lead form id", async () => {
    mockGraph([["GET", "2001", () => json({ ...adset, optimization_goal: "LEAD_GENERATION", campaign: { objective: "OUTCOME_LEADS" } })]])
    await expect(
      run("meta_create_ad", { adset_id: "2001", name: "L", page_id: "888", creative: { type: "link", link: "https://x.vn", call_to_action: { type: "SIGN_UP" } } })
    ).rejects.toThrow(/lead_gen_form_id/)
  })

  it("dryRun never creates", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["POST", "act_1001/ads", () => json({ success: true })],
    ])
    const res = await run("meta_create_ad", { adset_id: "2001", name: "Ad", page_id: "888", creative: { type: "link", link: "https://shop.vn" } }, { dryRun: true })
    expect(res.preview).toBe(true)
    expect(m.mutatingPosts()).toHaveLength(0)
  })

  it("page_id outside the ad account's advertisable Pages is refused (dry run and execute) before any POST", async () => {
    const link = (page_id: string) => ({ adset_id: "2001", name: "Ad", page_id, creative: { type: "link", link: "https://shop.vn" } })
    for (const opts of [{}, { dryRun: true }]) {
      const m = mockGraph([["GET", "2001", () => json(adset)], ...advertisable, ["POST", /.*/, () => json({ id: "13" })]])
      // unknown Page, and a Page the via only moderates (no ADVERTISE task)
      for (const page of ["999", "666"]) {
        await expect(run("meta_create_ad", link(page), opts)).rejects.toMatchObject({
          code: "invalid_request",
          userMessageVi: `Trang ${page} không nằm trong danh sách Trang mà tài khoản quảng cáo này được dùng để chạy quảng cáo.`,
          hint: "Gọi ads_lookup kind=pages để lấy page_id hợp lệ.",
        })
      }
      expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
    }
  })

  it("existing_post: the Page prefix of object_story_id is checked; a me/accounts Page with ADVERTISE passes", async () => {
    const m = mockGraph([["GET", "2001", () => json(adset)], ...advertisable, ["POST", "act_1001/ads", () => json({ id: "14" })]])
    const post = (id: string) => ({ adset_id: "2001", name: "Post", creative: { type: "existing_post", object_story_id: id } })
    await expect(run("meta_create_ad", post("999_1"))).rejects.toThrow(/Trang 999/)
    // a valid page_id does not launder a post of another Page
    await expect(run("meta_create_ad", { ...post("999_1"), page_id: "888" })).rejects.toThrow(/Trang 999/)
    expect(m.mutatingPosts()).toHaveLength(0)
    await run("meta_create_ad", post("777_5"))
    expect(JSON.parse(m.mutatingPosts()[0].params.creative).object_story_id).toBe("777_5")
  })

  it("meta_create_adset: promoted_object.page_id must be advertisable too", async () => {
    const input = { ...adsetInput, promoted_object: { ...adsetInput.promoted_object, page_id: "999" } }
    const m = mockGraph([["GET", "3001", () => json(aboCampaign)], ...advertisable, ["POST", "act_1001/adsets", () => json({ id: "2003" })]])
    await expect(run("meta_create_adset", input, { dryRun: true })).rejects.toThrow(/Trang 999/)
    await expect(run("meta_create_adset", input)).rejects.toThrow(/Trang 999/)
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
    await run("meta_create_adset", { ...input, promoted_object: { ...input.promoted_object, page_id: "888" } })
    expect(JSON.parse(m.mutatingPosts()[0].params.promoted_object).page_id).toBe("888")
  })
})

describe("meta_update_targeting", () => {
  const current = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    targeting: {
      geo_locations: { countries: ["VN"] },
      age_min: 18,
      age_max: 65,
      targeting_automation: { advantage_audience: 1 },
      publisher_platforms: ["facebook", "instagram"],
    },
  }

  it("merge mode keeps other fields and the current advantage_audience", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => json({ success: true })],
    ])
    const res = await run("meta_update_targeting", { adset_id: "2001", targeting: { age_min: 25, age_max: 40 } })
    const t = JSON.parse(m.mutatingPosts()[0].params.targeting)
    expect(t).toMatchObject({ age_min: 25, age_max: 40, geo_locations: { countries: ["VN"] }, publisher_platforms: ["facebook", "instagram"] })
    expect(t.targeting_automation).toEqual({ advantage_audience: 1 })
    expect(res.changes[0].before).toEqual(current.targeting)
    expect(res.warnings.join(" ")).toMatch(/đang chạy/)
  })

  it("replace mode requires geo and always sends advantage_audience", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => json({ success: true })],
    ])
    await expect(run("meta_update_targeting", { adset_id: "2001", merge: false, targeting: { age_min: 30 } })).rejects.toThrow(/vị trí/)
    await run("meta_update_targeting", { adset_id: "2001", merge: false, targeting: { countries: ["VN"] } })
    const t = JSON.parse(m.mutatingPosts()[0].params.targeting)
    expect(t).toEqual({ geo_locations: { countries: ["VN"] }, targeting_automation: { advantage_audience: 0 }, age_min: 18 })
  })

  it("rejects removed placements", async () => {
    mockGraph([["GET", "2001", () => json(current)]])
    await expect(
      run("meta_update_targeting", { adset_id: "2001", targeting: { publisher_platforms: ["instagram"], instagram_positions: ["explore"] } })
    ).rejects.toThrow(/Explore/)
  })

  it("dryRun on targeting update sends zero POSTs (preview from reads only)", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(current)],
      ["POST", "2001", () => graphError(100, undefined, { error_user_msg: "should not be called" })],
    ])
    const res = (await run("meta_update_targeting", { adset_id: "2001", targeting: { age_min: 25 } }, { dryRun: true })) as {
      preview: boolean
    }
    expect(res.preview).toBe(true)
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})
describe("meta_create_ad - video cover (D1-D5)", () => {
  const adset = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    optimization_goal: "OFFSITE_CONVERSIONS",
    campaign: { id: "3001", objective: "OUTCOME_SALES" },
  };
  const URI =
    "https://scontent.xx.fbcdn.net/v/t15/thumb.jpg?oh=SIGNEDOH&oe=6720AB00";
  const HASH = "c0ffee00c0ffee00c0ffee00c0ffee00";
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 9, 9]);
  const video = (extra: Record<string, unknown> = {}) => ({
    adset_id: "2001",
    name: "Video ad",
    page_id: "888",
    creative: { type: "video", video_id: "555", message: "Xem ngay", ...extra },
  });
  const ready: Route = [
    "GET",
    "555",
    () =>
      json({
        status: { video_status: "ready" },
        thumbnails: {
          data: [
            { uri: "https://scontent.xx.fbcdn.net/other.jpg" },
            { uri: URI, is_preferred: true },
          ],
        },
      }),
  ];
  const fetchImage = vi.fn(async () => ({
    bytes: JPEG,
    contentType: "image/jpeg",
  }));
  beforeEach(() => fetchImage.mockClear());

  const creativeOf = (m: ReturnType<typeof mockGraph>, validate = false) => {
    const post = m.calls.find(
      (c) =>
        c.method === "POST" &&
        c.path === "act_1001/ads" &&
        (c.params.execution_options ?? "").includes("validate_only") ===
          validate,
    )!;
    return JSON.parse(post.params.creative) as {
      object_story_spec: {
        video_data?: Record<string, unknown>;
        link_data?: Record<string, unknown>;
      };
    };
  };

  it("no cover + video still processing → video_processing (with %), nothing is sent (preview and execute)", async () => {
    for (const opts of [{ dryRun: true }, { fetchImage }]) {
      const m = mockGraph([
        ["GET", "2001", () => json(adset)],
        ...advertisable,
        [
          "GET",
          "555",
          () =>
            json({
              status: { video_status: "processing", processing_progress: 20 },
              picture: "https://scontent.fbcdn.net/placeholder.jpg",
            }),
        ],
        ["POST", /.*/, () => json({ id: "x" })],
      ]);
      const e = await run("meta_create_ad", video(), opts).catch(
        (x: unknown) => x,
      );
      expect(
        (e as { toJSON(): Record<string, unknown> }).toJSON(),
      ).toMatchObject({ code: "video_processing", retryable: false });
      expect((e as Error & { userMessageVi: string }).userMessageVi).toContain(
        "20%",
      );
      expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    }
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("no cover + failed / expired video → video_failed", async () => {
    mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["GET", "555", () => json({ status: { video_status: "expired" } })],
    ]);
    await expect(
      run("meta_create_ad", video(), { dryRun: true }),
    ).rejects.toMatchObject({ toolCode: "video_failed" });
  });

  it("preview with the automatic cover: validate_only gets Meta's thumbnail, the preview never shows the signed uri; nothing uploaded", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ready,
      ["POST", "act_1001/ads", () => json({ success: true })],
    ]);
    const res = await run("meta_create_ad", video(), { dryRun: true });
    expect(res.preview).toBe(true);
    expect(m.mutatingPosts()).toHaveLength(0);
    expect(m.calls.some((c) => c.path === "act_1001/adimages")).toBe(false);
    expect(creativeOf(m, true).object_story_spec.video_data).toMatchObject({
      video_id: "555",
      image_url: URI,
    });
    const shown = JSON.stringify({
      payload: res.payload,
      changes: res.changes,
      warnings: res.warnings,
    });
    expect(shown).not.toContain("fbcdn");
    expect(shown).not.toContain("SIGNEDOH");
    expect(shown).toContain("<ảnh bìa Meta tự chọn từ video>");
    expect(res.warnings.join(" ")).toMatch(/tự dùng ảnh bìa Meta/);
    // the thumbnails were asked for with the status
    expect(m.calls.find((c) => c.path === "555")!.params.fields).toBe(
      "status,picture,thumbnails{uri,is_preferred,width,height}",
    );
  });

  it("execute with the automatic cover: guarded download → adimages bytes → image_hash in video_data (no image_url, no uri anywhere)", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ready,
      [
        "POST",
        "act_1001/adimages",
        () =>
          json({
            images: {
              bytes: {
                hash: HASH,
                url: "https://scontent.fbcdn.net/adimg.jpg",
              },
            },
          }),
      ],
      ["POST", "act_1001/ads", () => json({ id: "77" })],
    ]);
    const res = await run("meta_create_ad", video(), { fetchImage });
    expect(fetchImage).toHaveBeenCalledWith(URI, {
      maxBytes: 30 * 1024 * 1024,
    });
    expect(
      m.calls.find((c) => c.path === "act_1001/adimages")!.params.bytes,
    ).toBe(Buffer.from(JPEG).toString("base64"));
    const data = creativeOf(m).object_story_spec.video_data!;
    expect(data).toMatchObject({
      video_id: "555",
      image_hash: HASH,
      message: "Xem ngay",
    });
    expect(data.image_url).toBeUndefined();
    expect(res.createdIds).toEqual(["77"]);
    expect(res.warnings.join(" ")).toContain(`image_hash ${HASH}`);
    const shown = JSON.stringify(res);
    expect(shown).not.toContain("fbcdn");
    expect(shown).not.toContain("SIGNEDOH");
  });

  it("execute without mcp-core's guarded fetch → refused before the ad is created", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ready,
      ["POST", /.*/, () => json({ id: "x" })],
    ]);
    await expect(run("meta_create_ad", video())).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(m.mutatingPosts()).toHaveLength(0);
  });

  it("a validate_only error that echoes the thumbnail URL is scrubbed", async () => {
    mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ready,
      [
        "POST",
        "act_1001/ads",
        () =>
          graphError(100, 3858258, {
            message: `Image wasn't downloaded from ${URI}`,
            error_user_msg: `Không tải được ${URI}`,
          }),
      ],
    ]);
    const e = await run("meta_create_ad", video(), { dryRun: true }).catch(
      (x: unknown) => x,
    );
    const text =
      JSON.stringify((e as { toJSON(): unknown }).toJSON()) +
      String((e as Error).message);
    expect(text).not.toContain("SIGNEDOH");
    expect(text).not.toContain("fbcdn");
    expect(text).toContain("[ảnh bìa]");
  });

  it("explicit image_hash / image_url win over the automatic cover (no thumbnail read on execute); a processing video only warns in the preview", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      [
        "GET",
        "555",
        () =>
          json({
            status: { video_status: "processing", processing_progress: 70 },
          }),
      ],
      ["POST", "act_1001/ads", () => json({ id: "78" })],
    ]);
    const pre = await run("meta_create_ad", video({ image_hash: HASH }), {
      dryRun: true,
    });
    expect(pre.warnings.join(" ")).toContain("70%");
    await run(
      "meta_create_ad",
      video({ image_url: "https://cdn.shop.vn/cover.jpg" }),
      { fetchImage },
    );
    expect(creativeOf(m).object_story_spec.video_data).toMatchObject({
      image_url: "https://cdn.shop.vn/cover.jpg",
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(
      m.calls.filter(
        (c) =>
          c.path === "555" && (c.params.fields ?? "").includes("thumbnails"),
      ),
    ).toHaveLength(0);
  });

  it("only one image source", async () => {
    mockGraph([["GET", "2001", () => json(adset)]]);
    await expect(
      run(
        "meta_create_ad",
        video({
          image_hash: HASH,
          image_drive_file: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        }),
      ),
    ).rejects.toThrow(
      /Chỉ truyền một trong image_hash, image_url hoặc image_drive_file/,
    );
  });

  it("Drive cover (opts.driveImage): execute uses the uploaded image_hash; preview shows the file label, validates with Meta's thumbnail stand-in", async () => {
    const drive = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const e = ext("meta_create_ad");
    expect(
      e.driveImageRef!(e.input.parse(video({ image_drive_file: drive }))),
    ).toBe(drive);
    expect(
      e.driveImageRef!(
        e.input.parse({
          adset_id: "2001",
          name: "P",
          creative: { type: "existing_post", object_story_id: "888_1" },
        }),
      ),
    ).toBeUndefined();

    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ready,
      ["POST", "act_1001/ads", () => json({ id: "79" })],
    ]);
    const exec = await e.run(
      providerCtx(),
      e.input.parse(video({ image_drive_file: drive })),
      {
        fetchImage,
        driveImage: { label: "bia.jpg (0.2 MB)", imageHash: HASH },
      },
    );
    expect(creativeOf(m).object_story_spec.video_data).toMatchObject({
      image_hash: HASH,
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(JSON.stringify(exec.payload)).toContain(
      "<ảnh bìa từ Google Drive: bia.jpg (0.2 MB)>",
    );

    const pre = await e.run(
      providerCtx(),
      e.input.parse(video({ image_drive_file: drive })),
      {
        dryRun: true,
        driveImage: { label: "bia.jpg (0.2 MB)" },
      },
    );
    expect(creativeOf(m, true).object_story_spec.video_data!.image_url).toBe(
      URI,
    );
    expect(JSON.stringify(pre)).not.toContain("fbcdn");
    expect(JSON.stringify(pre.payload)).toContain("bia.jpg (0.2 MB)");
    // execution without the uploaded hash is an internal error (mcp-core always uploads first)
    await expect(
      e.run(providerCtx(), e.input.parse(video({ image_drive_file: drive })), {
        fetchImage,
      }),
    ).rejects.toThrow(/Lỗi nội bộ/);
  });

  it("Drive cover preview while the video is processing: validate_only skipped with a warning (Meta decides at creation)", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["GET", "555", () => json({ status: { video_status: "processing" } })],
      ["POST", /.*/, () => json({ success: true })],
    ]);
    const res = await run(
      "meta_create_ad",
      video({ image_drive_file: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" }),
      { dryRun: true },
    );
    expect(res.preview).toBe(true);
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(res.warnings.join(" ")).toContain("validate_only");
  });

  it("link creative with a Drive image: link_data.image_hash from opts.driveImage; preview validates without a picture", async () => {
    const link = {
      adset_id: "2001",
      name: "L",
      page_id: "888",
      creative: {
        type: "link",
        link: "https://shop.vn",
        image_drive_file: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      },
    };
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...advertisable,
      ["POST", "act_1001/ads", () => json({ id: "80" })],
    ]);
    const e = ext("meta_create_ad");
    await e.run(providerCtx(), e.input.parse(link), {
      dryRun: true,
      driveImage: { label: "anh.png" },
    });
    const vd = creativeOf(m, true).object_story_spec.link_data!;
    expect(vd.picture).toBeUndefined();
    expect(vd.image_hash).toBeUndefined();
    await e.run(providerCtx(), e.input.parse(link), {
      fetchImage,
      driveImage: { label: "anh.png", imageHash: HASH },
    });
    expect(creativeOf(m).object_story_spec.link_data).toMatchObject({
      image_hash: HASH,
      link: "https://shop.vn",
    });
  });
});
describe("meta_create_ad - video ownership before any status / cover read (S-M1)", () => {
  const adset = {
    id: "2001",
    name: "Nhóm",
    account_id: "1001",
    campaign_id: "3001",
    optimization_goal: "OFFSITE_CONVERSIONS",
    campaign: { id: "3001", objective: "OUTCOME_SALES" },
  };
  const pages = advertisable.filter(([, path]) => path !== "act_1001/advideos");
  const video = (id: string, extra: Record<string, unknown> = {}) => ({
    adset_id: "2001",
    name: "V",
    page_id: "888",
    creative: { type: "video", video_id: id, ...extra },
  });
  const status: Route = [
    "GET",
    /^9\d+$/,
    () =>
      json({ status: { video_status: "processing", processing_progress: 61 } }),
  ];

  it("a video of another account: neutral not_found (no status, no %), the video node is never read - auto and Drive branches", async () => {
    for (const extra of [
      {},
      { image_drive_file: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
    ]) {
      const m = mockGraph([
        ["GET", "2001", () => json(adset)],
        ...pages,
        ["GET", "act_1001/advideos", () => json({ data: [] })],
        status,
      ]);
      const e = await run("meta_create_ad", video("9001", extra), {
        dryRun: true,
        driveImage: { label: "x.jpg" },
      }).catch((x: unknown) => x);
      expect(
        (e as { toJSON(): Record<string, unknown> }).toJSON(),
      ).toMatchObject({ code: "not_found" });
      expect(JSON.stringify((e as { toJSON(): unknown }).toJSON())).not.toMatch(
        /61|xử lý/,
      );
      expect(m.calls.some((c) => c.path === "9001")).toBe(false);
    }
  });

  it("explicit cover + unverified video: no status read, no warning (Meta decides)", async () => {
    const m = mockGraph([
      ["GET", "2001", () => json(adset)],
      ...pages,
      ["GET", "act_1001/advideos", () => json({ data: [] })],
      status,
      ["POST", "act_1001/ads", () => json({ success: true })],
    ]);
    const res = await run(
      "meta_create_ad",
      video("9002", { image_hash: "c0ffee00c0ffee00c0ffee00c0ffee00" }),
      { dryRun: true },
    );
    expect(res.warnings.join(" ")).not.toContain("61%");
    expect(m.calls.some((c) => c.path === "9002")).toBe(false);
  });

  it("an id this app uploaded (opts.isKnownMedia) skips the platform check", async () => {
    const isKnownMedia = vi.fn(async () => true);
    const m = mockGraph([["GET", "2001", () => json(adset)], ...pages, status]);
    await expect(
      run("meta_create_ad", video("9003"), { dryRun: true, isKnownMedia }),
    ).rejects.toMatchObject({ toolCode: "video_processing" });
    expect(isKnownMedia).toHaveBeenCalledWith({ type: "video", id: "9003" });
    expect(m.calls.some((c) => c.path === "act_1001/advideos")).toBe(false);
  });

  it("C-M2: the id filter fails or is ignored → the first library pages are scanned instead", async () => {
    // filter rejected, video on page 2
    let scans = 0;
    mockGraph([
      ["GET", "2001", () => json(adset)],
      ...pages,
      [
        "GET",
        "act_1001/advideos",
        (c) => {
          if (c.params.filtering)
            return graphError(100, undefined, { message: "Invalid filtering" });
          scans++;
          return c.params.after
            ? json({ data: [{ id: "9004" }] })
            : json({
                data: [{ id: "1" }, { id: "2" }],
                paging: {
                  cursors: { after: "CUR" },
                  next: "https://graph.facebook.com/next",
                },
              });
        },
      ],
      status,
    ]);
    await expect(
      run("meta_create_ad", video("9004"), { dryRun: true }),
    ).rejects.toMatchObject({ toolCode: "video_processing" });
    expect(scans).toBe(2);
    // filter ignored (other videos listed), not found in the scanned pages → not_found
    mockGraph([
      ["GET", "2001", () => json(adset)],
      ...pages,
      ["GET", "act_1001/advideos", () => json({ data: [{ id: "1" }] })],
      status,
    ]);
    await expect(
      run("meta_create_ad", video("9005"), { dryRun: true }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("meta video status - fallbacks (C-M1, S-L3, S-L4)", () => {
  it("readMetaVideo: thumbnails{…} expansion rejected → one retry with status,picture (picture only when ready)", async () => {
    const { getMetaMediaStatus, metaVideoCoverUri } = await import("./media");
    const m = mockGraph([
      [
        "GET",
        "9100",
        (c) =>
          c.params.fields.includes("thumbnails")
            ? graphError(100, undefined, {
                message:
                  "(#100) Tried accessing nonexisting field (thumbnails)",
              })
            : json({
                status: { video_status: "ready" },
                picture: "https://scontent.fbcdn.net/p.jpg",
              }),
      ],
    ]);
    expect(await metaVideoCoverUri(providerCtx(), "9100")).toBe(
      "https://scontent.fbcdn.net/p.jpg",
    );
    expect(m.calls.map((c) => c.params.fields)).toEqual([
      "status,picture,thumbnails{uri,is_preferred,width,height}",
      "status,picture",
    ]);
    expect(
      (await getMetaMediaStatus(providerCtx(), { type: "video", id: "9100" }))
        .hasThumbnail,
    ).toBe(true);
  });

  it("phase error text is one sanitised line (no control / bidi characters)", async () => {
    const { classifyVideoStatus } = await import("./media");
    const st = classifyVideoStatus({
      video_status: "error",
      processing_phase: {
        status: "error",
        errors: [{ message: "Bad‮video\u0007\nline2" }],
      },
    });
    expect(st.error).toBe("Badvideo line2");
  });
});
