import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { failuresToError } from "./mutate"
import {
  adSchedulesSchema,
  adScheduleSchema,
  campaignTargetingExtensions,
  microToDegreesText,
  proximitiesSchema,
  proximitySchema,
  proximityText,
  proximityPoint,
  scheduleText,
  schedulesText,
  toMicroDegrees,
  updateCampaignTargetingInput,
  validateAdSchedules,
  type AdSchedule,
} from "./targeting"
import {
  mockFetch,
  providerCtx,
  saCredentials,
  searchMatching,
  type FetchMock,
  type RecordedCall,
} from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const ext = (name: string) =>
  campaignTargetingExtensions.find((e) => e.name === name)!
const getTool = () => ext("google_ads_get_campaign_targeting")
const updTool = () => ext("google_ads_update_campaign_targeting")

const sch = (
  day: AdSchedule["day_of_week"],
  sh: number,
  eh: number,
  sm = 0,
  em = 0
): AdSchedule => ({
  day_of_week: day,
  start_hour: sh,
  start_minute: sm,
  end_hour: eh,
  end_minute: em,
})

type Row = Record<string, unknown>
const campaignRow = (over: Record<string, unknown> = {}): Row => ({
  campaign: {
    id: "1",
    name: "Search HN",
    status: "PAUSED",
    advertisingChannelType: "SEARCH",
    biddingStrategyType: "MANUAL_CPC",
    geoTargetTypeSetting: {
      positiveGeoTargetType: "PRESENCE_OR_INTEREST",
      negativeGeoTargetType: "PRESENCE",
    },
    ...over,
  },
})
const locCrit = (geoId: string, negative = false): Row => ({
  campaignCriterion: {
    criterionId: geoId,
    type: "LOCATION",
    negative,
    location: { geoTargetConstant: `geoTargetConstants/${geoId}` },
  },
})
const proxCrit = (
  id: string,
  lat: number,
  lng: number,
  radius: number
): Row => ({
  campaignCriterion: {
    criterionId: id,
    type: "PROXIMITY",
    proximity: {
      geoPoint: { latitudeInMicroDegrees: lat, longitudeInMicroDegrees: lng },
      radius,
      radiusUnits: "KILOMETERS",
      address: { cityName: "Hà Nội", countryCode: "VN" },
    },
  },
})
const schedCrit = (
  id: string,
  day: string,
  sh: number | undefined,
  eh: number,
  bidModifier?: number
): Row => ({
  campaignCriterion: {
    criterionId: id,
    type: "AD_SCHEDULE",
    ...(bidModifier !== undefined ? { bidModifier } : {}),
    adSchedule: {
      dayOfWeek: day,
      ...(sh ? { startHour: sh } : {}),
      startMinute: "ZERO",
      endHour: eh,
      endMinute: "ZERO",
    },
  },
})
const GEO: Record<string, string> = {
  "2704": "Vietnam",
  "1028580": "Hanoi,Hanoi,Vietnam",
  "9040331": "Ho Chi Minh City,Vietnam",
}

function setup(
  opts: {
    campaign?: Row | null
    criteria?: Row[]
    mutate?: { status?: number; body?: unknown }
  } = {}
): FetchMock {
  const m = mockFetch()
  m.on(searchMatching(/FROM campaign WHERE/), {
    body: {
      results: opts.campaign === null ? [] : [opts.campaign ?? campaignRow()],
    },
  })
  m.on(searchMatching(/FROM campaign_criterion/), {
    body: { results: opts.criteria ?? [] },
  })
  m.on(searchMatching(/FROM geo_target_constant/), (c) => {
    const ids = /IN \(([^)]*)\)/
      .exec(String((c.body as { query: string }).query))![1]!
      .split(", ")
    return {
      body: {
        results: ids
          .filter((id) => GEO[id])
          .map((id) => ({
            geoTargetConstant: {
              id,
              name: GEO[id]!.split(",")[0],
              canonicalName: GEO[id],
              targetType: "City",
            },
          })),
      },
    }
  })
  m.on(isMutate, opts.mutate ?? { body: { mutateOperationResponses: [] } })
  return m
}
const isMutate = (c: RecordedCall) => c.url.endsWith("googleAds:mutate")
const mutateBody = (m: FetchMock) =>
  m.api().find(isMutate)?.body as
    { mutateOperations: Row[]; validateOnly?: boolean } | undefined

async function update(input: Record<string, unknown>, dryRun = false) {
  const tool = updTool()
  return (await tool.run(
    providerCtx(saCredentials()),
    tool.input.parse({ campaign_id: "1", ...input }),
    { dryRun }
  )) as {
    preview: boolean
    changes: {
      field: string
      before: unknown
      after: unknown
      objectId: string
      level: string
    }[]
    warnings: string[]
    current_targeting?: Row
  }
}

describe("targeting schemas", () => {
  it("ad schedule: minutes, 24:xx, end after start", () => {
    expect(
      adScheduleSchema.parse({
        day_of_week: "MONDAY",
        start_hour: 8,
        end_hour: 12,
      })
    ).toEqual(sch("MONDAY", 8, 12))
    expect(
      adScheduleSchema.safeParse({
        day_of_week: "MONDAY",
        start_hour: 8,
        end_hour: 24,
        end_minute: 15,
      }).success
    ).toBe(false)
    expect(
      adScheduleSchema.safeParse({
        day_of_week: "MONDAY",
        start_hour: 8,
        end_hour: 24,
      }).success
    ).toBe(true)
    expect(
      adScheduleSchema.safeParse({
        day_of_week: "MONDAY",
        start_hour: 8,
        start_minute: 10,
        end_hour: 12,
      }).success
    ).toBe(false)
    const r = adScheduleSchema.safeParse({
      day_of_week: "SUNDAY",
      start_hour: 22,
      end_hour: 2,
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain("Chủ nhật")
  })

  it("list validation: overlap, >6 per day, 42 total", () => {
    expect(
      validateAdSchedules([sch("MONDAY", 8, 12), sch("MONDAY", 12, 18)])
    ).toEqual([])
    expect(
      validateAdSchedules([
        sch("MONDAY", 8, 12),
        sch("MONDAY", 11, 18, 45),
      ]).join(" ")
    ).toMatch(/Thứ 2: khung 08:00–12:00 và 11:45–18:00 chồng/)
    const seven = Array.from({ length: 7 }, (_, i) =>
      sch("TUESDAY", i * 2, i * 2 + 1)
    )
    expect(validateAdSchedules(seven).join(" ")).toMatch(/Thứ 3: tối đa 6/)
    expect(adSchedulesSchema.safeParse(seven).success).toBe(false)
    const many = Array.from({ length: 43 }, (_, i) =>
      sch("WEDNESDAY", i % 23, (i % 23) + 1)
    )
    expect(adSchedulesSchema.safeParse(many).success).toBe(false)
    expect(adSchedulesSchema.safeParse([sch("FRIDAY", 9, 17)]).success).toBe(
      true
    )
  })

  it("proximity: radius bounds per unit, 2 decimals, duplicates", () => {
    const p = (radius: number, radius_unit?: string) =>
      proximitySchema.safeParse({
        latitude: 21.0285,
        longitude: 105.8542,
        radius,
        radius_unit,
      })
    expect(p(1).success).toBe(true)
    expect(p(0.5).success).toBe(false)
    expect(p(800).success).toBe(true)
    expect(p(801).success).toBe(false)
    expect(p(0.7, "MILES").success).toBe(true)
    expect(p(0.6, "MILES").success).toBe(false)
    expect(p(501, "MILES").success).toBe(false)
    expect(p(1.234).success).toBe(false)
    expect(
      proximitySchema.safeParse({ latitude: 91, longitude: 0, radius: 5 })
        .success
    ).toBe(false)
    expect(
      proximitySchema.safeParse({ latitude: 0, longitude: -181, radius: 5 })
        .success
    ).toBe(false)
    const one = { latitude: 21.0285, longitude: 105.8542, radius: 5 }
    expect(proximitiesSchema.safeParse([one, { ...one }]).success).toBe(false)
    expect(
      proximitiesSchema.safeParse([one, { ...one, radius: 6 }]).success
    ).toBe(true)
  })

  it("micro-degrees are integers without float noise", () => {
    expect(toMicroDegrees(21.0285)).toBe(21_028_500)
    expect(toMicroDegrees(105.8542)).toBe(105_854_200)
    expect(toMicroDegrees(-33.8688)).toBe(-33_868_800)
    expect(toMicroDegrees(10.1234565)).toBe(10_123_457)
    expect(toMicroDegrees(0.1 + 0.2)).toBe(300_000)
    expect(toMicroDegrees(-0.0000001)).toBe(0)
    expect(toMicroDegrees(1e-7)).toBe(0)
    expect(microToDegreesText(21_028_500)).toBe("21.0285")
    expect(microToDegreesText(-33_868_800)).toBe("-33.8688")
    expect(microToDegreesText(5_000_000)).toBe("5")
  })

  it("readable texts", () => {
    expect(scheduleText(sch("MONDAY", 8, 12))).toBe("Thứ 2 08:00–12:00")
    expect(scheduleText(sch("SUNDAY", 0, 24, 30))).toBe("Chủ nhật 00:30–24:00")
    expect(schedulesText([])).toBe("Cả ngày, mọi ngày")
    expect(
      schedulesText([
        sch("SUNDAY", 1, 2),
        sch("MONDAY", 9, 10),
        sch("MONDAY", 7, 8),
      ])
    ).toEqual([
      "Thứ 2 07:00–08:00",
      "Thứ 2 09:00–10:00",
      "Chủ nhật 01:00–02:00",
    ])
    expect(
      proximityText(
        proximityPoint(
          proximitySchema.parse({
            latitude: 21.0285,
            longitude: 105.8542,
            radius: 5,
          })
        )
      )
    ).toBe("Bán kính 5 km quanh 21.0285, 105.8542")
  })

  it("update input requires a change and rejects target+exclude of the same id", () => {
    expect(
      updateCampaignTargetingInput.safeParse({ campaign_id: "1" }).success
    ).toBe(false)
    expect(
      updateCampaignTargetingInput.safeParse({
        campaign_id: "1",
        allow_no_location: true,
      }).success
    ).toBe(false)
    expect(
      updateCampaignTargetingInput.safeParse({
        campaign_id: "1",
        ad_schedules: [],
      }).success
    ).toBe(true)
    expect(
      updateCampaignTargetingInput.safeParse({
        campaign_id: "1",
        add_location_ids: ["2704"],
        add_excluded_location_ids: ["2704"],
      }).success
    ).toBe(false)
    expect(
      updateCampaignTargetingInput.safeParse({
        campaign_id: "1",
        positive_geo_target_type: "SEARCH_INTEREST",
      }).success
    ).toBe(false)
  })
})

describe("google_ads_get_campaign_targeting", () => {
  it("returns locations with names, proximities, sorted schedules and account timezone", async () => {
    const m = setup({
      criteria: [
        locCrit("1028580"),
        locCrit("9040331", true),
        proxCrit("77", 21_028_500, 105_854_200, 5),
        schedCrit("12", "TUESDAY", 9, 17),
        schedCrit("11", "MONDAY", undefined, 12, 1.2),
      ],
    })
    const tool = getTool()
    expect(tool.permission).toBe("read")
    expect(tool.write).toBe(false)
    const out = (await tool.run(
      providerCtx(saCredentials()),
      tool.input.parse({ campaign_id: "1" }),
      {}
    )) as Record<string, unknown> & {
      locations: Row[]
      proximities: Row[]
      ad_schedules: Row[]
    }
    expect(out).toMatchObject({
      campaign_id: "1",
      campaign_name: "Search HN",
      channel_type: "SEARCH",
      status: "PAUSED",
      timezone: "Asia/Ho_Chi_Minh",
      positive_geo_target_type: "PRESENCE_OR_INTEREST",
      negative_geo_target_type: "PRESENCE",
    })
    expect(out.locations).toEqual([
      {
        criterion_id: "1028580",
        location_id: "1028580",
        name: "Hanoi",
        canonical_name: "Hanoi,Hanoi,Vietnam",
        target_type: "City",
        negative: false,
        bid_modifier: null,
      },
      {
        criterion_id: "9040331",
        location_id: "9040331",
        name: "Ho Chi Minh City",
        canonical_name: "Ho Chi Minh City,Vietnam",
        target_type: "City",
        negative: true,
        bid_modifier: null,
      },
    ])
    expect(out.proximities[0]).toMatchObject({
      criterion_id: "77",
      latitude: 21.0285,
      longitude: 105.8542,
      radius: 5,
      radius_unit: "KILOMETERS",
      address: { city: "Hà Nội", country: "VN" },
    })
    expect(out.ad_schedules.map((s) => s.text)).toEqual([
      "Thứ 2 00:00–12:00",
      "Thứ 3 09:00–17:00",
    ])
    expect(out.ad_schedules[0]).toMatchObject({
      criterion_id: "11",
      start_hour: 0,
      bid_modifier: 1.2,
    })
    expect(typeof out.note).toBe("string")
    const q = String(
      (
        m.api().find(searchMatching(/FROM campaign_criterion/))!.body as {
          query: string
        }
      ).query
    )
    expect(q).toContain("campaign_criterion.status != 'REMOVED'")
    expect(q).toContain(
      "campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'AD_SCHEDULE')"
    )
  })

  it("strips bidi / zero-width / control characters from Google text", async () => {
    const m = mockFetch()
    m.on(searchMatching(/FROM campaign WHERE/), { body: { results: [campaignRow({ name: "Search\u202e HN\u200b" })] } })
    m.on(searchMatching(/FROM campaign_criterion/), {
      body: {
        results: [
          locCrit("2704"),
          {
            campaignCriterion: {
              criterionId: "77",
              type: "PROXIMITY",
              proximity: { geoPoint: { latitudeInMicroDegrees: 1, longitudeInMicroDegrees: 2 }, radius: 5, radiusUnits: "KILOMETERS", address: { cityName: "Hà\u2066 Nội\u0007" } },
            },
          },
        ],
      },
    })
    m.on(searchMatching(/FROM geo_target_constant/), {
      body: { results: [{ geoTargetConstant: { id: "2704", name: "Viet\ufeffnam", canonicalName: "Viet\u202enam" } }] },
    })
    const out = (await getTool().run(providerCtx(saCredentials()), { campaign_id: "1" }, {})) as {
      campaign_name: string
      locations: { name: string; canonical_name: string }[]
      proximities: { address: { city: string } }[]
    }
    expect(out.campaign_name).toBe("Search HN")
    expect(out.locations[0]).toMatchObject({ name: "Vietnam", canonical_name: "Vietnam" })
    expect(out.proximities[0]!.address.city).toBe("Hà Nội")
  })

  it("removed / missing campaign → not_found", async () => {
    setup({ campaign: campaignRow({ status: "REMOVED" }) })
    await expect(
      getTool().run(providerCtx(saCredentials()), { campaign_id: "1" }, {})
    ).rejects.toMatchObject({ code: "not_found" })
    vi.unstubAllGlobals()
    setup({ campaign: null })
    await expect(
      getTool().run(providerCtx(saCredentials()), { campaign_id: "1" }, {})
    ).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("google_ads_update_campaign_targeting", () => {
  it("metadata: update permission, write, no money keys", () => {
    const t = updTool()
    expect(t.permission).toBe("update")
    expect(t.write).toBe(true)
    expect(t.moneyOf).toBeUndefined()
    expect(t.alwaysConfirm).toBe(true)
    expect(t.description).toMatch(/LUÔN cần người dùng xác nhận/)
    expect(t.description.startsWith("Dùng khi")).toBe(true)
    expect(t.description.length).toBeLessThanOrEqual(1500)
  })

  it("geo type: exact nested updateMask (negative not cleared), dryRun uses validateOnly", async () => {
    const m = setup({ criteria: [locCrit("2704")] })
    const res = await update({ positive_geo_target_type: "PRESENCE" }, true)
    const body = mutateBody(m)!
    expect(body.validateOnly).toBe(true)
    expect(body.mutateOperations).toEqual([
      {
        campaignOperation: {
          update: {
            resourceName: "customers/1234567890/campaigns/1",
            geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
          },
          updateMask: "geo_target_type_setting.positive_geo_target_type",
        },
      },
    ])
    expect(res.preview).toBe(true)
    expect(res.changes).toEqual([
      {
        objectId: "1",
        objectName: "Search HN",
        level: "campaign",
        field: "positive_geo_target_type",
        before: "PRESENCE_OR_INTEREST",
        after: "PRESENCE",
      },
    ])
  })

  it("execute is not validateOnly and same changes as preview; unchanged geo type is skipped", async () => {
    const m = setup({ criteria: [locCrit("2704")] })
    const res = await update({ positive_geo_target_type: "PRESENCE" })
    expect(mutateBody(m)!.validateOnly).toBeUndefined()
    expect(res.preview).toBe(false)
    expect(res.changes[0]!.field).toBe("positive_geo_target_type")
    vi.unstubAllGlobals()
    const m2 = setup({ criteria: [locCrit("2704")] })
    const same = await update({
      positive_geo_target_type: "PRESENCE_OR_INTEREST",
    })
    expect(mutateBody(m2)).toBeUndefined()
    expect(same.changes).toEqual([])
    expect(same.warnings.join(" ")).toMatch(/đã là PRESENCE_OR_INTEREST/)
  })

  it("schedule diff keeps identical windows and warns about lost bid adjustments", async () => {
    const m = setup({
      criteria: [
        locCrit("2704"),
        schedCrit("11", "MONDAY", 8, 12, 1.2),
        schedCrit("12", "TUESDAY", 8, 12, 1.5),
      ],
    })
    const res = await update({
      ad_schedules: [
        { day_of_week: "WEDNESDAY", start_hour: 9, end_hour: 17 },
        { day_of_week: "MONDAY", start_hour: 8, end_hour: 12 },
      ],
    })
    expect(mutateBody(m)!.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          remove: "customers/1234567890/campaignCriteria/1~12",
        },
      },
      {
        campaignCriterionOperation: {
          create: {
            campaign: "customers/1234567890/campaigns/1",
            adSchedule: {
              dayOfWeek: "WEDNESDAY",
              startHour: 9,
              startMinute: "ZERO",
              endHour: 17,
              endMinute: "ZERO",
            },
          },
        },
      },
    ])
    const ch = res.changes.find((c) => c.field === "ad_schedules")!
    expect(ch.before).toEqual(["Thứ 2 08:00–12:00", "Thứ 3 08:00–12:00"])
    expect(ch.after).toEqual(["Thứ 2 08:00–12:00", "Thứ 4 09:00–17:00"])
    const w = res.warnings.join(" ")
    expect(w).toMatch(/Thứ 3 08:00–12:00 \(×1.5\)/)
    expect(w).not.toMatch(/×1.2/)
    expect(w).toMatch(/Asia\/Ho_Chi_Minh/)
  })

  it("ad_schedules [] removes every window → runs all day", async () => {
    const m = setup({
      criteria: [locCrit("2704"), schedCrit("11", "MONDAY", 8, 12)],
    })
    const res = await update({ ad_schedules: [] })
    expect(mutateBody(m)!.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          remove: "customers/1234567890/campaignCriteria/1~11",
        },
      },
    ])
    expect(res.changes[0]).toMatchObject({
      field: "ad_schedules",
      before: ["Thứ 2 08:00–12:00"],
      after: "Cả ngày, mọi ngày",
    })
  })

  it("smart bidding: warns that schedule bid adjustments are ignored", async () => {
    setup({
      campaign: campaignRow({ biddingStrategyType: "MAXIMIZE_CONVERSIONS" }),
      criteria: [locCrit("2704")],
    })
    const res = await update({
      ad_schedules: [{ day_of_week: "MONDAY", start_hour: 8, end_hour: 12 }],
    })
    expect(res.warnings.join(" ")).toMatch(/Smart Bidding/)
  })

  it("locations: existing same polarity skipped, opposite polarity refused, unknown id refused", async () => {
    const m = setup({ criteria: [locCrit("2704")] })
    const res = await update({ add_location_ids: ["2704"] })
    expect(mutateBody(m)).toBeUndefined()
    expect(res.changes).toEqual([])
    expect(res.warnings.join(" ")).toMatch(/2704 đã có/)
    vi.unstubAllGlobals()
    setup({ criteria: [locCrit("2704")] })
    await expect(
      update({ add_excluded_location_ids: ["2704"] })
    ).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/CANNOT_TARGET_AND_EXCLUDE/),
    })
    vi.unstubAllGlobals()
    setup({ criteria: [locCrit("2704")] })
    await expect(
      update({ add_location_ids: ["999999"] })
    ).rejects.toMatchObject({ userMessageVi: expect.stringMatching(/999999/) })
  })

  it("adds a location + exclusion + proximity with readable before/after", async () => {
    const m = setup({ criteria: [locCrit("2704")] })
    const res = await update({
      add_location_ids: ["1028580"],
      add_excluded_location_ids: ["9040331"],
      add_proximities: [
        {
          latitude: 21.0285,
          longitude: 105.8542,
          radius: 5,
          label: "Cửa hàng",
        },
      ],
    })
    expect(mutateBody(m)!.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          create: {
            campaign: "customers/1234567890/campaigns/1",
            location: { geoTargetConstant: "geoTargetConstants/1028580" },
          },
        },
      },
      {
        campaignCriterionOperation: {
          create: {
            campaign: "customers/1234567890/campaigns/1",
            location: { geoTargetConstant: "geoTargetConstants/9040331" },
            negative: true,
          },
        },
      },
      {
        campaignCriterionOperation: {
          create: {
            campaign: "customers/1234567890/campaigns/1",
            proximity: {
              geoPoint: {
                latitudeInMicroDegrees: 21_028_500,
                longitudeInMicroDegrees: 105_854_200,
              },
              radius: 5,
              radiusUnits: "KILOMETERS",
            },
          },
        },
      },
    ])
    expect(JSON.stringify(mutateBody(m))).not.toContain("Cửa hàng") // label stays local
    expect(res.changes.find((c) => c.field === "locations")).toMatchObject({
      before: ["Vietnam (2704)"],
      after: [
        "Vietnam (2704)",
        "Hanoi,Hanoi,Vietnam (1028580)",
        "loại trừ: Ho Chi Minh City,Vietnam (9040331)",
      ],
    })
    expect(res.changes.find((c) => c.field === "proximities")).toMatchObject({
      before: [],
      after: ["Bán kính 5 km quanh 21.0285, 105.8542 (Cửa hàng)"],
    })
  })

  it("existing identical proximity is skipped", async () => {
    const m = setup({ criteria: [proxCrit("77", 21_028_500, 105_854_200, 5)] })
    const res = await update({
      add_proximities: [{ latitude: 21.0285, longitude: 105.8542, radius: 5 }],
    })
    expect(mutateBody(m)).toBeUndefined()
    expect(res.warnings.join(" ")).toMatch(/đã có/)
  })

  it("removing the last positive location needs allow_no_location", async () => {
    setup({ criteria: [locCrit("2704"), locCrit("9040331", true)] })
    await expect(
      update({ remove_criterion_ids: ["2704"] })
    ).rejects.toMatchObject({
      userMessageVi: expect.stringMatching(/mọi quốc gia/),
    })
    vi.unstubAllGlobals()
    const m = setup({ criteria: [locCrit("2704"), locCrit("9040331", true)] })
    const res = await update({
      remove_criterion_ids: ["2704"],
      allow_no_location: true,
    })
    expect(mutateBody(m)!.mutateOperations).toEqual([
      {
        campaignCriterionOperation: {
          remove: "customers/1234567890/campaignCriteria/1~2704",
        },
      },
    ])
    expect(res.changes[0]).toMatchObject({
      field: "locations",
      before: [
        "Vietnam (2704)",
        "loại trừ: Ho Chi Minh City,Vietnam (9040331)",
      ],
      after: ["loại trừ: Ho Chi Minh City,Vietnam (9040331)"],
    })
    vi.unstubAllGlobals()
    // replacing it with a proximity is fine
    const m2 = setup({ criteria: [locCrit("2704")] })
    await update({
      remove_criterion_ids: ["2704"],
      add_proximities: [{ latitude: 21, longitude: 105, radius: 10 }],
    })
    expect(mutateBody(m2)!.mutateOperations).toHaveLength(2)
  })

  it("remove_criterion_ids only accepts LOCATION / PROXIMITY criteria of this campaign", async () => {
    setup({ criteria: [locCrit("2704"), schedCrit("11", "MONDAY", 8, 12)] })
    await expect(
      update({ remove_criterion_ids: ["11", "555"] })
    ).rejects.toMatchObject({ userMessageVi: expect.stringMatching(/11, 555/) })
  })

  it("refuses VIDEO and SMART campaigns before any write", async () => {
    const m = setup({
      campaign: campaignRow({ advertisingChannelType: "VIDEO" }),
    })
    await expect(update({ ad_schedules: [] })).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(mutateBody(m)).toBeUndefined()
    vi.unstubAllGlobals()
    const m2 = setup({
      campaign: campaignRow({ advertisingChannelType: "SMART" }),
    })
    await expect(update({ ad_schedules: [] })).rejects.toMatchObject({
      code: "invalid_request",
      userMessageVi: expect.stringMatching(/Smart/),
    })
    expect(mutateBody(m2)).toBeUndefined()
  })

  it("PMax proximity: warns that it is unverified", async () => {
    setup({
      campaign: campaignRow({ advertisingChannelType: "PERFORMANCE_MAX" }),
      criteria: [locCrit("2704")],
    })
    const res = await update(
      { add_proximities: [{ latitude: 21, longitude: 105, radius: 10 }] },
      true
    )
    expect(res.warnings.join(" ")).toMatch(/Performance Max/)
  })

  const err502 = {
    status: 502,
    body: { error: { code: 502, status: "UNAVAILABLE", message: "x" } },
  }

  it("uncertain outcome, applied: no retry, re-read finds the new geo type → changes returned", async () => {
    // persistent = state after the write; the first (pre-write) read gets the old state
    const m = setup({
      campaign: campaignRow({
        geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" },
      }),
      criteria: [locCrit("2704")],
      mutate: err502,
    })
    m.once(searchMatching(/FROM campaign WHERE/), { body: { results: [campaignRow()] } })
    const res = await update({ positive_geo_target_type: "PRESENCE" })
    expect(m.api().filter(isMutate)).toHaveLength(1)
    expect(res.preview).toBe(false)
    expect(res.changes[0]).toMatchObject({ field: "positive_geo_target_type", after: "PRESENCE" })
    expect(res.warnings.join(" ")).toMatch(/đã có trên Google Ads/)
  })

  it("uncertain outcome, applied: re-read finds the added schedule", async () => {
    const m = setup({ criteria: [locCrit("2704"), schedCrit("50", "MONDAY", 8, 12)], mutate: err502 })
    m.once(searchMatching(/FROM campaign_criterion/), { body: { results: [locCrit("2704")] } })
    const res = await update({ ad_schedules: [{ day_of_week: "MONDAY", start_hour: 8, end_hour: 12 }] })
    expect(res.changes[0]).toMatchObject({ field: "ad_schedules" })
  })

  it("uncertain outcome, not applied: the original error is rethrown", async () => {
    const m = setup({ criteria: [locCrit("2704")], mutate: err502 })
    const err = await update({ ad_schedules: [{ day_of_week: "MONDAY", start_hour: 8, end_hour: 12 }] }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "upstream_error" })
    expect((err as { audit?: unknown }).audit).toBeUndefined()
    expect(m.api().filter(isMutate)).toHaveLength(1)
  })

  it("uncertain outcome, removed criterion gone → applied", async () => {
    const m = setup({ criteria: [locCrit("2704")], mutate: err502 })
    m.once(searchMatching(/FROM campaign_criterion/), { body: { results: [locCrit("2704"), proxCrit("77", 21_000_000, 105_000_000, 5)] } })
    const res = await update({ remove_criterion_ids: ["77"] })
    expect(res.changes[0]).toMatchObject({ field: "proximities", after: [] })
  })

  it("uncertain outcome, re-read fails: rethrown with audit partial_failure_unknown", async () => {
    const m = mockFetch()
    m.once(searchMatching(/FROM campaign WHERE/), { body: { results: [campaignRow()] } })
    m.on(searchMatching(/FROM campaign WHERE/), { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "x" } } })
    m.on(searchMatching(/FROM campaign_criterion/), { body: { results: [locCrit("2704")] } })
    m.on(isMutate, err502)
    const err = await update({ positive_geo_target_type: "PRESENCE" }).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: "upstream_error",
      audit: { errorCode: "partial_failure_unknown", changes: [expect.objectContaining({ field: "positive_geo_target_type" })] },
    })
  })

  it("rejected mutate errors are surfaced (not swallowed)", async () => {
    setup({
      criteria: [locCrit("2704")],
      mutate: {
        status: 400,
        body: {
          error: { code: 400, status: "INVALID_ARGUMENT", message: "bad" },
        },
      },
    })
    await expect(
      update({ positive_geo_target_type: "PRESENCE" })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
})

describe("Vietnamese error mappings (targeting + assets)", () => {
  it("stringLengthError carries Google's field detail", () => {
    const e = failuresToError([{ index: 0, code: "stringLengthError.TOO_LONG", message: "Too long." }])
    expect(e.userMessageVi).toMatch(/quá dài.*Chi tiết: stringLengthError.TOO_LONG/)
    expect(failuresToError([{ index: 0, code: "assetLinkError.INVALID_STATUS", message: "x" }]).userMessageVi).not.toMatch(/Chi tiết/)
  })

  it("maps criterion / asset codes", () => {
    const vi1 = failuresToError([
      {
        index: 0,
        code: "criterionError.AD_SCHEDULE_TIME_INTERVALS_OVERLAP",
        message: "x",
      },
    ])
    expect(vi1.userMessageVi).toMatch(/chồng lên nhau/)
    expect(vi1.code).toBe("invalid_request")
    expect(
      failuresToError([
        {
          index: 0,
          code: "campaignCriterionError.CANNOT_TARGET_AND_EXCLUDE",
          message: "x",
        },
      ]).userMessageVi
    ).toMatch(/vừa nhắm vừa loại trừ/)
    expect(
      failuresToError([
        {
          index: 0,
          code: "assetError.CALL_PREMIUM_RATE_NUMBER_NOT_ALLOWED",
          message: "x",
        },
      ]).userMessageVi
    ).toMatch(/premium/)
    expect(
      failuresToError([
        { index: 0, code: "mutateError.RESOURCE_ALREADY_EXISTS", message: "x" },
      ]).userMessageVi
    ).toMatch(/đã có/)
  })
})
