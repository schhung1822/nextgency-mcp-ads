// System notices: fetch from the noti.vn webhook (worker job `notices.fetch`, hourly) and the app_settings key
// they live in (.claude/docs/13-system-notices.md). Shared by the worker, the web layout and the MCP layer, so it
// must stay framework-free: no `next/*`, no `server-only`.
//
// app_settings key (internal: NOT in SETTING_SCHEMAS, the Settings form never touches it):
//   system_notices   { items: SystemNotice[], fetchedAt, lastSuccessAt | null, error | null }
import { eq } from "drizzle-orm"
import { z } from "zod"

import { parseNoticesPayload, type SystemNotice } from "@/lib/system-notices"
import { db, type Tx } from "@/server/db/client"
import { appSettings } from "@/server/db/schema"

export const SYSTEM_NOTICES_KEY = "system_notices"
export const DEFAULT_NOTICES_URL =
  "https://auto.webhook.vn/webhook/noti-Ads-MCP-simple"
export const NOTICES_TIMEOUT_MS = 10_000
/** the answer is a handful of short rows; anything bigger is not what we asked for */
export const NOTICES_MAX_BYTES = 64 * 1024
/** when the webhook keeps failing, the last good notices are kept this long, then hidden */
export const NOTICES_STALE_MS = 24 * 60 * 60_000
/** in-process cache of the stored value (web layout + every MCP tool result read it) */
export const NOTICES_CACHE_MS = 60_000

/**
 * `SYSTEM_NOTICES_URL`: unset = the noti.vn webhook; empty / "off" / "false" / "0" = feature disabled; anything
 * else must be an absolute https URL without credentials (otherwise disabled - never fetch an arbitrary scheme).
 */
export function readNoticesUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.SYSTEM_NOTICES_URL
  if (raw === undefined) return DEFAULT_NOTICES_URL
  const v = raw.trim()
  if (!v || ["off", "false", "0", "no", "disabled"].includes(v.toLowerCase()))
    return null
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" || u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}

export type NoticesFetchErrorCode =
  "disabled" | "http" | "timeout" | "network" | "too_large" | "bad_response"

export type NoticesFetchResult =
  | { ok: true; items: SystemNotice[] }
  | { ok: false; code: NoticesFetchErrorCode; status?: number }

export interface FetchNoticesOptions {
  url?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return null
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** GET the webhook and parse it. Never throws. Redirects are refused (a moved webhook = change SYSTEM_NOTICES_URL). */
export async function fetchSystemNotices(
  opts: FetchNoticesOptions = {}
): Promise<NoticesFetchResult> {
  const url = opts.url === undefined ? readNoticesUrl() : opts.url
  if (!url) return { ok: false, code: "disabled" }
  const doFetch = opts.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? NOTICES_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  let res: Response
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "ads-mcp-notices" },
      signal,
      redirect: "error",
      cache: "no-store",
    })
  } catch (e) {
    const name = (e as { name?: string } | null)?.name
    if (name === "TimeoutError" || (name === "AbortError" && timeout.aborted))
      return { ok: false, code: "timeout" }
    return { ok: false, code: "network" }
  }
  // 204 / 404 = "no notice right now" for a webhook that answers nothing when the table is empty
  if (res.status === 204 || res.status === 404) return { ok: true, items: [] }
  if (!res.ok) return { ok: false, code: "http", status: res.status }
  let text: string | null
  try {
    // the same timeout covers the body: a webhook that sends headers then stalls cannot hang the job
    text = await readCapped(res, NOTICES_MAX_BYTES)
  } catch {
    return { ok: false, code: timeout.aborted ? "timeout" : "network" }
  }
  if (text === null) return { ok: false, code: "too_large" }
  if (!text.trim()) return { ok: true, items: [] }
  try {
    return { ok: true, items: parseNoticesPayload(JSON.parse(text) as unknown) }
  } catch {
    return { ok: false, code: "bad_response" }
  }
}

// ---------------------------------------------------------------------------
// app_settings storage
// ---------------------------------------------------------------------------

const storedSchema = z.object({
  items: z
    .array(z.object({ id: z.string().max(64), content: z.string().max(400) }))
    .max(20),
  fetchedAt: z.string(),
  lastSuccessAt: z.string().nullable(),
  error: z.string().nullable().optional(),
})
export type StoredNotices = z.infer<typeof storedSchema>

export async function readStoredNotices(
  tx: Tx | typeof db = db
): Promise<StoredNotices | null> {
  const rows = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SYSTEM_NOTICES_KEY))
    .limit(1)
  const p = storedSchema.safeParse(rows[0]?.value)
  return p.success ? p.data : null
}

/**
 * Next stored value: a success replaces the list (an empty list clears it); a failure keeps the last good list
 * until it is older than NOTICES_STALE_MS; "disabled" clears everything.
 */
export function nextStoredNotices(
  prev: StoredNotices | null,
  result: NoticesFetchResult,
  now: Date
): StoredNotices {
  const at = now.toISOString()
  if (result.ok)
    return {
      items: result.items,
      fetchedAt: at,
      lastSuccessAt: at,
      error: null,
    }
  if (result.code === "disabled")
    return { items: [], fetchedAt: at, lastSuccessAt: null, error: null }
  const last = prev?.lastSuccessAt ? Date.parse(prev.lastSuccessAt) : NaN
  const fresh = Number.isFinite(last) && now.getTime() - last < NOTICES_STALE_MS
  const error =
    result.code === "http" ? `http_${result.status ?? 0}` : result.code
  return {
    items: fresh ? (prev?.items ?? []) : [],
    fetchedAt: at,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    error,
  }
}

export async function writeStoredNotices(
  tx: Tx | typeof db,
  value: StoredNotices,
  now = new Date()
): Promise<void> {
  await tx
    .insert(appSettings)
    .values({ key: SYSTEM_NOTICES_KEY, value, updatedBy: null, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedBy: null, updatedAt: now },
    })
}

/** Fetch + store (worker job). Never throws on a webhook problem; a DB error propagates (pg-boss logs it). */
export async function runNoticesFetch(
  opts: FetchNoticesOptions & { now?: Date } = {}
): Promise<{ result: NoticesFetchResult; stored: StoredNotices }> {
  const result = await fetchSystemNotices(opts)
  const now = opts.now ?? new Date()
  const prev = await readStoredNotices()
  const stored = nextStoredNotices(prev, result, now)
  await writeStoredNotices(db, stored, now)
  resetNoticesCache()
  return { result, stored }
}

// ---------------------------------------------------------------------------
// cached read (web layout, MCP results)
// ---------------------------------------------------------------------------

let cache: { at: number; items: SystemNotice[] } | null = null

/** Current notices, cached NOTICES_CACHE_MS per process. Never throws (a DB hiccup shows no notice). */
export async function getActiveNotices(
  now = Date.now()
): Promise<SystemNotice[]> {
  if (readNoticesUrl() === null) return []
  if (cache && now - cache.at < NOTICES_CACHE_MS) return cache.items
  try {
    const stored = await readStoredNotices()
    const items = stored?.items ?? []
    cache = { at: now, items }
    return items
  } catch {
    // keep serving the previous list for a short while instead of hammering a failing DB
    cache = { at: now, items: cache?.items ?? [] }
    return cache.items
  }
}

export function resetNoticesCache(): void {
  cache = null
}
