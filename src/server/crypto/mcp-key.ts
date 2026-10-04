// MCP URL key: "amcp_" + 32 random bytes (base64url, 43 chars). Stored as HMAC-SHA256(pepper) + prefix + encrypted copy.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const MCP_KEY_PREFIX = "amcp_"
const KEY_RE = /^amcp_[A-Za-z0-9_-]{43}$/

export function generateMcpKey(): string {
  return MCP_KEY_PREFIX + randomBytes(32).toString("base64url")
}

export function isWellFormedMcpKey(raw: string): boolean {
  return KEY_RE.test(raw)
}

function pepper(): Buffer {
  const p = process.env.MCP_KEY_PEPPER
  if (!p) throw new Error("MCP_KEY_PEPPER chưa được cấu hình")
  const buf = Buffer.from(p, "base64")
  if (buf.length < 32) throw new Error("MCP_KEY_PEPPER phải dài ít nhất 32 byte (base64)")
  return buf
}

export function hashMcpKey(raw: string): string {
  return createHmac("sha256", pepper()).update(raw, "utf8").digest("hex")
}

/** first 12 chars (e.g. "amcp_Ab3dE9x") for display */
export function mcpKeyPrefix(raw: string): string {
  return raw.slice(0, 12)
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function buildMcpUrl(baseUrl: string, raw: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp/${raw}`
}
