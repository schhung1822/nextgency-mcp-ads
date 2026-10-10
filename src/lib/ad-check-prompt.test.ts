import { describe, expect, it } from "vitest"

import {
  AD_CHECK_SKILL_DESCRIPTION,
  AD_CHECK_SKILL_NAME,
  buildAdCheckPrompt,
  buildAdCheckRule,
  buildAdCheckSkillMd,
  buildAdCheckSkillPrompt,
  buildScheduleRequest,
  DEFAULT_AD_CHECK,
  normalizeTime,
  parseAccounts,
  scheduleLabel,
} from "./ad-check-prompt"

describe("ad check prompt builder", () => {
  it("default: yesterday, ROAS target, utm id match, Telegram delivery, read-only", () => {
    const rule = buildAdCheckRule(DEFAULT_AD_CHECK)
    expect(rule).toContain('preset = "yesterday"')
    expect(rule).toContain('level = "campaign"')
    expect(rule).toContain("ROAS thật ≥ 3")
    expect(rule).toContain("utm_campaign của đơn = mã (ID) chiến dịch")
    expect(rule).toContain("telegram_list_channels")
    expect(rule).toContain("telegram_send_message")
    expect(rule).toContain("đã chi từ 200000 VND")
    expect(rule).toContain("Không lấy tên, số điện thoại")
    expect(rule).toContain("không gọi bất kỳ tool nào thay đổi quảng cáo")
    expect(rule).toContain("Xét mọi tài khoản")
    // never asks for a write tool
    expect(rule).not.toMatch(/ads_set_status|ads_update_budget|_create_/)
    expect(buildAdCheckPrompt(DEFAULT_AD_CHECK)).toContain(
      "MCP bán hàng (Pancake POS)"
    )
  })

  it("CPA target, product match, named accounts and channel", () => {
    const rule = buildAdCheckRule({
      ...DEFAULT_AD_CHECK,
      period: "last_7d",
      target: "cpa",
      targetValue: 85000,
      currency: "usd",
      match: "product",
      pos: "other",
      accounts: 'Shop A, act_123 ; "B"\n',
      telegramChannel: "Nhóm báo cáo",
    })
    expect(rule).toContain('preset = "last_7d"')
    expect(rule).toContain("chi phí mỗi đơn thật ≤ 85000 USD")
    expect(rule).toContain("danh sách sản phẩm")
    expect(rule).toContain("số ước lượng")
    expect(rule).toContain('"Shop A", "act_123", "B"')
    expect(rule).toContain('kết nối Telegram "Nhóm báo cáo"')
    expect(rule).toContain("Dùng MCP bán hàng lấy")
  })

  it("normalises times, accounts and the schedule", () => {
    expect(normalizeTime("8:5")).toBe("08:05")
    expect(normalizeTime("7h30")).toBe("07:30")
    expect(normalizeTime("25:00")).toBe("08:00")
    expect(normalizeTime("abc")).toBe("08:00")
    expect(parseAccounts(" , ;")).toEqual([])
    expect(scheduleLabel(DEFAULT_AD_CHECK)).toBe(
      "mỗi ngày lúc 08:00 (giờ Việt Nam)"
    )
    expect(scheduleLabel({ ...DEFAULT_AD_CHECK, frequency: "hourly" })).toBe(
      "mỗi giờ"
    )
    expect(buildScheduleRequest(DEFAULT_AD_CHECK)).toContain(
      "mỗi ngày lúc 08:00"
    )
    // the schedule sentence is never part of the task itself (the run would schedule itself again)
    expect(buildAdCheckPrompt(DEFAULT_AD_CHECK)).not.toContain("đặt lịch")
  })

  it("names the connector the user chose (default Ads MCP)", () => {
    expect(buildAdCheckPrompt(DEFAULT_AD_CHECK)).toMatch(
      /^Dùng connector "Ads MCP" \(Ads MCP - số liệu quảng cáo\)/
    )
    const custom = { ...DEFAULT_AD_CHECK, connectorName: "Báo cáo đơn" }
    expect(buildAdCheckPrompt(custom)).toContain('connector "Báo cáo đơn"')
    expect(buildAdCheckSkillMd(custom)).toContain('connector "Báo cáo đơn"')
    expect(AD_CHECK_SKILL_DESCRIPTION).not.toContain("noti.vn")
  })

  it("wraps the steps as a prompt, a skill and a skill call", () => {
    const md = buildAdCheckSkillMd(DEFAULT_AD_CHECK)
    expect(
      md.startsWith(`---\nname: ${AD_CHECK_SKILL_NAME}\ndescription: `)
    ).toBe(true)
    expect(md).toContain(buildAdCheckRule(DEFAULT_AD_CHECK))
    expect(buildAdCheckSkillPrompt(DEFAULT_AD_CHECK)).toContain(
      AD_CHECK_SKILL_NAME
    )
    expect(AD_CHECK_SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(AD_CHECK_SKILL_DESCRIPTION.length).toBeLessThanOrEqual(200)
  })
})
