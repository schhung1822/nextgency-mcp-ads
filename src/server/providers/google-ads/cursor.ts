// Opaque cursor wrapping a Google pageToken + offset inside that page (Google pages are fixed at 10,000 rows,
// while MCP pages are small). Bound to the query via a short hash so a cursor cannot be replayed on another query.
import { createHash } from "node:crypto"
import { ProviderError } from "../errors"

interface CursorData {
  v: 1
  /** Google pageToken of the page the offset refers to (null = first page) */
  pt: string | null
  off: number
  q: string
}

export function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("base64url").slice(0, 12)
}

export function encodeCursor(pt: string | null, off: number, query: string): string {
  const d: CursorData = { v: 1, pt, off, q: queryHash(query) }
  return Buffer.from(JSON.stringify(d)).toString("base64url")
}

export function decodeCursor(cursor: string | null | undefined, query: string): { pt: string | null; off: number } {
  if (!cursor) return { pt: null, off: 0 }
  let d: CursorData
  try {
    d = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorData
  } catch {
    throw badCursor()
  }
  if (!d || d.v !== 1 || typeof d.off !== "number" || d.off < 0 || !Number.isInteger(d.off) || (d.pt !== null && typeof d.pt !== "string")) {
    throw badCursor()
  }
  if (d.q !== queryHash(query)) {
    throw new ProviderError({
      platform: "google_ads",
      code: "invalid_request",
      message: "Cursor does not belong to this query",
      userMessageVi: "Cursor không khớp với truy vấn hiện tại (đã đổi bộ lọc/khoảng ngày?). Hãy gọi lại không kèm cursor.",
    })
  }
  return { pt: d.pt, off: d.off }
}

function badCursor() {
  return new ProviderError({
    platform: "google_ads",
    code: "invalid_request",
    message: "Invalid cursor",
    userMessageVi: "Cursor phân trang không hợp lệ. Hãy gọi lại không kèm cursor.",
  })
}

/** Slice one Google page into an MCP page and compute the next cursor. */
export function slicePage<T>(
  results: T[],
  current: { pt: string | null; off: number },
  nextPageToken: string | null,
  limit: number,
  query: string
): { items: T[]; nextCursor: string | null } {
  const items = results.slice(current.off, current.off + limit)
  const end = current.off + items.length
  if (end < results.length) return { items, nextCursor: encodeCursor(current.pt, end, query) }
  if (nextPageToken) return { items, nextCursor: encodeCursor(nextPageToken, 0, query) }
  return { items, nextCursor: null }
}
