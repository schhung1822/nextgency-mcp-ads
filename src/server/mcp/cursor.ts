// Opaque, signed cursors: base64url(JSON payload) + "." + base64url(HMAC-SHA256). The MAC binds the
// cursor to the MCP, the tool, the resolved accounts and the query, so a client cannot forge or edit a
// cursor (e.g. swap the adapter cursor / fan-out position / Meta report run id) nor replay it against
// another MCP, tool, account set or query. Key = HKDF(MCP_KEY_PEPPER or BETTER_AUTH_SECRET, "cursor").
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { invalid } from "./errors"

export interface CursorBinding {
  mcpId: string
  tool: string
  /** internal ad_accounts ids the query runs on */
  accountIds: string[]
  /** every query parameter except the cursor */
  query: unknown
}

export function queryHash(q: unknown): string {
  return createHash("sha256").update(JSON.stringify(q)).digest("base64url").slice(0, 12)
}

let cachedKey: { ikm: string; key: Buffer } | null = null

function cursorKey(): Buffer {
  const ikm = process.env.MCP_KEY_PEPPER || process.env.BETTER_AUTH_SECRET
  if (!ikm) throw new Error("MCP_KEY_PEPPER / BETTER_AUTH_SECRET chưa được cấu hình (cần để ký cursor)")
  if (cachedKey?.ikm === ikm) return cachedKey.key
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(ikm, "utf8"), Buffer.from("ads-mcp", "utf8"), Buffer.from("cursor", "utf8"), 32))
  cachedKey = { ikm, key }
  return key
}

function mac(body: string, bind: CursorBinding): Buffer {
  const material = ["v1", bind.mcpId, bind.tool, [...bind.accountIds].sort().join(","), queryHash(bind.query), body].join("\n")
  return createHmac("sha256", cursorKey()).update(material, "utf8").digest()
}

export function encodeCursor(payload: Record<string, unknown>, bind: CursorBinding): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${body}.${mac(body, bind).toString("base64url")}`
}

const MISMATCH_HINT = "Dùng đúng next_cursor từ kết quả trước, giữ nguyên mọi tham số khác (trừ cursor)."

export function decodeCursor<T extends Record<string, unknown>>(cursor: string, bind: CursorBinding): T {
  const dot = cursor.lastIndexOf(".")
  const body = dot > 0 ? cursor.slice(0, dot) : ""
  const sig = dot > 0 ? Buffer.from(cursor.slice(dot + 1), "base64url") : Buffer.alloc(0)
  const expected = body ? mac(body, bind) : Buffer.alloc(32)
  // tampered, forged, or issued for another MCP / tool / account set / query: same answer
  if (!body || sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw invalid("invalid_cursor", "cursor không hợp lệ hoặc không khớp với truy vấn hiện tại.", MISMATCH_HINT)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    throw invalid("invalid_cursor", "cursor không hợp lệ.", MISMATCH_HINT)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("invalid_cursor", "cursor không hợp lệ.", MISMATCH_HINT)
  return parsed as T
}
