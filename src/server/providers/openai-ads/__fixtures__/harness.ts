// Test harness (not a test file): MSW server + request recorder + context factory.
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, vi } from "vitest"
import { __resetBuckets } from "../../rate-limit"
import type { ProviderContext } from "../../types"
import { __setRetryDelayScale } from "../client"
import type { OpenAIAdsCredentials } from "../credentials"
import adAccount from "./ad_account.json"
import adGroup from "./ad_group.json"
import ad from "./ad.json"
import campaign from "./campaign.json"
import conversionsInsights from "./conversions_insights.json"
import insightsCampaignDaily from "./insights_campaign_daily.json"

export const BASE = "https://api.ads.openai.com/v1"
export const API_KEY = "sk-ads-test-0123456789abcdef"

export const fx = {
  adAccount,
  campaign,
  adGroup,
  ad,
  insightsCampaignDaily,
  conversionsInsights,
}

/** deep clone of a fixture with overrides */
export function clone<T>(v: T, over: Record<string, unknown> = {}): T {
  return { ...(JSON.parse(JSON.stringify(v)) as T), ...over }
}

export function list<T>(data: T[], hasMore = false) {
  const ids = data.map((d) => (d as { id?: string }).id ?? null)
  return { object: "list", data, first_id: ids[0] ?? null, last_id: ids[ids.length - 1] ?? null, has_more: hasMore }
}

export interface Call {
  method: string
  url: URL
  path: string
  headers: Headers
  body: unknown
}

export const calls: Call[] = []
export const server = setupServer()

type Responder = (call: Call, n: number) => Response | Promise<Response>

/** Register a handler that records each call. `n` = 1-based call count for this route. */
export function route(method: "get" | "post", path: string, responder: Responder | object) {
  let n = 0
  server.use(
    http[method](`${BASE}${path}`, async ({ request }) => {
      n++
      const text = await request.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      const url = new URL(request.url)
      const call: Call = { method: request.method, url, path: url.pathname.replace(/^\/v1/, ""), headers: request.headers, body }
      calls.push(call)
      return typeof responder === "function" ? (responder as Responder)(call, n) : HttpResponse.json(responder)
    })
  )
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return HttpResponse.json(body as Record<string, unknown>, { status, headers: { "x-request-id": "req_test_1", ...headers } })
}

export function apiError(status: number, message: string, code: string | null = null, type = "invalid_request_error") {
  return json({ error: { message, type, param: null, code } }, status)
}

export function writes(): Call[] {
  return calls.filter((c) => c.method !== "GET")
}

export function makeCtx(over: Partial<ProviderContext<OpenAIAdsCredentials>> = {}): ProviderContext<OpenAIAdsCredentials> {
  return {
    connectionId: "conn_1",
    credentials: { apiKey: API_KEY },
    connectionMeta: {},
    account: { id: "acc-uuid", externalId: "adacct_123", name: "Acme Ads", currency: "USD", timezone: "America/New_York" },
    ...over,
  }
}

/** Call once at the top of each test file. Freezes Date at 2026-10-02T12:00:00Z (timers stay real). */
export function setupHarness() {
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" })
    __setRetryDelayScale(0)
  })
  afterEach(() => {
    server.resetHandlers()
    calls.length = 0
    __resetBuckets()
    vi.useRealTimers()
    delete process.env.OPENAI_ADS_INSIGHTS_FIELD_STYLE
  })
  afterAll(() => {
    server.close()
    __setRetryDelayScale(1)
  })
}

export function freezeDate(iso = "2026-10-02T12:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(iso))
}
