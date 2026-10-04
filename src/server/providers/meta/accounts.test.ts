import { beforeEach, describe, expect, it } from "vitest"

import { isProviderError } from "../errors"
import { __resetBuckets } from "../rate-limit"
import type { UpstreamEvent } from "../types"
import adaccounts from "./__fixtures__/adaccounts.json"
import { listMetaAccounts, prepareMetaCredentials, validateMetaCredentials } from "./accounts"
import { metaCredentialHint, parseMetaCredentials } from "./credentials"
import { TEST_TOKEN, graphError, json, mockGraph } from "./test-utils"

beforeEach(() => __resetBuckets())

const SECRET = "0123456789abcdef0123456789abcdef"
const ALL_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
]

describe("parseMetaCredentials", () => {
  it("accepts form (snake_case) keys, trims and drops empty optionals", () => {
    const c = parseMetaCredentials({
      access_token: `  ${TEST_TOKEN} `,
      app_id: "",
      app_secret: " ",
      business_id: "555000111",
    })
    expect(c).toEqual({ accessToken: TEST_TOKEN, businessId: "555000111" })
  })
  it("accepts camelCase keys", () => {
    expect(
      parseMetaCredentials({
        accessToken: TEST_TOKEN,
        appId: "12345",
        appSecret: SECRET,
      })
    ).toEqual({
      accessToken: TEST_TOKEN,
      appId: "12345",
      appSecret: SECRET,
    })
  })
  it("rejects missing token / bad secret with invalid_credentials_input", () => {
    for (const raw of [
      {},
      { access_token: "short" },
      { access_token: TEST_TOKEN, app_id: "1234567", app_secret: "nothex" },
    ]) {
      try {
        parseMetaCredentials(raw)
        throw new Error("should throw")
      } catch (e) {
        expect(isProviderError(e) && e.code).toBe("invalid_credentials_input")
      }
    }
  })
  it("requires app id with app secret", () => {
    expect(() =>
      parseMetaCredentials({ access_token: TEST_TOKEN, app_secret: SECRET })
    ).toThrow()
  })
  it("hint shows only the last 4 characters", () => {
    expect(metaCredentialHint({ accessToken: TEST_TOKEN })).toBe(
      `…${TEST_TOKEN.slice(-4)}`
    )
  })
})

describe("validateMetaCredentials", () => {
  it("uses debug_token with the app token, redacts input_token, warns when expiring in < 7 days", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3 * 86_400
    const m = mockGraph([
      [
        "GET",
        "debug_token",
        () =>
          json({
            data: {
              app_id: "12345",
              type: "USER",
              is_valid: true,
              expires_at: expiresAt,
              data_access_expires_at: 0,
              scopes: ALL_SCOPES,
              user_id: "99",
            },
          }),
      ],
      ["GET", "me", () => json({ id: "99", name: "Ads Bot" })],
    ])
    const events: UpstreamEvent[] = []
    const res = await validateMetaCredentials({
      credentials: {
        accessToken: TEST_TOKEN,
        appId: "12345",
        appSecret: SECRET,
      },
      onUpstream: (e) => events.push(e),
    })
    expect(res.valid).toBe(true)
    expect(res.tokenExpiresAt?.getTime()).toBe(expiresAt * 1000)
    expect(res.warnings.join(" ")).toMatch(/hết hạn sau 3 ngày/)
    expect(res.scopes).toEqual(ALL_SCOPES)
    const dbg = m.calls.find((c) => c.path === "debug_token")!
    expect(dbg.params.access_token).toBe(`12345|${SECRET}`)
    expect(dbg.params.input_token).toBe(TEST_TOKEN)
    expect(dbg.params.appsecret_proof).toBeUndefined()
    for (const e of events) expect(e.url).not.toContain(TEST_TOKEN)
  })

  it("never-expiring system user token → tokenExpiresAt null, no expiry warning", async () => {
    mockGraph([
      [
        "GET",
        "debug_token",
        () =>
          json({
            data: {
              app_id: "12345",
              type: "SYSTEM_USER",
              is_valid: true,
              expires_at: 0,
              scopes: ALL_SCOPES,
            },
          }),
      ],
      ["GET", "me", () => json({ id: "99", name: "Ads Bot" })],
    ])
    const res = await validateMetaCredentials({
      credentials: {
        accessToken: TEST_TOKEN,
        appId: "12345",
        appSecret: SECRET,
      },
    })
    expect(res.tokenExpiresAt).toBeNull()
    expect(res.warnings).toEqual([])
    expect(res.meta.tokenType).toBe("SYSTEM_USER")
  })

  it("without app secret falls back to /me + /me/permissions and warns about missing scopes", async () => {
    mockGraph([
      ["GET", "debug_token", () => graphError(100, undefined, {}, 400)],
      ["GET", "me", () => json({ id: "99", name: "Ads Bot" })],
      [
        "GET",
        "me/permissions",
        () =>
          json({
            data: [
              { permission: "ads_read", status: "granted" },
              { permission: "ads_management", status: "declined" },
            ],
          }),
      ],
    ])
    const res = await validateMetaCredentials({
      credentials: { accessToken: TEST_TOKEN },
    })
    expect(res.valid).toBe(true)
    expect(res.scopes).toEqual(["ads_read"])
    expect(res.warnings.join(" ")).toMatch(/ads_management/)
  })

  it("returns valid=false on error 190", async () => {
    mockGraph([
      ["GET", "debug_token", () => graphError(100)],
      ["GET", "me", () => graphError(190, 467)],
    ])
    const res = await validateMetaCredentials({
      credentials: { accessToken: TEST_TOKEN },
    })
    expect(res.valid).toBe(false)
  })
})

describe("listMetaAccounts", () => {
  it("maps status, currency offsets (VND=1, USD=100) and de-duplicates business accounts", async () => {
    const m = mockGraph([
      ["GET", "me/adaccounts", () => json(adaccounts)],
      [
        "GET",
        "555000111/owned_ad_accounts",
        () => json({ data: [adaccounts.data[0]] }),
      ],
      ["GET", "555000111/client_ad_accounts", () => graphError(200)],
    ])
    const list = await listMetaAccounts({
      credentials: { accessToken: TEST_TOKEN, businessId: "555000111" },
    })
    expect(list.map((a) => a.externalId)).toEqual(["act_2002", "act_1001"])
    const vn = list.find((a) => a.externalId === "act_1001")!
    expect(vn).toMatchObject({
      currency: "VND",
      timezone: "Asia/Ho_Chi_Minh",
      status: "active",
      statusRaw: "ACTIVE",
    })
    expect(vn.extra?.minDailyBudget).toBe(26484)
    expect(vn.extra?.balance).toBe(350000)
    const us = list.find((a) => a.externalId === "act_2002")!
    expect(us).toMatchObject({ status: "disabled", statusRaw: "UNSETTLED" })
    expect(us.extra?.amountSpent).toBe(12345.67)
    expect(us.extra?.minDailyBudget).toBe(1)
    expect(m.calls[0].params.limit).toBe("200")
  })

  it("works without business_management: retries without the business field after #100", async () => {
    const m = mockGraph([
      [
        "GET",
        "me/adaccounts",
        (c) =>
          c.params.fields.includes("business{")
            ? graphError(100, undefined, {
                message:
                  "(#100) Requires business_management permission to access the field.",
              })
            : json(adaccounts),
      ],
    ])
    const list = await listMetaAccounts({
      credentials: { accessToken: TEST_TOKEN },
    })
    expect(list.map((a) => a.externalId)).toEqual(["act_2002", "act_1001"])
    expect(m.calls).toHaveLength(2)
    expect(m.calls[1].params.fields).not.toContain("business")
  })

  it("falls back to the core field set when user_tasks also needs business_management", async () => {
    const m = mockGraph([
      [
        "GET",
        "me/adaccounts",
        (c) =>
          c.params.fields.includes("user_tasks") || c.params.fields.includes("min_daily_budget")
            ? graphError(100, undefined, { message: "(#100) Requires business_management permission to access the field." })
            : json(adaccounts),
      ],
    ])
    const list = await listMetaAccounts({ credentials: { accessToken: TEST_TOKEN } })
    expect(list).toHaveLength(2)
    expect(m.calls).toHaveLength(3)
    expect(m.calls[2].params.fields).toBe("id,account_id,name,account_status,currency,timezone_name")
  })

  it("never defaults a missing currency to USD: the account is skipped (all skipped → error)", async () => {
    const noCurrency = {
      ...adaccounts.data[0],
      id: "act_3003",
      account_id: "3003",
      currency: undefined,
    }
    mockGraph([
      [
        "GET",
        "me/adaccounts",
        () => json({ data: [adaccounts.data[0], noCurrency] }),
      ],
    ])
    const list = await listMetaAccounts({
      credentials: { accessToken: TEST_TOKEN },
    })
    expect(list.map((a) => a.externalId)).toEqual(["act_1001"])

    mockGraph([["GET", "me/adaccounts", () => json({ data: [noCurrency] })]])
    await expect(
      listMetaAccounts({ credentials: { accessToken: TEST_TOKEN } })
    ).rejects.toMatchObject({ code: "upstream_error" })
  })
})

describe("prepareMetaCredentials (personal user token)", () => {
  const SECRET_HEX = "0123456789abcdef0123456789abcdef"
  it("exchanges a short-lived user token for a long-lived one when App ID + Secret are given", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600
    const m = mockGraph([
      ["GET", "debug_token", () => json({ data: { app_id: "12345", type: "USER", is_valid: true, expires_at: soon } })],
      ["GET", "oauth/access_token", () => json({ access_token: "EAAlonglivedtoken0123456789abcdef", token_type: "bearer", expires_in: 5_184_000 })],
    ])
    const out = await prepareMetaCredentials({ credentials: { accessToken: TEST_TOKEN, appId: "12345", appSecret: SECRET_HEX } })
    expect(out.credentials.accessToken).toBe("EAAlonglivedtoken0123456789abcdef")
    expect(out.notes[0]).toMatch(/60 ngày/)
    const ex = m.calls.find((c) => c.path === "oauth/access_token")!
    expect(ex.params).toMatchObject({ grant_type: "fb_exchange_token", client_id: "12345", fb_exchange_token: TEST_TOKEN })
  })
  it("keeps system-user / long-lived tokens unchanged and does nothing without app secret", async () => {
    const far = Math.floor(Date.now() / 1000) + 50 * 86_400
    mockGraph([["GET", "debug_token", () => json({ data: { app_id: "12345", type: "USER", is_valid: true, expires_at: far } })]])
    const a = await prepareMetaCredentials({ credentials: { accessToken: TEST_TOKEN, appId: "12345", appSecret: SECRET_HEX } })
    expect(a.credentials.accessToken).toBe(TEST_TOKEN)
    const b = await prepareMetaCredentials({ credentials: { accessToken: TEST_TOKEN } })
    expect(b).toEqual({ credentials: { accessToken: TEST_TOKEN }, notes: [] })
  })
})
