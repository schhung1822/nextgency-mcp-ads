import { describe, expect, it } from "vitest"
import { ProviderError } from "../errors"
import { credentialFields, credentialHint, parseCredentials } from "./credentials"
import { oauthCredentials, saCredentials, testKeyPair, viMessage } from "./__fixtures__/mock-fetch"

describe("parseCredentials", () => {
  it("parses a service account JSON key and normalizes common fields", () => {
    const c = saCredentials({ login_customer_id: "123-456-7890", customer_ids: "111-222-3333, 4445556666", developer_token: "" })
    expect(c.auth_type).toBe("service_account")
    if (c.auth_type !== "service_account") throw new Error()
    expect(c.client_email).toBe("ads-bot@demo-project.iam.gserviceaccount.com")
    expect(c.private_key).toContain("PRIVATE KEY")
    expect(c.login_customer_id).toBe("1234567890")
    expect(c.customer_ids).toEqual(["1112223333", "4445556666"])
    expect(c.developer_token).toBeNull()
  })

  it("is idempotent (stored credentials can be re-parsed)", () => {
    const c = saCredentials({ login_customer_id: "123-456-7890" })
    expect(parseCredentials(c)).toEqual(c)
    const o = oauthCredentials({ customer_ids: ["1112223333"] })
    expect(parseCredentials(o)).toEqual(o)
  })

  it("rejects invalid JSON / missing fields with a Vietnamese message", () => {
    const bad = (json: string) => () => parseCredentials({ auth_type: "service_account", service_account_json: json })
    expect(viMessage(bad("not json"))).toMatch(/JSON hợp lệ/)
    expect(viMessage(bad(JSON.stringify({ type: "service_account", private_key: testKeyPair().privateKey })))).toMatch(/client_email/)
    expect(viMessage(bad(JSON.stringify({ type: "service_account", client_email: "a@b.c" })))).toMatch(/private_key/)
    expect(viMessage(bad(JSON.stringify({ type: "authorized_user", client_email: "a@b.c", private_key: "x" })))).toMatch(/service_account/)
    try {
      bad("x")()
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("invalid_credentials_input")
    }
  })

  it("validates login_customer_id is 10 digits", () => {
    expect(viMessage(() => oauthCredentials({ login_customer_id: "12345" }))).toMatch(/10 chữ số/)
  })

  it("requires OAuth fields", () => {
    expect(() => parseCredentials({ auth_type: "oauth_refresh_token", client_id: "1234567890-abc", client_secret: "" })).toThrow(ProviderError)
  })

  it("credentialHint never exposes the secret", () => {
    expect(credentialHint(oauthCredentials())).toBe("…ALUE")
    expect(credentialHint(saCredentials())).toBe("ads-bot@demo-project.iam.gserviceaccount.com")
  })

  it("form fields are conditional on auth_type", () => {
    const sa = credentialFields.find((f) => f.key === "service_account_json")!
    expect(sa.type).toBe("textarea")
    expect(sa.showWhen).toEqual({ key: "auth_type", equals: "service_account" })
    expect(credentialFields.find((f) => f.key === "refresh_token")!.showWhen).toEqual({ key: "auth_type", equals: "oauth_refresh_token" })
  })
})
