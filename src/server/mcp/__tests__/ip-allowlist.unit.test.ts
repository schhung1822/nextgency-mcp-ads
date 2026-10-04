// The wizard validates allowlist entries with zod (src/lib/schemas/mcp-servers.ts) and the endpoint matches them with
// node:net BlockList (net.ts). Every entry the form accepts MUST be understood by the matcher - an entry that is
// silently ignored would narrow (or empty) the allowlist without the user knowing.
import { describe, expect, it } from "vitest"
import { isValidIpOrCidr, parseIpList } from "@/lib/schemas/mcp-servers"
import { buildIpMatcher, ipAllowed } from "../net"

const ACCEPTED = [
  "1.2.3.4",
  "10.0.0.0/8",
  "0.0.0.0/0",
  "1.2.3.4/32",
  "::1",
  "::",
  "::/0",
  "2001:db8::/32",
  "2001:DB8::1",
  "2001:db8:0:0:0:0:0:1",
  "::ffff:1.2.3.4",
  "::ffff:102:304",
  "2001:db8::1/64",
  "10.0.0.5/8",
]
const REJECTED = ["1.2.3.4/33", "01.2.3.4", "1.2.3", "256.1.1.1", "[::1]", "fe80::1%eth0", "1.2.3.4:8080", "2001:db8::/129", "1.2.3.4/", "1.2.3.4/abc", "localhost"]

describe("IP allowlist: form validation and endpoint matcher agree", () => {
  it.each(ACCEPTED)("accepted entry %s is understood by the matcher", (entry) => {
    expect(isValidIpOrCidr(entry)).toBe(true)
    expect(buildIpMatcher([entry]).invalid).toEqual([])
  })

  it.each(REJECTED)("rejected entry %s never reaches the endpoint", (entry) => {
    expect(isValidIpOrCidr(entry)).toBe(false)
  })

  it("matches CIDR ranges, IPv6 case/short forms and IPv4-mapped addresses", () => {
    expect(ipAllowed(["10.0.0.0/8"], "10.255.255.255")).toBe(true)
    expect(ipAllowed(["10.0.0.0/8"], "11.0.0.1")).toBe(false)
    expect(ipAllowed(["10.0.0.5/8"], "10.1.1.1")).toBe(true) // host bits in a CIDR are ignored
    expect(ipAllowed(["2001:db8::/32"], "2001:db8:1::5")).toBe(true)
    expect(ipAllowed(["2001:db8::/32"], "2001:db9::1")).toBe(false)
    expect(ipAllowed(["2001:DB8::1"], "2001:db8:0:0:0:0:0:1")).toBe(true)
    expect(ipAllowed(["1.2.3.4"], "::ffff:1.2.3.4")).toBe(true)
    expect(ipAllowed(["::ffff:1.2.3.4"], "1.2.3.4")).toBe(true)
  })

  it("an empty list allows everyone, a non-empty list denies an unknown client IP", () => {
    expect(ipAllowed([], null)).toBe(true)
    expect(ipAllowed(["1.2.3.4"], null)).toBe(false)
    expect(ipAllowed(["1.2.3.4"], "garbage")).toBe(false)
  })

  it("parses a textarea separated by newlines, commas, semicolons and spaces, de-duplicated", () => {
    expect(parseIpList("1.2.3.4, 5.6.7.8;9.9.9.9\n1.2.3.4  2001:db8::1")).toEqual(["1.2.3.4", "5.6.7.8", "9.9.9.9", "2001:db8::1"])
  })
})
