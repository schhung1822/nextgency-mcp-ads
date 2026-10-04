import { describe, expect, it } from "vitest"

import { compactExtra } from "../../../providers/meta/report"
import { pickExtra } from "./get-report"

describe("platform-specific report metrics", () => {
  const raw = {
    account_id: "1001",
    campaign_id: "9",
    spend: "120000",
    impressions: "5000",
    objective: "OUTCOME_SALES",
    quality_ranking: "ABOVE_AVERAGE",
    actions: [
      { action_type: "add_to_cart", value: "12" },
      { action_type: "landing_page_view", value: "340" },
    ],
    action_values: [{ action_type: "add_to_cart", value: "2400000" }],
    video_p75_watched_actions: [{ action_type: "video_view", value: "88" }],
  }

  it("compactExtra drops ids / basic fields and turns action lists into maps", () => {
    expect(compactExtra(raw)).toEqual({
      objective: "OUTCOME_SALES",
      quality_ranking: "ABOVE_AVERAGE",
      actions: { add_to_cart: 12, landing_page_view: 340 },
      action_values: { add_to_cart: 2400000 },
      video_p75_watched_actions: { video_view: 88 },
    })
  })

  it("pickExtra returns exactly the requested metrics (bare action type, dotted path, top-level, unknown → null)", () => {
    const extra = compactExtra(raw)
    expect(
      pickExtra(extra, [
        "add_to_cart",
        "actions.landing_page_view",
        "quality_ranking",
        "initiate_checkout",
      ])
    ).toEqual({
      "actions.add_to_cart": 12,
      "action_values.add_to_cart": 2400000,
      "actions.landing_page_view": 340,
      quality_ranking: "ABOVE_AVERAGE",
      initiate_checkout: null,
    })
  })
})
