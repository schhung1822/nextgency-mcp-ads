// parseMcpSettings - Google Drive keys (15-google-drive-media.md §7.5): default ON, only an explicit false turns
// them off, so MCPs saved before the feature (no key in jsonb) get the owner's default without a data migration.
import { describe, expect, it } from "vitest"

import { MCP_LIMITS } from "@/lib/schemas/mcp-servers"

import { effectiveMcpSettings, parseMcpSettings } from "./settings"
import { DEFAULT_MCP_SETTINGS, isUnlimited } from "./types"

describe("parseMcpSettings - TikTok GMV Max write switch", () => {
  it("OFF unless explicitly true (fail closed), snake_case and camelCase", () => {
    expect(DEFAULT_MCP_SETTINGS.tiktokGmvMaxWrite).toBe(false)
    expect(parseMcpSettings(null).tiktokGmvMaxWrite).toBe(false)
    expect(parseMcpSettings({ two_step_confirm: true }).tiktokGmvMaxWrite).toBe(false)
    expect(parseMcpSettings({ tiktok_gmv_max_write: true }).tiktokGmvMaxWrite).toBe(true)
    expect(parseMcpSettings({ tiktokGmvMaxWrite: true }).tiktokGmvMaxWrite).toBe(true)
    expect(parseMcpSettings({ tiktok_gmv_max_write: true, tiktokGmvMaxWrite: false }).tiktokGmvMaxWrite).toBe(false)
    for (const garbage of ["true", 1, {}, []]) {
      expect(parseMcpSettings({ tiktok_gmv_max_write: garbage }).tiktokGmvMaxWrite).toBe(false)
    }
  })
})

describe("parseMcpSettings - Google Drive", () => {
  it("defaults both Drive switches to true", () => {
    expect(DEFAULT_MCP_SETTINGS.drivePublicLinks).toBe(true)
    expect(DEFAULT_MCP_SETTINGS.driveSheetWriteback).toBe(true)
    expect(parseMcpSettings(null)).toMatchObject({
      drivePublicLinks: true,
      driveSheetWriteback: true,
    })
    // a legacy row (saved before the feature) has other keys but no Drive keys
    expect(
      parseMcpSettings({ two_step_confirm: true, telegram_tool: true })
    ).toMatchObject({ drivePublicLinks: true, driveSheetWriteback: true })
  })

  it("explicit false turns them off (snake_case and camelCase)", () => {
    expect(
      parseMcpSettings({
        drive_public_links: false,
        drive_sheet_writeback: false,
      })
    ).toMatchObject({ drivePublicLinks: false, driveSheetWriteback: false })
    expect(
      parseMcpSettings({ drivePublicLinks: false, driveSheetWriteback: true })
    ).toMatchObject({ drivePublicLinks: false, driveSheetWriteback: true })
    expect(
      parseMcpSettings({
        drive_public_links: true,
        drive_sheet_writeback: false,
      })
    ).toMatchObject({ drivePublicLinks: true, driveSheetWriteback: false })
  })

  it("camelCase wins over snake_case; garbage values keep the default (true)", () => {
    expect(
      parseMcpSettings({ drive_public_links: true, drivePublicLinks: false })
        .drivePublicLinks
    ).toBe(false)
    expect(
      parseMcpSettings({
        drive_public_links: "false",
        drive_sheet_writeback: 0,
      })
    ).toMatchObject({ drivePublicLinks: true, driveSheetWriteback: true })
  })

  it("Drive keys do not disturb the other fields", () => {
    const s = parseMcpSettings({
      two_step_confirm: false,
      drive_public_links: false,
      rate_limit_per_min: 7,
    })
    expect(s).toEqual({
      ...DEFAULT_MCP_SETTINGS,
      twoStepConfirm: false,
      rateLimitPerMin: 7,
      drivePublicLinks: false,
    })
  })
})

describe("parseMcpSettings - write delay (write_delay_seconds)", () => {
  it("missing (rows saved before the setting) or invalid → 0 = off; valid values kept, snake_case and camelCase", () => {
    expect(DEFAULT_MCP_SETTINGS.writeDelaySeconds).toBe(0)
    expect(parseMcpSettings(null).writeDelaySeconds).toBe(0)
    expect(parseMcpSettings({ two_step_confirm: true }).writeDelaySeconds).toBe(0)
    expect(parseMcpSettings({ write_delay_seconds: 5 }).writeDelaySeconds).toBe(5)
    expect(parseMcpSettings({ writeDelaySeconds: 30 }).writeDelaySeconds).toBe(30)
    for (const bad of [-1, 31, 60, 2.5, "5", null, true])
      expect(parseMcpSettings({ write_delay_seconds: bad }).writeDelaySeconds).toBe(0)
  })

  it("effective settings: kept in advanced, always 0 in basic (the stored value stays in the row)", () => {
    const advanced = parseMcpSettings({ protection_mode: "advanced", write_delay_seconds: 7 })
    expect(effectiveMcpSettings(advanced).writeDelaySeconds).toBe(7)
    const basic = parseMcpSettings({ protection_mode: "basic", write_delay_seconds: 7 })
    expect(basic.writeDelaySeconds).toBe(7)
    expect(effectiveMcpSettings(basic).writeDelaySeconds).toBe(0)
  })
})

describe("parseMcpSettings - Apify (16-apify.md §7)", () => {
  it("defaults: off, $1 per run, $10 per day, Actors outside the catalog off", () => {
    expect(parseMcpSettings(null)).toMatchObject({
      apifyEnabled: false,
      apifyRunMaxUsd: 1,
      apifyDailyMaxUsd: 10,
      apifyStoreActors: false,
    })
  })

  it("switches only on an explicit true (fail closed), snake_case and camelCase", () => {
    const on = parseMcpSettings({ apify_enabled: true, apify_store_actors: true })
    expect([on.apifyEnabled, on.apifyStoreActors]).toEqual([true, true])
    expect(parseMcpSettings({ apifyEnabled: true }).apifyEnabled).toBe(true)
    for (const garbage of ["true", 1, {}, []]) {
      const s = parseMcpSettings({ apify_enabled: garbage, apify_store_actors: garbage })
      expect([s.apifyEnabled, s.apifyStoreActors]).toEqual([false, false])
    }
  })

  it("caps: valid values kept, invalid / out of range → defaults (per field)", () => {
    const s = parseMcpSettings({ apify_run_max_usd: 2.5, apify_daily_max_usd: 0, rate_limit_per_min: 7 })
    expect([s.apifyRunMaxUsd, s.apifyDailyMaxUsd, s.rateLimitPerMin]).toEqual([2.5, 0, 7])
    for (const bad of [0, 0.01, 21, -1, "2", null, Number.NaN])
      expect(parseMcpSettings({ apify_run_max_usd: bad }).apifyRunMaxUsd).toBe(1)
    for (const bad of [-1, 1001, "5", Number.POSITIVE_INFINITY])
      expect(parseMcpSettings({ apify_daily_max_usd: bad }).apifyDailyMaxUsd).toBe(10)
  })

  it("effective settings: basic → no daily cap (UNLIMITED), the per-run cap always kept", () => {
    const basic = effectiveMcpSettings(
      parseMcpSettings({ protection_mode: "basic", apify_enabled: true, apify_run_max_usd: 3, apify_daily_max_usd: 5 })
    )
    expect(basic.apifyRunMaxUsd).toBe(3)
    expect(isUnlimited(basic.apifyDailyMaxUsd)).toBe(true)
    expect(basic.apifyEnabled).toBe(true)
    const advanced = effectiveMcpSettings(
      parseMcpSettings({ protection_mode: "advanced", apify_run_max_usd: 3, apify_daily_max_usd: 5 })
    )
    expect([advanced.apifyRunMaxUsd, advanced.apifyDailyMaxUsd]).toEqual([3, 5])
  })
})

describe("parseMcpSettings - request limits share the form bounds (v1.1.6 B8)", () => {
  it("in range kept; out of range clamped to MCP_LIMITS min / max; not a number → default", () => {
    const { rateLimitPerMin: perMin, writeRateLimitPer10Min: writes } = MCP_LIMITS
    expect([perMin.min, perMin.max, writes.min, writes.max]).toEqual([1, 600, 1, 1000])
    expect(parseMcpSettings({ write_rate_limit_per_10min: 1000, rate_limit_per_min: 600 })).toMatchObject({
      writeRateLimitPer10Min: 1000,
      rateLimitPerMin: 600,
    })
    // a hand-edited / very old row above the form maximum is clamped (was: accepted up to 10000)
    expect(parseMcpSettings({ write_rate_limit_per_10min: 5000 }).writeRateLimitPer10Min).toBe(1000)
    expect(parseMcpSettings({ rate_limit_per_min: 601 }).rateLimitPerMin).toBe(600)
    expect(parseMcpSettings({ rateLimitPerMin: 10_000 }).rateLimitPerMin).toBe(600)
    // below the minimum → the minimum (stricter), fractions rounded down
    expect(parseMcpSettings({ write_rate_limit_per_10min: 0 }).writeRateLimitPer10Min).toBe(1)
    expect(parseMcpSettings({ rate_limit_per_min: -5 }).rateLimitPerMin).toBe(1)
    expect(parseMcpSettings({ rate_limit_per_min: 7.9 }).rateLimitPerMin).toBe(7)
    for (const bad of ["5", null, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = parseMcpSettings({ rate_limit_per_min: bad, write_rate_limit_per_10min: bad })
      expect([s.rateLimitPerMin, s.writeRateLimitPer10Min]).toEqual([
        DEFAULT_MCP_SETTINGS.rateLimitPerMin,
        DEFAULT_MCP_SETTINGS.writeRateLimitPer10Min,
      ])
    }
  })
})

describe("parseMcpSettings - Messenger inbox switch (11-meta-pages.md §13)", () => {
  it("off by default; on only for an explicit true (fail closed), snake_case and camelCase", () => {
    expect(parseMcpSettings(null).metaPageMessages).toBe(false)
    expect(parseMcpSettings({ meta_page_messages: true }).metaPageMessages).toBe(true)
    expect(parseMcpSettings({ metaPageMessages: true }).metaPageMessages).toBe(true)
    for (const garbage of ["true", 1, {}, [], null]) {
      expect(parseMcpSettings({ meta_page_messages: garbage }).metaPageMessages).toBe(false)
    }
  })
})
