import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const { metaFromHeaders } = await import("./activity-log")

describe("activity-log request meta", () => {
  it("uses only the first X-Forwarded-For hop and validates it with node:net isIP", () => {
    expect(metaFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).ip).toBe("203.0.113.9")
    expect(metaFromHeaders(new Headers({ "x-forwarded-for": "2001:db8::7" })).ip).toBe("2001:db8::7")
    // the old regex accepted these
    for (const bogus of ["999.999.999.999", "1.2.3", "::::", "abc:def", "....:::"]) {
      expect(metaFromHeaders(new Headers({ "x-forwarded-for": bogus })).ip, bogus).toBeNull()
    }
  })
  it("strips IPv6 zone ids and the ::ffff: prefix - a zone id would be rejected by the inet column and abort the log transaction", async () => {
    const { requestMetaFromHeaders } = await import("@/server/auth/activity-core")
    for (const f of [metaFromHeaders, (h: Headers) => requestMetaFromHeaders(h)]) {
      expect(f(new Headers({ "x-forwarded-for": "fe80::1%eth0" })).ip).toBe("fe80::1")
      expect(f(new Headers({ "x-forwarded-for": "::ffff:203.0.113.9" })).ip).toBe("203.0.113.9")
      expect(f(new Headers({ "x-forwarded-for": " 2001:DB8::7 , 1.1.1.1" })).ip).toBe("2001:db8::7")
      expect(f(new Headers({ "x-forwarded-for": "203.0.113.9:4711" })).ip).toBe("203.0.113.9")
    }
  })
  it("ignores X-Real-IP (not rewritten by Caddy, attacker-controlled)", () => {
    expect(metaFromHeaders(new Headers({ "x-real-ip": "198.51.100.1" })).ip).toBeNull()
  })
})
