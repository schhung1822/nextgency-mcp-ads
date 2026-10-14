// The real adapters' extensions must be registrable as MCP tools (names, inputs, JSON Schema).
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { googleAdsProvider } from "../../providers/google-ads"
import { metaProvider } from "../../providers/meta"
import { openaiAdsProvider } from "../../providers/openai-ads"
import { registerProvider } from "../../providers/registry"
import { tiktokProvider } from "../../providers/tiktok"
import type { AdsProvider } from "../../providers/types"
import { MONEY_KEY } from "../guardrails"
import { buildMcpServer } from "../handler"
import { COMMON_TOOL_PERMISSIONS } from "../registry"
import type { RequestState } from "../request-state"
import { extensionProblem } from "../tools/extensions"
import { DEFAULT_MCP_SETTINGS, PERMISSIONS, type McpGrant } from "../types"

const providers = [metaProvider, tiktokProvider, googleAdsProvider, openaiAdsProvider] as unknown as AdsProvider[]

describe("real adapter extensions", () => {
  it("have valid, unique tool names and z.object inputs", () => {
    const taken = new Set(Object.keys(COMMON_TOOL_PERMISSIONS))
    for (const p of providers) {
      for (const ext of p.extensions) {
        expect(extensionProblem(p.platform, ext, taken), `${p.platform}:${ext.name}`).toBeNull()
        expect(ext.description.startsWith("Dùng khi"), ext.name).toBe(true)
        taken.add(ext.name)
      }
    }
  })

  it("every write extension whose input carries money declares moneyOf (H1: caps cannot be bypassed)", () => {
    const names = (schema: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(schema)) for (const s of schema) names(s, out)
      else if (schema && typeof schema === "object") {
        const o = schema as Record<string, unknown>
        if (o.properties && typeof o.properties === "object") for (const k of Object.keys(o.properties)) out.add(k)
        for (const v of Object.values(o)) names(v, out)
      }
      return out
    }
    const withMoney: string[] = []
    for (const p of providers) {
      for (const ext of p.extensions) {
        if (!ext.write) continue
        const props = [...names(z.toJSONSchema(ext.input as z.ZodType, { unrepresentable: "any", io: "input" }))]
        // device_price_ranges = targeting by phone price, not spend
        const money = props.filter((k) => MONEY_KEY.test(k) && k !== "device_price_ranges")
        if (money.length) {
          withMoney.push(ext.name)
          expect(typeof ext.moneyOf, `${ext.name} has money fields ${money.join(",")} but no moneyOf`).toBe("function")
        }
      }
    }
    expect(withMoney).toEqual(
      expect.arrayContaining([
        "meta_create_campaign",
        "meta_create_adset",
        "tiktok_create_campaign",
        "tiktok_create_adgroup",
        "google_ads_create_search_campaign",
        "google_ads_add_keywords",
        "openai_ads_create_campaign",
        "openai_ads_create_ad_group",
        "openai_ads_update_ad_group",
      ])
    )
  })

  it("moneyOf reports major-unit amounts with flights", () => {
    const find = (name: string) => providers.flatMap((p) => p.extensions).find((e) => e.name === name)!
    const meta = find("meta_create_adset")
    expect(
      meta.moneyOf!(
        meta.input.parse({
          campaign_id: "123",
          name: "A",
          optimization_goal: "LINK_CLICKS",
          budget: { type: "lifetime", amount: 3_000_000 },
          bid_strategy: "COST_CAP",
          bid_amount: 20_000,
          end_time: "2026-10-12T00:00:00+07:00",
          targeting: { countries: ["VN"] },
        })
      )
    ).toEqual([
      { kind: "lifetime_budget", amount: 3_000_000, field: "budget.amount", startTime: null, endTime: "2026-10-12T00:00:00+07:00" },
      { kind: "bid", amount: 20_000, field: "bid_amount" },
    ])
    const oa = find("openai_ads_update_ad_group")
    expect(oa.moneyOf!({ ad_group_id: "x", bidding: { max_bid: 0.5, audience_bid_multipliers: [{ custom_audience_id: "a", multiplier: 3 }] } })).toEqual([
      { kind: "bid", amount: 1.5, field: "bidding.max_bid × audience_bid_multipliers" },
    ])
    const tt = find("tiktok_create_adgroup")
    const items = tt.moneyOf!({ budget_type: "daily", budget: 100, bid_amount: 2, advanced: { deep_cpa_bid: 9, budget_mode: "X" } })
    expect(items.map((i) => [i.kind, i.field, i.amount])).toEqual([
      ["daily_budget", "budget", 100],
      ["bid", "bid_amount", 2],
      ["bid", "advanced.deep_cpa_bid", 9],
    ])
  })

  it("google_ads_add_youtube_video: create permission, write, no money", () => {
    const ext = googleAdsProvider.extensions.find((e) => e.name === "google_ads_add_youtube_video")
    expect(ext, "google_ads_add_youtube_video").toBeDefined()
    expect(ext!.permission).toBe("create")
    expect(ext!.write).toBe(true)
    expect(ext!.moneyOf).toBeUndefined()
    const shape = (ext!.input as z.ZodObject).shape as Record<string, unknown>
    expect(Object.keys(shape).sort()).toEqual(["name", "video"])
  })

  it("register on a full grant and produce JSON Schemas", () => {
    for (const p of providers) registerProvider(p)
    const grant: McpGrant = {
      mcpId: "m",
      mcpName: "m",
      ownerId: "u",
      ownerEmail: "u@example.test",
      ownerRole: "admin",
      // opt-in tools (TikTok GMV Max writes) are listed only with their MCP setting on
      settings: { ...DEFAULT_MCP_SETTINGS, tiktokGmvMaxWrite: true },
      permissions: { meta: [...PERMISSIONS], tiktok: [...PERMISSIONS], google_ads: [...PERMISSIONS], openai_ads: [...PERMISSIONS] },
      accounts: [],
      pages: [],
      notificationChannels: [],
      driveSources: [],
      drivePublicAvailable: false,
      apifyTokens: [],
    }
    const req: RequestState = {
      startedAt: Date.now(),
      httpMethod: "POST",
      ip: null,
      userAgent: null,
      protocolVersionHeader: null,
      messages: [],
      loggedCallIds: new Set(),
      requestBytes: 0,
    }
    const server = buildMcpServer({ token: "m", clientId: "m", scopes: [], extra: { grant, req } })
    const names = [...Object.keys(COMMON_TOOL_PERMISSIONS), ...providers.flatMap((p) => p.extensions.map((e) => e.name))]
    for (const name of names) {
      const schema = server.toolInputSchemaJson(name)
      expect(schema, name).toBeDefined()
      expect(schema!.type, name).toBe("object")
      expect(Object.keys((schema!.properties as object) ?? {}), name).toContain(name.startsWith("ads_list_accounts") ? "platform" : name.startsWith("ads_get_report") ? "level" : name === "ads_get_media_upload" ? "upload_id" : "account_id")
    }
    expect(names.length).toBeLessThanOrEqual(45)
    // default settings: the GMV Max write tools are not listed at all
    const off = buildMcpServer({ token: "m", clientId: "m", scopes: [], extra: { grant: { ...grant, settings: DEFAULT_MCP_SETTINGS }, req } })
    for (const name of ["tiktok_gmv_max_update", "tiktok_gmv_max_creatives", "tiktok_gmv_max_create"]) {
      expect(off.toolInputSchemaJson(name), name).toBeUndefined()
    }
    expect(off.toolInputSchemaJson("tiktok_gmv_max_products")).toBeDefined()
  })
})
