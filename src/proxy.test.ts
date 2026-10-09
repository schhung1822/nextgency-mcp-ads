// The session proxy's matcher: public endpoints (MCP, video relay, auth, legal pages) never reach the login redirect.
import { describe, expect, it } from "vitest"

import { config } from "./proxy"

// the matcher is a single "/(<regex>)" path pattern; as a JS regex it decides the same paths
const matcher = new RegExp(`^${config.matcher[0]}$`)
const proxied = (path: string) => matcher.test(path)

describe("proxy matcher", () => {
  it("skips the temporary video links /dl/<token>/<name>", () => {
    expect(proxied(`/dl/adr_${"a".repeat(43)}/video.mp4`)).toBe(false)
    expect(
      proxied(`/dl/adr_${"a".repeat(43)}/Video%20qu%E1%BA%A3ng%20c%C3%A1o.mov`)
    ).toBe(false)
  })

  it("skips the MCP endpoint and other public routes", () => {
    expect(proxied("/mcp/amcp_xyz")).toBe(false)
    expect(proxied("/api/auth/sign-in/email")).toBe(false)
    expect(proxied("/login")).toBe(false)
    expect(proxied("/privacy")).toBe(false)
  })

  it("still guards the dashboard (incl. look-alike paths)", () => {
    expect(proxied("/")).toBe(true)
    expect(proxied("/connections")).toBe(true)
    expect(proxied("/dlx")).toBe(true)
    expect(proxied("/dl")).toBe(true)
    expect(proxied("/mcp-servers")).toBe(true)
  })
})
