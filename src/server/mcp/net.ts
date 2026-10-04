// IP helpers: client IP extraction, normalisation and allowlists (single IPs + CIDR, v4/v6).
import { BlockList, isIP } from "node:net"

import { normalizeIp } from "../net/ip"

export { normalizeIp }

/**
 * Client IP: first hop of X-Forwarded-For only. Caddy (header_up X-Forwarded-For {client_ip}) overwrites any
 * client-supplied X-Forwarded-For with the real peer address; X-Real-IP is NOT rewritten by Caddy and
 * would be attacker-controlled, so it is never read. Returns null when absent/invalid (direct dev requests).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")
  if (!xff) return null
  return normalizeIp(xff.split(",")[0])
}

/**
 * Key for per-client limiters: IPv4 as is, IPv6 grouped by /64 (a single host usually owns a whole
 * /64, so per-address buckets would be trivial to evade).
 */
export function ipBucketKey(ip: string | null): string {
  const n = normalizeIp(ip)
  if (!n) return "unknown"
  if (isIP(n) !== 6) return n
  return `${expandIpv6(n).slice(0, 4).join(":")}::/64`
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null]
  const h = head ? head.split(":") : []
  const t = tail ? tail.split(":") : []
  // an embedded IPv4 tail (::ffff:1.2.3.4 style) counts as two groups
  const groups = (xs: string[]) => xs.flatMap((x) => (x.includes(".") ? ["0", "0"] : [x]))
  const hh = groups(h)
  const tt = groups(t)
  const fill = tail === null ? [] : Array<string>(Math.max(0, 8 - hh.length - tt.length)).fill("0")
  return [...hh, ...fill, ...tt].map((x) => x.replace(/^0+(?=.)/, "").toLowerCase())
}

function family(ip: string): "ipv4" | "ipv6" {
  return isIP(ip) === 6 ? "ipv6" : "ipv4"
}

export interface IpMatcher {
  matches(ip: string | null): boolean
  /** entries that could not be parsed (ignored) */
  invalid: string[]
}

/** Build a matcher from entries like "1.2.3.4", "10.0.0.0/8", "2001:db8::/32". */
export function buildIpMatcher(entries: string[]): IpMatcher {
  const list = new BlockList()
  const invalid: string[] = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const slash = entry.indexOf("/")
    if (slash === -1) {
      const ip = normalizeIp(entry)
      if (!ip) {
        invalid.push(entry)
        continue
      }
      list.addAddress(ip, family(ip))
      continue
    }
    const ip = normalizeIp(entry.slice(0, slash))
    const prefix = Number(entry.slice(slash + 1))
    if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > (family(ip) === "ipv4" ? 32 : 128)) {
      invalid.push(entry)
      continue
    }
    list.addSubnet(ip, prefix, family(ip))
  }
  return {
    invalid,
    matches(ipRaw) {
      const ip = normalizeIp(ipRaw)
      if (!ip) return false
      return list.check(ip, family(ip))
    },
  }
}

/** Empty allowlist = any IP. Unknown client IP with a non-empty allowlist = denied. */
export function ipAllowed(allowedIps: string[], ip: string | null): boolean {
  const entries = allowedIps.map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) return true
  return buildIpMatcher(entries).matches(ip)
}
