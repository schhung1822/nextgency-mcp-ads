import { describe, expect, it, vi } from "vitest"

import type { AdObjectSummary, AdsProvider, ListQuery, ProviderContext } from "../providers/types"
import { campaignBudgetFlight, campaignFlightOrDeny, CHILD_MAX_PAGES, CHILD_PAGE_SIZE, isConfiguredOn, listChildAdGroups } from "./budget-flight"
import { McpToolError } from "./errors"

const ctx = {} as ProviderContext

function kid(id: string, configured: "ACTIVE" | "PAUSED" | "ARCHIVED", endTime: string | null, startTime: string | null = null): AdObjectSummary {
  return {
    id,
    level: "ad_group",
    name: id,
    status: configured === "ACTIVE" ? "active" : configured === "PAUSED" ? "paused" : "archived",
    statusRaw: configured === "ACTIVE" ? "CAMPAIGN_PAUSED" : configured,
    parentId: "c1",
    campaignId: "c1",
    startTime,
    endTime,
    extra: { configuredStatus: configured },
  }
}

function provider(platform: "meta" | "openai_ads", kids: AdObjectSummary[], pageSize = CHILD_PAGE_SIZE, endless = false) {
  const listObjects = vi.fn(async (_ctx: ProviderContext, q: ListQuery) => {
    const offset = q.cursor ? Number(q.cursor) : 0
    const items = kids.filter((k) => k.parentId === q.parentId).slice(offset, offset + Math.min(q.limit, pageSize))
    const next = endless || offset + items.length < kids.length ? String(offset + items.length) : null
    return { items, nextCursor: next, warnings: [] }
  })
  return { p: { platform, listObjects } as unknown as AdsProvider, listObjects }
}

const campaign = (o: { startTime?: string | null; endTime?: string | null } = {}) => ({ id: "c1", name: "C1", startTime: o.startTime ?? null, endTime: o.endTime ?? null })

describe("campaign lifetime budget flight", () => {
  it("uses the latest end of the ad sets that are configured on (campaign paused: effective status does not matter)", async () => {
    const { p } = provider("meta", [kid("a", "ACTIVE", "2026-10-12T00:00:00Z"), kid("b", "ACTIVE", "2026-10-15T00:00:00Z"), kid("c", "PAUSED", "2026-10-30T00:00:00Z")])
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: campaign() })).toEqual({ startTime: null, endTime: "2026-10-15T00:00:00.000Z" })
  })

  it("caps the end with the campaign stop_time and the start with the campaign start", async () => {
    const { p } = provider("meta", [kid("a", "ACTIVE", "2026-10-20T00:00:00Z", "2026-10-01T00:00:00Z")])
    expect(
      await campaignBudgetFlight({ provider: p, ctx, campaign: campaign({ startTime: "2026-10-05T00:00:00Z", endTime: "2026-10-10T00:00:00Z" }) })
    ).toEqual({ startTime: "2026-10-05T00:00:00.000Z", endTime: "2026-10-10T00:00:00.000Z" })
  })

  it("an ad set without end runs until the campaign stop_time; without stop_time the flight is unknown", async () => {
    const kids = [kid("a", "ACTIVE", null)]
    expect(await campaignBudgetFlight({ provider: provider("meta", kids).p, ctx, campaign: campaign({ endTime: "2026-10-09T00:00:00Z" }) })).toEqual({
      startTime: null,
      endTime: "2026-10-09T00:00:00.000Z",
    })
    expect(await campaignBudgetFlight({ provider: provider("meta", kids).p, ctx, campaign: campaign() })).toBe("unknown")
  })

  it("honours the ad sets being activated and a pending schedule override", async () => {
    const kids = [kid("a", "ACTIVE", "2026-10-12T00:00:00Z"), kid("c", "PAUSED", "2026-10-30T00:00:00Z")]
    const { p } = provider("meta", kids)
    expect((await campaignBudgetFlight({ provider: p, ctx, campaign: campaign(), activating: ["c"] })) as { endTime: string }).toMatchObject({
      endTime: "2026-10-30T00:00:00.000Z",
    })
    // ad set a pulled in to 10-08 (shorter flight → lower lifetime limit)
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: campaign(), override: { adGroupId: "a", endTime: "2026-10-08T00:00:00Z" } })).toMatchObject({
      endTime: "2026-10-08T00:00:00.000Z",
    })
    // removing the end of a delivering ad set → unknown
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: campaign(), override: { adGroupId: "a", endTime: null } })).toBe("unknown")
  })

  it("nothing configured on → every ad set counts; archived ad sets never count; no ad set → campaign dates", async () => {
    const paused = [kid("a", "PAUSED", "2026-10-12T00:00:00Z"), kid("b", "PAUSED", "2026-10-14T00:00:00Z"), kid("z", "ARCHIVED", "2027-01-01T00:00:00Z")]
    expect(await campaignBudgetFlight({ provider: provider("meta", paused).p, ctx, campaign: campaign() })).toMatchObject({ endTime: "2026-10-14T00:00:00.000Z" })
    const base = campaign({ startTime: "2026-10-01T00:00:00Z" })
    expect(await campaignBudgetFlight({ provider: provider("meta", []).p, ctx, campaign: base })).toEqual({ startTime: "2026-10-01T00:00:00Z", endTime: null })
  })

  it("more than 3 pages of ad sets → unknown (cannot verify), and the denial explains what to do", async () => {
    const { p, listObjects } = provider("meta", [kid("a", "ACTIVE", "2026-10-12T00:00:00Z")], CHILD_PAGE_SIZE, true)
    expect(await listChildAdGroups(p, ctx, "c1")).toBeNull()
    expect(listObjects).toHaveBeenCalledTimes(CHILD_MAX_PAGES)
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: campaign() })).toBe("unknown")
    const err = await campaignFlightOrDeny(p, ctx, campaign()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpToolError)
    expect(err).toMatchObject({ code: "budget_flight_unknown", logStatus: "denied" })
    expect((err as McpToolError).hint).toMatch(/end_time/)
  })

  it("pages through up to 600 ad sets", async () => {
    const many = Array.from({ length: 450 }, (_, i) => kid(`k${i}`, i === 449 ? "ACTIVE" : "PAUSED", `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`))
    const { p, listObjects } = provider("meta", many)
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: campaign() })).toMatchObject({ endTime: "2026-11-02T00:00:00.000Z" })
    expect(listObjects).toHaveBeenCalledTimes(3)
  })

  it("other platforms keep the campaign dates and never list ad groups", async () => {
    const { p, listObjects } = provider("openai_ads", [kid("a", "ACTIVE", "2026-10-12T00:00:00Z")])
    const c = campaign({ startTime: "2026-10-01T00:00:00Z", endTime: "2026-12-01T00:00:00Z" })
    expect(await campaignBudgetFlight({ provider: p, ctx, campaign: c })).toEqual({ startTime: "2026-10-01T00:00:00Z", endTime: "2026-12-01T00:00:00Z" })
    expect(await campaignFlightOrDeny(p, ctx, campaign())).toEqual({ startTime: null, endTime: null })
    expect(listObjects).not.toHaveBeenCalled()
  })

  it("isConfiguredOn reads the configured status, falling back to the raw status", () => {
    expect(isConfiguredOn(kid("a", "ACTIVE", null))).toBe(true)
    expect(isConfiguredOn(kid("a", "PAUSED", null))).toBe(false)
    expect(isConfiguredOn({ ...kid("a", "ACTIVE", null), extra: {}, statusRaw: "PAUSED" })).toBe(false)
    expect(isConfiguredOn({ ...kid("a", "ACTIVE", null), extra: {}, statusRaw: "CAMPAIGN_PAUSED" })).toBe(true)
  })
})
