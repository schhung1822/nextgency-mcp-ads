import { describe, expect, it } from "vitest"

import {
  buildCpaRule,
  buildSchedulePrompt,
  buildSkillMd,
  buildSkillPrompt,
  DEFAULT_CPA_RULE,
  normalizeCurrency,
  SKILL_NAME,
  skillDescription,
} from "./automation-prompt"

describe("automation prompt builder", () => {
  it("report mode never asks the AI to write", () => {
    const rule = buildCpaRule(DEFAULT_CPA_RULE)
    expect(rule).toContain('preset = "today"')
    expect(rule).toContain("min_spend: 100000")
    expect(rule).toContain("cpa > 200000")
    expect(rule).not.toContain("ads_set_status với")
    expect(rule).toContain("Không gọi ads_set_status")
  })

  it("pause mode pauses only, caps the batch and stops on confirmation", () => {
    const rule = buildCpaRule({
      ...DEFAULT_CPA_RULE,
      mode: "pause",
      maxPerRun: 999,
      window: "last_7d",
    })
    expect(rule).toContain('status = "paused"')
    expect(rule).toContain("Tắt tối đa 50 quảng cáo")
    expect(rule).toContain("không gửi confirm_token")
    expect(rule).toContain('preset = "last_7d"')
    expect(rule).toContain("Tuyệt đối không bật")
  })

  it("writes amounts as plain digits and a valid currency", () => {
    const rule = buildCpaRule({
      ...DEFAULT_CPA_RULE,
      cpaMax: 12.5,
      minSpend: -3,
      currency: " usd ",
    })
    expect(rule).toContain("cpa > 12.5")
    expect(rule).toContain("min_spend: 0")
    expect(rule).toContain("currency = USD")
    expect(normalizeCurrency("đồng")).toBe("VND")
  })

  it("wraps the rule as a prompt, a skill and a skill call", () => {
    expect(buildSchedulePrompt(DEFAULT_CPA_RULE)).toContain(
      buildCpaRule(DEFAULT_CPA_RULE)
    )
    const md = buildSkillMd(DEFAULT_CPA_RULE)
    expect(md.startsWith(`---\nname: ${SKILL_NAME}\ndescription: `)).toBe(true)
    expect(md).toContain(buildCpaRule(DEFAULT_CPA_RULE))
    expect(buildSkillPrompt(DEFAULT_CPA_RULE)).toContain(SKILL_NAME)
  })

  it("keeps the skill frontmatter inside Claude's limits", () => {
    expect(SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/)
    for (const mode of ["report", "pause"] as const) {
      expect(skillDescription(mode).length).toBeLessThanOrEqual(200)
      expect(
        buildSkillMd({ ...DEFAULT_CPA_RULE, mode, cpaMax: 123456789 })
      ).toContain(`description: ${skillDescription(mode)}\n`)
    }
  })
})
