// IP normalisation shared by the MCP endpoint (allowlists, limiters) and the SSRF guard.
import { isIP } from "node:net"

/** Strip IPv4-mapped IPv6 prefix and zone ids; returns null when not an IP. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  let ip = raw.trim()
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"))
  const zone = ip.indexOf("%")
  if (zone > 0) ip = ip.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) ip = mapped[1]!
  // "1.2.3.4:5678" (some proxies append the port)
  if (isIP(ip) === 0 && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"))
  return isIP(ip) === 0 ? null : ip.toLowerCase()
}
