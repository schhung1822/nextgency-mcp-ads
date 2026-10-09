// parseMcpSettings - Google Drive keys (15-google-drive-media.md §7.5): default ON, only an explicit false turns
// them off, so MCPs saved before the feature (no key in jsonb) get the owner's default without a data migration.
import { describe, expect, it } from "vitest"

import { parseMcpSettings } from "./settings"
import { DEFAULT_MCP_SETTINGS } from "./types"

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
