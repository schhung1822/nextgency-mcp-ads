import { describe, expect, it } from "vitest"

import { isSameOriginRequest } from "./same-origin"

const APP = "https://ads.example.com"
const req = (headers: Record<string, string>) =>
  new Request("https://ads.example.com/api/logs/export", { method: "POST", headers })

describe("isSameOriginRequest", () => {
  it("accepts the app's own origin", () => {
    expect(isSameOriginRequest(req({ origin: APP, "sec-fetch-site": "same-origin" }), APP)).toBe(true)
    expect(isSameOriginRequest(req({ origin: APP }), APP)).toBe(true)
  })
  it("rejects cross-site, missing or opaque origins", () => {
    expect(isSameOriginRequest(req({ origin: "https://evil.example" }), APP)).toBe(false)
    expect(isSameOriginRequest(req({}), APP)).toBe(false)
    expect(isSameOriginRequest(req({ origin: "null" }), APP)).toBe(false)
    expect(isSameOriginRequest(req({ origin: APP, "sec-fetch-site": "cross-site" }), APP)).toBe(false)
    expect(isSameOriginRequest(req({ origin: APP, "sec-fetch-site": "same-site" }), APP)).toBe(false)
  })
})
