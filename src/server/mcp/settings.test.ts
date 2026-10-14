// parseMcpSettings - Google Drive keys (15-google-drive-media.md §7.5): default ON, only an explicit false turns
// them off, so MCPs saved before the feature (no key in jsonb) get the owner's default without a data migration.
import { describe, expect, it } from "vitest"

import { effectiveMcpSettings, parseMcpSettings } from "./settings"
import { DEFAULT_MCP_SETTINGS } from "./types"

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
