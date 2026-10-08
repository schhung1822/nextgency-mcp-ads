import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import type { UpstreamEvent } from "../types"
import { __clearTokenCache } from "./auth"
import { CREATE_MAYBE_DONE_HINT, GoogleAdsClient, apiBase, field, numField } from "./client"
import { parseGoogleError, toProviderError } from "./errors"
import errors from "./__fixtures__/errors.json"
import { isSearch, mockFetch, oauthCredentials, saCredentials } from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GOOGLE_ADS_API_VERSION
})

const client = (creds = saCredentials(), extra: Partial<ConstructorParameters<typeof GoogleAdsClient>[0]> = {}) =>
  new GoogleAdsClient({ connectionId: `c-${Math.random()}`, credentials: creds, ...extra }, { retries: 2 })

describe("headers", () => {
  it("omits developer-token when empty and login-customer-id when not configured", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] } })
    await client(saCredentials({ developer_token: "  " })).search("1234567890", "SELECT customer.id FROM customer")
    const h = m.api()[0]!.headers
    expect(h).not.toHaveProperty("developer-token")
    expect(h).not.toHaveProperty("login-customer-id")
    expect(h.authorization).toMatch(/^Bearer ya29\.test-/)
  })

  it("never sends developer-token (sunset 2026-09-09, even when an old value is stored) and strips dashes from login-customer-id", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] } })
    await client(oauthCredentials({ developer_token: "DEVTOKEN", login_customer_id: "123-456-7890" })).search("987-654-3210", "SELECT customer.id FROM customer")
    const call = m.api()[0]!
    expect(call.headers).not.toHaveProperty("developer-token")
    expect(call.headers["login-customer-id"]).toBe("1234567890")
    expect(call.url).toBe(`${apiBase()}customers/9876543210/googleAds:search`)
  })

  it("uses the discovered login_customer_map when no explicit MCC is set", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] } })
    await client(saCredentials(), { connectionMeta: { login_customer_map: { "1234567890": "5555555555" } } }).search("1234567890", "SELECT customer.id FROM customer")
    expect(m.api()[0]!.headers["login-customer-id"]).toBe("5555555555")
  })

  it("uses GOOGLE_ADS_API_VERSION with v25 default and never sends pageSize", async () => {
    expect(apiBase()).toBe("https://googleads.googleapis.com/v25/")
    process.env.GOOGLE_ADS_API_VERSION = "v26"
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] } })
    await client().search("1234567890", "SELECT campaign.id FROM campaign", "tok")
    const call = m.api()[0]!
    expect(call.url).toContain("/v26/")
    expect(call.body).toEqual({ query: "SELECT campaign.id FROM campaign", pageToken: "tok" })
  })

  it("listAccessibleCustomers never sends login-customer-id", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith("customers:listAccessibleCustomers"), { body: { resourceNames: ["customers/1111111111", "customers/2222222222"] } })
    const ids = await client(saCredentials({ login_customer_id: "3333333333" })).listAccessibleCustomers()
    expect(ids).toEqual(["1111111111", "2222222222"])
    expect(m.api()[0]!.headers).not.toHaveProperty("login-customer-id")
  })

  it("reports the request-id response header", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] }, headers: { "request-id": "abc-123" } })
    const events: UpstreamEvent[] = []
    await client(saCredentials(), { onUpstream: (e) => events.push(e) }).search("1234567890", "SELECT customer.id FROM customer")
    expect(events.find((e) => e.url.includes("googleads"))?.requestId).toBe("abc-123")
  })
})

describe("error mapping (both shapes)", () => {
  const map = (body: unknown, status: number) => toProviderError(parseGoogleError(status, body, null))

  it("RESOURCE_EXHAUSTED → quota_exceeded, not retryable", () => {
    const e = map(errors.quotaExhausted, 429)
    expect(e.code).toBe("quota_exceeded")
    expect(e.retryable).toBe(false)
    expect(e.upstream?.code).toBe("quotaError.RESOURCE_EXHAUSTED")
    expect(e.upstream?.requestId).toBe("req-quota-day")
  })

  it("RESOURCE_TEMPORARILY_EXHAUSTED → rate_limited with retryDelay", () => {
    const e = map(errors.quotaTemporarilyExhausted, 429)
    expect(e.code).toBe("rate_limited")
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs).toBe(20)
  })

  it("USER_PERMISSION_DENIED hints login_customer_id", () => {
    const e = map(errors.userPermissionDenied, 403)
    expect(e.code).toBe("permission_denied")
    expect(e.hint).toContain("login_customer_id")
  })

  it("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION hints Explorer access", () => {
    const e = map(errors.projectNotApproved, 403)
    expect(e.code).toBe("permission_denied")
    expect(e.hint).toContain("Explorer")
  })

  it("google.rpc.ErrorInfo SERVICE_DISABLED → feature_not_enabled", () => {
    const e = map(errors.serviceDisabled, 403)
    expect(e.code).toBe("feature_not_enabled")
    expect(e.hint).toContain("Enable")
    expect(e.upstream?.code).toBe("SERVICE_DISABLED")
  })

  it("EU declaration required hints google_ads_declare_eu_political", () => {
    const e = map(errors.euDeclarationRequired, 400)
    expect(e.code).toBe("invalid_request")
    expect(e.hint).toContain("google_ads_declare_eu_political")
  })

  it("generic field errors include Google's detail and field path", () => {
    const e = map(errors.fieldRequired, 400)
    expect(e.code).toBe("invalid_request")
    expect(e.userMessageVi).toContain("fieldError.REQUIRED")
    expect(e.message).toContain("contains_eu_political_advertising")
  })

  it("CONCURRENT_MODIFICATION → conflict retryable", () => {
    const e = map(errors.concurrentModification, 409)
    expect(e.code).toBe("conflict")
    expect(e.retryable).toBe(true)
  })
})

describe("retries", () => {
  it("retries RESOURCE_TEMPORARILY_EXHAUSTED honoring retryDelay", async () => {
    const m = mockFetch()
    m.once(isSearch, { status: 429, body: errors.quotaTemporarilyExhausted })
    m.on(isSearch, { body: { results: [{ customer: { id: "1234567890" } }] } })
    const page = await client().search("1234567890", "SELECT customer.id FROM customer")
    expect(page.results).toHaveLength(1)
    expect(m.api()).toHaveLength(2)
  })

  it("does not retry daily quota exhaustion", async () => {
    const m = mockFetch()
    m.on(isSearch, { status: 429, body: errors.quotaExhausted })
    await expect(client().search("1234567890", "SELECT customer.id FROM customer")).rejects.toMatchObject({ code: "quota_exceeded" })
    expect(m.api()).toHaveLength(1)
  })

  it("refreshes the access token once on OAUTH_TOKEN_EXPIRED", async () => {
    const m = mockFetch()
    m.once(isSearch, { status: 401, body: errors.tokenExpired })
    m.on(isSearch, { body: { results: [] } })
    await client(oauthCredentials()).search("1234567890", "SELECT customer.id FROM customer")
    expect(m.tokenCalls()).toHaveLength(2)
    const [first, second] = m.api()
    expect(first!.headers.authorization).not.toBe(second!.headers.authorization)
  })

  it("gives up after one refresh when the token stays invalid", async () => {
    const m = mockFetch()
    m.on(isSearch, { status: 401, body: errors.tokenExpired })
    await expect(client(oauthCredentials()).search("1234567890", "SELECT customer.id FROM customer")).rejects.toBeInstanceOf(ProviderError)
    expect(m.api()).toHaveLength(2)
  })

  it("does not blindly retry a create on 503 (non-idempotent)", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith("googleAds:mutate"), { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "unavailable" } } })
    await expect(client().googleAdsMutate("1234567890", [{ campaignBudgetOperation: { create: {} } }])).rejects.toMatchObject({ code: "upstream_error" })
    expect(m.api()).toHaveLength(1)
  })

  it("5xx on a create → retryable=false + verify-before-retry hint (service mutate too)", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith(":mutate"), { status: 500, body: { error: { code: 500, status: "INTERNAL", message: "internal" } } })
    const e1 = await client().googleAdsMutate("1234567890", [{ campaignBudgetOperation: { create: {} } }]).catch((e) => e)
    expect(e1).toMatchObject({ retryable: false, hint: CREATE_MAYBE_DONE_HINT })
    const e2 = await client().mutate("1234567890", "adGroupAds", [{ create: {} }]).catch((e) => e)
    expect(e2).toMatchObject({ retryable: false, hint: CREATE_MAYBE_DONE_HINT })
    expect(m.api()).toHaveLength(2) // never retried
  })

  it("validateOnly creates are side-effect free → may be retried on 5xx", async () => {
    const m = mockFetch()
    m.once((c) => c.url.endsWith("googleAds:mutate"), { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "x" } } })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: { mutateOperationResponses: [] } })
    await client().googleAdsMutate("1234567890", [{ campaignBudgetOperation: { create: {} } }], { validateOnly: true })
    expect(m.api()).toHaveLength(2)
  })

  it("mutate()/googleAdsMutate() return the request-id header", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith("campaigns:mutate"), { body: { results: [{ resourceName: "customers/1234567890/campaigns/1" }] }, headers: { "request-id": "rid-1" } })
    m.on((c) => c.url.endsWith("googleAds:mutate"), { body: { mutateOperationResponses: [] }, headers: { "request-id": "rid-2" } })
    const r1 = await client().mutate("1234567890", "campaigns", [{ update: { resourceName: "customers/1234567890/campaigns/1", status: "PAUSED" }, updateMask: "status" }])
    expect(r1.requestId).toBe("rid-1")
    const r2 = await client().googleAdsMutate("1234567890", [{ campaignOperation: { update: {} } }], { idempotent: true })
    expect(r2.requestId).toBe("rid-2")
  })
})

describe("login-customer-id resolution", () => {
  it("does not force the explicit MCC on an account the map says is directly accessible", async () => {
    const m = mockFetch()
    m.on(isSearch, { body: { results: [] } })
    const c = client(saCredentials({ login_customer_id: "5555555555" }), {
      connectionMeta: { login_customer_map: { "1111111111": "5555555555", "2222222222": "2222222222" } },
    })
    await c.search("2222222222", "SELECT customer.id FROM customer")
    await c.search("1111111111", "SELECT customer.id FROM customer")
    await c.search("3333333333", "SELECT customer.id FROM customer") // unknown → explicit MCC
    expect(m.api().map((x) => x.headers["login-customer-id"])).toEqual(["2222222222", "5555555555", "5555555555"])
  })
})

describe("row helpers", () => {
  it("reads snake_case paths from camelCase JSON and defaults missing metrics", () => {
    const row = { campaignBudget: { amountMicros: "1500000" }, metrics: { clicks: "3" } }
    expect(field(row, "campaign_budget.amount_micros")).toBe("1500000")
    expect(numField(row, "metrics.clicks")).toBe(3)
    expect(numField(row, "metrics.impressions")).toBe(0)
    expect(numField(row, "metrics.impressions", null)).toBeNull()
  })
})
