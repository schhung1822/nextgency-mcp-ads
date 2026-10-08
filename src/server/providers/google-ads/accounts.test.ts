import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBuckets } from "../rate-limit"
import { __clearTokenCache } from "./auth"
import { listAccounts, validateCredentials } from "./accounts"
import { isSearch, mockFetch, saCredentials, type RecordedCall } from "./__fixtures__/mock-fetch"

beforeEach(() => {
  __clearTokenCache()
  __resetBuckets()
})
afterEach(() => vi.unstubAllGlobals())

const cidOf = (c: RecordedCall) => /customers\/(\d+)\/googleAds/.exec(c.url)?.[1]
const q = (c: RecordedCall) => String((c.body as { query?: string }).query)

function mockHierarchy() {
  const m = mockFetch()
  m.on((c) => c.url.endsWith("customers:listAccessibleCustomers"), { body: { resourceNames: ["customers/1000000000"] } })
  m.on(
    (c) => isSearch(c) && q(c).includes("FROM customer LIMIT 1"),
    { body: { results: [{ customer: { id: "1000000000", descriptiveName: "MCC Noti", currencyCode: "VND", timeZone: "Asia/Ho_Chi_Minh", manager: true, status: "ENABLED" } }] } }
  )
  m.on(
    (c) => isSearch(c) && q(c).includes("FROM customer_client") && cidOf(c) === "1000000000",
    {
      body: {
        results: [
          { customerClient: { id: "1000000000", level: "0", manager: true, status: "ENABLED" } },
          { customerClient: { id: "2000000000", level: "1", descriptiveName: "Shop A", currencyCode: "VND", timeZone: "Asia/Ho_Chi_Minh", manager: false, status: "ENABLED" } },
          { customerClient: { id: "3000000000", level: "1", descriptiveName: "Sub MCC", currencyCode: "USD", timeZone: "America/New_York", manager: true, status: "ENABLED" } },
        ],
      },
    }
  )
  m.on(
    (c) => isSearch(c) && q(c).includes("FROM customer_client") && cidOf(c) === "3000000000",
    {
      body: {
        results: [
          { customerClient: { id: "3000000000", level: "0", manager: true } },
          { customerClient: { id: "4000000000", level: "1", descriptiveName: "Shop B", currencyCode: "USD", timeZone: "America/New_York", manager: false, status: "ENABLED", testAccount: true } },
        ],
      },
    }
  )
  return m
}

describe("listAccounts", () => {
  it("walks the MCC hierarchy with the root as login-customer-id and marks managers", async () => {
    const m = mockHierarchy()
    const accounts = await listAccounts({ credentials: saCredentials(), connectionId: "c" })
    expect(accounts.map((a) => [a.externalId, a.isManager, a.parentExternalId])).toEqual([
      ["1000000000", true, null],
      ["2000000000", false, "1000000000"],
      ["3000000000", true, "1000000000"],
      ["4000000000", false, "3000000000"],
    ])
    expect(accounts[1]).toMatchObject({ name: "Shop A", currency: "VND", timezone: "Asia/Ho_Chi_Minh", status: "active" })
    expect(accounts[3]!.extra).toMatchObject({ testAccount: true, loginCustomerId: "1000000000" })
    const searches = m.api().filter(isSearch)
    expect(searches.every((c) => c.headers["login-customer-id"] === "1000000000")).toBe(true)
    expect(searches.every((c) => q(c).includes("customer_client.status = 'ENABLED'") || q(c).includes("FROM customer LIMIT 1"))).toBe(true)
  })

  it("applies the customer_ids allow-list but keeps the root MCC", async () => {
    mockHierarchy()
    const accounts = await listAccounts({ credentials: saCredentials({ customer_ids: "400-000-0000" }), connectionId: "c" })
    expect(accounts.map((a) => a.externalId)).toEqual(["1000000000", "4000000000"])
  })
})

describe("validateCredentials", () => {
  it("mints a token, lists accessible customers and stores the login map", async () => {
    const m = mockHierarchy()
    const check = await validateCredentials({ credentials: saCredentials(), connectionId: "c" })
    expect(check.valid).toBe(true)
    expect(check.scopes).toEqual(["https://www.googleapis.com/auth/adwords"])
    expect(check.meta).toMatchObject({
      auth_type: "service_account",
      client_email: "ads-bot@demo-project.iam.gserviceaccount.com",
      accessible_customer_ids: ["1000000000"],
      login_customer_map: { "2000000000": "1000000000", "4000000000": "1000000000" },
    })
    expect(JSON.stringify(check.meta)).not.toContain("PRIVATE KEY")
    expect(m.tokenCalls()).toHaveLength(1)
  })

  it("warns when the service account was not added to any Google Ads account", async () => {
    const m = mockFetch()
    m.on((c) => c.url.endsWith("customers:listAccessibleCustomers"), { body: {} })
    const check = await validateCredentials({ credentials: saCredentials(), connectionId: "c" })
    expect(check.warnings.join(" ")).toContain("ads-bot@demo-project.iam.gserviceaccount.com")
  })
})
